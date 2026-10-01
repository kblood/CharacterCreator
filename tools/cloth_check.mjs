// Clothing geometry checks shared by tests/clothing.test.mjs and the CLI report:
//   node tools/cloth_check.mjs [output-dir]
// Everything runs on the exported GLBs (what the viewer loads): morph targets, skin weights, joint rest TRS,
// inverse bind matrices, the body attribute _CCZONE and output/animations/*.json (the clips the viewer plays).
//
// Penetration = a garment vertex lies more than TOL inside a surface it must stay outside of:
//   * visible skin: nearest body vertex (within 3 cm) whose zone bits are not hidden by the outfit, signed
//     distance along that vertex's normal < -TOL (hidden body triangles are not drawn, so penetration there is
//     invisible and not counted);
//   * lower-layer garments of the same outfit (coat over T-shirt / jeans / skirt): same test against the lower
//     garment's vertices and normals.
// Poses: linear blend skinning with the clip rotations applied like tools/check_anim_glb.mjs (qToLocal of the
// JSON quaternions on the rest TRS, Root translation), neutral body.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, meshParts, jointNames } from './glb.mjs';
import * as Q from '../web/animation/qmath.js';

export const TOL = 0.002;          // m inside before a vertex counts as penetrating
const REACH = 0.03;                // m, only surfaces this close are considered

const PROJECT = fileURLToPath(new URL('..', import.meta.url));

export function kindOf(n) {
  return n.startsWith('face_') ? 'face' : n.startsWith('blink_') ? 'expr' : n.startsWith('look_') ? 'look'
    : n.startsWith('corr_') ? 'corr' : n.startsWith('bdet_') ? 'bdet' : n.startsWith('dyn_') ? 'dyn' : 'macro';
}

/** Weights { targetIndex: 1 } for the morphs `list` at full weight plus every corrective between two of them
 *  (what sliderInfluences gives at those slider extremes). Unknown names are skipped. */
export function combo(names, list) {
  const w = {};
  for (const n of list) if (names.includes(n)) w[names.indexOf(n)] = 1;
  for (const a of list) for (const b of list) { const k = names.indexOf(`corr_${a}__${b}`); if (k >= 0) w[k] = 1; }
  return w;
}

// Female breast shapes (the breast morphs are gated to a female adult at runtime, web/character.js breastGate):
// the extremes of size x firmness, x weight / muscle / age / proportions, the detail targets and the physics
// morphs at full deflection, all on the female body.
const F = 'gender_female';
export const BREAST_SHAPES = [
  ['breast_cup_max'], ['breast_cup_min'], ['breast_cup_max', 'breast_firm_min'], ['breast_cup_max', 'breast_firm_max'],
  ['breast_cup_max', 'weight_max'], ['breast_cup_max', 'weight_min'], ['breast_cup_max', 'muscle_max'],
  ['breast_cup_max', 'muscle_min'], ['breast_cup_max', 'age_old', 'breast_firm_min'], ['breast_cup_max', 'proportions_ideal'],
  ['breast_cup_max', 'bdet_breast_dist_decr'], ['breast_cup_max', 'bdet_breast_point_incr'],
  ['breast_cup_max', 'bdet_breast_height_incr'], ['breast_cup_max', 'bdet_breast_height_decr'],
  ...['up', 'down', 'left', 'right', 'fwd', 'back'].map(d => ['breast_cup_max', `dyn_breast_${d}`]),
].map(l => [F, ...l]);

/** Loads base + catalog + every garment GLB of `dir` (default output/). */
export function loadAll(dir = path.join(PROJECT, 'output')) {
  const G = readGlb(path.join(dir, 'base_body.glb'));
  const body = meshParts(G).Body.prims[0];
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'clothing.json'), 'utf8'));
  const names = meshParts(G).Body.targetNames;
  const zone = body.attr('_CCZONE');
  const garments = {};
  for (const it of catalog.items) {
    const g = readGlb(path.join(dir, it.file));
    const parts = Object.values(meshParts(g));
    garments[it.id] = { item: it, glb: g, parts, prim: parts[0].prims[0], targetNames: parts[0].targetNames,
      pin: parts[0].prims[0].attr('_CLOTH_PIN'), mesh: g.json.meshes[parts[0].nodeDef.mesh] };
  }
  const clips = {};
  const animDir = path.join(dir, 'animations');
  if (fs.existsSync(path.join(animDir, 'index.json'))) {
    for (const n of JSON.parse(fs.readFileSync(path.join(animDir, 'index.json'), 'utf8')).clips) {
      clips[n] = JSON.parse(fs.readFileSync(path.join(animDir, `${n}.json`), 'utf8'));
    }
  }
  return { dir, G, body, bodyIdx: body.indices, zone, names, catalog, garments, clips };
}

