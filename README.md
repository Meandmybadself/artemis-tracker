# Artemis II Trajectory Viewer

A 3D visualization of NASA's Artemis II mission, built with Three.js. Displays Orion's trajectory from Earth to the Moon using two data sources:

1. **JPL Horizons ephemeris** — pre-fetched predicted trajectory for the full ~9-day mission
2. **Live NASA AROW telemetry** — real-time spacecraft position polled from NASA's Google Cloud Storage bucket

In live mode, the viewer dead-reckons Orion's position between telemetry updates using the spacecraft's velocity vector for smooth motion.

## Running

```bash
npm install

# Local development
npm run dev

# Deploy to Cloudflare
npm run deploy
```

The site is deployed at [artemistracker.mapki.com](https://artemistracker.mapki.com).

## Controls

| Input | Action |
|-------|--------|
| Drag | Rotate camera |
| Scroll | Zoom |
| Right-drag | Pan |
| Space | Play/Pause |
| L | Toggle live mode |
| Left/Right arrows | Slower/Faster playback |
| 1/2/3/4 | Focus Earth/Orion/Moon/Free camera |
| U | Toggle imperial/metric units |
| T | Toggle local/UTC time |
| ? | Show keyboard shortcuts |

## Architecture

```
public/                  # Static assets (served by Cloudflare Workers)
  index.html             # UI layout and styles
  js/
    main.js              # Three.js scene, animation loop, HUD, controls
    horizons.js          # Data loading and interpolation
  data/
    orion.json           # Orion trajectory (1,279 points, 10-min intervals)
    moon.json            # Moon ephemeris (same cadence)
    sun.json             # Sun ephemeris (same cadence)
    stars.json           # HYG star catalog (mag < 6.5)
  textures/
    earth.jpg            # Blue Marble day texture
    earth-night.jpg      # City lights night texture
    moon.jpg             # Lunar surface texture
src/
  worker.js              # Cloudflare Worker — proxies NASA AROW telemetry
server.py                # Local dev server (legacy)
fetch_data.py            # One-time script to download Horizons ephemeris
wrangler.toml            # Cloudflare Workers config
```

## Data Sources

### JPL Horizons (predicted trajectory)

Pre-fetched via `fetch_data.py` from the JPL Horizons API:

```
https://ssd.jpl.nasa.gov/api/horizons.api
```

- **Orion spacecraft ID:** `-1024`
- **Moon ID:** `301`
- **Center:** `500@399` (Earth geocenter)
- **Coordinate frame:** Ecliptic J2000
- **Units:** km (position), km/s (velocity)
- **Coverage:** Apr 2 02:00 TDB through Apr 10 23:54 TDB (post-ICPS separation through mission end)
- **Resolution:** 10-minute intervals (1,279 data points per body)

The API returns a JSON object with a `result` string field containing text-formatted state vectors. Data rows are bracketed by `$$SOE` / `$$EOE` markers. Each row contains: Julian Date, Calendar Date, X, Y, Z, VX, VY, VZ.

### NASA AROW Live Telemetry

The official AROW website (nasa.gov/missions/artemis-ii/arow/) uses a Unity WebGL app that polls two files on Google Cloud Storage every ~2 seconds:

| Object | Bucket | Description |
|--------|--------|-------------|
| `October/1/October_105_1.txt` | `p-2-cen1` | Orion spacecraft telemetry |
| `Io/2/Io_108_2.txt` | `p-2-cen1` | ICPS (upper stage) telemetry |

**Polling pattern:** The app first checks object metadata (generation number) to detect updates, then fetches content via `?alt=media&generation=<gen>`.

**Update frequency:** NASA overwrites the file roughly every 5-10 seconds during the mission.

**Data format:** JSON with a `File` header and numbered `Parameter_NNNN` entries:

```json
{
  "File": {
    "Date": "2026/04/01 18:45:08",
    "Activity": "MIS",
    "Type": 4
  },
  "Parameter_2003": {
    "Number": "2003",
    "Length": "8",
    "Status": "Good",
    "Time": "2026:091:23:45:04.722",
    "Type": "2",
    "Value": "9229036.381258"
  }
}
```

**Key fields:**

- `File.Activity`: `"MIS"` = live mission data, `"SIM"` = simulation/test data
- `Parameter_NNNN.Time`: Day-of-year timestamp format `YYYY:DDD:HH:MM:SS.mmm`
- `Parameter_NNNN.Status`: `"Good"` when data is valid

**Known telemetry parameters:**

| Parameter | Description | Units (estimated) |
|-----------|-------------|-------------------|
| 2003, 2004, 2005 | Position (X, Y, Z) | meters, Earth-centered J2000 equatorial |
| 2009, 2010, 2011 | Velocity (VX, VY, VZ) | m/s |
| 2012, 2013, 2014, 2015 | Attitude quaternion (w, x, y, z) | unitless |
| 2016 | Status flag | hex |
| 2040, 2041, 2042 | Thruster state | flags |
| 2048-2065 | Solar array / orientation data | various |
| 2091-2098 | Reaction control system | various |
| 2101, 2102, 2103 | Angular rates | deg/s (estimated) |
| 5001 | Altitude above Earth | km |
| 5002-5009 | Attitude angles | degrees (estimated) |
| 5010-5013 | Timestamps | Unix-like |

**Coordinate conversion:** The telemetry positions are in Earth-centered J2000 equatorial coordinates. The Horizons ephemeris is in J2000 ecliptic. The viewer rotates telemetry positions by the obliquity of the ecliptic (23.4393 deg) to align them in the same scene.

## CORS

The JPL Horizons API and NASA's GCS bucket do not set CORS headers, so direct browser fetches fail. The Python server (`server.py`) acts as a proxy: it polls GCS every 500ms in a background thread and serves the latest telemetry at `/api/telemetry`.
