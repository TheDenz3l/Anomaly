/**
 * Dot-sphere status orbs, ported from @yogesharc/thinking-orbs (MIT © yogesharc,
 * https://thinkingorbs.com) to React Native.
 *
 * The web original rewrites one SVG <circle> per dot every frame. Here each frame runs as a
 * Reanimated worklet on the UI thread and the dots are drawn as BANDS paths, one per opacity
 * step. That is 8 prop updates a frame instead of ~80, which matters on device.
 */

export type OrbState = "base" | "working" | "reasoning" | "searching" | "background" | "waiting";

export const BANDS = 8;

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Time for one full turn, in ms. */
const PERIOD: Record<OrbState, number> = {
  base: 6500,
  working: 3000,
  reasoning: 6500,
  searching: 13000,
  background: 13000,
  waiting: 13000,
};

/** Reasoning: a hop every HOP ms to one of the REACH nearest dots, the last TAIL lit and fading. */
const HOP = 220;
const TAIL = 5;
const REACH = 24;
/** 325 hops = 71.5 s = exactly 11 turns, so the precomputed walk loops in step with the spin. */
const WALK_HOPS = 325;

/** Searching: a lens glides between spots on the face, lingering on each. */
const LENS_MS = 1800;
const MOVE = 0.4;
const LENS = 0.6;

/** Working's ring axis in view space: tipped 30° toward you, rolled 10°. */
const RING_AXIS = (() => {
  const tip = (30 * Math.PI) / 180;
  const roll = (10 * Math.PI) / 180;
  return [-Math.sin(roll) * Math.cos(tip), Math.cos(roll) * Math.cos(tip), Math.sin(tip)];
})();

export type OrbConfig = {
  state: OrbState;
  size: number;
  /** Flat [x, y, z, x, y, z, …] on the unit sphere. */
  pts: number[];
  count: number;
  /** Reasoning only: the dot each hop lands on, looped. */
  walk: number[];
  /** Index of the one dot drawn in the accent colour, or -1. */
  anomaly: number;
  pitch: number;
  rs: number;
};

export type OrbFrame = { paths: string[]; ax: number; ay: number; ar: number; aa: number };