/** Positions of a prim with morph weights { targetIndex: w }. */
export function morphed(prim, weights) {
  const out = prim.pos.map(p => [...p]);
  for (const [t, w] of Object.entries(weights)) {
    const d = prim.targets[t];
    for (let i = 0; i < out.length; i++) {
      out[i][0] += w * d[i][0]; out[i][1] += w * d[i][1]; out[i][2] += w * d[i][2];
    }
  }
  return out;
}

/** Morph shapes to test: neutral, every macro extreme, every corrective corner (both macros + corrective). */
export function shapes(names) {
  const out = [{ name: 'neutral', w: {} }];
  names.forEach((n, t) => { if (kindOf(n) === 'macro') out.push({ name: n, w: { [t]: 1 } }); });
  names.forEach((n, t) => {
    if (kindOf(n) !== 'corr') return;
    const [a, b] = n.slice(5).split('__');
    out.push({ name: n, w: { [names.indexOf(a)]: 1, [names.indexOf(b)]: 1, [t]: 1 } });
  });
  if (names.includes('breast_cup_max')) for (const l of BREAST_SHAPES) out.push({ name: l.join('+'), w: combo(names, l) });
  return out;
}

export function vertexNormals(pos, idx) {
  const n = pos.map(() => [0, 0, 0]);
  for (let i = 0; i < idx.length; i += 3) {
    const a = pos[idx[i]], b = pos[idx[i + 1]], c = pos[idx[i + 2]];
    const f = Q.vCross(Q.vSub(b, a), Q.vSub(c, a));
    for (const k of [idx[i], idx[i + 1], idx[i + 2]]) { n[k][0] += f[0]; n[k][1] += f[1]; n[k][2] += f[2]; }
  }
  return n.map(Q.vNorm);
}

/** Nearest-vertex grid over `pos` (optionally only vertices with keep[i]). */
export function grid(pos, cell = 0.02, keep = null) {
  const m = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  pos.forEach((p, i) => {
    if (keep && !keep[i]) return;
    const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell));
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(i);
  });
  const r = Math.ceil(REACH / cell);
  return q => {
    const cx = Math.floor(q[0] / cell), cy = Math.floor(q[1] / cell), cz = Math.floor(q[2] / cell);
    let best = -1, bd = REACH * REACH;
    for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) for (let z = -r; z <= r; z++) {
      const l = m.get(key(cx + x, cy + y, cz + z));
      if (!l) continue;
      for (const i of l) {
        const p = pos[i], d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };
}

/** Count of `pts` more than TOL inside the surface (pos, normals), considering only surface vertices with keep[i]. */
export function countInside(pts, pos, normals, keep = null, tol = TOL, drawn = null, tris = null) {
  // keep: surface vertices searched at all; drawn: the nearest surface vertex must be drawn for the point to count
  // (a point under a hidden part of a lower garment is not visible through it).
  // tris (the surface's index buffer): a point flagged by the nearest-vertex plane must also lie more than tol inside
  // the nearest triangle of that vertex's 1-ring (signed along the face normal). The vertex plane alone flagged points
  // 2 mm OUTSIDE the skin at concave creases (panties at weight_max: 9 flagged, all +1.9..+2.0 mm over the true
  // triangles); a real penetration is inside its nearest triangle too and still counts.
  const near = grid(pos, 0.02, keep);
  const ring = tris ? vertexRings(pos.length, tris) : null;
  let n = 0, worst = 0;
  const idx = [];
  pts.forEach((p, k) => {
    const i = near(p);
    if (i < 0 || (drawn && !drawn[i])) return;
    let sd = Q.vDot(Q.vSub(p, pos[i]), normals[i]);
    if (sd < -tol && ring) sd = Math.max(sd, ringSigned(p, pos, tris, ring[i]));
    if (sd < -tol) { n++; idx.push(k); worst = Math.min(worst, sd); }
  });
  return { n, worst, idx };
}

