// Load pre-fetched trajectory data from local JSON files

// Launch time for MET calculation
export const LAUNCH_TIME = new Date('2026-04-01T22:35:12Z');

function parseCalDate(s) {
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const m = s.match(/(\d{4})-(\w{3})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return new Date(0);
  return new Date(Date.UTC(+m[1], months[m[2]], +m[3], +m[4], +m[5], +m[6]));
}

async function loadJson(name) {
  const resp = await fetch(`data/${name}.json`);
  const raw = await resp.json();
  return raw.map(p => ({
    ...p,
    date: parseCalDate(p.cal),
  }));
}

export async function fetchTrajectoryData(onStatus) {
  onStatus('Loading Orion trajectory...');
  const orion = await loadJson('orion');

  onStatus('Loading Moon ephemeris...');
  const moon = await loadJson('moon');

  onStatus('Loading Sun ephemeris...');
  const sun = await loadJson('sun');

  onStatus('Data loaded. Building scene...');
  return { orion, moon, sun };
}

// Interpolate position at a given time from sorted data points
export function interpolate(points, time) {
  const t = time.getTime();
  if (t <= points[0].date.getTime()) return points[0];
  if (t >= points[points.length - 1].date.getTime()) return points[points.length - 1];

  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date.getTime() <= t) lo = mid;
    else hi = mid;
  }

  const p0 = points[lo];
  const p1 = points[hi];
  const frac = (t - p0.date.getTime()) / (p1.date.getTime() - p0.date.getTime());

  return {
    date: time,
    x: p0.x + (p1.x - p0.x) * frac,
    y: p0.y + (p1.y - p0.y) * frac,
    z: p0.z + (p1.z - p0.z) * frac,
    vx: p0.vx + (p1.vx - p0.vx) * frac,
    vy: p0.vy + (p1.vy - p0.vy) * frac,
    vz: p0.vz + (p1.vz - p0.vz) * frac,
  };
}
