/**
 * The dot field an image grows out of (ImageGeneration). Dots sit on a staggered lattice and take
 * their brightness from a slowly flowing noise field with thin bright filaments through it; a
 * finger parts them, lights them up and drags the flow along. When the image arrives the dots
 * turn into windows onto it and swell, a few at a time, until the picture is whole.
 *
 * Plain TypeScript, run on the JS thread: each frame becomes a handful of SVG path strings, one
 * per brightness band, so the drawing costs a few prop updates however many dots there are. The
 * noise is sampled on a coarse grid and interpolated per dot; the sharpening that makes the
 * filaments is applied per dot, so they stay crisp.
 */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (k: number) => k * k * (3 - 2 * k);
const sstep = (a: number, b: number, x: number) => smooth(clamp01((x - a) / (b - a)));
const easeOut = (k: number) => 1 - (1 - k) * (1 - k) * (1 - k);
/** Path coordinates to a tenth of a pixel: shorter strings, no visible difference. */
const rd = (n: number) => Math.round(n * 10) / 10;
const EMPTY = "M0 0";

/* ------------------------------------------------------------------ simplex noise */

const PERM = new Uint8Array(512);
{
  let seed = 1337;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const GX = [1, -1, 1, -1, 1, -1, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 1, -1];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

function snoise(x: number, y: number): number {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = 1 - i1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = PERM[ii + PERM[jj]] & 7;
    t0 *= t0;
    n += t0 * t0 * (GX[g] * x0 + GY[g] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = PERM[ii + i1 + PERM[jj + j1]] & 7;
    t1 *= t1;
    n += t1 * t1 * (GX[g] * x1 + GY[g] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    const g = PERM[ii + 1 + PERM[jj + 1]] & 7;
    t2 *= t2;
    n += t2 * t2 * (GX[g] * x2 + GY[g] * y2);
  }
  return 70 * n;
}

/* ------------------------------------------------------------------ bands */

/** Brightness bands: each is one SVG path with its own colour and opacity. */
export const BANDS = 14;
const SILVER: number[][] = [
  [26, 32, 48],
  [62, 73, 94],
  [128, 141, 166],
  [204, 213, 231],
  [255, 255, 255],
];

function ramp(v: number): string {
  const x = clamp01(v) * (SILVER.length - 1);
  const i = Math.min(SILVER.length - 2, Math.floor(x));
  const f = x - i;
  const a = SILVER[i];
  const b = SILVER[i + 1];
  const c = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

/** Colour and opacity of each band; bands too dim to see on black draw nothing. */
export const BAND_STYLE = Array.from({ length: BANDS }, (_, k) => {
  const v = (k + 0.5) / BANDS;
  return { color: ramp(v), opacity: sstep(0.1, 0.6, v) };
});
const VISIBLE = BAND_STYLE.map((b) => b.opacity > 0.02);

/* ------------------------------------------------------------------ engine */

export type DotFrame = {
  /** One path per band. */
  bands: string[];
  /** Four-point glints on a few bright dots. */
  sparks: string;
  /** Bright specks along the edge of the reveal. */
  flash: string;
  /**
   * Black over the image with holes where it shows through: a clockwise rectangle with
   * counter-clockwise dots and cells cut out of it. Empty until the reveal starts.
   */
  cover: string;
  /** Opacity of the silver dots: they give way to the image's own as it arrives. */
  dots: number;
  glow: { x: number; y: number; a: number };
  /** The reveal has finished: the image is whole. */
  done: boolean;
};

export type DotFlowOptions = {
  /** Lattice spacing in px. */
  pitch?: number;
  /** Brightness multiplier. */
  glow?: number;
  /** Reduce Motion: the flow barely moves, no glints, the image fades in instead. */
  reduced?: boolean;
  /** The field fades out toward a rounded rectangle with this corner radius, so it has no hard edges. */
  corner?: number;
};

/** Field samples are this far apart (px); 160 px of card is one unit of noise. */
const GRID = 20;
const UNIT = 160;
/** The reveal, in seconds: dots take the image's colours, then swell into it. */
const TONE_S = 0.45;
const START_S = 0.2;
const RESOLVE_S = 1.35;
const END_S = START_S + RESOLVE_S + 0.15;
/** A dot's brightness flickers to a new random level this often (Hz). */
const FLICKER_HZ = 1.6;
/** Share of dots that glint on each flicker step. */
const SPARK_RATE = 0.006;

export class DotFlow {
  readonly W: number;
  readonly H: number;
  private pitch: number;
  private rowH: number;
  private glowGain: number;
  private reduced: boolean;
  private n: number;
  private cols: number;
  private rows: number;
  private ox: number;
  private oy: number;
  private hx: Float32Array;
  private hy: Float32Array;
  /** Lattice column (×2, plus 1 on odd rows) and row of each dot. */
  private ci: Uint16Array;
  private ri: Uint16Array;
  /** Lattice cell → dot index, or -1 where the cell is off the card. */
  private lookup: Int32Array;
  private edge: Float32Array;
  private swirl: Float32Array;
  private jit: Float32Array;
  private dx: Float32Array;
  private dy: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private en: Float32Array;
  private sx: Float32Array;
  private sy: Float32Array;
  private v: Float32Array;
  private rA: Float32Array;
  private rB: Float32Array;
  private spark: Uint8Array;
  private th: Float32Array;
  private re: Float32Array;
  /** Dots the finger has disturbed and that haven't settled yet. */
  private live: Uint8Array;
  private active: number[] = [];
  private gw: number;
  private gh: number;
  private gBase: Float32Array;
  private gRidge: Float32Array;
  private colW: Float32Array;
  private rowW: Float32Array;
  private fieldT = -1;
  private time = 0;
  private step0 = -1;
  private revealAt = -1;
  private ptr = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, t: 0, active: false, glow: 0 };
  private bandBuf: string[][] = Array.from({ length: BANDS }, () => []);

  constructor(width: number, height: number, opts: DotFlowOptions = {}) {
    this.W = width;
    this.H = height;
    const pitch = (this.pitch = opts.pitch ?? 7);
    const rowH = (this.rowH = pitch * 0.8660254);
    this.glowGain = opts.glow ?? 1;
    this.reduced = opts.reduced ?? false;

    // Every dot whose cell touches the card, so at the end of the reveal the cells tile it whole.
    const cols = (this.cols = Math.ceil(width / pitch) + 2);
    const rows = (this.rows = Math.ceil(height / rowH) + 2);
    this.ox = (width - (cols - 0.5) * pitch) / 2;
    this.oy = (height - (rows - 1) * rowH) / 2;
    this.lookup = new Int32Array(rows * cols).fill(-1);
    const xs: number[] = [];
    const ys: number[] = [];
    const cis: number[] = [];
    const ris: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = this.ox + c * pitch + (r & 1 ? pitch / 2 : 0);
        const y = this.oy + r * rowH;
        if (x < -pitch / 2 || x > width + pitch / 2 || y < -rowH / 2 || y > height + rowH / 2)
          continue;
        this.lookup[r * cols + c] = xs.length;
        xs.push(x);
        ys.push(y);
        cis.push(c * 2 + (r & 1));
        ris.push(r);
      }
    }
    const n = (this.n = xs.length);
    const F = () => new Float32Array(n);
    this.hx = Float32Array.from(xs);
    this.hy = Float32Array.from(ys);
    this.ci = Uint16Array.from(cis);
    this.ri = Uint16Array.from(ris);
    this.edge = F();
    this.swirl = F();
    this.jit = F();
    this.dx = F();
    this.dy = F();
    this.vx = F();
    this.vy = F();
    this.en = F();
    this.sx = F();
    this.sy = F();
    this.v = F();
    this.rA = F();
    this.rB = F();
    this.th = F();
    this.re = F();
    this.spark = new Uint8Array(n);
    this.live = new Uint8Array(n);
    // Distance in from the edge of a rounded rectangle: the dots thin out toward it, corners too.
    const corner = Math.min(opts.corner ?? 28, width / 2, height / 2);
    for (let i = 0; i < n; i++) {
      const qx = Math.abs(xs[i] - width / 2) - (width / 2 - corner);
      const qy = Math.abs(ys[i] - height / 2) - (height / 2 - corner);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const inside = corner - outside - Math.min(Math.max(qx, qy), 0);
      this.edge[i] = sstep(-2, 24, inside);
      this.swirl[i] = Math.random() - 0.5;
      this.jit[i] = 0.6 + Math.random() * 0.8;
    }
    this.gw = Math.ceil(width / GRID) + 3;
    this.gh = Math.ceil(height / GRID) + 3;
    this.gBase = new Float32Array(this.gw * this.gh);
    this.gRidge = new Float32Array(this.gw * this.gh);
    this.colW = new Float32Array(cols * 2);
    this.rowW = new Float32Array(rows);
  }

  /** A finger (or the mouse) is on the card at x, y; `now` in ms. */
  touch(x: number, y: number, now: number): void {
    const p = this.ptr;
    if (!p.active) {
      Object.assign(p, { x, y, vx: 0, vy: 0, speed: 0, t: now, active: true });
      return;
    }
    const dt = Math.max(0.008, (now - p.t) / 1000);
    const cap = (v: number) => (v < -1800 ? -1800 : v > 1800 ? 1800 : v);
    p.vx = p.vx * 0.5 + cap((x - p.x) / dt) * 0.5;
    p.vy = p.vy * 0.5 + cap((y - p.y) / dt) * 0.5;
    p.speed = Math.hypot(p.vx, p.vy);
    p.x = x;
    p.y = y;
    p.t = now;
  }

  lift(): void {
    this.ptr.active = false;
  }

  /** How fast the finger is moving, in px/s. */
  get speed(): number {
    return this.ptr.active ? this.ptr.speed : 0;
  }

  get revealing(): boolean {
    return this.revealAt >= 0;
  }

  /** Starts turning the dots into the image. Brighter parts of the flow resolve first. */
  reveal(now: number): void {
    if (this.revealAt >= 0) return;
    this.revealAt = now;
    for (let i = 0; i < this.n; i++) {
      this.re[i] = 0;
      this.th[i] = 0.07 + 0.86 * (0.45 * Math.random() + 0.55 * (1 - clamp01(this.v[i])));
    }
  }

  /** Advances the field by dt seconds and draws it; `now` is the same ms clock touch() gets. */
  step(dt: number, now: number): DotFrame {
    this.time += dt * (this.reduced ? 0.15 : 1);
    const t = this.time * 0.35;
    const p = this.ptr;
    const decay = Math.exp(-7 * dt);
    p.speed *= decay;
    p.vx *= decay;
    p.vy *= decay;
    p.glow += ((p.active && !this.revealing ? 1 : 0) - p.glow) * clamp01(dt * 7);

    // The flow moves slowly: sampling it 20 times a second is plenty.
    if (this.fieldT < 0 || this.time - this.fieldT > 0.05) {
      this.sampleField(t);
      this.fieldT = this.time;
    }

    const rt = this.revealing ? (now - this.revealAt) / 1000 : 0;
    const tone = this.revealing ? (this.reduced ? 1 : easeOut(clamp01(rt / TONE_S))) : 0;
    const prog = !this.revealing
      ? 0
      : this.reduced
        ? clamp01(rt / 0.4)
        : easeOut(clamp01((rt - START_S) / RESOLVE_S));

    this.pointerForces(dt);
    this.settle(dt);
    return this.draw(t, tone, prog, rt);
  }

  private sampleField(t: number): void {
    const { gw, gh, gBase, gRidge, W, H } = this;
    let k = 0;
    for (let gy = 0; gy < gh; gy++) {
      const fy = ((gy - 1) * GRID - H / 2) / UNIT;
      for (let gx = 0; gx < gw; gx++, k++) {
        const fx = ((gx - 1) * GRID - W / 2) / UNIT;
        const wx = snoise(fx * 0.55 + t * 0.2, fy * 0.55 - t * 0.12);
        const wy = snoise(fx * 0.55 + 5.2 - t * 0.16, fy * 0.55 + 1.3 + t * 0.1);
        const px = fx + wx * 0.6;
        const py = fy + wy * 0.6;
        gBase[k] =
          snoise(px * 0.85 + t * 0.08, py * 0.85 - t * 0.05) * 0.65 +
          snoise(px * 1.9 - t * 0.06, py * 1.9 + t * 0.07) * 0.35;
        gRidge[k] = snoise(px * 1.3 + 3.1, py * 1.3 - t * 0.09);
      }
    }
  }

  /** The flow at (x, y): soft clouds with thin ridges of light through them. */
  private fieldAt(x: number, y: number): number {
    const { gw, gh, gBase, gRidge } = this;
    let X = x / GRID + 1;
    let Y = y / GRID + 1;
    X = X < 0 ? 0 : X > gw - 1.001 ? gw - 1.001 : X;
    Y = Y < 0 ? 0 : Y > gh - 1.001 ? gh - 1.001 : Y;
    const ix = X | 0;
    const iy = Y | 0;
    const fx = X - ix;
    const fy = Y - iy;
    const k = iy * gw + ix;
    const b0 = gBase[k] + (gBase[k + 1] - gBase[k]) * fx;
    const b1 = gBase[k + gw] + (gBase[k + gw + 1] - gBase[k + gw]) * fx;
    const g0 = gRidge[k] + (gRidge[k + 1] - gRidge[k]) * fx;
    const g1 = gRidge[k + gw] + (gRidge[k + gw + 1] - gRidge[k + gw]) * fx;
    const soft = Math.pow(smooth(clamp01((b0 + (b1 - b0) * fy) * 0.55 + 0.5)), 2.4);
    let ridge = 1 - Math.abs(g0 + (g1 - g0) * fy);
    ridge *= ridge;
    ridge *= ridge;
    ridge *= ridge;
    ridge *= 0.85;
    return soft > ridge ? soft : ridge;
  }

  /** The finger's pull on the dots within reach; only those are visited. */
  private pointerForces(dt: number): void {
    const p = this.ptr;
    if (!p.active) return;
    const R = 46;
    const motion = clamp01(p.speed / 700);
    const push = 450 + 4600 * motion;
    const { pitch, rowH, ox, oy, cols, rows, lookup } = this;
    const rowFrom = Math.max(0, Math.floor((p.y - R - oy) / rowH));
    const rowTo = Math.min(rows - 1, Math.ceil((p.y + R - oy) / rowH));
    const colFrom = Math.max(0, Math.floor((p.x - R - ox) / pitch) - 1);
    const colTo = Math.min(cols - 1, Math.ceil((p.x + R - ox) / pitch) + 1);
    const revealing = this.revealing;
    for (let r = rowFrom; r <= rowTo; r++) {
      for (let c = colFrom; c <= colTo; c++) {
        const i = lookup[r * cols + c];
        if (i < 0) continue;
        // Once the image is on its way the finger only lights dots and wipes the image in;
        // pushing them aside then would open holes in the picture.
        const ddx = this.hx[i] + (revealing ? 0 : this.dx[i]) - p.x;
        const ddy = this.hy[i] + (revealing ? 0 : this.dy[i]) - p.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) || 0.01;
        const f = 1 - d / R;
        const f2 = f * Math.sqrt(f) * this.jit[i];
        this.en[i] = Math.min(1.4, this.en[i] + f2 * (0.6 + motion * 2.4) * dt * 4);
        if (revealing) {
          this.re[i] = Math.min(1, this.re[i] + f2 * (0.6 + motion * 2.4) * dt * 3.5);
        } else {
          const sw = this.swirl[i];
          this.vx[i] += (((ddx - ddy * sw) / d) * f2 * push + p.vx * f2 * 4) * dt;
          this.vy[i] += (((ddy + ddx * sw) / d) * f2 * push + p.vy * f2 * 4) * dt;
          this.sx[i] = Math.max(-90, Math.min(90, this.sx[i] + p.vx * f2 * dt * 0.9));
          this.sy[i] = Math.max(-90, Math.min(90, this.sy[i] + p.vy * f2 * dt * 0.9));
        }
        if (!this.live[i]) {
          this.live[i] = 1;
          this.active.push(i);
        }
      }
    }
  }

  /** Springs disturbed dots home and lets their light fade; settled dots leave the list. */
  private settle(dt: number): void {
    const damp = Math.exp(-5.5 * dt);
    const enDecay = Math.exp(-1.5 * dt);
    const smDecay = Math.exp(-0.9 * dt);
    const { dx, dy, vx, vy, en, sx, sy, live } = this;
    const keep: number[] = [];
    for (const i of this.active) {
      vx[i] = (vx[i] - dx[i] * 55 * dt) * damp;
      vy[i] = (vy[i] - dy[i] * 55 * dt) * damp;
      dx[i] += vx[i] * dt;
      dy[i] += vy[i] * dt;
      en[i] *= enDecay;
      sx[i] *= smDecay;
      sy[i] *= smDecay;
      const still =
        Math.abs(dx[i]) < 0.05 &&
        Math.abs(dy[i]) < 0.05 &&
        Math.abs(vx[i]) < 0.5 &&
        Math.abs(vy[i]) < 0.5 &&
        en[i] < 0.01 &&
        Math.abs(sx[i]) < 0.5 &&
        Math.abs(sy[i]) < 0.5;
      if (still) {
        dx[i] = dy[i] = vx[i] = vy[i] = en[i] = sx[i] = sy[i] = 0;
        live[i] = 0;
      } else keep.push(i);
    }
    this.active = keep;
  }

  private draw(t: number, tone: number, prog: number, rt: number): DotFrame {
    const { n, hx, hy, dx, dy, en, sx, sy, v, edge, pitch, rowH, W, H, ci, ri } = this;
    const base = pitch * 0.5 * 0.66;
    const holeMax = rowH / 2;
    const halftone = holeMax * 0.72;

    // Each dot flickers to a new random level every step, cross-fading between the two.
    const clk = this.time * FLICKER_HZ;
    const s0 = Math.floor(clk);
    if (s0 !== this.step0) {
      const next = this.step0 >= 0 && s0 === this.step0 + 1;
      for (let i = 0; i < n; i++) {
        this.rA[i] = next ? this.rB[i] : Math.random();
        this.rB[i] = Math.random();
        this.spark[i] = !this.reduced && Math.random() < SPARK_RATE ? 1 : 0;
      }
      this.step0 = s0;
    }
    const fz = smooth(clk - s0);
    const sparkAmp = Math.sin(Math.PI * fz);

    // A slow wave of light; separable, so a sine per lattice column and row rather than per dot.
    const { colW, rowW, ox, oy, cols, rows } = this;
    for (let c = 0; c < cols * 2; c++) {
      const x = ox + (c >> 1) * pitch + (c & 1 ? pitch / 2 : 0);
      colW[c] = Math.sin(((x - W / 2) * 1.5) / UNIT + t * 1.5) * 0.5 + 0.5;
    }
    for (let r = 0; r < rows; r++) {
      rowW[r] = Math.sin(((oy + r * rowH - H / 2) * 1.25) / UNIT - t * 1.1) * 0.5 + 0.5;
    }

    const buf = this.bandBuf;
    for (let k = 0; k < BANDS; k++) buf[k].length = 0;
    const sparks: string[] = [];
    const flash: string[] = [];
    const holes: string[] = [];
    const revealing = this.revealing;

    for (let i = 0; i < n; i++) {
      const vi = this.fieldAt(hx[i] - sx[i], hy[i] - sy[i]);
      v[i] = vi;
      const lw = colW[ci[i]] * rowW[ri[i]];
      const hl = lw * lw;
      let b = vi * (0.66 + hl * 0.55) * this.glowGain;
      b += (this.rA[i] + (this.rB[i] - this.rA[i]) * fz - 0.5) * 0.22 * (0.25 + b);
      b += en[i] * 0.75;
      const r = base * (0.14 + 0.86 * clamp01(b)) * (1 + hl * 0.3) * (1 + en[i] * 0.5) * edge[i];

      if (revealing) {
        const thi = this.th[i] - this.re[i] * 0.75;
        const k = sstep(thi - 0.07, thi + 0.07, prog);
        if (k >= 0.999) {
          // Whole: its cell of the image shows. The cells tile the card, so the picture closes up.
          // Edges come from the lattice lines, so neighbours share them exactly: an overlap of
          // even a tenth of a pixel would wind back to black and draw a seam.
          const c = ci[i] >> 1;
          const shift = (ci[i] & 1) * 0.5;
          const left = rd(ox + (c - 0.5 + shift) * pitch);
          const right = rd(ox + (c + 0.5 + shift) * pitch);
          const top = rd(oy + (ri[i] - 0.5) * rowH);
          const bottom = rd(oy + (ri[i] + 0.5) * rowH);
          holes.push(`M${left} ${top}V${bottom}H${right}V${top}Z`);
        } else {
          // A window onto the image: the dot's size at first, then swelling toward its cell. It
          // never leaves the cell, so no two windows overlap (overlaps would wind back to black).
          let hr = r + (halftone - r) * tone;
          hr += (holeMax - hr) * k;
          // Rounding to a tenth of a pixel can't push it into the next cell either.
          if (hr > holeMax - 0.15) hr = holeMax - 0.15;
          if (hr > 0.3) holes.push(circle(hx[i], hy[i], rd(hr)));
          const front = 1 - Math.abs(prog - thi) * 6.25;
          if (front > 0.3 && prog > 0 && prog < 1 && this.rA[i] > 0.55)
            flash.push(circle(hx[i], hy[i], rd(Math.max(0.6, hr * 0.5))));
        }
      }

      if (r < 0.3 || tone >= 1) continue;
      const band = b <= 0 ? 0 : b >= 1 ? BANDS - 1 : (b * BANDS) | 0;
      if (!VISIBLE[band]) continue;
      const x = hx[i] + dx[i];
      const y = hy[i] + dy[i];
      buf[band].push(circle(x, y, rd(r)));
      if (this.spark[i] && b > 0.3 && !revealing) {
        const g = pitch * 1.3 * sparkAmp * clamp01(b);
        if (g > 1) sparks.push(star(x, y, g));
      }
    }

    const p = this.ptr;
    return {
      bands: buf.map((list) => (list.length ? list.join("") : EMPTY)),
      sparks: sparks.length ? sparks.join("") : EMPTY,
      flash: flash.length ? flash.join("") : EMPTY,
      cover: `M0 0H${W}V${H}H0Z${holes.join("")}`,
      dots: 1 - tone,
      glow: { x: p.x, y: p.y, a: p.glow * (0.05 + 0.07 * clamp01(p.speed / 700)) },
      done: revealing && rt > (this.reduced ? 0.45 : END_S),
    };
  }
}

/** A dot drawn counter-clockwise, so inside the cover's clockwise rectangle it cuts a hole. */
function circle(x: number, y: number, r: number): string {
  return `M${rd(x - r)} ${rd(y)}a${r} ${r} 0 1 0 ${rd(2 * r)} 0a${r} ${r} 0 1 0 ${rd(-2 * r)} 0`;
}

/** A four-point glint with a bright core. */
function star(x: number, y: number, g: number): string {
  const w = 0.55;
  const X = rd(x);
  const Y = rd(y);
  return (
    `M${rd(x - g)} ${Y}L${X} ${rd(y - w)}L${rd(x + g)} ${Y}L${X} ${rd(y + w)}Z` +
    `M${X} ${rd(y - g)}L${rd(x + w)} ${Y}L${X} ${rd(y + g)}L${rd(x - w)} ${Y}Z` +
    circle(x, y, rd(Math.min(1.2, g * 0.25)))
  );
}