function vertexRings(n, tris) {
  const r = Array.from({ length: n }, () => []);
  for (let t = 0; t < tris.length; t += 3) for (let j = 0; j < 3; j++) r[tris[t + j]].push(t);
  return r;
}

/** Signed distance (face normal) from p to the nearest of the triangles `ts` (offsets into tris). */
function ringSigned(p, pos, tris, ts) {
  let best = Infinity, sd = -Infinity;
  for (const t of ts) {
    const a = pos[tris[t]], b = pos[tris[t + 1]], c = pos[tris[t + 2]];
    const q = closestOnTri(p, a, b, c), d = Q.vSub(p, q), dd = Q.vDot(d, d);
    if (dd < best) { best = dd; sd = Q.vDot(d, Q.vNorm(Q.vCross(Q.vSub(b, a), Q.vSub(c, a)))); }
  }
  return sd;
}

function closestOnTri(p, a, b, c) {   // Ericson, Real-Time Collision Detection 5.1.5
  const ab = Q.vSub(b, a), ac = Q.vSub(c, a), ap = Q.vSub(p, a);
  const d1 = Q.vDot(ab, ap), d2 = Q.vDot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = Q.vSub(p, b), d3 = Q.vDot(ab, bp), d4 = Q.vDot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return Q.vAdd(a, Q.vScale(ab, v)); }
  const cp = Q.vSub(p, c), d5 = Q.vDot(ab, cp), d6 = Q.vDot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return Q.vAdd(a, Q.vScale(ac, w)); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return Q.vAdd(b, Q.vScale(Q.vSub(c, b), w)); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return Q.vAdd(a, Q.vAdd(Q.vScale(ab, v), Q.vScale(ac, w)));
}

/** Vertices of lower garment `u` still drawn while `ids` are worn: a triangle is dropped when its three vertices
 *  carry (attribute _CCZONE) a zone bit of a worn higher-layer item (web/clothing.js applyZones). */
export function drawnMask(D, u, ids) {
  const ug = D.garments[u], z = ug.prim.attr('_CCZONE'), idx = ug.prim.indices;
  const layer = ug.item.layer;
  const mask = hiddenMask(D.catalog, ids.filter(i => (D.garments[i]?.item.layer ?? 0) > layer));
  const keep = new Array(ug.prim.pos.length).fill(!z || !mask);
  if (!z || !mask) return keep;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if ((z[a] & mask) && (z[b] & mask) && (z[c] & mask)) continue;
    keep[a] = keep[b] = keep[c] = true;
  }
  return keep;
}

export function hiddenMask(catalog, ids) {
  let m = 0;
  for (const id of ids) for (const z of catalog.items.find(i => i.id === id)?.hidesBodyZones ?? []) m |= catalog.bodyZones[z] ?? 0;
  return m;
}

// ---- skinning -------------------------------------------------------------------------------------------
const mat = (q, t) => {                   // column-major 4x4 from rotation quaternion + translation
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, t[0], t[1], t[2], 1];
};
const mmul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

/** World matrices by node name for clip frame i (null clip = rest). */
export function poseWorld(G, clip, i) {
  const N = G.json.nodes, RW = {};
  const restW = k => {
    if (RW[k]) return RW[k];
    const r = N[k].rotation || [0, 0, 0, 1], p = G.parent[k];
    RW[k] = p === undefined ? r : Q.qMul(restW(p), r);
    return RW[k];
  };
  const byBone = clip ? Object.fromEntries(Object.entries(clip.boneMap).map(([j, b]) => [b, j])) : {};
  const W = {};
  const go = k => {
    if (W[k]) return W[k];
    const nd = N[k], p = G.parent[k];
    let r = nd.rotation || [0, 0, 0, 1], t = nd.translation || [0, 0, 0];
    const j = byBone[nd.name];
    if (clip && j && clip.joints[j]) r = Q.qToLocal(r, restW(k), clip.joints[j][i]);
    if (clip && nd.name === clip.rootBone) {
      const toParent = p === undefined ? [0, 0, 0, 1] : Q.qConj(restW(p));
      t = Q.vAdd(t, Q.qRotate(toParent, clip.root[i]));
    }
    const local = mat(r, t);
    W[k] = p === undefined ? local : mmul(go(p), local);
    return W[k];
  };
  const out = {};
  N.forEach((nd, k) => { out[nd.name] = go(k); });
  return out;
}

