# Cloudflare Deployment Design

## Goal

Deploy the Artemis II Trajectory Viewer to `artemistracker.mapki.com` using Cloudflare Workers with static assets.

## Architecture

Single Cloudflare Worker with Wrangler assets:

- **Static assets** (`public/`): `index.html`, `js/`, `data/` served by the Wrangler assets system
- **Worker** (`src/worker.js`): handles `/api/telemetry` with fetch-through caching
- **Custom domain**: `artemistracker.mapki.com`

## Telemetry Proxy

The Worker handles `GET /api/telemetry`:

1. Check the Cache API for a cached response
2. On cache miss: fetch both GCS objects (orion + icps telemetry) in parallel
3. Combine into a single JSON response `{ orion: {...}, icps: {...} }`
4. Cache the response for 2 seconds via the Cache API
5. Return the JSON with `Cache-Control: no-cache` to the client (browser should always revalidate)

GCS fetch pattern (same as current `server.py`):
- Fetch object metadata: `https://storage.googleapis.com/storage/v1/b/p-2-cen1/o/<encoded-path>`
- Fetch content: same URL with `?alt=media`

## File Structure

```
├── public/
│   ├── index.html
│   ├── js/
│   │   ├── main.js
│   │   └── horizons.js
│   └── data/
│       ├── orion.json
│       └── moon.json
├── src/
│   └── worker.js
├── wrangler.toml
├── package.json
├── server.py          (dev only, not deployed)
├── fetch_data.py      (utility, not deployed)
└── README.md
```

## Frontend Changes

None. The frontend already fetches `/api/telemetry` and `data/*.json` with relative paths, which work with both the local dev server and the Worker + assets setup.

## Custom Domain

Configure `artemistracker.mapki.com` via `routes` in `wrangler.toml`. DNS (CNAME or proxied A record) must be configured in Cloudflare's dashboard for the `mapki.com` zone.

## What's NOT Changing

- Three.js visualization code
- Data format / data files
- Horizons fetch script (`fetch_data.py`)
- Local dev server (`server.py`)
