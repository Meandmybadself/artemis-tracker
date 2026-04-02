# artemis-tracker

Retro CRT terminal display for NASA's Artemis II trajectory. Derivative of [iandees/artemis-viewer](https://github.com/iandees/artemis-viewer).

## Stack

- Vanilla JS + Canvas 2D API (no frameworks, no Three.js)
- Cloudflare Workers for hosting + AROW telemetry proxy
- `wrangler` for deploy (`npm run deploy`)

## Key files

- `public/index.html` — layout, CSS (CRT aesthetic), modals
- `public/js/main.js` — canvas rendering, telemetry polling, playback, keyboard shortcuts
- `public/js/horizons.js` — data loading + interpolation (do not modify)
- `src/worker.js` — Cloudflare Worker CORS proxy for NASA AROW telemetry
- `wrangler.toml` — Cloudflare Workers config (account: `me@meandmybadself.com`)

## Deployment

```bash
npm run deploy   # wrangler deploy → artemis-tracker.meandmybadself.com
```

Cloudflare account ID: `c3b373ae8a90a6494e520f962bdf462b`

## Data notes

- `data/*.json` — Earth-centered J2000 equatorial coordinates, **km**
- Live AROW telemetry — positions in **feet**, converted via `FT_TO_KM = 0.0003048` in `main.js`
- Orbital plane derived from mean angular momentum vector across all trajectory points
- View orientation auto-computed (0–179° sweep) to fit Earth + Moon + full trajectory optimally

## Aesthetic

- Color: `#00ff41` on `#010801`
- Font: VT323 (display), Share Tech Mono (data)
- CRT scanlines via `repeating-linear-gradient` in CSS
- Phosphor glow via `text-shadow` / `box-shadow` / canvas `shadowBlur`