/** Linear blend skinning of positions `pos` of prim (joints/weights) in GLB g for world matrices `world`. */
export function skin(g, prim, pos, world) {
  const names = jointNames(g), ibm = g.accessor(g.json.skins[0].inverseBindMatrices);
  const M = names.map((n, j) => mmul(world[n], ibm[j]));
  return pos.map((p, i) => {
    const o = [0, 0, 0];
    prim.joints[i].forEach((j, k) => {
      const w = prim.weights[i][k];
      if (w <= 0) return;
      const q = xf(M[j], p);
      o[0] += w * q[0]; o[1] += w * q[1]; o[2] += w * q[2];
    });
    return o;
  });
}

/** Clip frames to sample (every `step`-th frame). */
export const frames = (clip, count = 8) => Array.from({ length: count }, (_, k) => Math.floor(k * clip.frames / count));

// ---- reports --------------------------------------------------------------------------------------------
/** Penetration of garment `id` (worn alone, or over `under` garments) at every shape. */
export function morphReport(D, id, under = []) {
  const gm = D.garments[id], idx = D.bodyIdx, mask = hiddenMask(D.catalog, [id, ...under]);
  const keep = D.zone.map(z => (z & mask) === 0);
  return shapes(D.names).map(s => {
    const body = morphed(D.body, s.w), bn = vertexNormals(body, idx);
    const pts = morphed(gm.prim, s.w);
    const r = { shape: s.name, skin: countInside(pts, body, bn, keep, TOL, null, idx).n, layers: 0 };
    for (const u of under) {
      const ug = D.garments[u], up = morphed(ug.prim, s.w);
      r.layers += countInside(pts, up, vertexNormals(up, ug.prim.indices), null, TOL, drawnMask(D, u, [id, ...under]), ug.prim.indices).n;
    }
    return r;
  });
}

/** Penetration + edge stretch of garment `id` (over `under`) in the frames of `clip`, neutral body. */
export function poseReport(D, id, clipName, under = [], count = 8) {
  const clip = D.clips[clipName], gm = D.garments[id], idx = D.bodyIdx, mask = hiddenMask(D.catalog, [id, ...under]);
  const keep = D.zone.map(z => (z & mask) === 0);
  const gi = gm.prim.indices, edges = new Set();
  for (let i = 0; i < gi.length; i += 3) for (const [a, b] of [[gi[i], gi[i + 1]], [gi[i + 1], gi[i + 2]], [gi[i + 2], gi[i]]]) edges.add(a < b ? `${a},${b}` : `${b},${a}`);
  const E = [...edges].map(s => s.split(',').map(Number));
  const rest = gm.prim.pos, len0 = E.map(([a, b]) => Q.vLen(Q.vSub(rest[a], rest[b])));
  return frames(clip, count).map(f => {
    const world = poseWorld(D.G, clip, f);
    const body = skin(D.G, D.body, D.body.pos, world), bn = vertexNormals(body, idx);
    const pts = skin(gm.glb, gm.prim, rest, world);
    const inside = countInside(pts, body, bn, keep, TOL, null, idx);
    let layers = 0;
    for (const u of under) {
      const ug = D.garments[u], up = skin(ug.glb, ug.prim, ug.prim.pos, world);
      layers += countInside(pts, up, vertexNormals(up, ug.prim.indices), null, TOL, drawnMask(D, u, [id, ...under]), ug.prim.indices).n;
    }
    const ratios = E.map(([a, b], k) => Q.vLen(Q.vSub(pts[a], pts[b])) / Math.max(len0[k], 1e-6)).sort((x, y) => x - y);
    // legs: garment vertices inside the (visible or not) thigh/calf skin = the coat skirt cutting into the legs
    const legIn = countInside(pts, body, bn, null, TOL, null, idx).idx.filter(k => rest[k][1] < 0.85 && rest[k][1] > 0.3).length;
    return { frame: f, skin: inside.n, worst: +(inside.worst * 1000).toFixed(1), layers, legInside: legIn,
      stretchMax: +ratios[ratios.length - 1].toFixed(3), stretchP99: +ratios[Math.floor(ratios.length * 0.99)].toFixed(3),
      squashMin: +ratios[0].toFixed(3) };
  });
}

