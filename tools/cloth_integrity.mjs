// Cloth INTEGRITY harness: counts VISIBLE layer penetrations of worn outfits while the character animates, with
// cloth physics as the viewer runs it (web/cloth solver + lower layers, stepped like web/cloth/runtime.js incl. the
// worker's one-frame latency; deterministic; the real animator through tools/cloth_sim.mjs). Every pair of drawn
// surfaces, outer over inner by catalog layer (the body is innermost; CONFIG.split makes sub-parts such as the
// socks inside the shoes; a simulated skirt is tested in its SIMULATED shape), is checked every measured frame:
//   poke = an INNER vertex came out through the outer surface: the ray along its normal no longer hits the outer
//          surface, the ray backwards hits it within `reach` (the "blue hole": jeans / sock / skin through the
//          coat / shoe / skirt); depth = that distance;
//   sink = an OUTER vertex lies behind the inner surface: the ray along its normal hits the inner surface within
//          `reach` (the outer garment disappears behind the inner one).
// Only hits that can be SEEN count:
//   * drawn geometry only: body triangles hidden by the outfit's zones and garment triangles covered by a higher
//     layer (_CCZONE, web/clothing.js applyZones) are left out, exactly like the viewer;
//   * layered vertices only: in the bind pose the other surface covers the vertex (surfacePairs), so a hand beside
//     the hips or the sock cuff above the shoe are not pairs;
//   * triangles facing the same way only (dot >= align), so a coat panel that swung BEHIND a leg does not count;
//   * the ray outward from the hit must escape (no drawn surface within occludeDist): the T-shirt armpit behind
//     the arm and the coat sleeve is not visible.
//
//   node tools/cloth_integrity.mjs [--outfits a,b] [--bodies neutral,female] [--clips idle,run] [--every 3]
//        [--fps 60] [--worker 0|1] [--drawfix 0|1] [--bodylayer 0|1] [--simlayers 0|1] [--predict 0|1]
//        [--wind 0..1] [--cloth 0] [--json [file]] [--quiet] [--timeline default|moves]
//   --timeline moves: the extra clips instead of idle/walk/run (TIMELINES.moves: strafe left/right, walk backward,
//   a jump with its automatic return to idle, idle_fidget); optional, not part of the default matrix.
//   --timeline land: the airborne 'fall' loop and the 'land' one-shot (TIMELINES.land).
// Exit code 1 when any case is above its threshold (CONFIG.thresholds). tests/integrity.test.mjs runs a reduced
// matrix. docs/CLOTH_RUNTIME.md "Integrity harness" describes the numbers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, createCharacter, createGarmentSim, frameInputs, drawnParticles, targetWeights, BODIES } from './cloth_sim.mjs';
import { clothColliderDefs } from '../web/cloth/colliders.js';
import { morphBase, skinPositions, triNormals } from '../web/cloth/skin.js';
import { hiddenZoneMask, coveringZoneMask, collidesAsLayer, resolveOutfit, defaultUnderwear, isUnderwear } from '../web/clothing_rules.js';
import { LAYER_PARTS } from '../web/cloth/layers.js';
import { windVelocity } from '../web/cloth/wind.js';
import { advance } from '../web/cloth/solver.js';
import { createDrawFix } from '../web/cloth/drawfix.js';
import { LAYER_STRIDE } from '../web/cloth/layers.js';

