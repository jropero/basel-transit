# basel-transit

Check trams and buses in Basel. It's a small React + TypeScript PWA on [Vite+](https://viteplus.dev), with a Windows Phone "Metro" look. It uses the Swiss [OJP 2.0 API](https://opentransportdata.swiss).

## Features

- **Departures:** the next departures for a stop, grouped by line and direction, showing quay, delay and minutes left. Tap a line to see its next stops; these are cached in localStorage for 24h.
- **Saved stops:** Burgfelderplatz is preset. Add stops by name search or with **near me**, which lists stops within 500 m using your location.
- **Route planner:** plan a trip from one stop to another, with changes, walks and delays shown. Save routes for one-tap reuse.
- **Auto-refresh:** departures and the open route refresh every 30s while visible.
- **Installable:** works as an installable PWA ("Add to Home Screen"), always in dark mode.

Notes for coding agents (layout, OJP API quirks, rules) are in [AGENTS.md](AGENTS.md).

## Development

Set `OJP_TOKEN` in `.env`, then run `pnpm dev`. The dev server proxies `/ojp` to the
Swiss OJP API and injects the token, so it never reaches the browser during development.
With `base: "/b/"`, the app is served locally at http://localhost:5173/b/.

## Deployment

Deployed at https://ekult.co.uk/b/.

- `vite.config.ts` sets the absolute base path `base: "/b/"`. Keep it absolute —
  relative paths break the PWA manifest scope and icon resolution.
- Copy the **entire** `dist/` output to the server's `/b/` directory.
- `index.html` and `public/manifest.webmanifest` reference icons and the manifest
  with absolute `/b/...` paths; `start_url`, `scope`, and `id` are all `/b/`.
- The Vite `/ojp` proxy is dev-only. Hostinger static hosting cannot proxy it, so
  production builds call `https://api.opentransportdata.swiss/ojp20` directly; the
  API allows CORS with `Authorization` from `ekult.co.uk`.
- `OJP_TOKEN` is injected into the production bundle at build time via `define`.
  It is therefore visible to anyone who loads the app — only use a token intended
  for public clients, and rebuild after changing it. No server-side config is needed.
