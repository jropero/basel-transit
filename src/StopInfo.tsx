// Stop info panel: facts, a "show on map" link, the lines on the board, alerts and nearby stops.
import { useEffect, useState } from 'react';
import { AlertMark, relevantSituations } from './Alerts.tsx';
import type { Departure } from './App.tsx';
import { Icon } from './icons.tsx';
import {
  fetchNearby,
  headway,
  short,
  sloidNumber,
  splitTown,
  type Access,
  type NearbyStop,
  type Situation,
  type Stop,
} from './ojp.ts';

type Coords = { lat: number; lon: number };

// Open state of the info panel; closes when another stop is selected.
export function useInfoToggle(ref: string) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [ref]);
  return [open, () => setOpen(o => !o)] as const;
}

export function InfoButton({
  open,
  panelId,
  onToggle,
}: {
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <button
      className="info-btn"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label="Stop info"
      onClick={onToggle}
    >
      <Icon name="info" size={22} />
    </button>
  );
}

export const osmUrl = (c: Coords) =>
  `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=18/${c.lat}/${c.lon}`;
console.assert(
  osmUrl({ lat: 47.5, lon: 7.6 }) ===
    'https://www.openstreetmap.org/?mlat=47.5&mlon=7.6#map=18/47.5/7.6',
  'osmUrl',
);

const unique = <T extends string>(xs: (T | undefined)[]) => [
  ...new Set(xs.filter((x): x is T => !!x)),
];

// "step-free" / "with assistance" / "not step-free" when every known flag agrees, "partly
// step-free" when they differ, '' when no departure says.
export function accessSummary(levels: Access[]): string {
  const known = unique(levels.filter((l): l is NonNullable<Access> => l !== null));
  if (!known.length) return '';
  if (known.length > 1) return 'partly step-free';
  const labels = {
    'step-free': 'step-free',
    assisted: 'with assistance',
    none: 'not step-free',
  };
  return labels[known[0]];
}

export const platformsOf = (deps: Departure[]) =>
  unique(deps.map(d => d.quay.planned)).sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );

const platformText = (quays: string[]) => {
  if (!quays.length) return '';
  return `${quays.length > 1 ? 'platforms' : 'platform'} ${quays.join(', ')}`;
};

export type LineRow = {
  key: string;
  line: string;
  mode: string;
  to: string[];
  quays: string[];
  every: number | null;
  alert: boolean;
};

// "to Birsfelden" on departures; arrival labels already read "from <origin>".
const toLabel = (to: string) => (to.startsWith('from ') ? to : `to ${to}`);

const rowOf = (key: string, list: Departure[]): LineRow => ({
  key,
  line: list[0].line,
  mode: list[0].mode,
  to: unique(list.map(d => d.to)).map(toLabel),
  quays: platformsOf(list),
  every: headway(list.filter(d => !d.cancelled).map(d => d.planned.getTime() / 60000)),
  alert: list.some(d => d.alerts.length > 0),
});

