# Artemis II Trajectory Tracker

A real-time 2D trajectory display for NASA's Artemis II mission, rendered as a retro CRT terminal. Displays Orion's position on a top-down orbital diagram using two data sources:

1. **JPL Horizons ephemeris** — pre-fetched predicted trajectory for the full ~9-day mission
2. **Live NASA AROW telemetry** — real-time spacecraft position, attitude, and systems data polled from NASA's Google Cloud Storage bucket

In live mode, the viewer dead-reckons Orion's position and attitude between telemetry updates using velocity vectors and angular rates for smooth motion.

This is a derivative work of [Ian Dees' artemis-viewer](https://github.com/iandees/artemis-viewer).

## How this was built

The UI was rewritten using Claude Code with the following prompt:

> Replace the 3D Three.js visualization in artemis-viewer with a retro 2D CRT-style display.
>
> AESTHETIC: Cassette futurism / retro CRT terminal
> - Color: #00ff41 green on near-black (#020c02) background
> - Phosphor glow: text-shadow and canvas shadowBlur in green
> - CRT scanlines: CSS repeating-linear-gradient overlay (subtle, ~2px lines)
> - Font: VT323 or Share Tech Mono from Google Fonts (monospace terminal look)
> - Panel borders: CSS double borders or box-drawing chars (╔═╗║╚╝) in green
> - ALL CAPS labels
> - Glowing lines, interlacing effect
>
> WHAT THE 2D CANVAS SHOULD SHOW:
> 1. Top-down orbital view: Earth as a small circle at center, Moon's orbital path as a dotted circle, Moon as a dot on its orbit, Orion's trajectory as a line, Orion as a blinking crosshair/dot
> 2. Attitude reticle (small inset): shows Orion orientation using the quaternion data — a simple crosshair that rotates
> 3. Grid overlay: faint green grid lines behind everything (like a radar screen)
> 4. Scale indicator in corner
>
> Remove Three.js entirely. No more GLB model, no more OrbitControls, no more 3D camera. Keep all telemetry polling code, UI update code, event handlers and keyboard shortcuts. Replace the Three.js animate() loop with a simple 2D canvas redraw loop.

## Running

```bash
npm install

# Local development
npm run dev

# Deploy to Cloudflare
npm run deploy
```

The site is deployed at [artemis-tracker.meandmybadself.com](https://artemis-tracker.meandmybadself.com).

## Controls

| Input | Action |
|-------|--------|
| Space | Play/Pause |
| L | Toggle live mode |
| Left/Right arrows | Slower/Faster playback |
| U | Toggle imperial/metric units |
| T | Toggle local/UTC time |
| ? | Show keyboard shortcuts |

## Architecture

```
public/                  # Static assets (served by Cloudflare Workers)
  index.html             # UI layout and styles
  js/
    main.js              # 2D canvas scene, animation loop, HUD, controls
    horizons.js          # Data loading and interpolation
  data/
    orion.json           # Orion trajectory (1,279 points, 10-min intervals)
    moon.json            # Moon ephemeris (same cadence)
    sun.json             # Sun ephemeris (same cadence)
src/
  worker.js              # Cloudflare Worker — proxies NASA AROW telemetry
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
- **Sun ID:** `10`
- **Center:** `500@399` (Earth geocenter)
- **Coordinate frame:** Earth mean equator J2000 (`REF_PLANE=FRAME`)
- **Units:** km (position), km/s (velocity)
- **Coverage:** Apr 2 02:00 TDB through Apr 10 23:54 TDB (post-ICPS separation through mission end)
- **Resolution:** 10-minute intervals (1,279 data points per body)

**Note:** The Horizons ephemeris for Orion (`-1024`) is a pre-launch prediction and may diverge significantly from the actual trajectory. JPL updates the ephemeris with tracking data during the mission.

### NASA AROW Live Telemetry

The official AROW website (nasa.gov/missions/artemis-ii/arow/) uses a Unity WebGL app that polls two files on Google Cloud Storage:

| Object | Bucket | Description |
|--------|--------|-------------|
| `October/1/October_105_1.txt` | `p-2-cen1` | Orion spacecraft telemetry |
| `Io/2/Io_108_2.txt` | `p-2-cen1` | ICPS (upper stage) telemetry |

**Polling pattern:** Fetch object metadata to get generation number, then fetch content via `?alt=media&generation=<gen>`.

**Update frequency:** NASA updates the files roughly every 60 seconds during the mission.

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

- `File.Activity`: `"MIS"` = live mission data, `"SIM"` = simulation/test data
- `Parameter_NNNN.Status`: `"Good"` when data is valid

### Telemetry Parameters

**Important:** Position and velocity values are in **feet** and **feet/second**. The viewer converts to km internally.

| Parameter | Description | Units |
|-----------|-------------|-------|
| 2003, 2004, 2005 | Position (X, Y, Z) | feet, Earth-centered J2000 equatorial |
| 2009, 2010, 2011 | Velocity (VX, VY, VZ) | ft/s |
| 2012, 2013, 2014, 2015 | Attitude quaternion (w, x, y, z) | unitless |
| 2016 | Status flag | hex |
| 2040, 2041, 2042 | Thruster state | flags |
| 2048–2065 | Solar array wing data (angles, gimbal) | radians (estimated) |
| 2091–2098 | Reaction control system | radians (estimated) |
| 2101, 2102, 2103 | Angular rates (roll, pitch, yaw) | deg/s |

### Coordinate System

Both the Horizons ephemeris and AROW telemetry use **Earth-centered J2000 equatorial** coordinates. The orbital plane for the 2D diagram is computed from the mean angular momentum vector (`L = Σ r × v`) across all trajectory points. The view is then rotated to the orientation that maximises how large the full trajectory (Earth, Moon, Orion) appears on screen.

## CORS

The JPL Horizons API and NASA's GCS bucket do not set CORS headers, so direct browser fetches fail. The Cloudflare Worker (`src/worker.js`) proxies the GCS telemetry requests, returning combined JSON at `/api/telemetry`.
