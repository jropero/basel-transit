import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  access,
  all,
  envelope,
  escapeXml,
  flags,
  headway,
  headwayApplies,
  hhmm,
  knownCoords,
  loadJson,
  loadStops,
  nearbyStops,
  ojp,
  ojpCached,
  parseSituations,
  placeRef,
  rememberDoc,
  replacement,
  sampleLabel,
  saveJson,
  saveStops,
  searchStops,
  short,
  situationRefs,
  text,
  townHeadings,
  type Access,
  type Quay,
  type Situation,
  type Stop,
} from './ojp.ts';
import AccessMark, { Diverted, QuayMark } from './Access.tsx';
import Alerts, { AlertMark, relevantSituations } from './Alerts.tsx';
import AppBar, { type BarAction } from './AppBar.tsx';
import Settings from './Settings.tsx';
import Trail from './Trail.tsx';
import { useStopNav, type Nav } from './nav.ts';
import { FollowTrip, StopLink, TownRow, TripPicker, type FollowEnv } from './Follow.tsx';
import RefreshBar, { REFRESH_MS } from './RefreshBar.tsx';
import RoutePlanner from './Route.tsx';
import { InfoButton, StopInfo, useInfoToggle } from './StopInfo.tsx';
import { WeatherMark } from './Weather.tsx';

// `to` is the row label: the destination, or "from <origin>" on the arrivals board, where `dir`
// is the origin (groups are line + origin there, line + direction on departures).
export type Departure = {
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
  journey: string;
  day: string;
};

const departuresBody = (ref: string, onward = false, arrivals = false) =>
  envelope(`<OJPStopEventRequest>
      <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
      <Location><PlaceRef><StopPlaceRef>${escapeXml(ref)}</StopPlaceRef></PlaceRef></Location>
      <Params>
        <NumberOfResults>${onward ? 100 : 30}</NumberOfResults>
        <StopEventType>${arrivals ? 'arrival' : 'departure'}</StopEventType>${onward ? '\n        <IncludeOnwardCalls>true</IncludeOnwardCalls>' : ''}
        <IncludeRealtimeData>true</IncludeRealtimeData>
      </Params>
    </OJPStopEventRequest>`);

// "from <origin>" label of an arrival; the origin also groups them.
const fromLabel = (origin: string) => (origin ? `from ${origin}` : 'origin unknown');
console.assert(
  fromLabel('Basel, Bahnhof SBB') === 'from Basel, Bahnhof SBB' &&
    fromLabel('') === 'origin unknown',
  'fromLabel',
);

// Departures use ServiceDeparture of ThisCall, arrivals ServiceArrival (the stop's own times).
const parseDepartures = (doc: Document, arrivals = false): Departure[] =>
  all(doc, 'StopEvent').map(ev => {
    const here = all(ev, 'ThisCall')[0];
    const at = all(here, arrivals ? 'ServiceArrival' : 'ServiceDeparture')[0] ?? here;
    const planned = text(at, 'TimetabledTime');
    const origin = text(ev, 'OriginText');
    return {
      line: text(ev, 'PublishedServiceName'),
      dir: arrivals ? origin : text(ev, 'DirectionRef'),
      mode: text(ev, 'PtMode'),
      to: arrivals ? fromLabel(origin) : text(ev, 'DestinationText'),
      ...flags(ev, here),
      alerts: situationRefs(ev),
      planned: new Date(planned),
      expected: new Date(text(at, 'EstimatedTime') || planned),
      access: access(ev, here),
      replacement: replacement(here),
      journey: text(ev, 'JourneyRef'),
      day: text(ev, 'OperatingDayRef'),
    };
  });

if (typeof DOMParser !== 'undefined') {
  const ev = (call: string) =>
    new DOMParser().parseFromString(
      `<R xmlns="x"><StopEvent><ThisCall><CallAtStop>${call}</CallAtStop></ThisCall><Service><DirectionRef>R</DirectionRef>` +
        `<PublishedServiceName><Text>3</Text></PublishedServiceName><OriginText><Text>Birsfelden, Hard</Text></OriginText>` +
        `<DestinationText><Text>Basel, Bahnhof SBB</Text></DestinationText></Service></StopEvent></R>`,
      'application/xml',
    );
  const arr = parseDepartures(
    ev(
      '<ServiceArrival><TimetabledTime>2026-11-27T11:10:00Z</TimetabledTime><EstimatedTime>2026-11-27T11:11:00Z</EstimatedTime></ServiceArrival>',
    ),
    true,
  )[0];
  const dep = parseDepartures(
    ev(
      '<ServiceDeparture><TimetabledTime>2026-11-27T11:10:00Z</TimetabledTime></ServiceDeparture>',
    ),
  )[0];
  console.assert(
    arr.to === 'from Birsfelden, Hard' &&
      arr.dir === 'Birsfelden, Hard' &&
      arr.expected.getTime() - arr.planned.getTime() === 60_000 &&
      dep.to === 'Basel, Bahnhof SBB' &&
      dep.dir === 'R',
    'parseDepartures arrivals',
  );
}