function hash(n: number): number {
  "worklet";
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function ease(x: number): number {
  "worklet";
  return (1 - Math.cos(Math.PI * x)) / 2;
}

function spot(k: number): number[] {
  "worklet";
  const phi = k * 2.45 + hash(k) * 1.5;
  const theta = ((15 + 30 * hash(k + 0.5)) * Math.PI) / 180;
  return [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
}

function lensAt(t: number): number[] {
  "worklet";
  const k = Math.floor(t / LENS_MS);
  const u = t / LENS_MS - k;
  const e = u < MOVE ? (1 - Math.cos((u / MOVE) * Math.PI)) / 2 : 1;
  const a = spot(k);
  const b = spot(k + 1);
  const v = [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Fibonacci sphere: evenly spread points with no clumps at the poles. */
function sphere(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const th = i * GOLDEN;
    out.push(r * Math.cos(th), y, r * Math.sin(th));
  }
  return out;
}

function nearest(pts: number[], i: number, k: number): number[] {
  const d: { j: number; e: number }[] = [];
  for (let j = 0; j < pts.length / 3; j++) {
    if (j === i) continue;
    const e =
      (pts[i * 3] - pts[j * 3]) ** 2 +
      (pts[i * 3 + 1] - pts[j * 3 + 1]) ** 2 +
      (pts[i * 3 + 2] - pts[j * 3 + 2]) ** 2;
    d.push({ j, e });
  }
  return d
    .sort((a, b) => a.e - b.e)
    .slice(0, k)
    .map((x) => x.j);
}

/**
 * The reasoning walk, precomputed: each hop goes to the neighbour facing you most, with a little
 * chance mixed in so it wanders. Deterministic in time, so it can be worked out once at mount.
 */
function buildWalk(pts: number[], count: number, pitch: number): number[] {
  const near = Array.from({ length: count }, (_, i) => nearest(pts, i, REACH));
  const st = Math.sin(pitch);
  const ct = Math.cos(pitch);
  const facing = (k: number, t: number) => {
    const yaw = (t / PERIOD.reasoning) * TAU;
    return (
      pts[k * 3 + 1] * st + (-pts[k * 3] * Math.sin(yaw) + pts[k * 3 + 2] * Math.cos(yaw)) * ct
    );
  };
  let first = 0;
  for (let k = 1; k < count; k++) if (facing(k, 0) > facing(first, 0)) first = k;
  const walk = [first];
  for (let n = 1; n < WALK_HOPS; n++) {
    const t = n * HOP;
    const recent = walk.slice(-8);
    const from = walk[walk.length - 1];
    let best = -1;
    let score = -Infinity;
    near[from].forEach((k, j) => {
      const sc = facing(k, t) + 0.35 * hash((n - 1) * 31 + j);
      if (!recent.includes(k) && sc > score) {
        score = sc;
        best = k;
      }
    });
    walk.push(best < 0 ? near[from][0] : best);
  }
  return walk;
}

export function makeOrb(
  state: OrbState,
  size: number,
  { density = 1, dotSize = 1, tilt = 20, anomaly = false } = {}
): OrbConfig {
  // Background's orb has a quarter of the dots, so each comes out twice the size.
  const dens = state === "background" ? 1 : 4;
  const count = Math.max(8, Math.round(size * dens * density));
  const rs = (size / 64) ** 0.6 * (0.72 * Math.sqrt(4 / dens)) * dotSize;
  const pitch = (tilt * Math.PI) / 180;
  const pts = sphere(count);
  return {
    state,
    size,
    pts,
    count,
    walk: state === "reasoning" ? buildWalk(pts, count, pitch) : [],
    anomaly: anomaly ? Math.floor(count * 0.38) : -1,
    pitch,
    rs,
  };
}

function circle(x: number, y: number, r: number): string {
  "worklet";
  const rr = r.toFixed(2);
  return `M${(x - r).toFixed(2)} ${y.toFixed(2)}a${rr} ${rr} 0 1 0 ${(2 * r).toFixed(2)} 0a${rr} ${rr} 0 1 0 ${(-2 * r).toFixed(2)} 0`;
}

/** One frame at time `t` (ms): the dots bucketed into BANDS paths by opacity, plus the anomaly dot. */
export function orbFrame(t: number, cfg: OrbConfig): OrbFrame {
  "worklet";
  const { state, size, pts, count, walk, anomaly, pitch, rs } = cfg;
  const c = size / 2;
  const R = c * 0.8;
  const yaw = (t / PERIOD[state]) * TAU;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const st = Math.sin(pitch);
  const ct = Math.cos(pitch);

  const litIdx: number[] = [];
  const litVal: number[] = [];
  if (state === "reasoning" && walk.length > 0) {
    const s = t / HOP;
    const n = Math.floor(s);
    const f = s - n;
    const H = walk.length;
    for (let j = 0; j < TAIL; j++) {
      litIdx.push(walk[(((n - j) % H) + H) % H]);
      litVal.push(j === 0 ? ease(Math.min(1, f * 2)) : 1 - (j - 1 + f) / TAIL);
    }
  }

  const lens = state === "searching" ? lensAt(t) : null;

  // Working: every 1.7 s a ring of light runs down the sphere over 1.2 s.
  const wu = t % 1700;
  const ringAt = 1.3 - 2.6 * ease(Math.min(1, wu / 1200));

  // Waiting: a comet laps every 2 s, spiralling 70° north to 70° south every 6 s.
  const head = (t / 2000) * TAU + yaw;
  const ahead = TAU / 2000 + TAU / PERIOD.waiting;
  const glow = Math.min(1, 3 * Math.sin(Math.PI * ((t % 6000) / 6000)));

  const paths: string[] = [];
  for (let b = 0; b < BANDS; b++) paths.push("");
  let ax = 0;
  let ay = 0;
  let ar = 0;
  let aa = 0;

  for (let i = 0; i < count; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    const z = pts[i * 3 + 2];
    const z1 = -x * sy + z * cy;
    let vx = x * cy + z * sy;
    let vy = y * ct - z1 * st;
    const vz = y * st + z1 * ct;
    const d = (vz + 1) / 2;
    let r = (0.5 + 1.4 * d) * rs;
    // The back fades out instead of leaving a haze.
    let a = Math.max(0, (d - 0.3) / 0.7);

    if (lens) {
      const ang = Math.acos(
        Math.min(1, (vx * lens[0] + vy * lens[1] + vz * lens[2]) / Math.hypot(vx, vy, vz))
      );
      const w = ang < LENS ? (1 - (ang / LENS) ** 2) ** 2 : 0;
      a *= 1 - 0.55 * (1 - w);
      if (size <= 24) r *= 1 + 0.5 * w;
      if (w) {
        vx *= 1 + 0.12 * w;
        vy *= 1 + 0.12 * w;
        vx += (vx - lens[0]) * 0.35 * w;
        vy += (vy - lens[1]) * 0.35 * w;
        r *= 1 + 0.9 * w;
        a += (1 - a) * w;
      }
    }

    if (state === "working") {
      const q = vx * RING_AXIS[0] + vy * RING_AXIS[1] + vz * RING_AXIS[2];
      const g = wu < 1200 ? Math.exp(-(((q - ringAt) / 0.2) ** 2)) : 0;
      r *= 1 + 0.6 * g;
      a += (1 - a) * g;
      const w =
        Math.min(1, Math.max(0, (q - ringAt) / 0.2)) *
        (wu < 1200 ? 1 : 1 - Math.min(1, 1.6 * ((wu - 1200) / 800)));
      vx *= 1 - 0.08 * w;
      vy *= 1 - 0.08 * w;
      r *= 1 - 0.15 * w;
    }

    if (state === "reasoning") {
      a *= 0.5;
      for (let j = 0; j < litIdx.length; j++) {
        if (litIdx[j] === i) {
          const spark = litVal[j];
          r *= 1 + 0.8 * spark;
          a += (1 - a) * spark;
          break;
        }
      }
    }

    if (state === "waiting") {
      const lat = Math.asin(y / (Math.hypot(x, y, z) || 1));
      const lon = Math.atan2(z, x);
      const off = Math.atan2(Math.sin(lon - head), Math.cos(lon - head));
      const along = off * Math.cos(lat);
      const tt = t + off / ahead;
      const headLat = ((70 * Math.PI) / 180) * (1 - (2 * (((tt % 6000) + 6000) % 6000)) / 6000);
      const g =
        Math.exp(-(((lat - headLat) / 0.28) ** 2)) *
        Math.exp(-((along / (off * ahead > 0 ? 0.12 : 1)) ** 2));
      const w = glow * g ** 0.6;
      a = a * 0.5 + (1 - a * 0.5) * w;
      r *= 1 + 1.1 * w;
    }

    const px = c + vx * R;
    const py = c - vy * R;
    const rr = Math.max(0.45, r);

    if (i === anomaly) {
      ax = px;
      ay = py;
      ar = rr * 1.5;
      aa = Math.max(0.45, a);
      continue;
    }

    const band = Math.min(BANDS, Math.round(a * BANDS));
    if (band <= 0) continue;
    paths[band - 1] += circle(px, py, rr);
  }

  for (let b = 0; b < BANDS; b++) if (!paths[b]) paths[b] = "M0 0";
  return { paths, ax, ay, ar, aa };
}