// ---------------------------------------------------------------------------------------------------------------
export const CONFIG = {
  outfits: {
    'tee+jeans+shoes': ['tshirt', 'jeans', 'shoes'],
    'tee+jeans+coat+shoes': ['tshirt', 'jeans', 'shoes', 'trenchcoat'],
    'tee+skirt+shoes': ['tshirt', 'skirt', 'shoes'],
    'tee+skirt+coat': ['tshirt', 'skirt', 'trenchcoat'],
    'jeans+coat': ['jeans', 'trenchcoat'],
    'coat': ['trenchcoat'],                     // the coat over the underwear only (review 2026-10-01)
    'coat+shoes': ['trenchcoat', 'shoes'],
    'underwear': [],     // the default underwear of the body's sex only
    'hoodie+jeans+shoes': ['hoodie', 'jeans', 'shoes'],   // the hoodie conflicts with the coat (no hoodie+coat)
    'shirt+shorts+shoes': ['shirt', 'shorts', 'shoes'],
    'shirt+skirt': ['shirt', 'skirt'],
    'hoodie+skirt': ['hoodie', 'skirt'],
    'shirt+jeans+coat': ['shirt', 'jeans', 'trenchcoat'],
    // second garment batch (dress, jacket, boots); the jacket conflicts with hoodie / coat / dress, the dress with the
    // coat (tested as 'dress+coat' before the conflict: 13 failing cases on 9 bodies), boots = shoes slot
    'dress+shoes': ['dress', 'shoes'],
    'dress+boots': ['dress', 'boots'],
    'jacket+tee+jeans+shoes': ['tshirt', 'jeans', 'shoes', 'jacket'],
    'jacket+shirt+shorts+boots': ['shirt', 'shorts', 'boots', 'jacket'],
    'boots+jeans': ['jeans', 'boots'],
    'boots+shorts': ['shorts', 'boots'],
    'boots+skirt': ['skirt', 'boots'],
  },
  // every outfit is worn over the default underwear of the body's sex (like the viewer: web/clothing_rules.js
  // outfitWithUnderwear; female = gender < 0), unless the outfit lists an underwear item; false = no underwear
  underwear: true,
  // the 8 slider shapes of tools/cloth_sim.mjs + male (gender slider at +1; the male/female switch maps to it)
  bodies: { ...BODIES, male: { gender: 1 } },
  // one continuous run per outfit x body (the cloth carries its motion like in the viewer); [start s, label, clip]
  // 'idle>run' = the idle -> run crossfade (0.3 s) and the first second of run after it
  timeline: [[-1, 'preroll', 'idle'], [0, 'idle', 'idle'], [1.5, 'walk', 'walk'], [4.5, 'run', 'run'],
    [7, 'idle', 'idle'], [8.5, 'idle>run', 'run']],
  duration: 10,
  fps: 60,               // viewer frame rate (the cloth still steps at 60 Hz, max 4 steps per frame)
  worker: true,          // the viewer's default path: the worker's result is drawn one frame late, lag-compensated
                         // (x + A_now - A_ref, web/cloth/runtime.js writeProxy); false = the sync path (?clothWorker=0)
  drawFix: true,         // drawn-frame contacts (web/cloth/drawfix.js) as the viewer draws them; false = before them
  bodyLayer: true,       // the body's drawn leg / hip skin is a cloth layer (web/cloth/layers.js); false = before
  simLayers: true,       // a simulated lower garment (skirt under the coat) is a layer in its drawn shape; false = skinned
  predict: 1,            // worker jobs solved against inputs extrapolated one frame ahead (runtime.js); 0 = before
  every: 3,              // measure every n-th 60 Hz frame (20 Hz; scaled with fps)
  fade: 0.3,
  wind: 0,               // viewer wind slider (0..1), default 0 like ?wind
  tol: 0.002,            // m outside / inside before a vertex counts
  reach: 0.03,           // m, deepest penetration looked for (ray backwards / forwards)
  align: 0.3,            // min dot(point normal, triangle normal): the two surfaces are layered, not crossing at an angle
  coverDist: 0.15,       // m, a vertex is covered when the ray along its normal hits the outer surface this close
  occludeDist: 0.6,      // m, a hit only counts when the ray along its normal escapes: no drawn surface this close
  selfGap: 0.01,         // m, the vertex's own surface occludes it only beyond this distance
  // garments whose mesh holds an inner part: connected components (welded) with <= maxVerts vertices become a
  // separate surface `id` just inside the garment (layer + layerOffset), e.g. the socks inside the shoes
  split: { shoes: [{ id: 'socks', maxVerts: 400, layerOffset: -0.5 }],
    boots: [{ id: 'shaft', maxVerts: 400, layerOffset: -0.5 }] },     // the boot shaft (shoes03's sock) in the boot
  // A case (outfit x body x clip x pair) FAILS when, for poke or sink, the max per-frame vertex count > n AND the
  // deepest vertex > mm. The first matching rule wins (fields: outfit, body, clip, pair = 'outer:inner'; missing
  // = any). Default: at most 2 stray vertices, or any number shallower than 5 mm (a z-fight, not a hole).
  thresholds: [
    { n: 2, mm: 5 },
  ],
};

// ---------------------------------------------------------------------------------------------------------------
const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const labelAt = (T, t) => { let r = T[0]; for (const s of T) if (t >= s[0]) r = s; return r; };

