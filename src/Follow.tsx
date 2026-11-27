// Follow a vehicle: pick one departure of an open line group and list its whole journey.
import { useEffect, useState } from 'react';
import {
  callStamp,
  hhmm,
  isOffline,
  lateMinutes,
  ojp,
  parseTripInfo,
  rememberDoc,
  splitTown,
  townHeadings,
  tripInfoBody,
  tripProgress,
  type Progress,
  type Stop,
  type TripCall,
} from './ojp.ts';
import { REFRESH_MS } from './RefreshBar.tsx';

export type FollowEnv = {
  active: boolean; // departures pane on screen: polling only then
  here: string; // place ref of the stop being shown
  onJump: (stop: Stop, from: HTMLElement) => void; // show another stop's departures
};

// A stop of a list: a button that jumps to the stop's departures, except for the stop being shown
// (or one without a ref, e.g. an old cached list).
export function StopLink({
  stop,
  env,
}: {
  stop: { ref?: string; name: string };
  env: FollowEnv;
}) {
  const { ref, name } = stop;
  if (!ref || ref === env.here) return <span>{splitTown(name).stop}</span>;
  return (
    <button
      className="stop-link tilt"
      aria-label={`Show departures for ${name}`}
      onClick={e => env.onJump({ ref, name }, e.currentTarget)}
    >
      <span>{splitTown(name).stop}</span>
    </button>
  );
}

export type Followable = { journey: string; day: string; planned: Date; cancelled: boolean };

type TripState = { calls: TripCall[] | null; status: string };

const liveStatus = (calls: TripCall[]) =>
  calls.some(c => c.arr?.live || c.dep?.live) ? `live · ${hhmm(new Date())}` : 'no live data';

// calls: null when there is nothing to show (the caller keeps what it has).
async function fetchTrip(journey: string, day: string): Promise<TripState> {
  try {
    const doc = await ojp(tripInfoBody(journey, day));
    const calls = parseTripInfo(doc);
    rememberDoc(doc);
    if (!calls.length) return { calls: null, status: 'no live data' };
    return { calls, status: liveStatus(calls) };
  } catch (err) {
    return { calls: null, status: isOffline(err) ? 'offline' : 'no live data' };
  }
}

// Journey calls, refreshed every 15 s while `active` and the page is visible. A failed refresh keeps
// the calls already shown and only changes the status.
function useTripInfo(journey: string, day: string, active: boolean): TripState {
  const [state, setState] = useState<TripState>({ calls: null, status: 'loading…' });
  useEffect(() => {
    if (!journey || !active) return;
    let alive = true;
    const run = async () => {
      if (document.hidden) return;
      const next = await fetchTrip(journey, day);
      if (alive) setState(s => ({ calls: next.calls ?? s.calls, status: next.status }));
    };
    const onVisible = () => void run();
    void run();
    const id = setInterval(run, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [journey, day, active]);
  return state;
}

// Which departure of a group to follow (first by default).
export function TripPicker({
  list,
  selected,
  onPick,
}: {
  list: Followable[];
  selected: string;
  onPick: (journey: string) => void;
}) {
  if (list.length < 2) return null;
  return (
    <div className="picks" role="group" aria-label="Choose vehicle">
      {list.map(d => (
        <button
          key={d.journey}
          className={d.cancelled ? 'pick tilt cancelled' : 'pick tilt'}
          aria-pressed={d.journey === selected}
          onClick={() => onPick(d.journey)}
        >
          {hhmm(d.planned)}
        </button>
      ))}
    </div>
  );
}

function positionText(p: Progress, calls: TripCall[]) {
  const name = splitTown(calls[p.index].name).stop;
  if (p.state === 'at') return `at ${name}`;
  if (p.state === 'arriving') return `arriving at ${name}`;
  return `between ${splitTown(calls[p.index - 1].name).stop} and ${name}`;
}

// First row shown: the earlier stops fold away, but never the vehicle's previous stop or this stop.
function firstShown(here: number, progress: Progress | null) {
  if (!progress) return Math.max(0, here);
  const at = progress.state === 'between' ? progress.index - 1 : progress.index;
  return Math.max(0, Math.min(here < 0 ? at : here, at));
}
console.assert(
  firstShown(5, null) === 5 &&
    firstShown(5, { index: 3, state: 'at' }) === 3 &&
    firstShown(2, { index: 4, state: 'between' }) === 2 &&
    firstShown(-1, { index: 4, state: 'between' }) === 3,
  'firstShown',
);

const foldLabel = (n: number) => (n === 1 ? '1 earlier stop' : `${n} earlier stops`);

// Muted uppercase town heading above the stops entering that town.
export const TownRow = ({ town }: { town: string }) => <li className="town">{town}</li>;

function TripRow({
  c,
  here,
  passed,
  env,
}: {
  c: TripCall;
  here: boolean;
  passed: boolean;
  env: FollowEnv;
}) {
  const stamp = callStamp(c);
  const late = lateMinutes(stamp) >= 1;
  const cls = [here && 'here', passed && 'passed'].filter(Boolean).join(' ');
  return (
    <li className={cls || undefined}>
      <span className={late ? 'at late' : 'at'}>{stamp ? hhmm(stamp.expected) : ''}</span>
      <StopLink stop={c} env={env} />
    </li>
  );
}

function TripList({
  calls,
  here,
  progress,
  env,
}: {
  calls: TripCall[];
  here: number;
  progress: Progress | null;
  env: FollowEnv;
}) {
  const [every, setEvery] = useState(false);
  const first = firstShown(here, progress);
  const from = every ? 0 : first;
  const shown = calls.slice(from);
  const towns = townHeadings(shown.map(c => c.name));
  return (
    <ol className="route">
      {first > 0 && (
        <li className="fold">
          <button
            className="stop-link tilt"
            aria-expanded={every}
            onClick={() => setEvery(!every)}
          >
            {every ? 'hide earlier stops' : foldLabel(first)}
          </button>
        </li>
      )}
      {shown.flatMap((c, k) => {
        const i = from + k;
        const items = [];
        if (towns[k]) items.push(<TownRow key={`town-${i}`} town={towns[k]} />);
        if (progress?.index === i)
          items.push(
            <li key={`pos-${i}`} className="pos" aria-current="true">
              {positionText(progress, calls)}
            </li>,
          );
        items.push(
          <TripRow
            key={`${c.ref}-${i}`}
            c={c}
            here={i === here}
            passed={!!progress && i < progress.index}
            env={env}
          />,
        );
        return items;
      })}
    </ol>
  );
}

// The picked departure's whole journey. Without it (offline, error, still loading) `fallback`
// (the cached onward stops) is shown under the status.
export function FollowTrip({
  dep,
  env,
  now,
  fallback,
}: {
  dep: Followable;
  env: FollowEnv;
  now: number;
  fallback: React.ReactNode;
}) {
  const { calls, status } = useTripInfo(dep.journey, dep.day, env.active);
  return (
    <>
      <p className="follow-status">{status}</p>
      {calls ? (
        <TripList
          calls={calls}
          here={calls.findIndex(c => c.ref === env.here)}
          progress={tripProgress(calls, now)}
          env={env}
        />
      ) : (
        fallback
      )}
    </>
  );
}
