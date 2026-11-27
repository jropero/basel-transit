import { useEffect, useRef } from 'react';
import { short, type Stop } from './ojp.ts';

// Breadcrumbs of a stop exploration: earlier stops go back through history (so system back
// stays consistent), the last one is the current stop.
export default function Trail({ trail }: { trail: Stop[] }) {
  const current = useRef<HTMLSpanElement>(null);
  const count = trail.length;
  useEffect(() => {
    current.current?.scrollIntoView({ inline: 'end', block: 'nearest' });
  }, [count]);
  if (count < 2) return null;
  return (
    <nav className="stops trail" aria-label="Trail">
      {trail.map((s, i) => {
        const last = i === count - 1;
        return (
          <span key={`${s.ref}-${i}`} className="crumb">
            {last ? (
              <span ref={current} aria-current="true">
                {short(s.name)}
              </span>
            ) : (
              <>
                <button
                  className="tilt"
                  aria-label={`Back to ${short(s.name)}`}
                  onClick={() => history.go(i - (count - 1))}
                >
                  {short(s.name)}
                </button>
                <span aria-hidden="true">›</span>
              </>
            )}
          </span>
        );
      })}
    </nav>
  );
}