/** Connected components (triangles + welded positions) of a garment: array of vertex index arrays. */
function components(pos, idx) {
  const n = pos.length / 3, par = Int32Array.from({ length: n }, (_, i) => i);
  const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[b] = a; };
  for (let i = 0; i < idx.length; i += 3) { u(idx[i], idx[i + 1]); u(idx[i], idx[i + 2]); }
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${pos[3 * i].toFixed(5)},${pos[3 * i + 1].toFixed(5)},${pos[3 * i + 2].toFixed(5)}`;
    if (seen.has(k)) u(i, seen.get(k)); else seen.set(k, i);
  }
  const C = new Map();
  for (let i = 0; i < n; i++) { const r = f(i); if (!C.has(r)) C.set(r, []); C.get(r).push(i); }
  return [...C.values()];
}

/**
 * The drawn surfaces of an outfit: [{ id, garment, layer, tris (drawn, vertex indices), sign (outward per
 * triangle), verts (drawn vertices), pos/nrm (world, all vertices of the source mesh), bone (dominant joint name
 * per vertex), update(sims) }].
 */
export function outfitSurfaces(D, ch, outfit, cfg = CONFIG) {
  const byId = id => D.catalog.items.find(i => i.id === id);
  const out = [];
  const add = (id, garment, g, layer, mask, keepVert) => {
    const tris = [], sign = [];
    const idx = g.index, P = g.positions, N = g.normals;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      if (keepVert && !(keepVert[a] && keepVert[b] && keepVert[c])) continue;
      if (mask && g.zone && (g.zone[a] & mask) && (g.zone[b] & mask) && (g.zone[c] & mask)) continue;
      const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
      const wx = P[3 * c] - P[3 * a], wy = P[3 * c + 1] - P[3 * a + 1], wz = P[3 * c + 2] - P[3 * a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      if (Math.hypot(nx, ny, nz) < 1e-14) continue;
      let s = 0;
      for (const i of [a, b, c]) s += nx * N[3 * i] + ny * N[3 * i + 1] + nz * N[3 * i + 2];
      tris.push(a, b, c); sign.push(s >= 0 ? 1 : -1);
    }
    const drawn = new Uint8Array(P.length / 3);
    for (const v of tris) drawn[v] = 1;
    const verts = Int32Array.from({ length: drawn.length }, (_, i) => i).filter(i => drawn[i]);
    const bone = new Array(drawn.length);
    for (const v of verts) {
      let bj = 0, bw = -1;
      for (let q = 0; q < 4; q++) if (g.skinWeight[4 * v + q] > bw) { bw = g.skinWeight[4 * v + q]; bj = g.skinIndex[4 * v + q]; }
      bone[v] = D.names[bj] || '?';
    }
    out.push({ id, garment, layer, tris: Int32Array.from(tris), sign: Int8Array.from(sign), verts, bone, g,
      pos: new Float32Array(P.length), nrm: new Float32Array(P.length), triN: new Float32Array(tris.length) });
  };
  for (const id of outfit) {
    const g = D.garments[id], it = byId(id), layer = it.layer ?? 0, mask = coveringZoneMask(D.catalog, outfit, id);
    const sp = cfg.split?.[id];
    if (sp) {
      const comps = components(g.positions, g.index), n = g.positions.length / 3;
      const rest = new Uint8Array(n).fill(1);
      for (const s of sp) {
        const keep = new Uint8Array(n);
        for (const c of comps) if (c.length <= s.maxVerts) for (const v of c) { keep[v] = 1; rest[v] = 0; }
        add(s.id, id, g, layer + (s.layerOffset ?? -0.5), mask, keep);
      }
      add(id, id, g, layer, mask, rest);
    } else add(id, id, g, layer, mask, null);
  }
  add('body', 'body', D.body, -1, hiddenZoneMask(D.catalog, outfit), null);
  // morphed bases (slider shape) for skinning
  for (const S of out) {
    const w = targetWeights(S.g.targetNames, ch.influences);
    S.base = morphBase(new Float32Array(S.g.positions.length), S.g.positions, S.g.targets.map((t, k) => (w[k] ? t : null)), w);
  }
  return out.filter(S => S.tris.length);
}

/** Positions (skinned, or simulated for a cloth garment) + oriented triangle / vertex normals of every surface. */
function updateSurfaces(D, ch, surfaces, sims, bind = false) {
  const px = new Map();
  for (const S of surfaces) {
    const sim = sims.find(s => s.id === S.garment);
    if (bind) S.pos.set(S.base);
    else if (sim) {
      // the proxy the viewer draws: welded particles, solver positions for the simulated ones
      let PX = px.get(S.garment);
      if (!PX) { PX = drawnParticles(D, sim.id, sim, ch, sim.drawX ?? sim.solver.positions()); px.set(S.garment, PX); }
      const vm = sim.model.vmap;
      for (let v = 0; v < S.pos.length / 3; v++) { const p = 3 * vm[v]; S.pos[3 * v] = PX[p]; S.pos[3 * v + 1] = PX[p + 1]; S.pos[3 * v + 2] = PX[p + 2]; }
    } else skinPositions(S.pos, S.base, S.g.skinIndex, S.g.skinWeight, ch.skinMats);
    const P = S.pos, T = S.tris, TN = S.triN, N = S.nrm;
    N.fill(0);
    for (let k = 0, t = 0; t < T.length; t += 3, k++) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const s = S.sign[k];
      const nx = s * (uy * vz - uz * vy), ny = s * (uz * vx - ux * vz), nz = s * (ux * vy - uy * vx);
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz; N[b] += nx; N[b + 1] += ny; N[b + 2] += nz; N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
      const l = Math.hypot(nx, ny, nz) || 1;
      TN[t] = nx / l; TN[t + 1] = ny / l; TN[t + 2] = nz / l;
    }
    for (let i = 0; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]); if (l > 1e-12) { N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; } }
    S.grid = null;
  }
}

const CELL = 0.04;
const hkey = (x, y, z) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
function triGrid(S, reach) {
  if (S.grid && S.grid.reach === reach) return S.grid;
  const g = new Map(), P = S.pos, T = S.tris;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < T.length; t += 3) {
    const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
    const l = [0, 1, 2].map(k => Math.floor((Math.min(P[a + k], P[b + k], P[c + k]) - reach) / CELL));
    const h = [0, 1, 2].map(k => Math.floor((Math.max(P[a + k], P[b + k], P[c + k]) + reach) / CELL));
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], l[k]); hi[k] = Math.max(hi[k], h[k]); }
    for (let x = l[0]; x <= h[0]; x++) for (let y = l[1]; y <= h[1]; y++) for (let z = l[2]; z <= h[2]; z++) {
      const k = hkey(x, y, z); let L = g.get(k); if (!L) g.set(k, (L = [])); L.push(t);
    }
  }
  S.grid = { g, lo, hi, reach };
  return S.grid;
}

/**
 * Nearest hit (distance t in (0, maxT]) of the ray p + t d with a triangle of surface B whose outward normal faces
 * like `ref` (dot >= align), or Infinity. Candidates come from B's grid cells along the ray.
 */
function rayHit(B, p, d, maxT, ref, align, minT = 0) {
  const { g } = triGrid(B, GRID_MARGIN);
  const Q = B.pos, T = B.tris, TN = B.triN;
  const stamp = (B.stamp ??= new Int32Array(T.length / 3)), id = (B.stampId = (B.stampId ?? 0) + 1);
  let best = Infinity, lastKey = null;
  for (let s = 0; s <= maxT + 1e-9; s += CELL / 2) {
    const k = hkey(Math.floor((p[0] + s * d[0]) / CELL), Math.floor((p[1] + s * d[1]) / CELL), Math.floor((p[2] + s * d[2]) / CELL));
    if (k === lastKey) continue;
    lastKey = k;
    const L = g.get(k);
    if (!L) continue;
    for (const t of L) {
      if (stamp[t / 3] === id) continue;
      stamp[t / 3] = id;
      if (ref && TN[t] * ref[0] + TN[t + 1] * ref[1] + TN[t + 2] * ref[2] < align) continue;
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const e1x = Q[b] - Q[a], e1y = Q[b + 1] - Q[a + 1], e1z = Q[b + 2] - Q[a + 2];
      const e2x = Q[c] - Q[a], e2y = Q[c + 1] - Q[a + 1], e2z = Q[c + 2] - Q[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det, tx = p[0] - Q[a], ty = p[1] - Q[a + 1], tz = p[2] - Q[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const h = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (h > minT && h <= maxT && h < best) best = h;
    }
  }
  return best;
}
const GRID_MARGIN = 0.03;   // triangles are binned with this margin; rays sample every CELL / 2 (< margin + CELL / 2)

/**
 * Visibility tests of one vertex v of surface A against surface B (A under B for 'poke', A over B for 'sink'):
 *   poke(A = inner, B = outer): the ray along v's normal no longer hits B within coverDist (nothing covers v) AND
 *        the ray backwards hits B within reach, i.e. v came out through B; returns the depth (m) or 0.
 *   sink(A = outer, B = inner): the ray along v's normal hits B within reach, i.e. the inner layer lies in front of
 *        the outer vertex, and its first hit with B is an exit face (v is inside B, not in front of a separate part
 *        of B such as a hand beside the hips); returns the depth or 0.
 */
const _p = [0, 0, 0], _n = [0, 0, 0], _m = [0, 0, 0];
function load(A, v) {
  _p[0] = A.pos[3 * v]; _p[1] = A.pos[3 * v + 1]; _p[2] = A.pos[3 * v + 2];
  _n[0] = A.nrm[3 * v]; _n[1] = A.nrm[3 * v + 1]; _n[2] = A.nrm[3 * v + 2];
  _m[0] = -_n[0]; _m[1] = -_n[1]; _m[2] = -_n[2];
  return _n[0] || _n[1] || _n[2];
}
// seen from outside at all? any drawn surface of the outfit (but `skip`) hit along the normal after minT occludes it
// (the armpit of the T-shirt behind the arm and the coat sleeve, a sock under the jeans hem)
// (the surface the vertex belongs to, `self`, only beyond selfGap: its own neighbouring triangles start at t = 0)
function occluded(all, self, minT, cfg) {
  for (const S of all) if (rayHit(S, _p, _n, cfg.occludeDist, null, 0, S === self ? Math.max(minT, cfg.selfGap) : minT) < Infinity) return true;
  return false;
}
function pokeDepth(I, O, v, cfg, all) {
  if (!load(I, v)) return 0;
  if (rayHit(O, _p, _n, cfg.coverDist, _n, cfg.align) < Infinity) return 0;
  const b = rayHit(O, _p, _m, cfg.reach, _n, cfg.align);
  if (!(b < Infinity && b > cfg.tol)) return 0;
  return occluded(all, I, cfg.tol, cfg) ? 0 : b;
}
function sinkDepth(O, I, v, cfg, all) {
  if (!load(O, v)) return 0;
  const f = rayHit(I, _p, _n, cfg.reach, _n, cfg.align);
  if (!(f < Infinity && f > cfg.tol)) return 0;
  // inside I means the ray LEAVES I first: an entry face (facing the vertex) before that exit face = the vertex is in
  // front of a separate part of I (a hand hanging at the coat's side), not sunk into it (review 2026-10-01)
  if (rayHit(I, _p, _n, f, _m, cfg.align) < f) return 0;
  return occluded(all.filter(S => S !== I), O, f + cfg.tol, cfg) ? 0 : f;
}

/**
 * Pairs (outer over inner) of an outfit's surfaces: outer.layer > inner.layer, with the vertices each side is
 * tested with: the ones LAYERED in the bind pose (slider shape, no animation). An inner vertex is layered when the
 * ray along its normal hits the outer surface within coverDist, or it already pokes through it (so a bind-pose
 * penetration still counts); an outer vertex when the ray against its normal hits the inner surface within
 * coverDist, or the inner already lies in front of it. A hand beside the hips, the sock cuff above the shoe or
 * the shoe below the jeans hem are side by side, not layered, and are not tested.
 * Call with the surfaces in their bind pose (updateSurfaces(..., bind = true)).
 */
export function surfacePairs(surfaces, cfg = CONFIG) {
  const pairs = [];
  for (const O of surfaces) for (const I of surfaces) {
    if (O === I || !(O.layer > I.layer)) continue;
    const ci = [], co = [];
    for (const v of I.verts) {
      if (!load(I, v)) continue;
      if (rayHit(O, _p, _n, cfg.coverDist, _n, cfg.align) < Infinity || rayHit(O, _p, _m, cfg.reach, _n, cfg.align) < Infinity) ci.push(v);
    }
    for (const v of O.verts) {
      if (!load(O, v)) continue;
      if (rayHit(I, _p, _m, cfg.coverDist, _n, cfg.align) < Infinity || rayHit(I, _p, _n, cfg.reach, _n, cfg.align) < Infinity) co.push(v);
    }
    if (ci.length || co.length) pairs.push({ O, I, key: `${O.id}:${I.id}`, innerCovered: Int32Array.from(ci), outerCovered: Int32Array.from(co) });
  }
  return pairs;
}

/** One measured frame: { 'outer:inner': { poke: { n, mm, at }, sink: { n, mm, at } } }. */
export function measure(pairs, cfg = CONFIG, all = [...new Set(pairs.flatMap(p => [p.O, p.I]))]) {
  const out = {};
  const rec = (r, S, v, s) => {
    r.n++;
    if (cfg.collect) (r.list ??= []).push([S.bone[v], ...[...S.pos.subarray(3 * v, 3 * v + 3)].map(x => +x.toFixed(3)), +(s * 1000).toFixed(0)]);
    if (s * 1000 > r.mm) { r.mm = s * 1000; r.at = { pos: [...S.pos.subarray(3 * v, 3 * v + 3)], bone: S.bone[v], v }; }
  };
  for (const { O, I, key, innerCovered, outerCovered } of pairs) {
    const r = { poke: { n: 0, mm: 0, at: null }, sink: { n: 0, mm: 0, at: null } };
    for (const v of innerCovered) { const s = pokeDepth(I, O, v, cfg, all); if (s) rec(r.poke, I, v, s); }
    for (const v of outerCovered) { const s = sinkDepth(O, I, v, cfg, all); if (s) rec(r.sink, O, v, s); }
    out[key] = r;
  }
  return out;
}
/** Garments of the outfit that the viewer simulates (cloth data) and the lower layers each collides with. */
// (+ the body's drawn leg / hip skin as the last part, like web/cloth/runtime.js syncLayers; cfg.bodyLayer)
function clothPlan(D, outfit, cfg = CONFIG) {
  const byId = id => D.catalog.items.find(i => i.id === id);
  const body = cfg.bodyLayer !== false;
  return outfit.filter(id => D.garments[id].pin && D.garments[id].extras).map(id => {
    const my = byId(id).layer ?? 0;
    const under = outfit.filter(u => u !== id && (byId(u).layer ?? 0) < my && collidesAsLayer(byId(u))).slice(0, LAYER_PARTS - (body ? 1 : 0));
    return { id, under: body ? [...under, 'body'] : under };
  });
}

/** The ids worn for outfit on a body: + the default underwear of its sex (cfg.underwear), rules applied. */
export function wornOutfit(catalog, outfit, bodyValues = {}, cfg = CONFIG) {
  const sex = (Number(bodyValues?.gender ?? 1) || 0) < 0 ? 'female' : 'male';
  const add = cfg.underwear !== false && !outfit.some(id => isUnderwear(catalog, id)) ? defaultUnderwear(catalog, sex) : [];
  return resolveOutfit(catalog, [...add, ...outfit]);
}

/** cur + k (cur - prev) for the first `cols` of every `stride` floats (k = 1: web/cloth/runtime.js extrapolate). */
function extrapolate(cur, prev, stride, cols = stride, k = 1) {
  const o = Float32Array.from(cur);
  for (let i = 0; i < cur.length; i += stride) for (let c = 0; c < cols; c++) o[i + c] = cur[i + c] + k * (cur[i + c] - prev[i + c]);
  return o;
}

/** Drawn shape of a simulated garment per vertex: { positions, normals } (world; welded triangle normals, oriented
 *  like the exported normals, as web/cloth/runtime.js writeProxy). */
function drawnVerts(D, s, ch) {
  const g = D.garments[s.id], m = s.model, n = g.positions.length / 3;
  const PX = drawnParticles(D, s.id, s, ch, s.drawX);
  if (!s.dv) {
    const PB = new Float32Array(m.particleCount * 3);
    for (let p = 0; p < m.particleCount; p++) PB.set(g.positions.subarray(3 * m.rep[p], 3 * m.rep[p] + 3), 3 * p);
    const NB = triNormals(new Float32Array(PB.length), PB, m.tris), sign = new Float32Array(n);
    for (let v = 0; v < n; v++) { const q = 3 * m.vmap[v]; sign[v] = NB[q] * g.normals[3 * v] + NB[q + 1] * g.normals[3 * v + 1] + NB[q + 2] * g.normals[3 * v + 2] < 0 ? -1 : 1; }
    s.dv = { sign, PN: new Float32Array(PB.length), positions: new Float32Array(3 * n), normals: new Float32Array(3 * n) };
  }
  const { sign, PN, positions, normals } = s.dv;
  triNormals(PN, PX, m.tris);
  for (let v = 0; v < n; v++) {
    const q = 3 * m.vmap[v];
    for (let c = 0; c < 3; c++) { positions[3 * v + c] = PX[q + c]; normals[3 * v + c] = sign[v] * PN[q + c]; }
  }
  return s.dv;
}

/** Optional timelines (--timeline <name>): same format as CONFIG.timeline. 'jump' is a one-shot: the animator
 *  returns to idle by itself ~2.1 s later (the label stays 'jump' until the next entry). */
export const TIMELINES = {
  moves: {
    timeline: [[-1, 'preroll', 'idle'], [0, 'idle', 'idle'], [1, 'strafe_left', 'strafe_left'], [3, 'strafe_right', 'strafe_right'],
      [5, 'walk_back', 'walk_back'], [7.5, 'idle', 'idle'], [8.5, 'jump', 'jump'], [11, 'idle_fidget', 'idle_fidget']],
    duration: 18.5,             // idle_fidget runs 7.5 s: shoulder roll + the forearm raise (3.2-7.4 s)
  },
  // the airborne loop at the jump apex, then 'land' (one-shot 1.06 s: touch-down, deep absorb, stand up; then idle)
  land: {
    timeline: [[-1, 'preroll', 'idle'], [0, 'idle', 'idle'], [1, 'fall', 'fall'], [2.5, 'land', 'land'], [4.5, 'idle', 'idle']],
    duration: 6,
  },
};

/**
 * Runs the timeline for one outfit on one body. Returns { outfit, body, frames, ms, pairs: { 'outer:inner':
 * { [label]: { poke: { n, mm, frames, at }, sink: {...} } } } } (max over the label's measured frames; `frames` =
 * measured frames with any hit; `at` = worst vertex: t, pos, bone).
 */
export function runCase(D, outfit, bodyValues, opt = {}) {
  const cfg = { ...CONFIG, ...opt.cfg };
  const { cloth = true, clips = null, onFrame = null, wind = cfg.wind } = opt;
  const t0 = performance.now();
  const ids = wornOutfit(D.catalog, outfit, bodyValues, cfg);
  const ch = createCharacter(D, bodyValues);
  const defs = clothColliderDefs(D.colliders), caps = new Float32Array(defs.length * 7);
  // inner cloth garments first (the coat collides with the skirt's DRAWN shape of this frame, as runtime.js)
  const layerOf = id => D.catalog.items.find(i => i.id === id)?.layer ?? 0;
  const sims = cloth ? clothPlan(D, ids, cfg).sort((a, b) => layerOf(a.id) - layerOf(b.id))
    .map(({ id, under }) => createGarmentSim(D, id, ch, opt.over?.[id] ?? {}, under, ids)) : [];
  const drawnOf = cfg.simLayers === false ? null : id => { const s = sims.find(q => q.id === id && q.drawX); return s ? drawnVerts(D, s, ch) : null; };
  if (cfg.drawFix) for (const s of sims) s.fix = createDrawFix(s.model.sim, s.params, s.limit);
  const surfaces = outfitSurfaces(D, ch, ids, cfg);
  updateSurfaces(D, ch, surfaces, sims, true);
  const pairList = surfacePairs(surfaces, cfg);
  // frames at cfg.fps; the cloth runs like web/cloth/runtime.js update(): fixed 60 Hz steps from an accumulator,
  // at most MAX_STEPS per frame, anchors / capsules / layers interpolated inside the frame (solver.js advance),
  // a reset + SETTLE static steps on the first frame; cfg.worker = the worker's one-frame latency, drawn with the
  // runtime's lag compensation (x + A_now - A_ref)
  const fps = cfg.fps, dt = 1 / fps, T = cfg.timeline, HZ = 60, MAX_STEPS = 4, SETTLE = 20;
  const every = Math.max(1, Math.round(cfg.every * fps / HZ));
  const n0 = Math.round(-T[0][0] * fps), n1 = Math.round(cfg.duration * fps);
  const pairs = {}, stretch = {};
  let curLabel = null, measured = 0, acc = 0, simTime = 0;
  for (let i = -n0; i <= n1; i++) {
    const t = i * dt, [, label, clip] = labelAt(T, t);
    if (label !== curLabel) { ch.animator.play(clip, { fade: curLabel ? cfg.fade : 0 }); curLabel = label; }
    ch.animator.update(i === -n0 ? 0 : dt);
    ch.update();
    const reset = i === -n0;
    acc += reset ? 0 : Math.min(dt, MAX_STEPS / HZ);
    let n = Math.floor(acc * HZ + 1e-6);
    if (n > MAX_STEPS) n = MAX_STEPS;
    acc = Math.max(0, acc - n / HZ);
    if (acc >= 1 / HZ) acc %= 1 / HZ;
    simTime += n / HZ;
    const f = frameInputs(D, ch, defs, caps, { t });
    // travel velocity of the blended clips (strafe: sideways, walk_back: backwards); == [0, 0, rootSpeed] for idle/walk/run
    const rv = ch.animator.state().rootVelocity || [0, 0, ch.animator.state().rootSpeed || 0];
    for (const s of sims) {
      const wv = windVelocity(wind * s.params.wind, simTime);   // as web/cloth/runtime.js: ui wind x garment wind
      const A1 = Float32Array.from(s.anchorsNow()), L = s.layerNow(drawnOf), L1 = L ? Float32Array.from(L) : null, C1 = Float32Array.from(caps);
      // worker + predict: the job is solved against the inputs extrapolated one frame ahead (the frame it is drawn
      // in), as web/cloth/runtime.js; the drawn lag compensation then only corrects the prediction error
      const k = +cfg.predict || 0, pred = cfg.worker && k > 0 && !reset && s.actA;
      const PA = pred ? extrapolate(A1, s.actA, 3, 3, k) : A1, PC = pred ? extrapolate(C1, s.actC, 7, 6, k) : C1;
      const PL = pred && L1 && s.actL?.length === L1.length ? extrapolate(L1, s.actL, LAYER_STRIDE, 3, k) : L1;
      s.actA = A1; s.actC = C1; s.actL = L1;
      const job = { n, A0: reset ? null : s.lastA, A1: PA, C0: reset ? null : s.lastC, C1: PC, L0: reset ? null : s.lastL, L1: PL,
        floorY: 0, lateral: f.lateral, air: [wv[0] - rv[0], wv[1] - rv[1], wv[2] - rv[2]], limit: s.limit, reset, settle: reset ? SETTLE : 0 };
      if (n > 0 || reset) {
        const X = Float32Array.from(advance(s.solver, job));
        // drawn this frame: sync = the fresh result; worker = the previous job's result, lag-compensated
        const cur = { X, A: PA, C: PC, L: PL };
        const show = !cfg.worker || !s.pend ? cur : s.pend;
        if (show !== s.show) { s.show = show; s.fix?.setRef(show.X, show.C, show.L); }
        s.pend = cur;
        s.lastA = PA; s.lastC = PC; s.lastL = PL;
      }
      const dx = s.drawX ??= new Float32Array(A1.length), { X: SX, A: SA } = s.show;
      for (let k = 0; k < dx.length; k++) dx[k] = SX[k] + A1[k] - SA[k];
      // drawn-frame contacts (web/cloth/drawfix.js, as web/cloth/runtime.js writeProxy)
      s.fix?.apply(dx, A1, C1, L1);
    }
    if (t < 0 || i % every !== 0 || (clips && !clips.includes(label))) continue;
    for (const s of sims) stretch[s.id] = Math.max(stretch[s.id] ?? 0, s.solver.stretch().p99);
    updateSurfaces(D, ch, surfaces, sims);
    const m = measure(pairList, cfg, surfaces);
    measured++;
    for (const [pk, r] of Object.entries(m)) {
      const P = (pairs[pk] ??= {}), L = (P[label] ??= { poke: { n: 0, mm: 0, frames: 0, at: null }, sink: { n: 0, mm: 0, frames: 0, at: null } });
      for (const k of ['poke', 'sink']) {
        const a = L[k], b = r[k];
        if (!b.n) continue;
        a.frames++; a.n = Math.max(a.n, b.n);
        if (b.mm > a.mm) { a.mm = +b.mm.toFixed(1); a.at = { t: +t.toFixed(3), pos: b.at.pos.map(x => +x.toFixed(3)), bone: b.at.bone }; }
      }
    }
    if (onFrame) onFrame({ t, label, surfaces, m, sims });
  }
  for (const k in stretch) stretch[k] = +stretch[k].toFixed(3);
  return { outfit: ids, body: bodyValues, measured, ms: Math.round(performance.now() - t0), pairs, stretch };
}

/** Threshold rule for a case (first match in cfg.thresholds). */
export function thresholdFor(c, cfg = CONFIG) {
  for (const r of cfg.thresholds) {
    if ((r.outfit == null || r.outfit === c.outfit) && (r.body == null || r.body === c.body)
      && (r.clip == null || r.clip === c.clip) && (r.pair == null || r.pair === c.pair)) return r;
  }
  return { n: 2, mm: 5 };
}

/** Flattens a matrix run into rows { outfit, body, pair, clip, poke, sink, limit, fail }. */
export function rows(results, cfg = CONFIG) {
  const out = [];
  for (const r of results) for (const [pair, byClip] of Object.entries(r.pairs)) for (const [clip, v] of Object.entries(byClip)) {
    const c = { outfit: r.name, body: r.bodyName, pair, clip };
    const lim = thresholdFor(c, cfg);
    const bad = k => v[k].n > lim.n && v[k].mm > lim.mm;
    out.push({ ...c, poke: v.poke, sink: v.sink, limit: { n: lim.n, mm: lim.mm }, fail: bad('poke') || bad('sink') });
  }
  return out;
}

/** Runs the matrix. opts: { outfits: names, bodies: names, clips, cloth, cfg, log }. */
export function runMatrix(D, opts = {}) {
  const cfg = { ...CONFIG, ...opts.cfg };
  const outfits = opts.outfits ?? Object.keys(cfg.outfits), bodies = opts.bodies ?? Object.keys(cfg.bodies);
  const results = [];
  for (const o of outfits) for (const b of bodies) {
    const r = runCase(D, cfg.outfits[o], cfg.bodies[b], { cloth: opts.cloth ?? true, clips: opts.clips, cfg });
    r.name = o; r.bodyName = b;
    results.push(r);
    opts.log?.(`# ${o} / ${b}: ${r.measured} frames, ${(r.ms / 1000).toFixed(1)} s${Object.entries(r.stretch).map(([k, v]) => `, ${k} stretch p99 ${v}`).join('')}`);
  }
  return results;
}

