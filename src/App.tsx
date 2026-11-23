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
  const [showSearch, setShowSearch] = useState(false);

  function updateStops(next: Stop[]) {
    setStops(next);
    saveStops(next);
  }

  async function load() {
    setStatus("Loading…");
    try {
      setDeps(parseDepartures(await ojp(departuresBody(selected.ref))));
      setStatus(`updated ${hhmm(new Date())}`);
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

  const pivot = isSaved(selected) ? stops : [...stops, selected];
  // "Basel, Burgfelderplatz" -> "burgfelderplatz" for the pivot header.
  const short = (name: string) => name.replace(/^Basel,\s*/, "");

  return (
    <main className="app">
      <p className="brand">Basel Transit</p>
      <nav className="pivot">
        {pivot.map((s) => (
          <button key={s.ref} aria-current={s.ref === selected.ref} onClick={() => setSelected(s)}>
            {short(s.name)}
          </button>
        ))}
      </nav>

      <div className="appbar">
        <button onClick={load} aria-label="Refresh">↻ refresh</button>
        <button
          aria-label="Remove stop"
          disabled={!isSaved(selected) || stops.length <= 1}
          onClick={() => {
            const next = stops.filter((s) => s.ref !== selected.ref);
            updateStops(next);
            setSelected(next[0]);
          }}
        >
          ✕ remove
        </button>
        <button aria-expanded={showSearch} onClick={() => setShowSearch(!showSearch)}>⌕ search</button>
      </div>

      {showSearch && (
        <>
          <form onSubmit={search} className="search">
            <input
              type="text"
              aria-label="Stop name"
              placeholder="stop name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="btn">go</button>
          </form>
          {results.length > 0 && (
            <ul className="results">
              {results.map((s) => (
                <li key={s.ref}>
                  <span>{s.name}</span>
                  <button className="btn" onClick={() => { setSelected(s); setResults([]); setShowSearch(false); }}>show</button>
                  <button className="btn" disabled={isSaved(s)} onClick={() => updateStops([...stops, s])}>save</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {groupByDirection(deps).map(([key, list]) => (
        <section key={key}>
          <button className="group" aria-expanded={open === key} onClick={() => toggle(key)}>
            <span className={`tile ${list[0].mode}`}>
              <b>{list[0].line}</b>
              <small>{list[0].mode}</small>
            </span>
            <span className="deps">
              <span className="dest">{list[0].to}</span>
              {list.map((d, i) => {
                const delay = Math.round((d.expected.getTime() - d.planned.getTime()) / 60000);
                const left = Math.max(0, Math.floor((d.expected.getTime() - Date.now()) / 60000));
                return (
                  <span className="dep" key={i}>
                    <span>{hhmm(d.planned)}</span>
                    {delay > 0 && <span className="late">+{delay}'</span>}
                    <span className="via">{d.to !== list[0].to ? d.to : d.quay && `quay ${d.quay}`}</span>
                    <span className="left">{left === 0 ? "now" : `${left} min`}</span>
                  </span>
                );
              })}
            </span>
          </button>
          {open === key && (
            <ul className="route">
              {onward?.[key] ? onward[key].map((s, i) => <li key={i}>{s}</li>) : <li>loading stops…</li>}
            </ul>
          )}
        </section>
      ))}

      <p className="status">{status}</p>
    </main>
  );
}
