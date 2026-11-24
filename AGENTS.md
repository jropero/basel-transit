# AGENTS.md

Basel tram/bus departures and route planner. React 19 + TypeScript on Vite+ (`vp`), installable PWA, Windows Phone "Metro" look. Data comes from the Swiss OJP 2.0 API (XML). For setup and deployment, see [README.md](README.md).

## Commands

- `vp dev`: dev server at http://localhost:5173/b/ (base is `/b/`)
- `vp run build`: `tsc` type check + production build. Run it after every change; there is no test runner.
- `vp lint` (`pnpm lint`): Oxlint with type-aware checks plus SonarJS rules (cognitive complexity max 6, no nested ternaries). Rules live in the `lint` block of `vite.config.ts`; SonarJS loads via `lint/sonarjs.js`. Fix findings rather than disabling rules; if a rule really doesn't fit, turn it off in the config with a one-line reason, not inline.
- `vp fmt` / `vp fmt --check` (`pnpm format` / `pnpm format:check`): Oxfmt, single quotes, 96 columns (`fmt` block in `vite.config.ts`)
- `pnpm lint:css`: stylelint on `src/index.css` (`.stylelintrc.json`, standard config)
- `pnpm typecheck`: `tsc --noEmit`. `vp check` runs format, lint and type checks together.
- Pre-commit hook (`.husky/pre-commit`, installed by `pnpm install` via `prepare`) runs `vp staged`: lint/format staged TS files, stylelint staged CSS. Needs Node >= 22.22 (`.node-version` pins 26.12.1).
- Package manager: pnpm (`vp add`, `vp remove`)

## Layout

- `src/ojp.ts`: everything shared. Request builders (`envelope`, `searchBody`, `nearBody`, `tripBody`), `ojp()` fetch, XML helpers (`text`, `all`), parsers (`parseStops`, `parseTrips`), localStorage helpers (`loadJson` / `saveJson`, `loadStops`, `loadRoutes`), formatting (`hhmm`, `short`). Also `ojpCached` (last-known XML for offline), situations and flags parsing, the known-stops directory and headways. Put new shared logic here.
- `src/App.tsx`: departures view. Saved-stop pivot, search, near me, groups by line + `DirectionRef`, onward stops (prefetched, cached 7 days), alerts, 30s auto-refresh.
- `src/Route.tsx`: route view (`OJPTripRequest`). From/to, saved routes, 30s auto-refresh.
- `src/RefreshBar.tsx`: Metro countdown bar and loading dots. `src/Alerts.tsx`: alert banner and ⚠ mark. `src/Access.tsx`: ♿, replacement, quay-change and diverted marks.
- `public/sw.js`: service worker for the offline app shell (production only).
- `src/index.css`: the only stylesheet, plain CSS with tokens on `:root`. Always dark. No CSS framework: don't add one.
- `public/`: PWA manifest and icons. Paths are absolute `/b/...`.

## OJP API notes

- Every request is a POST of an XML body built with `envelope()`. Escape user input with `escapeXml`.
- **Dev:** `ojp()` posts to `/ojp`, and the Vite proxy adds `Authorization: Bearer $OJP_TOKEN`. The proxy path is `/ojp`, **not** `/b/ojp`.
- **Production:** `ojp()` calls the API directly, with the token inlined at build time (see README).
- Parse with `text(el, localName)` / `all(el, localName)`. They're namespace-agnostic (`siri:` vs default namespace) and return the **first** descendant, so scope to the right element. In a `StopEvent`, `ThisCall` comes before `OnwardCall`.
- Times are UTC ISO strings. Display them with `hhmm()` (de-CH).
- Stop IDs are SLOIDs, e.g. Burgfelderplatz `ch:1:sloid:89303`. `ch:1:sloid:10` is the Basel SBB _train_ station, not the tram stop; the tram stop "Basel, Bahnhof SBB" is `ch:1:sloid:78143`.
- English alert text comes from `siri:ServiceRequestContext/siri:Language` as the first child of `siri:ServiceRequest` (set by `envelope()` via `LANG`). `Params/Language` has no effect. Alerts (`PtSituation`) sit in the response context; `Service/SituationFullRefs/SituationFullRef/SituationNumber` in each `StopEvent` / `TimedLeg` points at them. `Cancelled` and `Deviation` sit in `Service`; `EstimatedQuay` next to `PlannedQuay` in the call.
- **Before relying on a response shape, check it live:** with the dev server running, `curl -X POST localhost:5173/ojp -H 'Content-Type: application/xml' --data-binary '<OJP …>'`.

## Rules

- Never read, print or commit `.env`; it holds `OJP_TOKEN`.
- Wrap localStorage access in try/catch (use `loadJson` / `saveJson`). Keys are prefixed `basel-transit:`.
- Keep it small: no new dependencies for things a few lines can do. New parsing or maths logic gets an inline `console.assert` self-check (see `isoMinutes`, `metres`).
- Interactive elements are real `<button>`s with `aria-*` state. Don't put `<div>`s inside buttons; use `<span>`.
