import { useEffect, useState } from "react";

type Stop = { ref: string; name: string };
type Departure = {
  line: string;
  dir: string;
  mode: string;
  to: string;
  quay: string;
  planned: Date;
  expected: Date;
};

const STORAGE_KEY = "basel-transit:stops";
const DEFAULT_STOPS: Stop[] = [{ ref: "ch:1:sloid:89303", name: "Basel, Burgfelderplatz" }];

const envelope = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPRequest><siri:ServiceRequest>
    <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
    <siri:RequestorRef>basel-transit</siri:RequestorRef>
    ${inner}
  </siri:ServiceRequest></OJPRequest>
</OJP>`;

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

const searchBody = (name: string) =>
  envelope(`<OJPLocationInformationRequest>
      <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
      <InitialInput><Name>${escapeXml(name)}</Name></InitialInput>
      <Restrictions><Type>stop</Type><NumberOfResults>10</NumberOfResults></Restrictions>
    </OJPLocationInformationRequest>`);

const departuresBody = (ref: string, onward = false) =>
  envelope(`<OJPStopEventRequest>
      <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
      <Location><PlaceRef><StopPlaceRef>${escapeXml(ref)}</StopPlaceRef></PlaceRef></Location>
      <Params>
        <NumberOfResults>30</NumberOfResults>
        <StopEventType>departure</StopEventType>${onward ? "\n        <IncludeOnwardCalls>true</IncludeOnwardCalls>" : ""}
        <IncludeRealtimeData>true</IncludeRealtimeData>
      </Params>
    </OJPStopEventRequest>`);

async function ojp(body: string): Promise<Document> {
  const res = await fetch("/ojp", {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return new DOMParser().parseFromString(await res.text(), "application/xml");
}

// Namespace-agnostic lookup: first descendant with this local name, text only.
const text = (el: Element | Document, tag: string) =>
  el.getElementsByTagNameNS("*", tag)[0]?.textContent?.trim() ?? "";
const all = (el: Document, tag: string) => [...el.getElementsByTagNameNS("*", tag)];

const parseStops = (doc: Document): Stop[] =>
  all(doc, "PlaceResult")
    .map((p) => ({ ref: text(p, "StopPlaceRef"), name: text(p, "StopPlaceName") }))
    .filter((s) => s.ref);

const parseDepartures = (doc: Document): Departure[] =>
  all(doc, "StopEvent").map((ev) => {
    const planned = text(ev, "TimetabledTime");
    return {
      line: text(ev, "PublishedServiceName"),
      dir: text(ev, "DirectionRef"),
      mode: text(ev, "PtMode"),
      to: text(ev, "DestinationText"),
      quay: text(ev, "PlannedQuay"),
      planned: new Date(planned),
      expected: new Date(text(ev, "EstimatedTime") || planned),
    };
  });

const groupKey = (d: { line: string; dir: string }) => `${d.line}|${d.dir}`;

// shortcut: first trip per line+direction wins, so short-turn trips may show a shorter/longer list.
function parseOnward(doc: Document): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const ev of all(doc, "StopEvent")) {
    const key = groupKey({ line: text(ev, "PublishedServiceName"), dir: text(ev, "DirectionRef") });
    if (groups[key]) continue;
    groups[key] = [...ev.getElementsByTagNameNS("*", "OnwardCall")].map((c) => text(c, "StopPointName"));
  }
  return groups;
}

const ONWARD_TTL = 24 * 60 * 60 * 1000;
const onwardKey = (ref: string) => `basel-transit:onward:${ref}`;

function loadOnward(ref: string): Record<string, string[]> | null {
  try {
    const c = JSON.parse(localStorage.getItem(onwardKey(ref)) ?? "null");
    return c && Date.now() - c.at < ONWARD_TTL ? c.groups : null;
  } catch {
    return null;
  }
}

function saveOnward(ref: string, groups: Record<string, string[]>) {
  try {
    localStorage.setItem(onwardKey(ref), JSON.stringify({ at: Date.now(), groups }));
  } catch {
    // Storage unavailable: stops just get refetched next time.
  }
}

function groupByDirection(deps: Departure[]) {
  const groups = new Map<string, Departure[]>();
  for (const d of deps) {
    const key = groupKey(d);
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function loadStops(): Stop[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_STOPS;
  } catch {
    return DEFAULT_STOPS;
  }
}

function saveStops(stops: Stop[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stops));
  } catch {
    // Storage unavailable (private mode etc.): list just won't persist.
  }
}

const hhmm = (d: Date) => d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });

export default function App() {
  const [stops, setStops] = useState<Stop[]>(loadStops);
  const [selected, setSelected] = useState<Stop>(stops[0]);
  const [deps, setDeps] = useState<Departure[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Stop[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [onward, setOnward] = useState<Record<string, string[]> | null>(null);

  function updateStops(next: Stop[]) {
    setStops(next);
    saveStops(next);
  }

  async function load() {
    setStatus("Loading…");
    try {
      setDeps(parseDepartures(await ojp(departuresBody(selected.ref))));
      setStatus(`Updated ${hhmm(new Date())}`);
    } catch (err) {
      setStatus(String(err));
    }
  }

  useEffect(() => {
    setOpen(null);
    load();
  }, [selected.ref]);

  async function toggle(key: string) {
    if (open === key) return setOpen(null);
    setOpen(key);
    const cached = loadOnward(selected.ref);
    if (cached?.[key]) return setOnward(cached);
    setOnward(null);
    try {
      const fresh = { ...cached, ...parseOnward(await ojp(departuresBody(selected.ref, true))) };
      saveOnward(selected.ref, fresh);
      setOnward(fresh);
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      setResults(parseStops(await ojp(searchBody(query))));
    } catch (err) {
      setStatus(String(err));
    }
  }

  const isSaved = (s: Stop) => stops.some((x) => x.ref === s.ref);

  return (
    <div className="window" style={{ margin: 24, maxWidth: 640 }}>
      <div className="title-bar">
        <div className="title-bar-text">{selected.name}: next departures</div>
      </div>
      <div className="window-body">
        <div className="field-row">
          <label htmlFor="stop">Stop:</label>
          <select
            id="stop"
            value={selected.ref}
            onChange={(e) => setSelected(stops.find((s) => s.ref === e.target.value)!)}
          >
            {!isSaved(selected) && <option value={selected.ref}>{selected.name}</option>}
            {stops.map((s) => (
              <option key={s.ref} value={s.ref}>{s.name}</option>
            ))}
          </select>
          <button
            disabled={!isSaved(selected) || stops.length <= 1}
            onClick={() => {
              const next = stops.filter((s) => s.ref !== selected.ref);
              updateStops(next);
              setSelected(next[0]);
            }}
          >
            Remove
          </button>
          <button onClick={load}>Refresh</button>
        </div>

        <form onSubmit={search} className="field-row" style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="Search stop…"
            style={{ flex: 1 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>
        {results.length > 0 && (
          <ul className="tree-view" style={{ marginTop: 8 }}>
            {results.map((s) => (
              <li key={s.ref} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{s.name}</span>
                <span>
                  <button onClick={() => { setSelected(s); setResults([]); }}>Show</button>
                  <button disabled={isSaved(s)} onClick={() => updateStops([...stops, s])}>Save</button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {groupByDirection(deps).map(([key, list]) => (
          <fieldset key={key} style={{ marginTop: 8 }}>
            <legend>
              <button aria-expanded={open === key} onClick={() => toggle(key)}>
                {open === key ? "▾" : "▸"} {list[0].mode === "tram" ? "🚋" : "🚌"} {list[0].line} → {list[0].to}
              </button>
            </legend>
            <table style={{ width: "100%" }}>
              <tbody>
                {list.map((d, i) => {
                  const delay = Math.round((d.expected.getTime() - d.planned.getTime()) / 60000);
                  const left = Math.max(0, Math.floor((d.expected.getTime() - Date.now()) / 60000));
                  return (
                    <tr key={i}>
                      <td>{d.to}</td>
                      <td style={{ width: 40 }}>{d.quay}</td>
                      <td style={{ width: 50 }}>{hhmm(d.planned)}</td>
                      <td style={{ width: 40 }}>{delay > 0 ? `+${delay}'` : ""}</td>
                      <td style={{ width: 50, textAlign: "right" }}>{left === 0 ? "now" : `${left} min`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {open === key && (
              <ul className="tree-view" style={{ marginTop: 6 }}>
                {onward?.[key] ? (
                  onward[key].map((s, i) => <li key={i}>{s}</li>)
                ) : (
                  <li>Loading stops…</li>
                )}
              </ul>
            )}
          </fieldset>
        ))}

        <p className="status-bar" style={{ marginTop: 8 }}>
          <span className="status-bar-field">{status}</span>
        </p>
      </div>
    </div>
  );
}