/** Text table: one line per outfit x body x pair with any hit, columns per clip "poke n/mm  sink n/mm". */
export function table(rs, clipOrder = [...new Set(CONFIG.timeline.map(x => x[1]).filter(l => l !== 'preroll'))]) {
  const key = r => `${r.outfit}|${r.body}|${r.pair}`, groups = new Map();
  for (const r of rs) { if (!groups.has(key(r))) groups.set(key(r), []); groups.get(key(r)).push(r); }
  const cell = v => (v.n ? `${v.n}/${Math.round(v.mm)}` : '-');
  const W = [22, 9, 20, 16, 16, 16, 16, 16], row = cols => cols.map((s, i) => String(s).padEnd(i < cols.length - 1 ? W[i] ?? 4 : 0)).join('');
  const lines = [row(['outfit', 'body', 'outer:inner', ...clipOrder.map(c => `${c} poke|sink`), ''])];
  for (const [, g] of groups) {
    if (!g.some(r => r.poke.n || r.sink.n)) continue;
    const r0 = g[0], by = Object.fromEntries(g.map(r => [r.clip, r]));
    const cols = clipOrder.map(c => (by[c] ? `${cell(by[c].poke)}|${cell(by[c].sink)}` : ''));
    lines.push(row([r0.outfit, r0.body, r0.pair, ...cols, g.some(r => r.fail) ? 'FAIL' : 'ok']));
  }
  return lines.join('\n');
}

