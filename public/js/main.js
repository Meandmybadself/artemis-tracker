import { fetchTrajectoryData, interpolate, LAUNCH_TIME } from './horizons.js';

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg:       '#010801',
  green:    '#00ff41',
  dim:      'rgba(0, 255, 65, 0.50)',
  muted:    'rgba(0, 255, 65, 0.22)',
  faint:    'rgba(0, 255, 65, 0.08)',
  grid:     'rgba(0, 255, 65, 0.065)',
};

// ── Canvas setup ──────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

const ro = new ResizeObserver(() => {
  const r = canvas.getBoundingClientRect();
  canvas.width  = Math.round(r.width);
  canvas.height = Math.round(r.height);
  computeTargetView(); // recompute optimal fit for new dimensions
  viewScale = 0;       // snap immediately to new target
});
ro.observe(canvas);

// ── View state (lerped each frame) ───────────────────────────────────────────
let viewCX    = 0;   // current center X (km)
let viewCY    = 0;   // current center Y (km)
let viewAngle = 0;   // rotation so Moon stays lower-right (radians)
let viewScale = 0;   // px/km  (0 = uninitialised)

// Map km coords → canvas pixels (with rotation)
function toPx(x, y) {
  const dx  = x - viewCX;
  const dy  = y - viewCY;
  const cos = Math.cos(viewAngle);
  const sin = Math.sin(viewAngle);
  return [
    canvas.width  / 2 + (dx * cos - dy * sin) * viewScale,
    canvas.height / 2 - (dx * sin + dy * cos) * viewScale,
  ];
}

// ── State ─────────────────────────────────────────────────────────────────────
let data               = null;
let currentTime        = null;
let timeStart          = null;
let timeEnd            = null;
let playing            = false;
let liveMode           = false;
let liveTelemetry      = null;
let prevLiveTelemetry  = null;  // eslint-disable-line no-unused-vars
let liveTelemetryTime  = 0;
let lastTelemetryFetch = -Infinity;
let speedMultiplier    = 60;
const speedSteps       = [1, 10, 30, 60, 120, 300, 600, 1800, 3600];
let speedIdx           = 3;
let useImperial  = false;
let useLocalTime = false;
let lastRealTime = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const elDistEarth    = document.getElementById('dist-earth');
const elDistMoon     = document.getElementById('dist-moon');
const elVelocity     = document.getElementById('velocity');
const elAltitude     = document.getElementById('altitude');
const elDataSource   = document.getElementById('data-source');
const elDataAge      = document.getElementById('data-age');
const elTimeLabel    = document.getElementById('time-label');
const elMetLabel     = document.getElementById('met-label');
const elTimeline     = document.getElementById('timeline');
const elBtnPlay      = document.getElementById('btn-play');
const elBtnLive      = document.getElementById('btn-live');
const elLiveStatus   = document.getElementById('live-status');
const elSpeedDisplay = document.getElementById('speed-display');
const elLoading      = document.getElementById('loading');
const elLoadingStatus= document.getElementById('loading-status');

// ── Live telemetry polling ────────────────────────────────────────────────────
async function pollTelemetry() {
  const now = performance.now();
  if (now - lastTelemetryFetch < 10000) return;
  lastTelemetryFetch = now;
  try {
    const resp   = await fetch('/api/telemetry');
    const telData = await resp.json();
    if (telData.orion?.File?.Activity === 'MIS') {
      const parsed = parseTelemetry(telData.orion);
      if (parsed) {
        const isNew = !liveTelemetry || parsed.date.getTime() !== liveTelemetry.date.getTime();
        if (isNew) {
          prevLiveTelemetry = liveTelemetry;
          liveTelemetry     = parsed;
          liveTelemetryTime = performance.now();
        }
      }
    }
  } catch (e) {
    console.warn('Telemetry poll error:', e);
  }
}

