import { useEffect, useState } from 'react';
import type { Stop } from './ojp.ts';

// Stop navigation: a jump (a stop in an open line's list) pushes a history entry so system back
// walks the jumps; picking a saved stop only replaces the current entry.
// `trail` = the stops of the current exploration, from where the first jump started to `stop`;
// `openLine` = the line group that was open when the entry was left.
export type Nav = { stop: Stop; trail?: Stop[]; openLine?: string };

const navOf = (st: unknown): Nav | null => {
  const s = st as Partial<Nav> | null;
  return s?.stop?.ref ? (s as Nav) : null;
};
const entry = (n: Nav) => ({ view: 'departures', ...n });
// The settings / route pivot entry sits on top of the app entry; stop navigation never writes there.
const onPivotEntry = () => !!(history.state as { pivot?: boolean } | null)?.pivot;
const write = (n: Nav, push: boolean) => {
  if (onPivotEntry()) return;
  if (push) history.pushState(entry(n), '');
  else history.replaceState(entry(n), '');
};

export function useStopNav(initial: Stop) {
  // A reload restores the entry's stop, trail and open line.
  const [nav, setNav] = useState<Nav>(() => navOf(history.state) ?? { stop: initial });

  useEffect(() => {
    const onPop = () => {
      const n = navOf(history.state);
      if (n) setNav(n);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Picking a saved stop ends the exploration: no trail.
  const select = (stop: Stop) => {
    const n = { stop };
    setNav(n);
    write(n, false);
  };

  const jump = (stop: Stop, openLine?: string) => {
    if (stop.ref === nav.stop.ref) return;
    const pivot = onPivotEntry();
    const n: Nav = pivot ? { stop } : { stop, trail: [...(nav.trail ?? [nav.stop]), stop] };
    if (!pivot) write({ ...nav, openLine }, false);
    setNav(n);
    write(n, true);
  };

  return { nav, select, jump };
}
