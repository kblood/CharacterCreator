// MakeHuman macro-target runtime (port of MPFB TargetService.calculate_target_stack_from_macro_info_dict).
// Data: CC0 MakeHuman base mesh + targets, packed by tools/export_data.py. Engine-agnostic (plain typed arrays).
// positions = base + sum(weight_i * target_i); all in MakeHuman decimetres (multiply by 0.1 for metres).

export const DEFAULT_MACROS = {
  gender: 0.5, age: 0.5, muscle: 0.5, weight: 0.5, proportions: 0.5, height: 0.5,
  race: { asian: 1 / 3, caucasian: 1 / 3, african: 1 / 3 },
};

const r4 = x => Math.round(x * 1e4) / 1e4;

function interpolate(macroDef, value) {
  const out = [];
  for (const p of macroDef.parts) {
    if (value > p.lowest && value < p.highest) {
      const pct = (value - p.lowest) / (p.highest - p.lowest);
      if (p.low) out.push([p.low, r4(1 - pct)]);
      if (p.high) out.push([p.high, r4(pct)]);
    }
  }
  return out;
}

/** Returns [[targetName, weight], ...] for the macro values (race-gender-age, universal, height, proportions). */
export function targetStack(macro, macros, cutoff = 0.01) {
  const m = { ...DEFAULT_MACROS, ...macros };
  const c = {};
  for (const k of ['gender', 'age', 'muscle', 'weight', 'proportions', 'height']) c[k] = interpolate(macro.macrotargets[k], m[k]);
  const t = [];
  for (const [race, rw] of Object.entries(m.race)) if (rw > 0.0001)
    for (const [a, aw] of c.age) for (const [g, gw] of c.gender) {
      const w = rw * gw * aw; if (w > cutoff) t.push([`macrodetails/${race}-${g}-${a}`, w]);
    }
  for (const [g, gw] of c.gender) for (const [a, aw] of c.age) for (const [mu, mw] of c.muscle) for (const [we, ww] of c.weight) {
    const w = gw * aw * mw * ww;
    if (w > cutoff) t.push([`macrodetails/universal-${g}-${a}-${mu}-${we}`, w]);
    for (const [h, hw] of c.height) {
      const w2 = w * hw; if (w2 > cutoff) t.push([`macrodetails/height/${g}-${a}-${mu}-${we}-${h}`, w2]);
    }
    for (const [p, pw] of c.proportions) {
      const w2 = w * pw;
      if (w2 > cutoff && !a.includes('baby')) t.push([`macrodetails/proportions/${g}-${a}-${mu}-${we}-${p}`, w2]);
    }
  }
  return t;
}

export class Human {
  /** @param load async (relativePath) => ArrayBuffer | object (json) via loader.bytes()/loader.json() */
  constructor(loader) { this.loader = loader; this.cache = new Map(); }

  async init() {
    this.meta = await this.loader.json('meta.json');
    this.macro = await this.loader.json('macro.json');
    const buf = await this.loader.bytes('mesh.bin'), { nBody, nVerts, nIdx } = this.meta;
    let o = 0;
    this.base = new Float32Array(buf, o, nBody * 3); o += nBody * 12;
    this.uv = new Float32Array(buf, o, nVerts * 2); o += nVerts * 8;
    this.orig = new Uint32Array(buf, o, nVerts); o += nVerts * 4;
    this.index = new Uint32Array(buf, o, nIdx);
    this.work = new Float32Array(nBody * 3);
    this.positions = new Float32Array(nVerts * 3);   // render positions in metres
    return this;
  }

  async target(name) {
    if (!this.cache.has(name)) {
      this.cache.set(name, this.loader.bytes(`targets/${name.replace(/\//g, '__')}.bin`).then(b => {
        const n = new Uint16Array(b, 0, 1)[0];
        return { n, idx: new Uint16Array(b, 2, n), d: new Int16Array(b.slice(2 + n * 2, 2 + n * 2 + n * 6)) };
      }));
    }
    return this.cache.get(name);
  }

  /** Apply macro values; returns the (re-used) render position array in metres. */
  async apply(macros) {
    const stack = targetStack(this.macro, macros), step = this.meta.deltaStep, w = this.work;
    w.set(this.base);
    for (const [name, weight] of stack) {
      const t = await this.target(name), k = weight * step;
      for (let i = 0; i < t.n; i++) {
        const v = t.idx[i] * 3, j = i * 3;
        w[v] += t.d[j] * k; w[v + 1] += t.d[j + 1] * k; w[v + 2] += t.d[j + 2] * k;
      }
    }
    const p = this.positions, orig = this.orig;
    for (let i = 0; i < orig.length; i++) {
      const s = orig[i] * 3, d = i * 3;
      p[d] = w[s] * 0.1; p[d + 1] = w[s + 1] * 0.1; p[d + 2] = w[s + 2] * 0.1;
    }
    this.lastStack = stack;
    return p;
  }
}

export const browserLoader = base => ({
  bytes: async p => (await fetch(base + p)).arrayBuffer(),
  json: async p => (await fetch(base + p)).json(),
});
