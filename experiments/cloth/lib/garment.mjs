// SPDX-License-Identifier: GPL-3.0-or-later
// Procedural test garment: an A-line skirt made of `around` x `rows` vertices, fitted to one body from
// data/bodies.json (silhouette rows + capsules at rest). Row 0 = waistband, pinned by the mask.
// Portable data: pos (rest, character frame), tris, mask (-> glTF COLOR_0.r), and the cloth extras.
import { PROFILE_BINS, CAPSULES, capsuleEnds } from './bodies.mjs';

export const RES = { 500: { around: 32, rows: 16 }, 2000: { around: 64, rows: 32 } };

/** Default portable cloth parameters (glTF mesh extras "cloth"). Units SI; see the report for engine mapping. */
export const CLOTH_EXTRAS = {
  version: 1,
  mask: 'COLOR_0.r: 1 = follows the skin (pinned), 0 = fully simulated; maxDistance_i = (1 - mask_i) * maxDistance',
  maxDistance: 0.6,        // m
  stretchStiffness: 1.0,   // 0..1 (1 = inextensible)
  bendStiffness: 0.05,     // 0..1
  damping: 0.4,            // 1/s linear air drag relative to wind
  gravity: [0, -9.81, 0],  // m/s^2
  wind: [0, 0, 0],         // m/s air velocity (world)
  thickness: 0.008,        // m collision offset
  colliders: 'capsules on bones, see lib/bodies.mjs CAPSULES (joint -> joint, radius per body)',
};

function profileAt(body, y, theta) {
  const rows = body.profile.rows;
  let k = rows.findIndex(r => r.y <= y);
  if (k < 0) k = rows.length - 1;
  const B = PROFILE_BINS, f = ((theta / (2 * Math.PI)) * B % B + B) % B;
  const i0 = Math.floor(f);
  let m = 0;
  for (let d = -2; d <= 3; d++) m = Math.max(m, rows[k].r[((i0 + d) % B + B) % B]);   // widen: +-10 deg
  return m;
}

function segClosest(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / L2));
  return [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
}

export function buildSkirt(body, n = 500, { flare = 0.10, margin = 0.012 } = {}) {
  const { around, rows } = RES[n] || n;
  const H = body.heads;
  const yTop = H.spine[1];
  const yHem = (H.leftLowerLeg[1] + H.rightLowerLeg[1]) / 2 - 0.03;       // just below the knee
  const cz = body.profile.cz;
  const N = around * rows;
  const pos = new Float32Array(N * 3), mask = new Float32Array(N), row = new Uint16Array(N);
  // Radius per row and angle, every vertex on its own ray from the body axis (0, y, cz):
  //  1. silhouette (empty bins filled with the row median), cumulative max from the waist down (never tucks in)
  //  2. + margin + flare, then pushed out along the ray until outside the rest capsules (+margin)
  //  3. slope limit around the ring (r_i >= r_j - |i-j| * 0.35 * dTheta * median): only grows, so it stays
  //     collision free, and neighbouring ring edges cannot collapse or jump (clean rest lengths).
  const caps = CAPSULES.map(def => { const [a, b] = capsuleEnds(def, H); return { a, b, r: body.capsules[def[0]].r }; });
  const inside = p => caps.some(c => { const q = segClosest(p, c.a, c.b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < c.r + margin; });
  const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];
  const envelope = new Array(around).fill(0);
  for (let j = 0; j < rows; j++) {
    const s = j / (rows - 1), y = yTop + (yHem - yTop) * s;
    const prof = Array.from({ length: around }, (_, i) => profileAt(body, y, (2 * Math.PI * i) / around));
    const med = median(prof);
    const r = prof.map((p, i) => {
      envelope[i] = Math.max(envelope[i], p < 0.5 * med ? med : p);
      const th = (2 * Math.PI * i) / around, sn = Math.sin(th), cs = Math.cos(th);
      let R = envelope[i] + (j === 0 ? 0.004 : margin) + flare * Math.pow(s, 1.3);
      if (j > 0) for (let k = 0; k < 200 && inside([R * sn, y, cz + R * cs]); k++) R += 0.002;
      return R;
    });
    const slope = 0.35 * (2 * Math.PI / around) * median(r);
    const lim = r.map((_, i) => { let m = 0; for (let d = 0; d < around; d++) m = Math.max(m, r[(i + d) % around] - Math.min(d, around - d) * slope); return m; });
    for (let i = 0; i < around; i++) {
      envelope[i] = Math.max(envelope[i], lim[i] - (j === 0 ? 0.004 : margin) - flare * Math.pow(s, 1.3));
      const th = (2 * Math.PI * i) / around, v = j * around + i;
      pos[3 * v] = lim[i] * Math.sin(th); pos[3 * v + 1] = y; pos[3 * v + 2] = cz + lim[i] * Math.cos(th);
      mask[v] = j === 0 ? 1 : 0; row[v] = j;
    }
  }
  const id = (i, j) => j * around + ((i % around) + around) % around;
  const tris = [], edges = [], shear = [], bends = [], dihedrals = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < around; i++) {
    edges.push(id(i, j), id(i + 1, j));                                   // around (ring)
    if (j + 1 < rows) {
      edges.push(id(i, j), id(i, j + 1));                                 // down
      shear.push(id(i, j), id(i + 1, j + 1), id(i + 1, j), id(i, j + 1));
      tris.push(id(i, j), id(i, j + 1), id(i + 1, j), id(i + 1, j), id(i, j + 1), id(i + 1, j + 1));
      // dihedral across the diagonal (shared edge a-b, opposite c,d)
      dihedrals.push(id(i, j + 1), id(i + 1, j), id(i, j), id(i + 1, j + 1));
      // across the vertical edge (i+1, j)-(i+1, j+1) between quad i and quad i+1
      dihedrals.push(id(i + 1, j), id(i + 1, j + 1), id(i, j + 1), id(i + 2, j));
    }
    bends.push(id(i, j), id(i + 2, j));                                   // skip-one bending
    if (j + 2 < rows) bends.push(id(i, j), id(i, j + 2));
  }
  const len = (a, b) => Math.hypot(pos[3 * a] - pos[3 * b], pos[3 * a + 1] - pos[3 * b + 1], pos[3 * a + 2] - pos[3 * b + 2]);
  const rest = arr => Float32Array.from({ length: arr.length / 2 }, (_, k) => len(arr[2 * k], arr[2 * k + 1]));
  return {
    around, rows, count: N, pos, mask, row,
    tris: Uint32Array.from(tris), edges: Uint32Array.from(edges), shear: Uint32Array.from(shear),
    bends: Uint32Array.from(bends), dihedrals: Uint32Array.from(dihedrals),
    edgeRest: rest(edges), shearRest: rest(shear), bendRest: rest(bends),
    yTop, yHem,
  };
}
