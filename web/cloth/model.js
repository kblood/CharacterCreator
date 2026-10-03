// SPDX-License-Identifier: GPL-3.0-or-later
// Cloth model builder (pure JS, no three.js): garment vertex arrays + ccCloth extras -> the particle system the
// solver runs (docs/CLOTH_RUNTIME.md).
//
// * The GLB splits vertices at UV seams / normal splits; particles are the WELDED vertices (same bind position),
//   so a seam never tears and normals can be computed across it.
// * Simulated set = particles with pin < PIN_FIXED (free, weight 1) + every pinned particle that shares a
//   constraint with one of them (kinematic, weight 0, follows the skinned position). Everything else is pure
//   skinning. So the collar / shoulders / sleeves of a coat cost nothing.
// * Constraints (index pairs into the simulated set):
//     edges    - every triangle edge (stretch / compression; the quad diagonals act as shear),
//     bends    - "skip-one" pairs a-c of nearly straight chains a-b-c (angle > 150 deg); vertical ones (bind
//                direction mostly along Y) are flagged, so long panels can be stiffer along their length,
//     mirrors  - open-edge particle pairs mirrored across x = 0 (front opening, back vent): the left one must stay
//                on the character's left of the right one (the front panels never cross).
// * Rest lengths come from the MORPHED bind positions (restLengths()), so a tall body gets a longer coat.
export const PIN_FIXED = 0.999;

const keyOf = (p, i) => `${Math.round(p[3 * i] * 1e5)},${Math.round(p[3 * i + 1] * 1e5)},${Math.round(p[3 * i + 2] * 1e5)}`;

/**
 * src: { positions: Float32Array(n*3) bind space, index: Uint16|Uint32Array, pin: Float32Array(n) }
 * Returns the model (typed arrays only, so it can be posted to a worker).
 */