/** Holes: body triangles hidden by `ids` (not drawn) that are not covered by a garment, i.e. a ray from the
 *  triangle centroid along its outward normal hits no garment triangle within `reach` m. */
export function holes(D, ids, reach = 0.2) {
  const mask = hiddenMask(D.catalog, ids), z = D.zone, idx = D.bodyIdx, P = D.body.pos;
  const tris = [];
  for (const id of ids) {
    const { pos, indices: gi } = D.garments[id].prim;
    for (let i = 0; i < gi.length; i += 3) {
      const t = [pos[gi[i]], pos[gi[i + 1]], pos[gi[i + 2]]];
      const c = Q.vScale(Q.vAdd(Q.vAdd(t[0], t[1]), t[2]), 1 / 3);
      tris.push({ t, c, r: Math.max(...t.map(p => Q.vLen(Q.vSub(p, c)))) });
    }
  }
  const hit = (o, d) => {
    for (const { t, c, r } of tris) {
      const oc = Q.vSub(c, o), s = Q.vDot(oc, d);
      if (s < -r || s > reach + r || Q.vDot(oc, oc) - s * s > r * r) continue;   // bounding sphere
      const e1 = Q.vSub(t[1], t[0]), e2 = Q.vSub(t[2], t[0]), pv = Q.vCross(d, e2), det = Q.vDot(e1, pv);
      if (Math.abs(det) < 1e-12) continue;
      const tv = Q.vSub(o, t[0]), u = Q.vDot(tv, pv) / det;
      if (u < 0 || u > 1) continue;
      const qv = Q.vCross(tv, e1), v = Q.vDot(d, qv) / det;
      if (v < 0 || u + v > 1) continue;
      const dist = Q.vDot(e2, qv) / det;
      if (dist > 0 && dist < reach) return true;
    }
    return false;
  };
  let hidden = 0, bad = 0;
  const where = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (!((z[a] & mask) && (z[b] & mask) && (z[c] & mask))) continue;
    hidden++;
    const m = Q.vScale(Q.vAdd(Q.vAdd(P[a], P[b]), P[c]), 1 / 3);
    const n = Q.vNorm(Q.vCross(Q.vSub(P[b], P[a]), Q.vSub(P[c], P[a])));
    if (!hit(m, n)) { bad++; where.push(m); }
  }
  return { hidden, bad, where };
}

// ---- CLI ------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const D = loadAll(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  const OUTFITS = { tshirt: [], jeans: [], skirt: [], shoes: [], trenchcoat: ['tshirt', 'jeans'] };
  const coatSkirt = D.catalog.items.some(i => i.id === 'skirt');
  for (const [id, under] of Object.entries(OUTFITS)) {
    if (!D.garments[id]) continue;
    const rows = morphReport(D, id, under);
    const bad = rows.filter(r => r.skin || r.layers);
    const nv = D.garments[id].prim.pos.length;
    console.log(`MORPH ${id}${under.length ? ' over ' + under.join('+') : ''} (${nv} verts): max skin ${Math.max(...rows.map(r => r.skin))}, ` +
      `max layers ${Math.max(...rows.map(r => r.layers))}; shapes with any: ${bad.map(r => `${r.shape}=${r.skin}/${r.layers}`).join(' ') || 'none'}`);
    for (const c of Object.keys(D.clips).filter(c => c !== 'idle')) {
      const pr = poseReport(D, id, c, under);
      console.log(`POSE  ${id} ${c}: ` + pr.map(r => `f${r.frame}: skin ${r.skin} (${r.worst} mm) layers ${r.layers} legs ${r.legInside} stretch ${r.stretchMax}/${r.stretchP99} squash ${r.squashMin}`).join(' | '));
    }
    console.log(`HOLES ${id}: ${JSON.stringify(holes(D, [id]))}`);
  }
  if (coatSkirt && D.garments.trenchcoat) {
    const rows = morphReport(D, 'trenchcoat', ['tshirt', 'skirt']);
    console.log(`MORPH trenchcoat over tshirt+skirt: max skin ${Math.max(...rows.map(r => r.skin))}, max layers ${Math.max(...rows.map(r => r.layers))}`);
  }
}
