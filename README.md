# basel-transit

Check trams and buses in Basel. It's a small React + TypeScript PWA on [Vite+](https://viteplus.dev), with a Windows Phone "Metro" look. It uses the Swiss [OJP 2.0 API](https://opentransportdata.swiss).

## Features

- **Departures:** the next departures for a stop, grouped by line and direction. Each departure shows quay, delay, minutes left and step-free boarding (♿). Each line shows its measured headway ("every ~8 min").
- **Line stops:** tap a line to see its next stops with travel minutes. They're prefetched in the background and cached for 7 days.
- **Service alerts:** disruption notices for trams, buses and trains, in English and supplied by the operator. They appear as a banner and as a ⚠ on affected lines. Cancelled departures are struck through, diverted ones are tagged, and platform changes show as old → new.
- **Saved stops:** Burgfelderplatz is preset. Add stops by name search or with **near me**, which lists stops within 500 m using your location.
- **Route planner:** plan a trip from one stop to another, with changes, walks, delays and intermediate stops. Save routes for one-tap reuse.
- **Auto-refresh:** departures and the open route refresh every 15s while visible. A thin Metro-style bar at the top counts down, and dots fly across while it loads.
- **Offline:** the installed PWA opens offline and shows the last-known departures, trips, line stops and alerts, hiding anything that has already left. Search and near me use the stops seen so far.
- **Metro UI:** swipe between departures, route and settings. A bottom app bar with round icons, tilt on press, turnstile transitions and a choice of 20 Windows Phone accent colours. Selawik font and Fluent icons.
- **Installable:** works as an installable PWA ("Add to Home Screen"), in dark or light mode (Settings: theme auto / light / dark). The app icon shows a badge with the number of active alerts where supported.

Notes for coding agents (layout, OJP API quirks, rules) are in [AGENTS.md](AGENTS.md).

## Development

Set `OJP_TOKEN` in `.env`, then run `pnpm dev`. The dev server proxies `/ojp` to the
Swiss OJP API and injects the token, so it never reaches the browser during development.
With `base: "/b/"`, the app is served locally at http://localhost:5173/b/.

Weather in the stop title: [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0), credited in Settings ("Weather: Open-Meteo.com (CC BY 4.0)").

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

### GitHub Actions

`.github/workflows/deploy.yml` builds and deploys over SSH on every push to `main` and on demand (`gh workflow run deploy.yml`). It does not run on pull requests (the repo is public and the job holds secrets). Steps: `pnpm install --frozen-lockfile`, `vp run build` (with `OJP_TOKEN`), a sanity gate (`dist/index.html`, `dist/manifest.webmanifest` and `dist/sw.js` exist, and the built JS no longer contains the `__OJP_TOKEN__` placeholder, so the token was injected), then `rsync -az --delete --delay-updates` of `dist/` to `DEPLOY_PATH`. `--delete` makes `/b` identical to `dist/`, so the workflow refuses a `DEPLOY_PATH` that does not end in `/b`. The host key is pinned to `SSH_HOST_FP`. A failed build or gate stops the run before the deploy step, leaving the live site untouched.

One-time setup (the deploy key and host values can be the same as for madrid-transit):

1. `ssh-keygen -t ed25519 -f ~/.ssh/madrid_deploy -N '' -C deploy` (skip if the key already exists) and add `~/.ssh/madrid_deploy.pub` in hPanel, Advanced, SSH Access.
2. In this repo, run:
   - `gh secret set OJP_TOKEN`
   - `gh secret set SSH_HOST`
   - `gh secret set SSH_PORT`
   - `gh secret set SSH_USER`
   - `gh secret set SSH_KEY < ~/.ssh/madrid_deploy`
   - `gh variable set SSH_HOST_FP --body 'SHA256:…'` (the server's ED25519 host key fingerprint from hPanel → SSH Access)
   - `gh variable set DEPLOY_PATH --body '/home/<user>/domains/ekult.co.uk/public_html/b'`
