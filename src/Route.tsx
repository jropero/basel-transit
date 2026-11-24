import { Fragment, useEffect, useState } from "react";
import AccessMark, { Diverted, QuayMark } from "./Access.tsx";
import Alerts, { AlertMark } from "./Alerts.tsx";
import RefreshBar, { REFRESH_MS } from "./RefreshBar.tsx";
import {
  hhmm,
  isOffline,
  knownSearch,
  loadRoutes,
  loadStops,
  ojp,
  ojpCached,
  parseSituations,
  parseStops,
  parseTrips,
  rememberDoc,
  rememberPlaces,
  saveRoutes,
  searchBody,
  short,
  tripBody,
  type Route,
  type Situation,
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
  const [situations, setSituations] = useState<Situation[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [openLeg, setOpenLeg] = useState<string | null>(null);

  async function plan(from: Stop | null, to: Stop | null) {
    if (!from || !to) return;
    setActive({ from, to });
    setStatus("planning…");
    setLoading(true);
    try {
      const { doc, offlineSince } = await ojpCached(`trip:${from.ref}>${to.ref}`, tripBody(from, to));
      rememberDoc(doc);
      let found = parseTrips(doc);
      // Offline the cached connections include ones that have already left.
      if (offlineSince) found = found.filter((t) => t.start.getTime() > Date.now());
      setTrips(found);
      setSituations(parseSituations(doc));
      setStatus(
        offlineSince
          ? found.length ? `offline · from ${hhmm(offlineSince)}` : "offline · no cached connections left"
          : found.length ? `updated ${hhmm(new Date())}` : "no connections found",
      );
    } catch (err) {
      setStatus(String(err));
    } finally {
      setLoading(false);
      setLoadedAt(Date.now());
    }
  }

  // Re-plan 30s after the last load (manual or automatic); in the background just re-arm the timer.
  useEffect(() => {
    if (!active || loadedAt === null) return;
    const id = setTimeout(() => (document.hidden ? setLoadedAt(Date.now()) : void plan(active.from, active.to)), REFRESH_MS);
    return () => clearTimeout(id);
  }, [loadedAt, active?.from.ref, active?.to.ref]);

  // Back online: re-plan immediately instead of waiting for the next 30s tick.
  useEffect(() => {
    if (!active) return;
    const on = () => void plan(active.from, active.to);
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [active?.from.ref, active?.to.ref]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      const found = parseStops(await ojp(searchBody(query)));
      rememberPlaces(found);
      setResults(found);
    } catch (err) {
      if (!isOffline(err)) return setStatus(String(err));
      const known = knownSearch(query);
      setResults(known);
      setStatus(known.length ? `offline · ${known.length} known stops` : "offline · no known stop matches");
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
      {active && <RefreshBar at={loadedAt} loading={loading} />}
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

      <Alerts situations={situations} ids={trips.flatMap((t) => t.alerts)} />

      {trips.map((t, i) => (
        <section key={i} className="trip">
          <p className="trip-head">
            {hhmm(t.start)} → {hhmm(t.end)}
            <AlertMark on={t.alerts.length > 0} />
            {t.legs.some((l) => l.kind === "ride" && l.cancelled) && <span className="tag bad">⚠ cancelled leg</span>}
            <span>
              {" "}· {t.minutes} min · {t.transfers === 0 ? "direct" : `${t.transfers} change${t.transfers > 1 ? "s" : ""}`}
            </span>
          </p>
          {t.legs.map((l, j) =>
            l.kind === "walk" ? (
              <p key={j} className="leg walk">walk {l.minutes} min</p>
            ) : (
              <Fragment key={j}>
                <button
                  className={l.cancelled ? "leg cancelled" : "leg"}
                  aria-expanded={openLeg === `${i}-${j}`}
                  onClick={() => setOpenLeg(openLeg === `${i}-${j}` ? null : `${i}-${j}`)}
                >
                  <span className={`tile sm ${l.mode}`}>
                    <b>{l.line}</b>
                  </span>
                  <span>
                    {short(l.from)} <strong>{hhmm(l.fromTime)}</strong>
                    <AccessMark level={l.access} replacement={l.replacement} />
                    {l.delay > 0 && !l.cancelled && <span className="late"> +{l.delay}'</span>}
                    <Diverted on={l.deviation} />
                    {l.cancelled && <span className="tag bad">cancelled</span>}
                    {l.quay.planned && <> · <QuayMark quay={l.quay} /></>}
                    <br />→ {short(l.alight)} {hhmm(l.alightTime)}
                  </span>
                </button>
                {openLeg === `${i}-${j}` && (
                  <ul className="route sm">
                    {l.stops.length ? l.stops.map((s, k) => <li key={k}>{short(s.name)} {hhmm(s.time)}</li>) : <li>no intermediate stops</li>}
                  </ul>
                )}
              </Fragment>
            ),
          )}
        </section>
      ))}

      {status && <p className="status">{status}</p>}
    </>
  );
}