export function buildClothModel(src) {
  const { positions, index, pin } = src;
  const n = positions.length / 3;
  // ---- weld
  const vmap = new Int32Array(n), rep = [], keys = new Map();
  for (let i = 0; i < n; i++) {
    const k = keyOf(positions, i);
    let p = keys.get(k);
    if (p === undefined) { p = rep.length; keys.set(k, p); rep.push(i); }
    vmap[i] = p;
  }
  const P = rep.length;
  const ppin = new Float32Array(P);
  for (let p = 0; p < P; p++) ppin[p] = 1;
  for (let i = 0; i < n; i++) ppin[vmap[i]] = Math.min(ppin[vmap[i]], pin ? pin[i] : 1);
  const tris = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = vmap[index[t]], b = vmap[index[t + 1]], c = vmap[index[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  // ---- adjacency (particle level)
  const edgeUse = new Map();
  const ek = (a, b) => (a < b ? a * P + b : b * P + a);
  for (let t = 0; t < tris.length; t += 3) {
    for (const [a, b] of [[tris[t], tris[t + 1]], [tris[t + 1], tris[t + 2]], [tris[t + 2], tris[t]]]) {
      const k = ek(a, b);
      edgeUse.set(k, (edgeUse.get(k) || 0) + 1);
    }
  }
  const nbr = Array.from({ length: P }, () => []);
  const allEdges = [];
  for (const [k, c] of edgeUse) {
    const a = Math.floor(k / P), b = k % P;
    nbr[a].push(b); nbr[b].push(a);
    allEdges.push([a, b, c === 1]);
  }
  const pos = p => { const i = rep[p]; return [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]; };
  const free = p => ppin[p] < PIN_FIXED;
  // ---- skip-one bending pairs (straight chains through a free particle)
  const bendSet = new Map();
  for (let b = 0; b < P; b++) {
    const B = pos(b), ns = nbr[b];
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], c = ns[j];
        if (!free(a) && !free(b) && !free(c)) continue;
        const A = pos(a), C = pos(c);
        const u = [A[0] - B[0], A[1] - B[1], A[2] - B[2]], v = [C[0] - B[0], C[1] - B[1], C[2] - B[2]];
        const lu = Math.hypot(...u), lv = Math.hypot(...v);
        if (lu < 1e-6 || lv < 1e-6) continue;
        const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
        if (cos > -0.866) continue;                   // angle < 150 deg: not a chain
        const k = ek(a, c);
        if (edgeUse.has(k) || bendSet.has(k)) continue;
        const d = [C[0] - A[0], C[1] - A[1], C[2] - A[2]], L = Math.hypot(...d);
        bendSet.set(k, Math.abs(d[1]) / L > 0.7 ? 1 : 0);
      }
    }
  }
  // ---- simulated set
  const inSim = new Int32Array(P).fill(-1), simList = [];
  const addSim = p => { if (inSim[p] < 0) { inSim[p] = simList.length; simList.push(p); } };
  for (let p = 0; p < P; p++) if (free(p)) addSim(p);
  for (const [a, b] of allEdges) if (free(a) || free(b)) { addSim(a); addSim(b); }
  for (const k of bendSet.keys()) { const a = Math.floor(k / P), c = k % P; addSim(a); addSim(c); }
  const S = simList.length;
  const edges = [], bends = [], bendVert = [];
  for (const [a, b] of allEdges) if (free(a) || free(b)) edges.push(inSim[a], inSim[b]);
  for (const [k, vert] of bendSet) { bends.push(inSim[Math.floor(k / P)], inSim[k % P]); bendVert.push(vert); }
  const simTris = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = inSim[tris[t]], b = inSim[tris[t + 1]], c = inSim[tris[t + 2]];
    if (a >= 0 && b >= 0 && c >= 0) simTris.push(a, b, c);
  }
  // ---- mirror pairs on open edges (x -> -x within 2 cm), both simulated, one of them free
  const open = new Uint8Array(P);
  for (const [a, b, isOpen] of allEdges) if (isOpen) { open[a] = 1; open[b] = 1; }
  const mirrors = [];
  const cand = [];
  for (let p = 0; p < P; p++) if (open[p] && inSim[p] >= 0 && pos(p)[0] > 0 && pos(p)[0] < 0.12) cand.push(p);
  const right = [];
  for (let p = 0; p < P; p++) if (open[p] && inSim[p] >= 0 && pos(p)[0] < 0 && pos(p)[0] > -0.12) right.push(p);
  for (const l of cand) {
    const L = pos(l);
    let best = -1, bd = 0.02;
    for (const r of right) {
      const R = pos(r), d = Math.hypot(L[0] + R[0], L[1] - R[1], L[2] - R[2]);
      if (d < bd) { bd = d; best = r; }
    }
    if (best >= 0 && (free(l) || free(best))) mirrors.push(inSim[l], inSim[best]);
  }
  const simPin = new Float32Array(S);
  for (let s = 0; s < S; s++) simPin[s] = ppin[simList[s]];
  return {
    vertexCount: n, particleCount: P, vmap, rep: Int32Array.from(rep), pin: ppin,
    tris: Uint32Array.from(tris),
    sim: {
      count: S, particles: Int32Array.from(simList), pin: simPin,
      edges: Uint32Array.from(edges), bends: Uint32Array.from(bends), bendVertical: Uint8Array.from(bendVert),
      mirrors: Uint32Array.from(mirrors), tris: Uint32Array.from(simTris),
    },
  };
}

/** Rest lengths of pairs (flat index array into the simulated set) from particle positions X (sim order, n*3). */
export function restLengths(pairs, X) {
  const R = new Float32Array(pairs.length / 2);
  for (let k = 0; k < R.length; k++) {
    const a = pairs[2 * k], b = pairs[2 * k + 1];
    R[k] = Math.hypot(X[3 * a] - X[3 * b], X[3 * a + 1] - X[3 * b + 1], X[3 * a + 2] - X[3 * b + 2]);
  }
  return R;
}

/** Lateral rest separation of the mirror pairs (x_left - x_right in bind space, before any pose). */
export function mirrorRest(mirrors, X) {
  const R = new Float32Array(mirrors.length / 2);
  for (let k = 0; k < R.length; k++) R[k] = X[3 * mirrors[2 * k]] - X[3 * mirrors[2 * k + 1]];
  return R;
}