// One row per line + direction, in board order (the same grouping as the board).
export function lineRows(deps: Departure[]): LineRow[] {
  const groups = new Map<string, Departure[]>();
  for (const d of deps) {
    const key = `${d.line}|${d.dir}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups].map(([key, list]) => rowOf(key, list));
}

const rowText = (r: LineRow) =>
  [r.to.join(', '), platformText(r.quays), r.every ? `every ~${r.every} min` : '']
    .filter(Boolean)
    .join(' · ');

if (typeof Date !== 'undefined') {
  const dep = (line: string, dir: string, to: string, quay: string, min: number) =>
    ({
      line,
      dir,
      to,
      mode: 'tram',
      quay: { planned: quay, actual: quay },
      cancelled: false,
      alerts: [],
      planned: new Date(min * 60000),
    }) as unknown as Departure;
  const rows = lineRows([
    dep('3', 'a', 'Birsfelden', 'D', 0),
    dep('3', 'a', 'Birsfelden', 'D', 10),
    dep('3', 'a', 'Birsfelden', 'D', 20),
    dep('3', 'b', 'Burgfelderhof', 'A', 5),
  ]);
  console.assert(
    rows.length === 2 &&
      rowText(rows[0]) === 'to Birsfelden · platform D · every ~10 min' &&
      rowText(rows[1]) === 'to Burgfelderhof · platform A' &&
      platformsOf([dep('3', 'a', 'x', 'D', 0), dep('3', 'b', 'x', 'A', 0)]).join() === 'A,D' &&
      toLabel('from Riehen') === 'from Riehen' &&
      accessSummary(['step-free', null]) === 'step-free' &&
      accessSummary(['step-free', 'none']) === 'partly step-free' &&
      accessSummary(['assisted']) === 'with assistance' &&
      accessSummary(['none']) === 'not step-free' &&
      accessSummary([null]) === '',
    'lineRows / accessSummary',
  );
}

type Fact = [string, string];

export const factsOf = (stop: Stop, coords: Coords | null, deps: Departure[]): Fact[] => [
  ['town', splitTown(stop.name).town],
  ['code', sloidNumber(stop.ref)],
  ['modes', unique(deps.map(d => d.mode)).join(', ')],
  ['access', accessSummary(deps.map(d => d.access))],
  ['platforms', platformsOf(deps).join(', ')],
  ['coordinates', coords ? `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}` : ''],
];
console.assert(
  factsOf(
    { ref: 'ch:1:sloid:89303', name: 'Basel, Burgfelderplatz' },
    { lat: 47.5, lon: 7.6 },
    [],
  )
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('|') === 'town=Basel|code=89303|coordinates=47.50000, 7.60000',
  'factsOf',
);

function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="facts">
      {facts
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function Lines({ deps }: { deps: Departure[] | null }) {
  if (!deps) return <p className="status">loading…</p>;
  const rows = lineRows(deps);
  if (!rows.length) return <p className="status">no departures</p>;
  return (
    <ul className="svc-list">
      {rows.map(r => (
        <li key={r.key}>
          <span className={`tile mini ${r.mode}${r.line.length > 3 ? ' long' : ''}`}>
            <b>{r.line}</b>
          </span>
          <span>
            {rowText(r)} <AlertMark on={r.alert} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// Summaries of the alerts the board points at.
function StopAlerts({ situations, deps }: { situations: Situation[]; deps: Departure[] }) {
  const shown = relevantSituations(
    situations,
    deps.flatMap(d => d.alerts),
  );
  if (!shown.length) return null;
  return (
    <>
      <h3>alerts</h3>
      <ul className="svc-list">
        {shown.map(s => (
          <li key={s.id[0]}>
            <span>{s.summary}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

// Stops within ~300 m, fetched only while the panel is open; a failure hides the section.
function useNearby(stop: Stop, coords: Coords | null) {
  const [near, setNear] = useState<{ ref: string; list: NearbyStop[] } | null>(null);
  const { lat, lon } = coords ?? {};
  useEffect(() => {
    if (lat === undefined || lon === undefined) return;
    let current = true;
    fetchNearby({ ref: stop.ref, name: stop.name, lat, lon }).then(
      list => current && setNear({ ref: stop.ref, list }),
      () => current && setNear({ ref: stop.ref, list: [] }),
    );
    return () => {
      current = false;
    };
  }, [stop.ref, stop.name, lat, lon]);
  return near?.ref === stop.ref ? near.list : [];
}

function Nearby({
  list,
  onJump,
}: {
  list: NearbyStop[];
  onJump: (s: Stop, from: HTMLElement) => void;
}) {
  if (!list.length) return null;
  return (
    <>
      <h3>nearby</h3>
      <ul className="near">
        {list.map(s => (
          <li key={s.ref}>
            <button
              className="link"
              aria-label={`Show departures for ${s.name}`}
              onClick={e => onJump({ ref: s.ref, name: s.name }, e.currentTarget)}
            >
              <span className="name">{short(s.name)}</span>
              <span className="sub">
                {[s.modes.join(', '), `${s.dist} m`].filter(Boolean).join(' · ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function StopInfo({
  id,
  stop,
  coords,
  deps,
  situations,
  onJump,
}: {
  id: string;
  stop: Stop;
  coords: Coords | null;
  deps: Departure[] | null;
  situations: Situation[];
  onJump: (s: Stop, from: HTMLElement) => void;
}) {
  const near = useNearby(stop, coords);
  return (
    <section className="info" id={id} aria-label="Stop info">
      <Facts facts={factsOf(stop, coords, deps ?? [])} />
      <p>
        {coords ? (
          <a href={osmUrl(coords)} target="_blank" rel="noopener">
            show on map
          </a>
        ) : (
          <span className="status">no coordinates yet</span>
        )}
      </p>
      <h3>lines</h3>
      <Lines deps={deps} />
      <StopAlerts situations={situations} deps={deps ?? []} />
      <Nearby list={near} onJump={onJump} />
    </section>
  );
}
