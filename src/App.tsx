import { useCallback, useEffect, useRef, useState } from 'react';
import {
  access,
  all,
  envelope,
  escapeXml,
  flags,
  headway,
  headwayApplies,
  hhmm,
  loadJson,
  loadStops,
  nearbyStops,
  ojp,
  ojpCached,
  parseSituations,
  rememberDoc,
  replacement,
  sampleLabel,
  saveJson,
  saveStops,
  searchStops,
  short,
  situationRefs,
  text,
  type Access,
  type Quay,
  type Situation,
  type Stop,
} from './ojp.ts';
import AccessMark, { Diverted, QuayMark } from './Access.tsx';
import Alerts, { AlertMark } from './Alerts.tsx';
import RefreshBar, { REFRESH_MS } from './RefreshBar.tsx';
import RoutePlanner from './Route.tsx';

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
        <StopEventType>departure</StopEventType>${onward ? '\n        <IncludeOnwardCalls>true</IncludeOnwardCalls>' : ''}
        <IncludeRealtimeData>true</IncludeRealtimeData>
      </Params>
    </OJPStopEventRequest>`);

const parseDepartures = (doc: Document): Departure[] =>
  all(doc, 'StopEvent').map(ev => {
    const planned = text(ev, 'TimetabledTime');
    const here = all(ev, 'ThisCall')[0];
    return {
      line: text(ev, 'PublishedServiceName'),
      dir: text(ev, 'DirectionRef'),
      mode: text(ev, 'PtMode'),
      to: text(ev, 'DestinationText'),
      ...flags(ev, here),
      alerts: situationRefs(ev),
      planned: new Date(planned),
      expected: new Date(text(ev, 'EstimatedTime') || planned),
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
  for (const ev of all(doc, 'StopEvent')) {
    const line = text(ev, 'PublishedServiceName');
    const key = groupKey({ line, dir: text(ev, 'DirectionRef') });
    const base = new Date(text(all(ev, 'ThisCall')[0], 'TimetabledTime')).getTime();
    (times[key] ??= []).push(base);
    if (groups[key]) continue;
    const stops = all(ev, 'OnwardCall').map(c => {
      const t = new Date(text(all(c, 'ServiceDeparture')[0] ?? c, 'TimetabledTime')).getTime();
      return { name: text(c, 'StopPointName'), min: Math.round((t - base) / 60000) };
    });
    groups[key] = {
      line,
      mode: text(ev, 'PtMode'),
      to: text(ev, 'DestinationText'),
      stops,
      headway: null,
      measuredAt: base,
    };
  }
  for (const [key, ts] of Object.entries(times)) {
    groups[key].headway = headway(ts.map(t => t / 60000));
    groups[key].measuredAt = [...ts].sort((a, b) => a - b)[ts.length >> 1];
  }
  return groups;
}

const ONWARD_TTL = 7 * 24 * 60 * 60 * 1000;
const onwardKey = (ref: string) => `basel-transit:onward2:${ref}`;

// Offline, stale beats nothing: the TTL is ignored.
function loadOnward(ref: string, offline: boolean): Record<string, OnwardGroup> | null {
  const c = loadJson<{ at: number; groups: Record<string, OnwardGroup> } | null>(
    onwardKey(ref),
    null,
  );
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

// Prefetch the onward stops unless a usable copy is cached; the callback gets them when they arrive.
function prefetchMissing(ref: string, onLoaded: (g: Record<string, OnwardGroup>) => void) {
  if (loadOnward(ref, false)) return;
  void prefetchOnward(ref).then(g => g && onLoaded(g));
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

function everyLabel(
  offline: boolean,
  list: Departure[],
  g: OnwardGroup | undefined,
  now: number,
) {
  if (offline) {
    if (!g?.headway || !headwayApplies(new Date(g.measuredAt), new Date(now))) return null;
    return `usually every ~${g.headway} min (as of ${sampleLabel(new Date(g.measuredAt))})`;
  }
  const h =
    headway(list.filter(d => !d.cancelled).map(d => d.planned.getTime() / 60000)) ?? g?.headway;
  return h ? `every ~${h} min` : null;
}

// Wall clock for countdowns, ticking independently of the 15s data refresh.
function useNow(tickMs = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

function DepartureRow({ d, firstTo, now }: { d: Departure; firstTo: string; now: number }) {
  const delay = Math.round((d.expected.getTime() - d.planned.getTime()) / 60000);
  const left = Math.max(0, Math.floor((d.expected.getTime() - now) / 60000));
  return (
    <span className={d.cancelled ? 'dep cancelled' : 'dep'}>
      <span className="time">{hhmm(d.planned)}</span>
      <AccessMark level={d.access} replacement={d.replacement} />
      {delay > 0 && !d.cancelled && <span className="late">+{delay}'</span>}
      <Diverted on={d.deviation} />
      <span className="via">{d.to !== firstTo ? d.to : <QuayMark quay={d.quay} />}</span>
      {d.cancelled ? (
        <span className="tag bad">cancelled</span>
      ) : (
        <span className="left">{left === 0 ? 'now' : `${left} min`}</span>
      )}
    </span>
  );
}

function LineGroup({
  list,
  g,
  isOpen,
  offline,
  now,
  onToggle,
}: {
  list: Departure[];
  g: OnwardGroup | undefined;
  isOpen: boolean;
  offline: boolean;
  now: number;
  onToggle: () => void;
}) {
  const head = list[0] ?? g!;
  const every = everyLabel(offline, list, g, now);
  return (
    <section>
      <button className="group" aria-expanded={isOpen} onClick={onToggle}>
        <span className={`tile ${head.mode}`}>
          <b>{head.line}</b>
          <small>{head.mode}</small>
        </span>
        <span className="deps">
          <span className="dest">
            {head.to}
            <AlertMark on={list.some(d => d.alerts.length > 0)} />
          </span>
          {every && <span className="headway">{every}</span>}
          {list.length === 0 && <span className="headway">no cached departures</span>}
          {list.map((d, i) => (
            <DepartureRow key={i} d={d} firstTo={list[0].to} now={now} />
          ))}
        </span>
      </button>
      {isOpen && (
        <ul className="route">
          {g ? (
            g.stops.map((s, i) => (
              <li key={i}>
                {s.name} · {s.min} min
              </li>
            ))
          ) : (
            <li>{offline ? 'stops not cached' : 'loading stops…'}</li>
          )}
        </ul>
      )}
    </section>
  );
}

function nearbyStatus(count: number, offline: boolean) {
  const pre = offline ? 'offline · ' : '';
  return count ? `${pre}${count} stops nearby` : `${pre}no stops within 1 km`;
}

// Offline the cached list still holds departures that have left: hide them, and keep lines with none left.
function visibleGroups(
  deps: Departure[],
  offline: boolean,
  onward: Record<string, OnwardGroup> | null,
  now: number,
) {
  const live = offline ? deps.filter(d => d.expected.getTime() > now) : deps;
  const grouped = new Map(groupByDirection(live));
  const keep = offline ? Object.keys(onward ?? {}) : [];
  for (const k of keep) if (!grouped.has(k)) grouped.set(k, []);
  return [...grouped.entries()].sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function SearchPanel({
  query,
  onQuery,
  onSubmit,
  results,
  isSaved,
  onShow,
  onSave,
}: {
  query: string;
  onQuery: (q: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  results: (Stop & { dist?: number })[];
  isSaved: (s: Stop) => boolean;
  onShow: (s: Stop) => void;
  onSave: (s: Stop) => void;
}) {
  return (
    <>
      <form onSubmit={onSubmit} className="search">
        <input
          type="text"
          aria-label="Stop name"
          placeholder="stop name"
          value={query}
          onChange={e => onQuery(e.target.value)}
        />
        <button type="submit" className="btn">
          go
        </button>
      </form>
      {results.length > 0 && (
        <ul className="results">
          {results.map(s => (
            <li key={s.ref}>
              <span>
                {s.name}
                {s.dist !== undefined && <span className="dist"> {s.dist} m</span>}
              </span>
              <button className="btn" onClick={() => onShow(s)}>
                show
              </button>
              <button className="btn" disabled={isSaved(s)} onClick={() => onSave(s)}>
                save
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// Departures for one stop: loads on stop change, refreshes 15s after each load and when back online.
function useDepartures(ref: string, active: boolean) {
  const [deps, setDeps] = useState<Departure[]>([]);
  const [status, setStatus] = useState('Loading…');
  const [onward, setOnward] = useState<Record<string, OnwardGroup> | null>(null);
  const [situations, setSituations] = useState<Situation[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState<Date | null>(null);
  const current = useRef(ref);
  useEffect(() => {
    current.current = ref;
  }, [ref]);

  const load = useCallback(async () => {
    setStatus('Loading…');
    setLoading(true);
    try {
      const { doc, offlineSince } = await ojpCached(`deps:${ref}`, departuresBody(ref));
      setDeps(parseDepartures(doc));
      setSituations(parseSituations(doc));
      setOffline(offlineSince);
      setOnward(loadOnward(ref, offlineSince !== null));
      setStatus(
        offlineSince ? `offline · from ${hhmm(offlineSince)}` : `updated ${hhmm(new Date())}`,
      );
      if (!offlineSince) {
        rememberDoc(doc);
        prefetchMissing(ref, g => current.current === ref && setOnward(g));
      }
    } catch (err) {
      setStatus(String(err));
    } finally {
      setLoading(false);
      setLoadedAt(Date.now());
    }
  }, [ref]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh 15s after the last load (manual or automatic) so the top-edge bar never drifts;
  // in the background just re-arm the timer.
  useEffect(() => {
    if (!active || loadedAt === null) return;
    const id = setTimeout(
      () => (document.hidden ? setLoadedAt(Date.now()) : void load()),
      REFRESH_MS,
    );
    return () => clearTimeout(id);
  }, [loadedAt, active, load]);

  // Back online: refresh immediately instead of waiting for the next tick.
  useEffect(() => {
    if (!active) return;
    const on = () => void load();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [active, load]);

  return {
    deps,
    status,
    setStatus,
    current,
    onward,
    setOnward,
    situations,
    loadedAt,
    loading,
    offline,
    load,
  };
}

export default function App() {
  const [stops, setStops] = useState<Stop[]>(loadStops);
  const [selected, setSelected] = useState<Stop>(stops[0]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<(Stop & { dist?: number })[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [view, setView] = useState<'departures' | 'route'>('departures');
  const {
    deps,
    status,
    setStatus,
    current,
    onward,
    setOnward,
    situations,
    loadedAt,
    loading,
    offline,
    load,
  } = useDepartures(selected.ref, view === 'departures');

  function updateStops(next: Stop[]) {
    setStops(next);
    saveStops(next);
  }

  // Switching stops resets the open line and its onward stops; the load effect refetches.
  function selectStop(s: Stop) {
    setSelected(s);
    if (s.ref === selected.ref) return;
    setOpen(null);
    setOnward(null);
  }

  async function nearMe() {
    setStatus('locating…');
    try {
      const { stops, offline } = await nearbyStops();
      setResults(stops);
      setShowSearch(true);
      setStatus(nearbyStatus(stops.length, offline));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggle(key: string) {
    if (open === key) return setOpen(null);
    setOpen(key);
    if (onward?.[key]) return;
    const ref = selected.ref;
    try {
      const fresh = await fetchOnward(ref);
      if (current.current === ref) setOnward(fresh);
      if (!fresh[key]) setStatus('no stop list for this line');
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      const { stops, status: note } = await searchStops(query);
      setResults(stops);
      if (note) setStatus(note);
    } catch (err) {
      setStatus(String(err));
    }
  }

  const isSaved = (s: Stop) => stops.some(x => x.ref === s.ref);

  const now = useNow();
  const groups = visibleGroups(deps, offline !== null, onward, now);

  const pivot = isSaved(selected) ? stops : [...stops, selected];

  return (
    <main className="app">
      <p className="brand">Basel Transit</p>
      <nav className="views">
        {(['departures', 'route'] as const).map(v => (
          <button key={v} aria-current={view === v} onClick={() => setView(v)}>
            {v}
          </button>
        ))}
      </nav>

      {view === 'route' ? (
        <RoutePlanner from={selected} />
      ) : (
        <>
          <RefreshBar at={loadedAt} loading={loading} />
          <nav className="pivot">
            {pivot.map(s => (
              <button
                key={s.ref}
                aria-current={s.ref === selected.ref}
                onClick={() => selectStop(s)}
              >
                {short(s.name)}
              </button>
            ))}
          </nav>

          <div className="appbar">
            <button onClick={load} aria-label="Refresh">
              ↻ refresh
            </button>
            <button
              aria-label="Remove stop"
              disabled={!isSaved(selected) || stops.length <= 1}
              onClick={() => {
                const next = stops.filter(s => s.ref !== selected.ref);
                updateStops(next);
                selectStop(next[0]);
              }}
            >
              ✕ remove
            </button>
            <button aria-expanded={showSearch} onClick={() => setShowSearch(!showSearch)}>
              ⌕ search
            </button>
            <button onClick={nearMe}>◎ near me</button>
          </div>

          {showSearch && (
            <SearchPanel
              query={query}
              onQuery={setQuery}
              onSubmit={search}
              results={results}
              isSaved={isSaved}
              onShow={s => {
                selectStop(s);
                setResults([]);
                setShowSearch(false);
              }}
              onSave={s => updateStops([...stops, { ref: s.ref, name: s.name }])}
            />
          )}

          <Alerts situations={situations} ids={deps.flatMap(d => d.alerts)} />

          {groups.map(([key, list]) => (
            <LineGroup
              key={key}
              list={list}
              g={onward?.[key]}
              isOpen={open === key}
              offline={offline !== null}
              now={now}
              onToggle={() => toggle(key)}
            />
          ))}

          <p className="status">{status}</p>
        </>
      )}
    </main>
  );
}
