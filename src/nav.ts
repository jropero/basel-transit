import { useEffect, useRef, useState } from 'react';
import type { Stop } from './ojp.ts';

// Stop navigation and the exit guard. A jump (a stop in an open line's list) pushes a history entry so system back
// walks the jumps; picking a saved stop only replaces the current entry.
// `trail` = the stops of the current exploration, from where the first jump started to `stop`;
// `openLine` = the line group that was open when the entry was left.
// Exit guard: a fresh load's stack is `{guard:true}` + the app entry; back onto the guard shows
// "Press back again to exit" for 2 s and re-arms, a second back within 2 s leaves the app.
export type Nav = { stop: Stop; trail?: Stop[]; openLine?: string };

const navOf = (st: unknown): Nav | null => {
  const s = st as Partial<Nav> | null;
  return s?.stop?.ref ? (s as Nav) : null;
};
const entry = (n: Nav) => ({ view: 'departures', ...n });
// The settings / route pivot entry sits on top of the app entry; stop navigation never writes there.
const onPivotEntry = () => !!(history.state as { pivot?: boolean } | null)?.pivot;
const onGuardEntry = () => !!(history.state as { guard?: boolean } | null)?.guard;
const TOAST_MS = 2000;
const write = (n: Nav, push: boolean) => {
  if (onPivotEntry()) return;
  if (push) history.pushState(entry(n), '');
  else history.replaceState(entry(n), '');
};

export function useStopNav(initial: Stop) {
  // A reload restores the entry's stop, trail and open line.
  const [nav, setNav] = useState<Nav>(() => navOf(history.state) ?? { stop: initial });

  const [toast, setToast] = useState(false);
  const navRef = useRef(nav);
  const toastTimer = useRef(0);
  useEffect(() => {
    navRef.current = nav;
  }, [nav]);

  // Chrome's history-manipulation intervention makes back skip entries that were added without
  // user activation, so a guard + app entry pushed on load would be skipped and back would close
  // the installed app. The guard is therefore armed on the first user activation (the current
  // entry becomes the guard, the app entry goes above it), and again after each toast. A reload
  // keeps the restored entries.
  const armed = useRef(!!navOf(history.state));
  useEffect(() => {
    const arm = () => {
      if (armed.current || onPivotEntry()) return;
      armed.current = true;
      if (!onGuardEntry()) history.replaceState({ guard: true }, '');
      history.pushState(entry(navRef.current), '');
    };
    const events = ['pointerdown', 'touchstart', 'keydown'];
    for (const e of events) window.addEventListener(e, arm, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, arm);
    };
  }, []);

  useEffect(() => {
    // Back reached the guard: the first time warn and stay on it, a second one within 2 s leaves.
    const exitGuard = () => {
      if (toastTimer.current) {
        clearTimeout(toastTimer.current);
        toastTimer.current = 0;
        setToast(false);
        history.back();
        return;
      }
      // Stay on the guard entry (a push here has no user activation); the next tap re-arms.
      armed.current = false;
      setToast(true);
      toastTimer.current = window.setTimeout(() => {
        toastTimer.current = 0;
        setToast(false);
      }, TOAST_MS);
    };
    const onPop = () => {
      if (onGuardEntry()) return exitGuard();
      const n = navOf(history.state);
      if (n) setNav(n);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      clearTimeout(toastTimer.current);
    };
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

  return { nav, select, jump, toast };
}
