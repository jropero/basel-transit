import { useEffect, useRef, useState } from 'react';
import { moveSaved, short, type Stop } from './ojp.ts';
import { applyTheme, loadTheme, THEMES, type Theme } from './theme.ts';
import { ACCENTS, applyAccent, loadAccent, type AccentName } from './accent.ts';

type Pending = { ref: string; delta: -1 | 1 };

// "saved stops": reorder the saved stops; the departures pivot follows this order.
function SavedOrder({ stops, onStops }: { stops: Stop[]; onStops: (next: Stop[]) => void }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pending = useRef<Pending | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    const same = buttons.current.get(`${p.ref}:${p.delta}`);
    const other = buttons.current.get(`${p.ref}:${-p.delta}`);
    (same && !same.disabled ? same : other)?.focus();
  }, [stops]);
  const move = (index: number, delta: -1 | 1) => {
    const next = moveSaved(stops, index, delta);
    if (next === stops) return;
    const { ref, name } = stops[index];
    pending.current = { ref, delta };
    setNote(`${short(name)}: position ${index + delta + 1} of ${stops.length}`);
    onStops(next);
  };
  const track = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(key, el);
    else buttons.current.delete(key);
  };
  return (
    <>
      <h2 className="title">saved stops</h2>
      {stops.length === 0 && <p className="saved-empty">no saved stops</p>}
      <ol className="saved-order">
        {stops.map((s, i) => (
          <li key={s.ref}>
            <span className="saved-name">{short(s.name)}</span>
            <button
              ref={track(`${s.ref}:-1`)}
              className="btn tilt"
              aria-label={`Move ${short(s.name)} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <span aria-hidden="true">↑</span>
            </button>
            <button
              ref={track(`${s.ref}:1`)}
              className="btn tilt"
              aria-label={`Move ${short(s.name)} down`}
              disabled={i === stops.length - 1}
              onClick={() => move(i, 1)}
            >
              <span aria-hidden="true">↓</span>
            </button>
          </li>
        ))}
      </ol>
      <span className="sr-only" aria-live="polite">
        {note}
      </span>
    </>
  );
}

export default function Settings({
  stops,
  onStops,
}: {
  stops: Stop[];
  onStops: (next: Stop[]) => void;
}) {
  const [accent, setAccent] = useState<AccentName>(loadAccent);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  return (
    <>
      <h2 className="title">theme</h2>
      <div className="themes">
        {THEMES.map(t => (
          <button
            key={t.name}
            className="btn"
            aria-pressed={theme === t.name}
            onClick={() => {
              setTheme(t.name);
              applyTheme(t.name);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <SavedOrder stops={stops} onStops={onStops} />
      <h2 className="title">accent colour</h2>
      <div className="swatches">
        {ACCENTS.map(a => (
          <button
            key={a.name}
            className="swatch tilt"
            style={{ '--swatch': a.hex } as React.CSSProperties}
            aria-pressed={accent === a.name}
            aria-label={a.name}
            onClick={() => {
              setAccent(a.name);
              applyAccent(a.name);
            }}
          />
        ))}
      </div>
      <h2 className="title">about</h2>
      <p className="about">
        Departures and routes from opentransportdata.swiss (OJP 2.0). Type: Selawik (SIL OFL).
        Icons: Fluent UI System Icons (MIT). Weather:{' '}
        <a href="https://open-meteo.com/" target="_blank" rel="noopener">
          Open-Meteo.com
        </a>{' '}
        (CC BY 4.0).
      </p>
    </>
  );
}
