import { useEffect, useRef, useState } from "react";
import {
  access, all, envelope, escapeXml, flags, headway, headwayApplies, hhmm, isOffline, knownNear, knownSearch, loadJson,
  loadStops, metres, nearBody, ojp, ojpCached, parseSituations, parseStops, rememberDoc, rememberPlaces, replacement,
  sampleLabel, saveJson, saveStops, searchBody, short, situationRefs, text, type Access, type Quay, type Situation, type Stop,
} from "./ojp.ts";
import AccessMark, { Diverted, QuayMark } from "./Access.tsx";
import Alerts, { AlertMark } from "./Alerts.tsx";
import RefreshBar, { REFRESH_MS } from "./RefreshBar.tsx";
import RoutePlanner from "./Route.tsx";

type Departure = {
  line: string;
  dir: string;
  mode: string;
  to: string;
  quay: Quay;
  cancelled: boolean;
  deviation: boolean;
  alerts: string[];
  planned: Date;
  expected: Date;
  access: Access;
  replacement: boolean;
};

const departuresBody = (ref: string, onward = false) =>
  envelope(`<OJPStopEventRequest>
      <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
      <Location><PlaceRef><StopPlaceRef>${escapeXml(ref)}</StopPlaceRef></PlaceRef></Location>
      <Params>
        <NumberOfResults>${onward ? 100 : 30}</NumberOfResults>
        <StopEventType>departure</StopEventType>${onward ? "\n        <IncludeOnwardCalls>true</IncludeOnwardCalls>" : ""}
        <IncludeRealtimeData>true</IncludeRealtimeData>
      </Params>
    </OJPStopEventRequest>`);

const parseDepartures = (doc: Document): Departure[] =>
  all(doc, "StopEvent").map((ev) => {
    const planned = text(ev, "TimetabledTime");
    const here = all(ev, "ThisCall")[0];
    return {
      line: text(ev, "PublishedServiceName"),
      dir: text(ev, "DirectionRef"),
      mode: text(ev, "PtMode"),
      to: text(ev, "DestinationText"),
      ...flags(ev, here),
      alerts: situationRefs(ev),
      planned: new Date(planned),
      expected: new Date(text(ev, "EstimatedTime") || planned),
      access: access(ev, here),
      replacement: replacement(here),
    };
  });

const groupKey = (d: { line: string; dir: string }) => `${d.line}|${d.dir}`;

type OnwardGroup = {
  line: string;
  mode: string;
  to: string;
  stops: { name: string; min: number }[];
  headway: number | null;
  measuredAt: number; // median planned departure of the sample
};

// shortcut: first trip per line+direction wins, so short-turn trips may show a shorter/longer list.
function parseOnward(doc: Document): Record<string, OnwardGroup> {
  const groups: Record<string, OnwardGroup> = {};
  const times: Record<string, number[]> = {};
  for (const ev of all(doc, "StopEvent")) {
    const line = text(ev, "PublishedServiceName");
    const key = groupKey({ line, dir: text(ev, "DirectionRef") });
    const base = new Date(text(all(ev, "ThisCall")[0], "TimetabledTime")).getTime();
    (times[key] ??= []).push(base);
    if (groups[key]) continue;
    const stops = all(ev, "OnwardCall").map((c) => {
      const t = new Date(text(all(c, "ServiceDeparture")[0] ?? c, "TimetabledTime")).getTime();
      return { name: text(c, "StopPointName"), min: Math.round((t - base) / 60000) };
    });
    groups[key] = { line, mode: text(ev, "PtMode"), to: text(ev, "DestinationText"), stops, headway: null, measuredAt: base };
  }
  for (const [key, ts] of Object.entries(times)) {
    groups[key].headway = headway(ts.map((t) => t / 60000));
    groups[key].measuredAt = [...ts].sort((a, b) => a - b)[ts.length >> 1];
  }
  return groups;
}

const ONWARD_TTL = 7 * 24 * 60 * 60 * 1000;
const onwardKey = (ref: string) => `basel-transit:onward2:${ref}`;

// Offline, stale beats nothing: the TTL is ignored.
function loadOnward(ref: string, offline: boolean): Record<string, OnwardGroup> | null {
  const c = loadJson<{ at: number; groups: Record<string, OnwardGroup> } | null>(onwardKey(ref), null);
  return c && (offline || Date.now() - c.at < ONWARD_TTL) ? c.groups : null;
}