const groupKey = (d: { line: string; dir: string }) => `${d.line}|${d.dir}`;

type OnwardGroup = {
  line: string;
  mode: string;
  to: string;
  stops: { name: string; min: number; ref?: string }[];
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
      return {
        name: text(c, 'StopPointName'),
        min: Math.round((t - base) / 60000),
        ref: placeRef(text(c, 'StopPointRef')),
      };
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
const onwardKey = (ref: string) => `basel-transit:onward3:${ref}`;

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

// Soonest actual departure first (delays included), timetabled time breaks ties.
const byExpected = (a: Departure, b: Departure) =>
  a.expected.getTime() - b.expected.getTime() || a.planned.getTime() - b.planned.getTime();
{
  const at = (h: number, m: number) => new Date(2026, 0, 1, h, m);
  const late = { planned: at(14, 58), expected: at(15, 19) } as Departure;
  const onTime = { planned: at(15, 9), expected: at(15, 9) } as Departure;
  console.assert([late, onTime].sort(byExpected)[0] === onTime, 'byExpected');
}

type SortMode = 'line' | 'time';
// Anything but 'time' (including a missing or foreign stored value) means 'line'.
const parseSort = (v: unknown): SortMode => (v === 'time' ? 'time' : 'line');

const TIME_ROWS_MAX = 30;

// "by time": every departure in one list by expected time, capped (cancelled ones included).
const timeOrdered = (deps: Departure[], max = TIME_ROWS_MAX) =>
  [...deps].sort(byExpected).slice(0, max);
{
  const mk = (t: number) => ({ expected: new Date(t), planned: new Date(t) }) as Departure;
  const out = timeOrdered([mk(3), mk(1), mk(2)], 2);
  console.assert(
    out.length === 2 && out[0].expected.getTime() === 1 && out[1].expected.getTime() === 2,
    'timeOrdered sorts by expected time and caps',
  );
  console.assert(
    parseSort('time') === 'time' && parseSort('x') === 'line' && parseSort(null) === 'line',
    'parseSort defaults to line',
  );
}

function groupByDirection(deps: Departure[]) {
  const groups = new Map<string, Departure[]>();
  for (const d of deps) {
    const key = groupKey(d);
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  for (const list of groups.values()) list.sort(byExpected);
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

function GroupBody({
  list,
  g,
  offline,
  now,
}: {
  list: Departure[];
  g: OnwardGroup | undefined;
  offline: boolean;
  now: number;
}) {
  const head = list[0] ?? g!;
  const every = everyLabel(offline, list, g, now);
  return (
    <>
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
    </>
  );
}

function OnwardStops({
  g,
  offline,
  env,
}: {
  g: OnwardGroup | undefined;
  offline: boolean;
  env: FollowEnv;
}) {
  if (!g) return <li>{offline ? 'stops not cached' : 'loading stops…'}</li>;
  const towns = townHeadings(g.stops.map(s => s.name));
  return g.stops.flatMap((s, i) => [
    ...(towns[i] ? [<TownRow key={`town-${i}`} town={towns[i]} />] : []),
    <li key={i}>
      <StopLink stop={s} env={env} />
      <span>· {s.min} min</span>
    </li>,
  ]);
}

// The open group: pick a departure and follow its journey; the cached onward stops stand in when
// the journey can't be fetched.
function OpenGroup({
  list,
  g,
  offline,
  now,
  env,
}: {
  list: Departure[];
  g: OnwardGroup | undefined;
  offline: boolean;
  now: number;
  env: FollowEnv;
}) {
  const [picked, setPicked] = useState('');
  const dep = list.find(d => d.journey === picked) ?? list[0];
  const onward = (
    <ul className="route">
      <OnwardStops g={g} offline={offline} env={env} />
    </ul>
  );
  if (!dep?.journey) return onward;
  return (
    <>
      <TripPicker list={list} selected={dep.journey} onPick={setPicked} />
      <FollowTrip key={dep.journey} dep={dep} env={env} now={now} fallback={onward} />
    </>
  );
}

// Without `onToggle` (by time) the group is a plain row: no stops to open.
function LineGroup({
  list,
  g,
  isOpen,
  offline,
  now,
  env,
  onToggle,
}: {
  list: Departure[];
  g: OnwardGroup | undefined;
  isOpen: boolean;
  offline: boolean;
  now: number;
  env?: FollowEnv;
  onToggle?: () => void;
}) {
  const body = <GroupBody list={list} g={g} offline={offline} now={now} />;
  return (
    <section>
      {onToggle ? (
        <button className="group tilt" aria-expanded={isOpen} onClick={onToggle}>
          {body}
        </button>
      ) : (
        <div className="group">{body}</div>
      )}
      {isOpen && env && <OpenGroup list={list} g={g} offline={offline} now={now} env={env} />}
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
            <li key={s.ref} className="tilt">
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

// App-icon badge: the number of active alerts at this stop (installed PWAs only; failures are fine).
function updateBadge(situations: Situation[], deps: Departure[]) {
  if (!('setAppBadge' in navigator)) return;
  const n = relevantSituations(
    situations,
    deps.flatMap(d => d.alerts),
  ).length;
  try {
    void (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => undefined);
  } catch {
    // Unsupported or not installed.
  }
}

async function fetchBoard(ref: string, arrivals: boolean) {
  const { doc, offlineSince } = await ojpCached(
    `${arrivals ? 'arrs' : 'deps'}:${ref}`,
    departuresBody(ref, false, arrivals),
  );
  return {
    doc,
    offlineSince,
    parsed: parseDepartures(doc, arrivals),
    sits: parseSituations(doc),
  };
}

// Departures for one stop: loads on stop change, refreshes 15s after each load and when back online.
function useDepartures(ref: string, active: boolean, arrivals: boolean) {
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
      const { doc, offlineSince, parsed, sits } = await fetchBoard(ref, arrivals);
      setDeps(parsed);
      setSituations(sits);
      updateBadge(sits, parsed);
      setOffline(offlineSince);
      setOnward(arrivals ? null : loadOnward(ref, offlineSince !== null));
      setStatus(
        offlineSince ? `offline · from ${hhmm(offlineSince)}` : `updated ${hhmm(new Date())}`,
      );
      if (!offlineSince) rememberDoc(doc);
      if (!offlineSince && !arrivals)
        prefetchMissing(ref, g => current.current === ref && setOnward(g));
    } catch (err) {
      setStatus(String(err));
    } finally {
      setLoading(false);
      setLoadedAt(Date.now());
    }
  }, [ref, arrivals]);

  // The other board's rows must not linger while this one loads.
  useEffect(() => {
    setDeps([]);
  }, [arrivals]);

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

const VIEWS = ['departures', 'route', 'settings'] as const;
type View = (typeof VIEWS)[number];

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// While exploring (two or more stops in the trail) the app bar leads with "back".
const backAction = (trail: unknown[]): BarAction[] =>
  trail.length < 2 ? [] : [{ icon: 'back', label: 'Back', onClick: () => history.back() }];

function StopsRow({
  stops,
  selected,
  onSelect,
}: {
  stops: Stop[];
  selected: Stop;
  onSelect: (s: Stop) => void;
}) {
  const row = stops.some(s => s.ref === selected.ref) ? stops : [...stops, selected];
  // Nothing to switch to: the title below already names the stop.
  if (row.length < 2) return null;
  return (
    <nav className="stops" aria-label="Saved stops">
      {row.map(s => (
        <button key={s.ref} aria-current={s.ref === selected.ref} onClick={() => onSelect(s)}>
          {short(s.name)}
        </button>
      ))}
    </nav>
  );
}

const SORT_KEY = 'basel-transit:sort';
const SORT_MODES: { id: SortMode; label: string }[] = [
  { id: 'line', label: 'by line' },
  { id: 'time', label: 'by time' },
];

// The by line / by time choice, kept across stops and reloads.
function useSortMode() {
  const [sort, setSort] = useState<SortMode>(() =>
    parseSort(loadJson<unknown>(SORT_KEY, null)),
  );
  const choose = (m: SortMode) => {
    setSort(m);
    saveJson(SORT_KEY, m);
  };
  return [sort, choose] as const;
}

type Board = 'departures' | 'arrivals';
const BOARDS: Board[] = ['departures', 'arrivals'];

// Departures or arrivals of the stop. Kept while browsing stops, not across reloads.
function BoardSwitch(p: { board: Board; onBoard: (b: Board) => void }) {
  return (
    <div className="board-mode" role="group" aria-label="Departures or arrivals">
      {BOARDS.map(b => (
        <button
          key={b}
          className="btn tilt"
          aria-pressed={p.board === b}
          onClick={() => p.onBoard(b)}
        >
          {b}
        </button>
      ))}
    </div>
  );
}

// Switch between grouping departures by line and one list by time.
function SortSwitch(p: { show: boolean; sort: SortMode; onSort: (m: SortMode) => void }) {
  if (!p.show) return null;
  return (
    <div className="board-mode" role="group" aria-label="List order">
      {SORT_MODES.map(m => (
        <button
          key={m.id}
          className="btn tilt"
          aria-pressed={p.sort === m.id}
          onClick={() => p.onSort(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// "by time": one single-departure row per departure, shown like a group of one.
function TimeRows({ deps, now }: { deps: Departure[]; now: number }) {
  return timeOrdered(deps).map(d => (
    <LineGroup
      key={`${d.line}|${d.dir}|${d.planned.getTime()}`}
      list={[d]}
      g={undefined}
      isOpen={false}
      offline={false}
      now={now}
    />
  ));
}

// Departures pane: owns search, onward stops and the 15s refresh (only while `active`).
function Departures({
  stops,
  nav,
  active,
  onSelect,
  onJump,
  onStops,
}: {
  stops: Stop[];
  nav: Nav;
  active: boolean;
  onSelect: (s: Stop) => void;
  onJump: (s: Stop, openLine?: string) => void;
  onStops: (next: Stop[]) => void;
}) {
  const selected = nav.stop;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<(Stop & { dist?: number })[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [board, setBoard] = useState<Board>('departures');
  const arrivals = board === 'arrivals';
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
  } = useDepartures(selected.ref, active, arrivals);

  // A new stop (picked, jumped to, or reached through system back) resets the open line (back
  // re-opens the one it was left with) and the onward stops; the load effect refetches.
  useEffect(() => {
    setOpen(nav.openLine ?? null);
    setOnward(null);
  }, [nav.stop.ref, nav.openLine, setOnward]);

  const selectStop = onSelect;

  // From a stop list: show that stop (not saved), start at the top of the pane.
  function jumpTo(s: Stop, from: HTMLElement) {
    from.closest('.pane')?.scrollTo({ top: 0 });
    onJump(s, open ?? undefined);
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
    if (arrivals || onward?.[key]) return;
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

  // Saved stops often lack coordinates: the known-stops directory (filled by every response,
  // including the departures one, hence `loadedAt`) has them.
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    const { lat, lon, ref } = selected;
    setCoords(lat && lon ? { lat, lon } : knownCoords(ref));
  }, [selected, loadedAt]);

  const [infoOpen, toggleInfo] = useInfoToggle(selected.ref);
  const infoId = useId();

  const now = useNow();
  const groups = visibleGroups(deps, offline !== null, arrivals ? null : onward, now);
  const [sort, setSort] = useSortMode();
  // Offline the cached list still holds departures that have left.
  const upcoming = offline !== null ? deps.filter(d => d.expected.getTime() > now) : deps;

  return (
    <>
      {active && <RefreshBar at={loadedAt} loading={loading} />}
      {active && (
        <AppBar
          actions={[
            ...backAction(nav.trail ?? []),
            { icon: 'refresh', label: 'Refresh', onClick: load },
            {
              icon: 'search',
              label: 'Search',
              expanded: showSearch,
              onClick: () => setShowSearch(!showSearch),
            },
            { icon: 'nearMe', label: 'Near me', onClick: nearMe },
          ]}
          menu={[
            {
              label: 'remove stop',
              disabled: !isSaved(selected) || stops.length <= 1,
              onClick: () => {
                const next = stops.filter(s => s.ref !== selected.ref);
                onStops(next);
                selectStop(next[0]);
              },
            },
          ]}
        />
      )}
      <StopsRow stops={stops} selected={selected} onSelect={selectStop} />
      <Trail trail={nav.trail ?? []} />
      <div className="title-row">
        <h2 className="title">
          {short(selected.name)}
          <InfoButton open={infoOpen} panelId={infoId} onToggle={toggleInfo} />
        </h2>
        <WeatherMark lat={coords?.lat} lon={coords?.lon} />
      </div>
      {infoOpen && (
        <StopInfo
          id={infoId}
          stop={selected}
          coords={coords}
          deps={loading && !deps.length ? null : deps}
          situations={situations}
          onJump={jumpTo}
        />
      )}

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
          onSave={s => onStops([...stops, { ref: s.ref, name: s.name }])}
        />
      )}

      <Alerts situations={situations} ids={deps.flatMap(d => d.alerts)} />

      <BoardSwitch
        board={board}
        onBoard={b => {
          setBoard(b);
          setOpen(null);
        }}
      />
      <SortSwitch show={deps.length > 0} sort={sort} onSort={setSort} />

      {sort === 'time' ? (
        <TimeRows deps={upcoming} now={now} />
      ) : (
        groups.map(([key, list]) => (
          <LineGroup
            key={key}
            list={list}
            g={onward?.[key]}
            isOpen={open === key}
            offline={offline !== null}
            now={now}
            env={{ active, here: selected.ref, onJump: jumpTo }}
            onToggle={() => toggle(key)}
          />
        ))
      )}

      <p className="status">{status}</p>
    </>
  );
}

type PivotState = { pivot: true; view: View };

const pivotState = (): PivotState | null => {
  const st = history.state as Partial<PivotState> | null;
  return st?.pivot ? (st as PivotState) : null;
};

// Keep at most one history entry for the pivot: leaving departures pushes it, moving between
// the other views replaces it, and returning to departures pops it.
function syncHistory(next: View) {
  const entry = pivotState();
  if (next === 'departures') {
    if (entry) history.back();
  } else if (entry) {
    history.replaceState({ pivot: true, view: next }, '');
  } else {
    history.pushState({ pivot: true, view: next }, '');
  }
}

// Swipe pivot state: native scroll-snap drives `view`; header taps scroll to the pane.
function usePivot() {
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const viewRef = useRef<View>('departures');
  const [view, setView] = useState<View>('departures');

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scroller.current;
      const next = el && VIEWS[Math.round(el.scrollLeft / el.clientWidth)];
      if (!next || next === viewRef.current) return;
      viewRef.current = next;
      syncHistory(next);
      setView(next);
    });
  };

  const goTo = (v: View) => {
    const el = scroller.current;
    el?.scrollTo({
      left: VIEWS.indexOf(v) * el.clientWidth,
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  };

  // System back (Android gesture, iOS swipe-back, browser button) returns to departures.
  useEffect(() => {
    const onPop = () => goTo(pivotState()?.view ?? 'departures');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return { scroller, view, onScroll, goTo };
}

// Big lowercase headers, looping like a Windows Phone pivot: the active one comes first,
// the rest follow in order and wrap around.
function PivotHeader({ view, onSelect }: { view: View; onSelect: (v: View) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const i = VIEWS.indexOf(view);
  const order = [...VIEWS.slice(i), ...VIEWS.slice(0, i)];

  // The row is rebuilt when the view changes; hand keyboard focus to the new first header.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    row.current?.querySelector('button')?.focus();
  }, [view]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    refocus.current = true;
    onSelect(VIEWS[(i + step + VIEWS.length) % VIEWS.length]);
  };

  return (
    <nav className="views" aria-label="Views">
      <div className="views-row" key={view} ref={row}>
        {order.map(v => (
          <button
            key={v}
            aria-current={view === v}
            onClick={() => onSelect(v)}
            onKeyDown={onKeyDown}
          >
            {v}
          </button>
        ))}
      </div>
    </nav>
  );
}

export default function App() {
  const [stops, setStops] = useState<Stop[]>(loadStops);
  const { nav, select, jump, toast } = useStopNav(stops[0]);
  const { scroller, view, onScroll, goTo } = usePivot();

  function updateStops(next: Stop[]) {
    setStops(next);
    saveStops(next);
  }

  // Turnstile plays once on first load (initial pane only); pivot changes just slide.
  const pane = (v: View, children: React.ReactNode) => (
    <section className="pane" aria-label={v} inert={view !== v}>
      <div className={v === 'departures' ? 'pane-in turn' : 'pane-in'}>{children}</div>
    </section>
  );

  return (
    <main className="app">
      <p className="brand">Basel Transit</p>
      <PivotHeader view={view} onSelect={goTo} />
      <div className="panes" ref={scroller} onScroll={onScroll}>
        {pane(
          'departures',
          <Departures
            stops={stops}
            nav={nav}
            active={view === 'departures'}
            onSelect={select}
            onJump={jump}
            onStops={updateStops}
          />,
        )}
        {pane('route', <RoutePlanner from={nav.stop} shown={view === 'route'} />)}
        {pane('settings', <Settings stops={stops} onStops={updateStops} />)}
      </div>
      <p className="toast" role="status" aria-live="polite">
        {toast && <span>Press back again to exit</span>}
      </p>
    </main>
  );
}
