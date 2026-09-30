// Lower-layer collision surface for a cloth garment (pure JS, no three.js; docs/CLOTH_RUNTIME.md "Layers").
// The body capsules are fitted to the SKIN; the garments worn under the cloth (jeans, T-shirt, skirt) lie outside
// them by up to ~45 mm (loose jeans legs, the T-shirt hem over the hips), more than the cloth thickness covers. So
// the free cloth also collides with the actual skinned lower-layer surfaces: every frame the lower garments'
// vertices near the cloth's free part are morphed + skinned (position + normal); the solver keeps each free
// particle on the outer side of its nearest layer point's tangent plane (solver.js, layer collision).
import { morphBase, skinPositions } from './skin.js';

export const LAYER_SELECT = 0.12;   // m: lower-layer vertices within this bind distance of a free cloth particle
export const LAYER_STRIDE = 7;      // floats per layer point: x, y, z, nx, ny, nz, part
export const LAYER_PARTS = 4;       // the solver keeps one nearest point per part (garment); parts beyond are ignored

/**
 * Indices of the vertices of `positions` (bind space, n*3) within `radius` of any of `freeBind` (bind positions of
 * the cloth's free particles, k*3). Grid of `radius` cells.
 */
export function selectLayerVertices(positions, freeBind, radius = LAYER_SELECT) {
  const cell = radius, grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  for (let i = 0; i < freeBind.length / 3; i++) {
    const k = key(Math.floor(freeBind[3 * i] / cell), Math.floor(freeBind[3 * i + 1] / cell), Math.floor(freeBind[3 * i + 2] / cell));
    let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
  }
  const out = [], r2 = radius * radius;
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let hit = false;
    for (let a = -1; a <= 1 && !hit; a++) for (let b = -1; b <= 1 && !hit; b++) for (let c = -1; c <= 1 && !hit; c++) {
      const l = grid.get(key(cx + a, cy + b, cz + c));
      if (!l) continue;
      for (const i of l) if ((freeBind[3 * i] - x) ** 2 + (freeBind[3 * i + 1] - y) ** 2 + (freeBind[3 * i + 2] - z) ** 2 < r2) { hit = true; break; }
    }
    if (hit) out.push(v);
  }
  return Int32Array.from(out);
}

/**
 * Collision points of the selected lower-layer vertices. parts: [{ positions, normals, skinIndex, skinWeight,
 * targets: [Float32Array|null], list: Int32Array }] (garment arrays in bind space; skinIndex into the shared
 * skeleton). Returns { count, out: Float32Array(count * LAYER_STRIDE) [x, y, z, nx, ny, nz, part] world, update(matsOf, inflOf) }
 * where matsOf(k) = skinning matrices of part k (skin.js layout) and inflOf(k) = its morph influences (array in
 * target order; the morphed base is recomputed only when they change).
 */
export function createLayerSet(parts) {
  const P = parts.map(p => {
    const m = p.list.length, pick = (src, w) => { const o = new src.constructor(m * w); p.list.forEach((v, k) => o.set(src.subarray(w * v, w * v + w), w * k)); return o; };
    return {
      bind: pick(p.positions, 3), nrm: pick(p.normals, 3), si: pick(p.skinIndex, 4), sw: pick(p.skinWeight, 4),
      targets: (p.targets || []).map(t => (t ? pick(t, 3) : null)), base: new Float32Array(m * 3), last: null,
      pos: new Float32Array(m * 3), n: new Float32Array(m * 3), count: m,
    };
  });
  const count = P.reduce((a, p) => a + p.count, 0);
  const out = new Float32Array(count * LAYER_STRIDE);
  function update(matsOf, inflOf) {
    let o = 0;
    P.forEach((p, k) => {
      const infl = inflOf?.(k) || [];
      let changed = !p.last || p.last.length !== infl.length;
      if (!changed) for (let t = 0; t < infl.length; t++) if (Math.abs((infl[t] || 0) - p.last[t]) > 1e-6) { changed = true; break; }
      if (changed) {
        p.last = Float32Array.from(infl, w => w || 0);
        morphBase(p.base, p.bind, p.targets.map((t, i) => (p.last[i] ? t : null)), p.last);
      }
      const mats = matsOf(k);
      skinPositions(p.pos, p.base, p.si, p.sw, mats);
      // normals: linear part of the blended matrix (as skin.js skinNormals)
      for (let i = 0; i < p.count; i++) {
        const x = p.nrm[3 * i], y = p.nrm[3 * i + 1], z = p.nrm[3 * i + 2];
        let nx = 0, ny = 0, nz = 0;
        for (let j = 0; j < 4; j++) {
          const w = p.sw[4 * i + j];
          if (!w) continue;
          const b = 16 * p.si[4 * i + j];
          nx += w * (mats[b] * x + mats[b + 4] * y + mats[b + 8] * z);
          ny += w * (mats[b + 1] * x + mats[b + 5] * y + mats[b + 9] * z);
          nz += w * (mats[b + 2] * x + mats[b + 6] * y + mats[b + 10] * z);
        }
        const l = Math.hypot(nx, ny, nz) || 1;
        out[o] = p.pos[3 * i]; out[o + 1] = p.pos[3 * i + 1]; out[o + 2] = p.pos[3 * i + 2];
        out[o + 3] = nx / l; out[o + 4] = ny / l; out[o + 5] = nz / l; out[o + 6] = k;
        o += LAYER_STRIDE;
      }
    });
    return out;
  }
  return { count, out, update };
}
