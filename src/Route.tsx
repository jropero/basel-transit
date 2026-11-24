import { useEffect, useState } from "react";
import {
  hhmm,
  loadRoutes,
  loadStops,
  ojp,
  parseStops,
  parseTrips,
  saveRoutes,
  searchBody,
  short,
  tripBody,
  type Route,
  type Stop,
  type Trip,
} from "./ojp.ts";

type Field = "from" | "to";

export default function RoutePlanner({ from: initialFrom }: { from: Stop }) {
  const saved = loadStops();
  const [ends, setEnds] = useState<Record<Field, Stop | null>>({ from: initialFrom, to: null });
  const [routes, setRoutes] = useState<Route[]>(loadRoutes);
  const [searching, setSearching] = useState<Field | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Stop[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [active, setActive] = useState<Route | null>(null);
  const [status, setStatus] = useState("");

  async function plan(from: Stop | null, to: Stop | null) {
    if (!from || !to) return;
    setActive({ from, to });
    setStatus("planning…");
    try {
      const found = parseTrips(await ojp(tripBody(from, to)));
      setTrips(found);
      setStatus(found.length ? `updated ${hhmm(new Date())}` : "no connections found");
    } catch (err) {
      setStatus(String(err));
    }
  }

  // Auto-refresh the last planned route every 30s while this view is mounted and visible.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (!document.hidden) void plan(active.from, active.to);
    }, 30_000);
    return () => clearInterval(id);
  }, [active?.from.ref, active?.to.ref]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      setResults(parseStops(await ojp(searchBody(query))));
    } catch (err) {
      setStatus(String(err));
    }
  }

  function pick(field: Field, stop: Stop) {
    setEnds((e) => ({ ...e, [field]: stop }));
    setSearching(null);
    setResults([]);
    setQuery("");
  }

  function updateRoutes(next: Route[]) {
    setRoutes(next);
    saveRoutes(next);
  }

  const same = (r: Route) => r.from.ref === ends.from?.ref && r.to.ref === ends.to?.ref;
  const label = (r: Route) => `${short(r.from.name)} → ${short(r.to.name)}`;

  return (
    <>
      {routes.length > 0 && (
        <ul className="results">
          {routes.map((r) => (
            <li key={label(r)}>
              <button
                className="saved-route"
                onClick={() => {
                  setEnds({ from: r.from, to: r.to });
                  plan(r.from, r.to);
                }}
              >
                {label(r)}
              </button>
              <button className="btn" aria-label={`Delete ${label(r)}`} onClick={() => updateRoutes(routes.filter((x) => x !== r))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {(["from", "to"] as const).map((field) => {
        const current = ends[field];
        const chips = current && !saved.some((s) => s.ref === current.ref) ? [...saved, current] : saved;
        return (
          <div key={field} className="field">
            <span className="field-label">{field}</span>
            <nav className="chips">
              {chips.map((s) => (
                <button key={s.ref} aria-current={s.ref === current?.ref} onClick={() => pick(field, s)}>
                  {short(s.name)}
                </button>
              ))}
              <button aria-expanded={searching === field} onClick={() => setSearching(searching === field ? null : field)}>
                ⌕
              </button>
            </nav>
            {searching === field && (
              <>
                <form onSubmit={search} className="search">
                  <input
                    type="text"
                    aria-label={`${field} stop name`}
                    placeholder="stop name"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button type="submit" className="btn">find</button>
                </form>
                {results.length > 0 && (
                  <ul className="results">
                    {results.map((s) => (
                      <li key={s.ref}>
                        <span>{s.name}</span>
                        <button className="btn" onClick={() => pick(field, s)}>pick</button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        );
      })}

      <div className="appbar">
        <button disabled={!ends.from || !ends.to} onClick={() => plan(ends.from, ends.to)}>→ go</button>
        <button aria-label="Swap from and to" onClick={() => setEnds({ from: ends.to, to: ends.from })}>⇅ swap</button>
        <button
          disabled={!ends.from || !ends.to || routes.some(same)}
          onClick={() => updateRoutes([...routes, { from: ends.from!, to: ends.to! }])}
        >
          ★ save route
        </button>
      </div>

      {trips.map((t, i) => (
        <section key={i} className="trip">
          <p className="trip-head">
            {hhmm(t.start)} → {hhmm(t.end)}
            <span>
              {" "}· {t.minutes} min · {t.transfers === 0 ? "direct" : `${t.transfers} change${t.transfers > 1 ? "s" : ""}`}
            </span>
          </p>
          {t.legs.map((l, j) =>
            l.kind === "walk" ? (
              <p key={j} className="leg walk">walk {l.minutes} min</p>
            ) : (
              <div key={j} className="leg">
                <span className={`tile sm ${l.mode}`}>
                  <b>{l.line}</b>
                </span>
                <span>
                  {short(l.from)} <strong>{hhmm(l.fromTime)}</strong>
                  {l.delay > 0 && <span className="late"> +{l.delay}'</span>}
                  {l.quay && ` · quay ${l.quay}`}
                  <br />→ {short(l.alight)} {hhmm(l.alightTime)}
                </span>
              </div>
            ),
          )}
        </section>
      ))}

      {status && <p className="status">{status}</p>}
    </>
  );
}