function parseTelemetry(raw) {
  const p = (num) => {
    const param = raw[`Parameter_${num}`];
    return param ? parseFloat(param.Value) : null;
  };
  const FT = 0.0003048; // feet → km
  const xRaw = p(2003), yRaw = p(2004), zRaw = p(2005);
  if (xRaw == null || yRaw == null || zRaw == null) return null;

  const timeStr = raw.Parameter_2003?.Time;
  let date = new Date();
  if (timeStr) {
    const m = timeStr.match(/(\d{4}):(\d{3}):(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const jan1 = new Date(Date.UTC(+m[1], 0, 1));
      date = new Date(jan1.getTime()
        + (+m[2] - 1) * 86400000 + +m[3] * 3600000 + +m[4] * 60000 + +m[5] * 1000);
    }
  }
  return {
    date,
    x: xRaw * FT, y: yRaw * FT, z: zRaw * FT,
    vx: (p(2009) ?? 0) * FT, vy: (p(2010) ?? 0) * FT, vz: (p(2011) ?? 0) * FT,
    qw: p(2012), qx: p(2013), qy: p(2014), qz: p(2015),
    rateRoll:  p(2101), ratePitch: p(2102), rateYaw: p(2103),
    thr1: p(2040), thr2: p(2041), thr3: p(2042),
    rcs1: p(2091), rcs2: p(2092), rcs3: p(2093), rcs4: p(2094), rcs5: p(2095),
    solar2048: p(2048), solar2049: p(2049), solar2050: p(2050),
    solar2051: p(2051), solar2052: p(2052), solar2053: p(2053),
    statusFlag: p(2016),
    altitude:   p(5001),
    raw,
  };
}

// ── Dead-reckoning (no Three.js) ──────────────────────────────────────────────
function qMul(a, b) {
  return {
    w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
  };
}
function qNorm(q) {
  const l = Math.sqrt(q.w*q.w + q.x*q.x + q.y*q.y + q.z*q.z) || 1;
  return { w: q.w/l, x: q.x/l, y: q.y/l, z: q.z/l };
}

function getLiveState() {
  if (!liveTelemetry) return null;
  const t     = liveTelemetry;
  const dtSec = (performance.now() - liveTelemetryTime) / 1000;

  const x = t.x + (t.vx||0) * dtSec;
  const y = t.y + (t.vy||0) * dtSec;
  const z = t.z + (t.vz||0) * dtSec;

  let { qw, qx, qy, qz } = t;
  if (qw != null && t.rateRoll != null) {
    const wx = (t.rateRoll  || 0) * Math.PI / 180;
    const wy = (t.ratePitch || 0) * Math.PI / 180;
    const wz = (t.rateYaw   || 0) * Math.PI / 180;
    const omega     = Math.sqrt(wx*wx + wy*wy + wz*wz);
    const halfAngle = 0.5 * omega * dtSec;
    if (halfAngle > 1e-8) {
      const s = Math.sin(halfAngle) / omega;
      const delta = { w: Math.cos(halfAngle), x: wx*s, y: wy*s, z: wz*s };
      const q = qNorm(qMul({ w: qw, x: qx, y: qy, z: qz }, delta));
      qw = q.w; qx = q.x; qy = q.y; qz = q.z;
    }
  }
  return { ...t, x, y, z, qw, qx, qy, qz, altitude: Math.sqrt(x*x+y*y+z*z) - 6371 };
}

// ── Orbital plane projection ──────────────────────────────────────────────────
// The trajectory is fully 3D; projecting onto X-Y collapses the lunar loop.
// We compute the orbital plane from the mean angular momentum vector, then
// derive two orthonormal in-plane basis vectors (projU, projV).
let projU = { x: 1, y: 0, z: 0 };
let projV = { x: 0, y: 1, z: 0 };

function computeOrbitalPlane(orionData) {
  // Mean angular momentum L = Σ r × v  (plane normal)
  let Lx = 0, Ly = 0, Lz = 0;
  for (const p of orionData) {
    Lx += p.y * p.vz - p.z * p.vy;
    Ly += p.z * p.vx - p.x * p.vz;
    Lz += p.x * p.vy - p.y * p.vx;
  }
  const Lmag = Math.sqrt(Lx**2 + Ly**2 + Lz**2);
  const nx = Lx/Lmag, ny = Ly/Lmag, nz = Lz/Lmag;

  // First in-plane axis u: direction of apoapsis, projected onto orbital plane
  let maxR = 0, refX = 1, refY = 0, refZ = 0;
  for (const p of orionData) {
    const r = Math.sqrt(p.x**2 + p.y**2 + p.z**2);
    if (r > maxR) { maxR = r; refX = p.x; refY = p.y; refZ = p.z; }
  }
  const dot = refX*nx + refY*ny + refZ*nz;
  let ux = refX - dot*nx, uy = refY - dot*ny, uz = refZ - dot*nz;
  const umag = Math.sqrt(ux**2 + uy**2 + uz**2);
  ux /= umag; uy /= umag; uz /= umag;

  // Second in-plane axis v = n × u
  const vx = ny*uz - nz*uy;
  const vy = nz*ux - nx*uz;
  const vz = nx*uy - ny*ux;

  projU = { x: ux, y: uy, z: uz };
  projV = { x: vx, y: vy, z: vz };
}

// Project a 3D km position onto the orbital plane → [u, v]
function proj2D(x, y, z) {
  return [
    x * projU.x + y * projU.y + z * projU.z,
    x * projV.x + y * projV.y + z * projV.z,
  ];
}

// All trajectory + Moon points projected to (u,v) — built once in init()
let allProjPts = [];

// ── Optimal view (recomputed on init + resize) ────────────────────────────────
// Searches 0–179° to find the rotation that maximises display scale, i.e. the
// minimum bounding rectangle of the full trajectory + Moon positions.
let tvCX = 0, tvCY = 0, tvAngle = 0, tvScale = 1;

function computeTargetView() {
  if (!canvas.width || !canvas.height || allProjPts.length === 0) return;
  const W = canvas.width, H = canvas.height;
  const PAD = 1.20; // 20% breathing room on each axis

  let bestScale = 0, bestAngle = 0, bestCRX = 0, bestCRY = 0;

  for (let deg = 0; deg < 180; deg++) {
    const theta = deg * Math.PI / 180;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    for (const [u, v] of allProjPts) {
      const rx =  u * cos - v * sin;
      const ry =  u * sin + v * cos;
      if (rx < xMin) xMin = rx; if (rx > xMax) xMax = rx;
      if (ry < yMin) yMin = ry; if (ry > yMax) yMax = ry;
    }
    const sx = xMax - xMin, sy = yMax - yMin;
    if (sx < 1 || sy < 1) continue;
    const s = Math.min(W / (sx * PAD), H / (sy * PAD));
    if (s > bestScale) {
      bestScale = s;
      bestAngle = theta;
      bestCRX = (xMin + xMax) / 2;
      bestCRY = (yMin + yMax) / 2;
    }
  }

  // Convert bounding-box centre from rotated (rx,ry) back to orbital-plane (u,v)
  const cos = Math.cos(bestAngle), sin = Math.sin(bestAngle);
  tvCX    = bestCRX * cos + bestCRY * sin;
  tvCY    = -bestCRX * sin + bestCRY * cos;
  tvAngle = bestAngle;
  tvScale = bestScale;
}

// ── View management (lerp toward pre-computed target) ─────────────────────────
function updateView() {
  if (!tvScale) return;
  if (viewScale === 0) {
    // First call — snap immediately
    viewCX = tvCX; viewCY = tvCY; viewAngle = tvAngle; viewScale = tvScale;
  } else {
    const k = 0.05;
    viewCX    += (tvCX    - viewCX)    * k;
    viewCY    += (tvCY    - viewCY)    * k;
    viewAngle += (tvAngle - viewAngle) * k;
    viewScale += (tvScale - viewScale) * k;
  }
}

// ── Grid & scale helpers ──────────────────────────────────────────────────────
function niceStep(approxKm) {
  const mag = Math.pow(10, Math.floor(Math.log10(approxKm)));
  const f   = approxKm / mag;
  if (f < 1.5) return mag;
  if (f < 3.5) return 2 * mag;
  if (f < 7)   return 5 * mag;
  return 10 * mag;
}

// Fixed canvas-space grid — view rotates so a data-space grid would look chaotic
function drawGrid() {
  const W = canvas.width, H = canvas.height;
  const step = 52; // px

  ctx.strokeStyle = C.grid;
  ctx.lineWidth   = 0.5;
  ctx.shadowBlur  = 0;

  for (let x = step; x < W; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = step; y < H; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
}

// ── Scale bar ─────────────────────────────────────────────────────────────────
function drawScaleBar() {
  const W = canvas.width, H = canvas.height;
  const margin   = 14;
  const targetPx = W * 0.12;
  const km       = niceStep(targetPx / viewScale);
  const barPx    = km * viewScale;

  const x = W - margin - barPx;
  const y = H - margin - 14;

  ctx.strokeStyle = C.dim;
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = C.green;
  ctx.shadowBlur  = 4;
  ctx.beginPath();
  ctx.moveTo(x, y);          ctx.lineTo(x + barPx, y);
  ctx.moveTo(x, y - 4);      ctx.lineTo(x, y + 4);
  ctx.moveTo(x + barPx, y - 4); ctx.lineTo(x + barPx, y + 4);
  ctx.stroke();

  ctx.fillStyle   = C.dim;
  ctx.shadowBlur  = 4;
  ctx.font        = '10px "Share Tech Mono", monospace';
  ctx.textAlign   = 'center';
  ctx.fillText(fmtKm(km), x + barPx / 2, y - 6);
}

function fmtKm(km) {
  if (km >= 1000) return `${Math.round(km / 1000)}K KM`;
  return `${Math.round(km)} KM`;
}

// ── Orbital drawing ───────────────────────────────────────────────────────────
function drawEarth() {
  const [cx, cy] = toPx(0, 0);
  const rKm  = 6371;
  const rPx  = Math.max(4, rKm * viewScale);

  ctx.beginPath(); ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
  ctx.strokeStyle = C.green;
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = C.green;
  ctx.shadowBlur  = 14;
  ctx.stroke();
  ctx.fillStyle   = C.faint;
  ctx.fill();

  // Label
  ctx.fillStyle  = C.dim;
  ctx.font       = '11px "Share Tech Mono", monospace';
  ctx.textAlign  = 'center';
  ctx.shadowBlur = 6;
  ctx.fillText('EARTH', cx, cy - rPx - 5);
}

function drawMoonOrbit(moonState) {
  const [mu, mv]  = proj2D(moonState.x, moonState.y, moonState.z);
  const moonDist  = Math.sqrt(mu**2 + mv**2);
  const [cx, cy]  = toPx(0, 0);
  const rPx       = moonDist * viewScale;

  ctx.beginPath(); ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0, 255, 65, 0.22)';
  ctx.lineWidth   = 1.5;
  ctx.shadowBlur  = 0;
  ctx.setLineDash([4, 8]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawTrajectory(orionState) {
  if (!data) return;
  const currentT = currentTime.getTime();

  // Always use the JPL-interpolated position for trail endpoints so the
  // trail follows the planned trajectory regardless of live telemetry offset.
  const jplCurrent = interpolate(data.orion, currentTime);

  // ── Past trajectory (phosphor trail, fading to dim) ──
  // Collect points up to current time
  const pastPts = [];
  for (const p of data.orion) {
    if (p.date.getTime() > currentT) break;
    pastPts.push(p);
  }
  // Add JPL-interpolated current position as final trail point
  pastPts.push(jplCurrent);

  if (pastPts.length > 1) {
    // Draw bright "hot" tail for last segment of trail
    const TAIL = 80; // number of sample points in glowing tail
    const tailStart = Math.max(0, pastPts.length - TAIL);

    // Dim base trail
    ctx.beginPath();
    pastPts.forEach((p, i) => {
      const [pu, pv] = proj2D(p.x, p.y, p.z);
      const [px, py] = toPx(pu, pv);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.strokeStyle = 'rgba(0, 255, 65, 0.25)';
    ctx.lineWidth   = 2;
    ctx.shadowBlur  = 0;
    ctx.stroke();

    // Glowing tail — draw segment by segment with rising alpha
    if (pastPts.length > tailStart + 1) {
      for (let i = tailStart; i < pastPts.length - 1; i++) {
        const alpha = (i - tailStart) / (pastPts.length - 1 - tailStart);
        const [u0, v0] = proj2D(pastPts[i].x,   pastPts[i].y,   pastPts[i].z);
        const [u1, v1] = proj2D(pastPts[i+1].x, pastPts[i+1].y, pastPts[i+1].z);
        const [x0, y0] = toPx(u0, v0);
        const [x1, y1] = toPx(u1, v1);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.strokeStyle = `rgba(0, 255, 65, ${0.35 + alpha * 0.6})`;
        ctx.lineWidth   = 2 + alpha * 1.5;
        ctx.shadowColor = C.green;
        ctx.shadowBlur  = alpha * 12;
        ctx.stroke();
      }
    }
  }

  // ── Future trajectory (projected path — visible dashed) ──
  const [ou, ov] = proj2D(jplCurrent.x, jplCurrent.y, jplCurrent.z);
  ctx.beginPath();
  let firstFuture = true;
  for (const p of data.orion) {
    if (p.date.getTime() < currentT) continue;
    const [pu, pv] = proj2D(p.x, p.y, p.z);
    const [px, py] = toPx(pu, pv);
    if (firstFuture) {
      const [ox, oy] = toPx(ou, ov);
      ctx.moveTo(ox, oy); ctx.lineTo(px, py);
      firstFuture = false;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.strokeStyle = 'rgba(0, 255, 65, 0.35)';
  ctx.lineWidth   = 1.5;
  ctx.shadowBlur  = 0;
  ctx.setLineDash([5, 8]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawMoon(moonState) {
  const [mu, mv]  = proj2D(moonState.x, moonState.y, moonState.z);
  const [mx, my]  = toPx(mu, mv);
  const rPx      = Math.max(5, 1737 * viewScale);

  // Outer glow ring
  ctx.beginPath(); ctx.arc(mx, my, rPx + 4, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0, 255, 65, 0.12)';
  ctx.lineWidth   = 6;
  ctx.shadowBlur  = 0;
  ctx.stroke();

  // Main circle
  ctx.beginPath(); ctx.arc(mx, my, rPx, 0, Math.PI * 2);
  ctx.strokeStyle = C.green;
  ctx.lineWidth   = 2;
  ctx.shadowColor = C.green;
  ctx.shadowBlur  = 14;
  ctx.stroke();
  ctx.fillStyle   = 'rgba(0, 255, 65, 0.06)';
  ctx.fill();

  ctx.fillStyle  = C.green;
  ctx.font       = '11px "Share Tech Mono", monospace';
  ctx.textAlign  = 'center';
  ctx.shadowBlur = 8;
  ctx.fillText('MOON', mx, my - rPx - 7);
}

function drawOrion(orionState) {
  const [ou, ov] = proj2D(orionState.x, orionState.y, orionState.z);
  const [ox, oy] = toPx(ou, ov);
  const blink    = (Date.now() % 1000) < 600; // 60 % duty cycle
  const s        = 9;

  // Clear trail glow beneath marker so crosshair renders visually on top
  ctx.fillStyle  = C.bg;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(ox, oy, s + 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = blink ? C.green : C.dim;
  ctx.lineWidth   = blink ? 1.5 : 1;
  ctx.shadowColor = C.green;
  ctx.shadowBlur  = blink ? 18 : 5;

  // Crosshair
  ctx.beginPath();
  ctx.moveTo(ox - s, oy); ctx.lineTo(ox - 3, oy);
  ctx.moveTo(ox + 3, oy); ctx.lineTo(ox + s, oy);
  ctx.moveTo(ox, oy - s); ctx.lineTo(ox, oy - 3);
  ctx.moveTo(ox, oy + 3); ctx.lineTo(ox, oy + s);
  ctx.stroke();

  // Ring
  ctx.beginPath(); ctx.arc(ox, oy, 5, 0, Math.PI * 2);
  ctx.stroke();

  // Label
  ctx.fillStyle  = blink ? C.green : C.dim;
  ctx.font       = '11px "Share Tech Mono", monospace';
  ctx.textAlign  = 'left';
  ctx.shadowBlur = blink ? 10 : 3;
  ctx.fillText('ORION', ox + s + 5, oy - 3);
}

// ── Attitude reticle (top-right inset) ───────────────────────────────────────
function drawAttitudeReticle(telem) {
  const W  = canvas.width;
  const cx = W - 58, cy = 58, r = 42;

  // Background
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle   = 'rgba(1, 12, 1, 0.85)';
  ctx.shadowBlur  = 0;
  ctx.fill();
  ctx.strokeStyle = C.muted;
  ctx.lineWidth   = 1;
  ctx.stroke();

  // Concentric rings
  [0.35, 0.65].forEach(frac => {
    ctx.beginPath(); ctx.arc(cx, cy, r * frac, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,255,65,0.08)';
    ctx.lineWidth   = 0.5;
    ctx.stroke();
  });

  // Title
  ctx.fillStyle  = 'rgba(0,255,65,0.35)';
  ctx.font       = '9px "Share Tech Mono", monospace';
  ctx.textAlign  = 'center';
  ctx.fillText('ATT', cx, cy + r + 12);

  const q = telem && telem.qw != null ? telem : null;

  if (!q) {
    // No data — dim static cross
    ctx.strokeStyle = 'rgba(0,255,65,0.18)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r*0.6, cy); ctx.lineTo(cx + r*0.6, cy);
    ctx.moveTo(cx, cy - r*0.6); ctx.lineTo(cx, cy + r*0.6);
    ctx.stroke();
    return;
  }

  const { qw, qx, qy, qz } = q;
  // Roll angle (rotation around body X/forward axis)
  const roll = Math.atan2(2*(qw*qx + qy*qz), 1 - 2*(qx*qx + qy*qy));
  // Pitch (body Y / side axis)
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2*(qw*qy - qz*qx))));

  // Pitch horizon bar
  const pitchPx = Math.max(-r*0.55, Math.min(r*0.55, (pitch / (Math.PI/3)) * r * 0.55));
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, Math.PI * 2); ctx.clip();
  ctx.strokeStyle = 'rgba(0,255,65,0.35)';
  ctx.lineWidth   = 1;
  ctx.shadowBlur  = 0;
  ctx.beginPath();
  ctx.moveTo(cx - r*0.55, cy + pitchPx);
  ctx.lineTo(cx + r*0.55, cy + pitchPx);
  ctx.stroke();
  ctx.restore();

  // Rotating roll crosshair
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(roll);
  ctx.strokeStyle = C.green;
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = C.green;
  ctx.shadowBlur  = 8;
  ctx.beginPath();
  ctx.moveTo(-r*0.65, 0); ctx.lineTo(-r*0.2, 0);
  ctx.moveTo( r*0.2,  0); ctx.lineTo( r*0.65, 0);
  ctx.moveTo(0, -r*0.65); ctx.lineTo(0, -r*0.2);
  ctx.moveTo(0,  r*0.2);  ctx.lineTo(0,  r*0.65);
  ctx.stroke();
  // Centre pip
  ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = C.green; ctx.fill();
  // Roll indicator tick at top
  ctx.strokeStyle = C.green;
  ctx.lineWidth   = 2;
  ctx.beginPath(); ctx.moveTo(0, -r + 4); ctx.lineTo(0, -r + 10); ctx.stroke();
  ctx.restore();
}

// ── Main draw ─────────────────────────────────────────────────────────────────
function drawOrbitalView(orionState, moonState) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  drawGrid();
  drawMoonOrbit(moonState);
  drawTrajectory(orionState);
  drawEarth();
  drawMoon(moonState);
  drawOrion(orionState);
  drawAttitudeReticle(liveTelemetry);
  drawScaleBar();
  ctx.restore();
}

// ── HUD update ────────────────────────────────────────────────────────────────
function updateHUD(orionState, moonState, usedLive) {
  const distEarth = Math.sqrt(orionState.x**2 + orionState.y**2 + orionState.z**2);
  const distMoon  = Math.sqrt(
    (orionState.x-moonState.x)**2 +
    (orionState.y-moonState.y)**2 +
    (orionState.z-moonState.z)**2
  );
  const speed    = Math.sqrt(orionState.vx**2 + orionState.vy**2 + orionState.vz**2);
  const altitude = (usedLive && orionState.altitude != null) ? orionState.altitude : distEarth - 6371;

  elDistEarth.textContent = formatDist(distEarth);
  elDistMoon.textContent  = formatDist(distMoon);
  elVelocity.textContent  = formatSpeed(speed);
  elAltitude.textContent  = formatDist(altitude);

  if (usedLive) {
    elDataSource.textContent = 'NASA AROW (LIVE)';
    elDataSource.className   = 'val live';
  } else {
    elDataSource.textContent = 'JPL HORIZONS';
    elDataSource.className   = 'val';
  }
  document.getElementById('trajectory-note').style.display = usedLive ? 'block' : 'none';

  if (usedLive && liveTelemetry?.date) {
    const ageSec = Math.round((Date.now() - liveTelemetry.date.getTime()) / 1000);
    elDataAge.textContent = `${ageSec}S AGO`;
  } else {
    elDataAge.textContent = liveMode ? 'WAITING...' : '——';
  }

  const displayTime = liveMode ? new Date() : currentTime;
  const timeStr = useLocalTime
    ? displayTime.toLocaleString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
      }).toUpperCase()
    : displayTime.toUTCString().replace('GMT', 'UTC').toUpperCase();
  elTimeLabel.textContent = timeStr;

  const met = displayTime.getTime() - LAUNCH_TIME.getTime();
  elMetLabel.textContent = `MET: ${formatMET(met)}`;
  elSpeedDisplay.textContent = liveMode ? 'LIVE' : formatPlaybackSpeed();
  document.title = `MET ${formatMET(met)} | ALT ${formatDist(altitude)}`;

  // Timeline slider
  const frac = (currentTime.getTime() - timeStart.getTime()) / (timeEnd.getTime() - timeStart.getTime());
  elTimeline.value = Math.round(Math.max(0, Math.min(1000, frac * 1000)));

  updateTelemetryHUD(usedLive ? liveTelemetry : null);
}

// ── Format helpers ────────────────────────────────────────────────────────────
function formatDist(km) {
  if (useImperial) {
    const mi = km * 0.621371;
    return mi >= 1000
      ? `${mi.toLocaleString('en-US', { maximumFractionDigits: 0 })} MI`
      : `${mi.toFixed(1)} MI`;
  }
  return km >= 1000
    ? `${km.toLocaleString('en-US', { maximumFractionDigits: 0 })} KM`
    : `${km.toFixed(1)} KM`;
}

function formatSpeed(kmPerSec) {
  if (useImperial) {
    return `${(kmPerSec * 2236.936).toLocaleString('en-US', { maximumFractionDigits: 0 })} MPH`;
  }
  return `${kmPerSec.toFixed(2)} KM/S`;
}

function formatMET(ms) {
  const totalSec = Math.floor(ms / 1000);
  const days     = Math.floor(totalSec / 86400);
  const hrs      = Math.floor((totalSec % 86400) / 3600);
  const mins     = Math.floor((totalSec % 3600) / 60);
  const secs     = totalSec % 60;
  const tenths   = Math.floor((ms % 1000) / 100);
  const base     = `${days}D ${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  return liveMode ? `${base}.${tenths}` : base;
}

function formatPlaybackSpeed() {
  if (speedMultiplier >= 3600) return `${speedMultiplier/3600}H/S`;
  if (speedMultiplier >= 60)   return `${speedMultiplier/60}M/S`;
  return `${speedMultiplier}X`;
}

function updateSpeedDisplay() {
  elSpeedDisplay.textContent = liveMode ? 'LIVE' : formatPlaybackSpeed();
}

// ── Telemetry HUD ─────────────────────────────────────────────────────────────
function tv(val, decimals = 4) {
  if (val == null) return '——';
  return typeof val === 'number' ? val.toFixed(decimals) : String(val);
}
function setTelem(id, val, decimals = 4) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = tv(val, decimals);
  el.classList.toggle('na', val == null);
}
function updateTelemetryHUD(telem) {
  setTelem('att-qw', telem?.qw);
  setTelem('att-qx', telem?.qx);
  setTelem('att-qy', telem?.qy);
  setTelem('att-qz', telem?.qz);
  setTelem('rate-roll',  telem?.rateRoll,  3);
  setTelem('rate-pitch', telem?.ratePitch, 3);
  setTelem('rate-yaw',   telem?.rateYaw,   3);
  setTelem('thr-1', telem?.thr1, 0);
  setTelem('thr-2', telem?.thr2, 0);
  setTelem('thr-3', telem?.thr3, 0);
  setTelem('rcs-1', telem?.rcs1, 0);
  setTelem('rcs-2', telem?.rcs2, 0);
  setTelem('rcs-3', telem?.rcs3, 0);
  setTelem('rcs-4', telem?.rcs4, 0);
  setTelem('rcs-5', telem?.rcs5, 0);
  setTelem('solar-2048', telem?.solar2048, 2);
  setTelem('solar-2049', telem?.solar2049, 2);
  setTelem('solar-2050', telem?.solar2050, 2);
  setTelem('solar-2051', telem?.solar2051, 2);
  setTelem('solar-2052', telem?.solar2052, 2);
  setTelem('solar-2053', telem?.solar2053, 2);
  const flagEl = document.getElementById('status-flag');
  if (flagEl) {
    const fv = telem?.statusFlag;
    flagEl.textContent = fv != null ? '0X' + Math.round(fv).toString(16).toUpperCase() : '——';
    flagEl.classList.toggle('na', fv == null);
  }
  setTelem('telem-alt', telem?.altitude, 1);
}

// ── Live mode ─────────────────────────────────────────────────────────────────
function setLiveMode(on) {
  liveMode = on;
  if (on) {
    playing = false;
    elBtnPlay.innerHTML = '&#9654; PLAY';
    elBtnLive.classList.add('active');
    speedIdx = 0; speedMultiplier = speedSteps[0];
    lastTelemetryFetch = -Infinity;
    updateSpeedDisplay();
    updateLiveTime();
  } else {
    elBtnLive.classList.remove('active');
    elLiveStatus.textContent = '';
  }
}

function updateLiveTime() {
  const now = new Date();
  if (now < timeStart) {
    currentTime = new Date(timeStart);
    const s = Math.ceil((timeStart - now) / 1000);
    elLiveStatus.textContent = `DATA BEGINS IN ${Math.floor(s/60)}M ${String(s%60).padStart(2,'0')}S`;
  } else if (now > timeEnd) {
    currentTime = new Date(timeEnd);
    elLiveStatus.textContent = 'MISSION TRACKING DATA ENDED';
  } else {
    currentTime = now;
    elLiveStatus.textContent = liveTelemetry
      ? 'RECEIVING LIVE NASA TELEMETRY'
      : 'AWAITING TELEMETRY...';
  }
}

// ── Animation loop ────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  if (liveMode) {
    updateLiveTime();
    pollTelemetry();
  } else if (playing && lastRealTime) {
    const dtMs = (now - lastRealTime) * speedMultiplier;
    currentTime = new Date(Math.min(currentTime.getTime() + dtMs, timeEnd.getTime()));
    if (currentTime.getTime() >= timeEnd.getTime()) {
      playing = false;
      elBtnPlay.innerHTML = '&#9654; PLAY';
    }
  }
  lastRealTime = now;

  if (!data || !canvas.width) return;

  let orionState, usedLive = false;
  if (liveMode && liveTelemetry) {
    const live = getLiveState();
    const dist = live ? Math.sqrt(live.x**2 + live.y**2 + live.z**2) : 0;
    if (live && dist > 6371) {   // sanity check: must be outside Earth's surface
      orionState = live;
      usedLive   = true;
    } else {
      orionState = interpolate(data.orion, currentTime);
    }
  } else {
    orionState = interpolate(data.orion, currentTime);
  }
  const moonState = interpolate(data.moon, currentTime);

  updateView();
  drawOrbitalView(orionState, moonState);
  updateHUD(orionState, moonState, usedLive);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    data = await fetchTrajectoryData(status => {
      elLoadingStatus.innerHTML = status.toUpperCase() + '<span id="loading-cursor">_</span>';
    });

    timeStart = data.orion[0].date;
    timeEnd   = data.orion[data.orion.length - 1].date;

    const now = new Date();
    if (now >= LAUNCH_TIME && now <= timeEnd) {
      setLiveMode(true);
    } else {
      currentTime = new Date(timeStart);
    }

    computeOrbitalPlane(data.orion);

    // Build the full set of projected points used for optimal-view computation:
    // Earth at origin + every Orion trajectory point + every Moon position
    allProjPts = [[0, 0]];
    for (const p of data.orion) allProjPts.push(proj2D(p.x, p.y, p.z));
    for (const p of data.moon)  allProjPts.push(proj2D(p.x, p.y, p.z));
    computeTargetView();

    elLoading.style.display = 'none';
    lastRealTime = performance.now();
    if (liveMode) pollTelemetry();
    animate();
  } catch (err) {
    elLoadingStatus.textContent = `ERROR: ${err.message}`;
    console.error(err);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────
elBtnPlay.addEventListener('click', () => {
  if (liveMode) setLiveMode(false);
  playing = !playing;
  elBtnPlay.innerHTML = playing ? '&#9646;&#9646; PAUSE' : '&#9654; PLAY';
  if (playing) lastRealTime = performance.now();
});

elBtnLive.addEventListener('click', () => setLiveMode(!liveMode));

document.getElementById('btn-faster').addEventListener('click', () => {
  if (liveMode) setLiveMode(false);
  speedIdx = Math.min(speedIdx + 1, speedSteps.length - 1);
  speedMultiplier = speedSteps[speedIdx];
  playing = true;
  elBtnPlay.innerHTML = '&#9646;&#9646; PAUSE';
  updateSpeedDisplay();
});

document.getElementById('btn-slower').addEventListener('click', () => {
  if (liveMode) setLiveMode(false);
  speedIdx = Math.max(speedIdx - 1, 0);
  speedMultiplier = speedSteps[speedIdx];
  updateSpeedDisplay();
});

elTimeline.addEventListener('input', () => {
  if (liveMode) setLiveMode(false);
  const frac = parseInt(elTimeline.value) / 1000;
  currentTime = new Date(timeStart.getTime() + frac * (timeEnd.getTime() - timeStart.getTime()));
});

window.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal.open')) {
    if (e.key === 'Escape') document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
    return;
  }
  if (e.code === 'Space')      { e.preventDefault(); elBtnPlay.click(); }
  if (e.code === 'ArrowRight') document.getElementById('btn-faster').click();
  if (e.code === 'ArrowLeft')  document.getElementById('btn-slower').click();
  if (e.key  === 'l' || e.key === 'L') elBtnLive.click();
  if (e.key  === 'u' || e.key === 'U') useImperial = !useImperial;
  if (e.key  === 't' || e.key === 'T') useLocalTime = !useLocalTime;
  if (e.key  === '?') document.getElementById('shortcuts-modal').classList.toggle('open');
});

document.getElementById('shortcuts-modal').addEventListener('click', e => {
  if (e.target.id === 'shortcuts-modal') e.target.classList.remove('open');
});
document.getElementById('about-modal').addEventListener('click', e => {
  if (e.target.id === 'about-modal') e.target.classList.remove('open');
});
document.getElementById('header-about').addEventListener('click', () => {
  document.getElementById('about-modal').classList.add('open');
});

const btnFs = document.getElementById('header-fs');
btnFs.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
});
document.addEventListener('fullscreenchange', () => {
  btnFs.textContent = document.fullscreenElement ? '⛶ EXIT' : '⛶ FULLSCREEN';
});

updateSpeedDisplay();
init();