/** Sum per outfit (over bodies, pairs, clips) of the max poke / sink counts, for a compact baseline. */
export function summary(rs) {
  const s = {};
  for (const r of rs) {
    const o = (s[r.outfit] ??= { cases: 0, failing: 0, pokeN: 0, pokeMm: 0, sinkN: 0, sinkMm: 0, pairs: {} });
    o.cases++; if (r.fail) o.failing++;
    o.pokeN += r.poke.n; o.sinkN += r.sink.n;
    o.pokeMm = Math.max(o.pokeMm, r.poke.mm); o.sinkMm = Math.max(o.sinkMm, r.sink.mm);
    if (r.poke.n || r.sink.n) {
      const p = (o.pairs[r.pair] ??= { pokeN: 0, pokeMm: 0, sinkN: 0, sinkMm: 0 });
      p.pokeN += r.poke.n; p.sinkN += r.sink.n; p.pokeMm = Math.max(p.pokeMm, r.poke.mm); p.sinkMm = Math.max(p.sinkMm, r.sink.mm);
    }
  }
  return s;
}

// ---- CLI --------------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : ''; };
  const list = k => { const v = opt(k); return v ? v.split(',') : undefined; };
  const outfits = list('--outfits'), bodies = list('--bodies'), clips = list('--clips');
  const every = opt('--every'), cloth = opt('--cloth'), json = opt('--json'), quiet = opt('--quiet') !== null, wind = opt('--wind');
  const fps = opt('--fps'), worker = opt('--worker'), drawFix = opt('--drawfix'), bodyLayer = opt('--bodylayer');
  const simLayers = opt('--simlayers'), predict = opt('--predict'), tl = opt('--timeline');
  if (tl && tl !== 'default' && !TIMELINES[tl]) throw new Error(`unknown --timeline ${tl} (${Object.keys(TIMELINES).join(', ')})`);
  const cfg = { ...(every ? { every: +every } : {}), ...(wind ? { wind: +wind } : {}), ...(fps ? { fps: +fps } : {}), ...(worker !== null ? { worker: worker !== '0' } : {}),
    ...(drawFix !== null ? { drawFix: drawFix !== '0' } : {}), ...(bodyLayer !== null ? { bodyLayer: bodyLayer !== '0' } : {}),
    ...(simLayers !== null ? { simLayers: simLayers !== '0' } : {}), ...(predict !== null ? { predict: +predict } : {}),
    ...(tl && TIMELINES[tl] ? TIMELINES[tl] : {}) };
  const D = loadData();
  const results = runMatrix(D, { outfits, bodies, clips, cloth: cloth !== '0', cfg, log: quiet ? null : m => console.error(m) });
  const rs = rows(results, { ...CONFIG, ...cfg });
  const failing = rs.filter(r => r.fail);
  if (json !== null) {
    const rep = { tool: 'cloth_integrity', cloth: cloth !== '0', config: { ...CONFIG, bodies: undefined, ...cfg }, summary: summary(rs), failing: failing.length, rows: rs };
    const s = JSON.stringify(rep, null, 1);
    if (json) fs.writeFileSync(path.resolve(json), s); else console.log(s);
  }
  if (json === null || json) {
    console.log(table(rs, [...new Set((cfg.timeline ?? CONFIG.timeline).map(x => x[1]).filter(l => l !== 'preroll'))]));
    console.log(`\n${failing.length} of ${rs.length} outfit x body x clip x pair cases above threshold${failing.length ? ' -> FAIL' : ' -> OK'}`);
  }
  process.exitCode = failing.length ? 1 : 0;
}
export { PROJECT };