async function fetchOnward(ref: string): Promise<Record<string, OnwardGroup>> {
  const doc = await ojp(departuresBody(ref, true));
  rememberDoc(doc);
  const groups = parseOnward(doc);
  saveJson(onwardKey(ref), { at: Date.now(), groups });
  return groups;
}

// Background fetch, at most once at a time per stop; failures are silent (toggle() retries on demand).
const prefetching = new Set<string>();
async function prefetchOnward(ref: string): Promise<Record<string, OnwardGroup> | null> {
  if (prefetching.has(ref)) return null;
  prefetching.add(ref);
  try {
    return await fetchOnward(ref);
  } catch {
    return null;
  } finally {
    prefetching.delete(ref);
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

export default function App() {
  const [stops, setStops] = useState<Stop[]>(loadStops);
  const [selected, setSelected] = useState<Stop>(stops[0]);
  const [deps, setDeps] = useState<Departure[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<(Stop & { dist?: number })[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [onward, setOnward] = useState<Record<string, OnwardGroup> | null>(null);
  const [situations, setSituations] = useState<Situation[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState<Date | null>(null);
  const current = useRef(selected.ref);
  current.current = selected.ref;
  const [showSearch, setShowSearch] = useState(false);
  const [view, setView] = useState<"departures" | "route">("departures");

  function updateStops(next: Stop[]) {
    setStops(next);
    saveStops(next);
  }

  async function load() {
    setStatus("Loading…");
    setLoading(true);
    const ref = selected.ref;
    try {
      const { doc, offlineSince } = await ojpCached(`deps:${ref}`, departuresBody(ref));
      setDeps(parseDepartures(doc));
      setSituations(parseSituations(doc));
      setOffline(offlineSince);
      setOnward(loadOnward(ref, offlineSince !== null));
      setStatus(offlineSince ? `offline · from ${hhmm(offlineSince)}` : `updated ${hhmm(new Date())}`);
      if (!offlineSince) {
        rememberDoc(doc);
        if (!loadOnward(ref, false)) {
          void prefetchOnward(ref).then((g) => g && current.current === ref && setOnward(g));
        }
      }
    } catch (err) {
      setStatus(String(err));
    } finally {
      setLoading(false);
      setLoadedAt(Date.now());
    }
  }

  useEffect(() => {
    setOpen(null);
    setOnward(null);
    load();
  }, [selected.ref]);

  // Refresh 30s after the last load (manual or automatic) so the top-edge bar never drifts;
  // in the background just re-arm the timer.
  useEffect(() => {
    if (view !== "departures" || loadedAt === null) return;
    const id = setTimeout(() => (document.hidden ? setLoadedAt(Date.now()) : void load()), REFRESH_MS);
    return () => clearTimeout(id);
  }, [loadedAt, view, selected.ref]);

  // Back online: refresh immediately instead of waiting for the next 30s tick.
  useEffect(() => {
    if (view !== "departures") return;
    const on = () => void load();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [selected.ref, view]);

  function nearMe() {
    if (!navigator.geolocation) return setStatus("location not available in this browser");
    setStatus("locating…");
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        const here = { lat: coords.latitude, lon: coords.longitude };
        try {
          let found = parseStops(await ojp(nearBody(here.lat, here.lon)));
          if (!found.length) found = parseStops(await ojp(nearBody(here.lat, here.lon, 1000)));
          rememberPlaces(found);
          const withDist = found
            .map((s) => ({ ...s, dist: s.lat && s.lon ? metres(here, { lat: s.lat, lon: s.lon }) : undefined }))
            .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
          setResults(withDist);
          setShowSearch(true);
          setStatus(withDist.length ? `${withDist.length} stops nearby` : "no stops within 1 km");
        } catch (err) {
          if (!isOffline(err)) return setStatus(String(err));
          const known = knownNear(here);
          setResults(known);
          setShowSearch(true);
          setStatus(known.length ? `offline · ${known.length} known stops nearby` : "offline · no known stops within 1 km");
        }
      },
      (err) => setStatus(`location: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function toggle(key: string) {
    if (open === key) return setOpen(null);
    setOpen(key);
    if (onward?.[key]) return;
    const ref = selected.ref;
    try {
      const fresh = await fetchOnward(ref);
      if (current.current === ref) setOnward(fresh);
      if (!fresh[key]) setStatus("no stop list for this line");
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      const found = parseStops(await ojp(searchBody(query)));
      rememberPlaces(found);
      setResults(found);
    } catch (err) {
      if (!isOffline(err)) return setStatus(String(err));
      const known = knownSearch(query);
      setResults(known);
      setStatus(known.length ? `offline · ${known.length} known stops` : "offline · no known stop matches");
    }
  }

  const isSaved = (s: Stop) => stops.some((x) => x.ref === s.ref);

  // Offline the cached list still holds departures that have left: hide them, and keep lines with none left.
  const now = Date.now();
  const grouped = new Map(groupByDirection(offline ? deps.filter((d) => d.expected.getTime() > now) : deps));
  if (offline) for (const k of Object.keys(onward ?? {})) if (!grouped.has(k)) grouped.set(k, []);
  const groups = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

  const pivot = isSaved(selected) ? stops : [...stops, selected];

  return (
    <main className="app">
      <p className="brand">Basel Transit</p>
      <nav className="views">
        {(["departures", "route"] as const).map((v) => (
          <button key={v} aria-current={view === v} onClick={() => setView(v)}>{v}</button>
        ))}
      </nav>

      {view === "route" ? (
        <RoutePlanner from={selected} />
      ) : (
      <>
      <RefreshBar at={loadedAt} loading={loading} />
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
        <button onClick={nearMe}>◎ near me</button>
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
                  <span>
                    {s.name}
                    {s.dist !== undefined && <span className="dist"> {s.dist} m</span>}
                  </span>
                  <button className="btn" onClick={() => { setSelected(s); setResults([]); setShowSearch(false); }}>show</button>
                  <button className="btn" disabled={isSaved(s)} onClick={() => updateStops([...stops, { ref: s.ref, name: s.name }])}>save</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Alerts situations={situations} ids={deps.flatMap((d) => d.alerts)} />

      {groups.map(([key, list]) => {
        const g = onward?.[key];
        const head = list[0] ?? g!;
        const every = offline
          ? g?.headway && headwayApplies(new Date(g.measuredAt), new Date(now))
            ? `usually every ~${g.headway} min (as of ${sampleLabel(new Date(g.measuredAt))})`
            : null
          : (() => {
              const h = headway(list.filter((d) => !d.cancelled).map((d) => d.planned.getTime() / 60000)) ?? g?.headway;
              return h ? `every ~${h} min` : null;
            })();
        return (
        <section key={key}>
          <button className="group" aria-expanded={open === key} onClick={() => toggle(key)}>
            <span className={`tile ${head.mode}`}>
              <b>{head.line}</b>
              <small>{head.mode}</small>
            </span>
            <span className="deps">
              <span className="dest">
                {head.to}
                <AlertMark on={list.some((d) => d.alerts.length > 0)} />
              </span>
              {every && <span className="headway">{every}</span>}
              {list.length === 0 && <span className="headway">no cached departures</span>}
              {list.map((d, i) => {
                const delay = Math.round((d.expected.getTime() - d.planned.getTime()) / 60000);
                const left = Math.max(0, Math.floor((d.expected.getTime() - now) / 60000));
                return (
                  <span className={d.cancelled ? "dep cancelled" : "dep"} key={i}>
                    <span className="time">{hhmm(d.planned)}</span>
                    <AccessMark level={d.access} replacement={d.replacement} />
                    {delay > 0 && !d.cancelled && <span className="late">+{delay}'</span>}
                    <Diverted on={d.deviation} />
                    <span className="via">{d.to !== list[0].to ? d.to : <QuayMark quay={d.quay} />}</span>
                    {d.cancelled ? <span className="tag bad">cancelled</span> : <span className="left">{left === 0 ? "now" : `${left} min`}</span>}
                  </span>
                );
              })}
            </span>
          </button>
          {open === key && (
            <ul className="route">
              {g ? g.stops.map((s, i) => <li key={i}>{s.name} · {s.min} min</li>) : <li>{offline ? "stops not cached" : "loading stops…"}</li>}
            </ul>
          )}
        </section>
        );
      })}

      <p className="status">{status}</p>
      </>
      )}
    </main>
  );
}
