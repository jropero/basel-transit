import { useState } from 'react';
import { ACCENTS, applyAccent, loadAccent, type AccentName } from './accent.ts';

export default function Settings() {
  const [accent, setAccent] = useState<AccentName>(loadAccent);
  return (
    <>
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
