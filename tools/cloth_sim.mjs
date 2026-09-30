// Headless cloth harness: the viewer's cloth runtime (web/cloth: model, skin, solver, colliders) driven by the
// REAL animator (web/animation) on a duck-typed copy of the exported skeleton, with slider joint offsets applied
// like character.js applySkeleton (bone positions + rebased inverse bind matrices). Used by tests/cloth.test.mjs
// and as a report:
//   node tools/cloth_sim.mjs [garment ...] [--bodies neutral,tall,...] [--seconds 10] [--under tshirt,jeans]
// --under: lower layers worn under the garment -> "layer" = visible-layer penetration (layer/body vertices showing
// through the simulated cloth, pokeThrough()) per layer, max over frames and per clip; "layerSkin" = the same for
// the skinned garment (cloth off).
// Timeline (like experiments/cloth): 1 s idle preroll, walk 0-3 s, run 3-5.5 s, idle 5.5-7.5 s, idle->run 7.5-10 s,
// 0.3 s crossfades, 60 Hz. The character runs in place (root motion is only reported, as in the viewer): the
// air moves past it at the animator's rootSpeed instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, meshParts, jointNames } from './glb.mjs';
import { createHumanoid } from '../web/humanoid.js';
import { createAnimator } from '../web/animation/animator.js';
import { sliderInfluences } from '../web/character.js';
import { buildClothModel } from '../web/cloth/model.js';
import { createSolver, clothParams, hashFloats } from '../web/cloth/solver.js';
import { morphBase, skinPositions, skinNormals } from '../web/cloth/skin.js';
import { clothColliderDefs, evalColliders, limitFlags } from '../web/cloth/colliders.js';
import { windVelocity } from '../web/cloth/wind.js';
import { hiddenZoneMask, coveringZoneMask, collidesAsLayer } from '../web/clothing_rules.js';
import { createLayerSet, selectLayerVertices } from '../web/cloth/layers.js';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
export const OUT = path.join(PROJECT, 'output');
export const BODIES = {
  neutral: {}, tall: { height: 1 }, short: { height: -1 }, heavy: { weight: 1 }, child: { age: -1 },
  old: { age: 1 }, muscular: { muscle: 1 }, female: { gender: -1 },
};
export const HZ = 60, PREROLL = 1.0, DURATION = 10.0;
export const TIMELINE = [[-PREROLL, 'idle'], [0, 'walk'], [3, 'run'], [5.5, 'idle'], [7.5, 'run']];
export const clipAt = t => { let c = TIMELINE[0][1]; for (const [s, n] of TIMELINE) if (t >= s) c = n; return c; };

// ---- column-major 4x4 helpers (Float64Array(16)) ----
const M4 = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul(a, b, o = new Float64Array(16)) {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[4 * c + r] = a[r] * b[4 * c] + a[4 + r] * b[4 * c + 1] + a[8 + r] * b[4 * c + 2] + a[12 + r] * b[4 * c + 3];
  }
  return o;
}
function compose(p, q, s = [1, 1, 1]) {
  const [x, y, z, w] = q, m = new Float64Array(16);
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
  m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1;
  return m;
}
function invert(m) {                    // general 4x4 inverse
  const a = m, o = new Float64Array(16);
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return o;
}
const flat = a => Float32Array.from(a.flat());

// ---- data ----
const cache = new Map();
export function loadData(dir = OUT) {
  if (cache.has(dir)) return cache.get(dir);
  const G = readGlb(path.join(dir, 'base_body.glb'));
  const parts = meshParts(G);
  const body = parts.Body;
  const joints = JSON.parse(fs.readFileSync(path.join(dir, 'base_body.joints.json'), 'utf8'));
  const colliders = JSON.parse(fs.readFileSync(path.join(dir, 'body_colliders.json'), 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'clothing.json'), 'utf8'));
  const names = jointNames(G), ibm = G.accessor(G.json.skins[0].inverseBindMatrices).map(m => Float64Array.from(m));
  const garments = {};
  for (const it of catalog.items) {
    const g = readGlb(path.join(dir, it.file));
    const gp = Object.values(meshParts(g))[0], prim = gp.prims[0];
    const gnames = jointNames(g), remap = gnames.map(n => names.indexOf(n));
    garments[it.id] = {
      item: it, extras: gp.mesh.extras?.ccCloth ?? null, targetNames: gp.targetNames,
      positions: flat(prim.pos), index: Uint32Array.from(prim.indices),
      normals: prim.attr('NORMAL') ? flat(prim.attr('NORMAL')) : null,
      pin: prim.attr('_CLOTH_PIN') ? Float32Array.from(prim.attr('_CLOTH_PIN')) : null,
      zone: prim.attr('_CCZONE') ? Uint32Array.from(prim.attr('_CCZONE')) : null,
      skinIndex: Uint16Array.from(prim.joints.flat().map(j => remap[j])), skinWeight: flat(prim.weights),
      targets: prim.targets.map(flat),
    };
  }
  const bprim = body.prims[0];
  const d = {
    dir, G, joints, colliders, catalog, names, ibm, garments,
    body: { positions: flat(bprim.pos), index: Uint32Array.from(bprim.indices), normals: flat(bprim.attr('NORMAL')),
      skinIndex: Uint16Array.from(bprim.joints.flat()), skinWeight: flat(bprim.weights), targets: bprim.targets.map(flat),
      targetNames: body.targetNames, zone: bprim.attr('_CCZONE') ? Uint32Array.from(bprim.attr('_CCZONE')) : null },
  };
  cache.set(dir, d);
  return d;
}

/**
 * Duck-typed character: nodes of base_body.glb below a scene-root object (the animator moves root.position),
 * sliders -> bone positions + rebased inverse binds (character.js applySkeleton), FK world matrices.
 */
export function createCharacter(D, values = {}) {
  const N = D.G.json.nodes;
  const obj = n => {
    const o = { name: n.name, parent: null, children: [], rest: { t: n.translation || [0, 0, 0], r: n.rotation || [0, 0, 0, 1] } };
    o.position = { x: o.rest.t[0], y: o.rest.t[1], z: o.rest.t[2] };
    o.quaternion = { x: o.rest.r[0], y: o.rest.r[1], z: o.rest.r[2], w: o.rest.r[3], set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } };
    return o;
  };
  const root = { name: 'scene', parent: null, children: [], position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1, set() {} } };
  const objs = N.map(obj);
  N.forEach((n, i) => (n.children || []).forEach(c => { objs[c].parent = objs[i]; objs[i].children.push(objs[c]); }));
  for (const i of D.G.json.scenes[0].nodes) { objs[i].parent = root; root.children.push(objs[i]); }
  const byName = Object.fromEntries(objs.map(o => [o.name, o]));
  const bones = D.names.map(n => byName[n]);
  const mesh = { skeleton: { bones } };
  // FK
  const world = new Map();
  const localOf = o => compose([o.position.x, o.position.y, o.position.z], [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]);
  function fk() {
    world.clear();
    const visit = (o, pw) => { const w = mul(pw, localOf(o)); world.set(o, w); o.children.forEach(c => visit(c, w)); };
    const rw = compose([root.position.x, root.position.y, root.position.z], [0, 0, 0, 1]);
    world.set(root, rw);
    root.children.forEach(c => visit(c, rw));
  }
  // rest state (root-relative) for the slider rebase
  fk();
  const rootInv = invert(world.get(root));
  const restPos = bones.map(b => [b.position.x, b.position.y, b.position.z]);
  const restRel = bones.map(b => mul(rootInv, world.get(b)));
  const restRelInv = restRel.map(invert);
  const toParent = bones.map(b => { const m = mul(rootInv, world.get(b.parent)); m[12] = m[13] = m[14] = 0; return invert(m); });
  const boneInv = D.ibm.map(m => Float64Array.from(m));
  let infl = {};
  function setSliders(vals) {
    infl = sliderInfluences(vals);
    const delta = bones.map(() => [0, 0, 0]);
    for (const [m, w] of Object.entries(infl)) {
      if (!w) continue;
      for (const [bn, d] of Object.entries(D.joints.morphs[m] || {})) {
        const i = D.names.indexOf(bn);
        if (i < 0) continue;
        delta[i][0] += w * d[0]; delta[i][1] += w * d[1]; delta[i][2] += w * d[2];
      }
    }
    bones.forEach((b, i) => {
      const pi = bones.indexOf(b.parent);
      const t = pi >= 0 ? [delta[i][0] - delta[pi][0], delta[i][1] - delta[pi][1], delta[i][2] - delta[pi][2]] : delta[i];
      const m = toParent[i], v = [m[0] * t[0] + m[4] * t[1] + m[8] * t[2], m[1] * t[0] + m[5] * t[1] + m[9] * t[2], m[2] * t[0] + m[6] * t[1] + m[10] * t[2]];
      b.position.x = restPos[i][0] + v[0]; b.position.y = restPos[i][1] + v[1]; b.position.z = restPos[i][2] + v[2];
      const tr = M4(); tr[12] = -delta[i][0]; tr[13] = -delta[i][1]; tr[14] = -delta[i][2];
      boneInv[i] = mul(mul(mul(restRelInv[i], tr), restRel[i]), D.ibm[i]);
    });
  }
  setSliders(values);
  const humanoid = createHumanoid(mesh, { root });
  const animator = createAnimator(humanoid, { getBody: () => values });
  animator.bodyChanged();
  const skinMats = new Float32Array(16 * bones.length);
  function update() {
    fk();
    const tmp = new Float64Array(16);
    bones.forEach((b, i) => { mul(world.get(b), boneInv[i], tmp); skinMats.set(tmp, 16 * i); });   // bindMatrix = I
  }
  update();
  const jointPos = n => { const b = byName[n]; if (!b) return null; const w = world.get(b); return [w[12], w[13], w[14]]; };
  return { root, bones, byName, humanoid, animator, update, skinMats, jointPos, get influences() { return infl; }, values };
}

/** Morph weights (garment target order) for the character's influences. */
export const targetWeights = (names, infl) => names.map(n => infl[n] || 0);

/**
 * One garment's cloth instance, same data flow as web/cloth/runtime.js: morphed base -> CPU skinning -> anchors
 * of the simulated particles -> solver.step().
 */
export function createGarmentSim(D, id, ch, over = {}, under = []) {
  const g = D.garments[id];
  const model = buildClothModel({ positions: g.positions, index: g.index, pin: g.pin });
  const w = targetWeights(g.targetNames, ch.influences);
  const base = morphBase(new Float32Array(g.positions.length), g.positions, g.targets, w);
  const sim = model.sim, reps = Int32Array.from(sim.particles, p => model.rep[p]);
  const restX = new Float32Array(sim.count * 3);
  reps.forEach((v, s) => { restX[3 * s] = base[3 * v]; restX[3 * s + 1] = base[3 * v + 1]; restX[3 * s + 2] = base[3 * v + 2]; });
  const params = clothParams(g.extras, over);
  const solver = createSolver(sim, restX, params);
  const limit = limitFlags(clothColliderDefs(D.colliders), params.limit);
  const anchors = new Float32Array(sim.count * 3);
  // lower layers (web/cloth/layers.js), as web/cloth/runtime.js builds them for the worn garments under this one
  const lay = under.length ? layerSetFor(D, g, model, under) : null;
  return {
    id, model, solver, params, reps, base, limit, layerCount: lay ? lay.count : 0,
    anchorsNow() { return skinPositions(anchors, base, g.skinIndex, g.skinWeight, ch.skinMats, reps); },
    layerNow() { return lay ? lay.update(() => ch.skinMats, k => targetWeights(D.garments[under[k]].targetNames, ch.influences)) : null; },
  };
}

/** Lower-layer collision set of cloth garment g (model) over the garments `under` (same selection as the runtime). */
export function layerSetFor(D, g, model, under) {
  const freeBind = [];
  for (let p = 0; p < model.particleCount; p++) if (model.pin[p] < 0.999) { const v = model.rep[p]; freeBind.push(g.positions[3 * v], g.positions[3 * v + 1], g.positions[3 * v + 2]); }
  const fb = Float32Array.from(freeBind);
  return createLayerSet(under.map(id => {
    const u = D.garments[id];
    return { positions: u.positions, normals: u.normals, skinIndex: u.skinIndex, skinWeight: u.skinWeight, targets: u.targets, list: selectLayerVertices(u.positions, fb) };
  }));
}

/** Frame inputs shared by all garments: capsules, floor, lateral axis, air velocity. */
export function frameInputs(D, ch, defs, caps, { wind = 0, t = 0, windScale = 1 } = {}) {
  evalColliders(caps, defs, ch.jointPos, ch.influences);
  const L = ch.jointPos('thigh_l'), R = ch.jointPos('thigh_r');
  const lat = [L[0] - R[0], L[1] - R[1], L[2] - R[2]], ll = Math.hypot(...lat) || 1;
  const speed = ch.animator.state().rootSpeed || 0;
  const wv = windVelocity(wind * windScale, t);
  return { caps, floorY: 0, lateral: lat.map(c => c / ll), air: [wv[0], wv[1], wv[2] - speed] };
}

/** Skinned body positions / normals (world) for the penetration metric. */
export function bodySkin(D, ch) {
  const b = D.body, w = targetWeights(b.targetNames, ch.influences);
  const base = morphBase(new Float32Array(b.positions.length), b.positions, b.targets.map((t, k) => (w[k] ? t : null)), w);
  return { base, pos: new Float32Array(base.length), nrm: new Float32Array(base.length) };
}

function bodyGrid(pos, cell = 0.03) {
  const m = new Map();
  for (let i = 0; i < pos.length / 3; i++) {
    const k = `${Math.floor(pos[3 * i] / cell)},${Math.floor(pos[3 * i + 1] / cell)},${Math.floor(pos[3 * i + 2] / cell)}`;
    let l = m.get(k); if (!l) m.set(k, (l = [])); l.push(i);
  }
  return q => {
    let best = -1, bd = cell * cell;
    const cx = Math.floor(q[0] / cell), cy = Math.floor(q[1] / cell), cz = Math.floor(q[2] / cell);
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const l = m.get(`${cx + x},${cy + y},${cz + z}`); if (!l) continue;
      for (const i of l) { const d = (pos[3 * i] - q[0]) ** 2 + (pos[3 * i + 1] - q[1]) ** 2 + (pos[3 * i + 2] - q[2]) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    return best;
  };
}

// ---- visible-layer penetration (what the viewer shows: a lower layer poking out through the simulated cloth) ----
/**
 * Lower layers worn under a cloth garment: the garments `under` + the body, skinned every measured frame. Only
 * vertices of DRAWN triangles count (web/clothing.js applyZones: body triangles hidden by the outfit's zones and
 * lower-garment triangles covered by a higher layer are not drawn, so they cannot show through).
 */
export function layerSurfaces(D, ch, clothId, under = []) {
  const outfit = [...under, clothId];
  const srcs = [...under.map(id => ({ id, g: D.garments[id], mask: coveringZoneMask(D.catalog, outfit, id) })),
    { id: 'body', g: D.body, mask: hiddenZoneMask(D.catalog, outfit) }];
  return srcs.map(({ id, g, mask }) => {
    const n = g.positions.length / 3, drawn = new Uint8Array(n), idx = g.index;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      if (mask && g.zone && (g.zone[a] & mask) && (g.zone[b] & mask) && (g.zone[c] & mask)) continue;
      drawn[a] = drawn[b] = drawn[c] = 1;
    }
    const w = targetWeights(g.targetNames, ch.influences);
    const base = morphBase(new Float32Array(g.positions.length), g.positions, g.targets.map((t, k) => (w[k] ? t : null)), w);
    const list = Int32Array.from({ length: n }, (_, i) => i).filter(i => drawn[i]);
    const pos = new Float32Array(list.length * 3), nrm = new Float32Array(list.length * 3);
    const bn = new Float32Array(list.length * 3);
    list.forEach((v, k) => bn.set(g.normals.subarray(3 * v, 3 * v + 3), 3 * k));
    const si = new Uint16Array(list.length * 4), sw = new Float32Array(list.length * 4);
    list.forEach((v, k) => { si.set(g.skinIndex.subarray(4 * v, 4 * v + 4), 4 * k); sw.set(g.skinWeight.subarray(4 * v, 4 * v + 4), 4 * k); });
    const lbase = new Float32Array(list.length * 3);
    list.forEach((v, k) => lbase.set(base.subarray(3 * v, 3 * v + 3), 3 * k));
    // body: hands, arms and the head legitimately lie outside the coat (a hand beside the skirt), skip them
    const skip = /^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky|neck|head|clavicle)/;
    const ok = new Uint8Array(list.length).fill(1);
    if (id === 'body') list.forEach((v, k) => {
      let bj = 0, bw = -1;
      for (let q = 0; q < 4; q++) if (g.skinWeight[4 * v + q] > bw) { bw = g.skinWeight[4 * v + q]; bj = g.skinIndex[4 * v + q]; }
      if (skip.test(D.names[bj] || '')) ok[k] = 0;
    });
    return {
      id, count: list.length, pos, nrm, ok, covered: null,
      update() { skinPositions(pos, lbase, si, sw, ch.skinMats); skinNormals(nrm, bn, si, sw, ch.skinMats); return this; },
    };
  });
}

/**
 * Oriented triangles (particle indices + outward sign from the exported normals) of the cloth garment's simulated
 * part (triangles with a free particle): the part that can move off its skinned (checked) shape.
 */
export function clothTris(D, id, model) {
  const g = D.garments[id], idx = g.index, P = g.positions, N = g.normals, tris = [];
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t], idx[t + 1], idx[t + 2]], p = v.map(i => model.vmap[i]);
    if (p[0] === p[1] || p[1] === p[2] || p[0] === p[2]) continue;
    if (!p.some(q => model.pin[q] < 0.999)) continue;
    const a = v[0], b = v[1], c = v[2];
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const wx = P[3 * c] - P[3 * a], wy = P[3 * c + 1] - P[3 * a + 1], wz = P[3 * c + 2] - P[3 * a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    let s = 0;
    for (const i of v) s += nx * N[3 * i] + ny * N[3 * i + 1] + nz * N[3 * i + 2];
    tris.push(p[0], p[1], p[2], s >= 0 ? 1 : -1);
  }
  return Int32Array.from(tris);
}

/** Full particle positions as drawn: skinned everywhere, solver positions for the simulated particles. */
export function drawnParticles(D, id, sim, ch, x) {
  const g = D.garments[id], m = sim.model;
  sim.skinAll ??= new Float32Array(g.positions.length);
  sim.PX ??= new Float32Array(m.particleCount * 3);
  skinPositions(sim.skinAll, sim.base, g.skinIndex, g.skinWeight, ch.skinMats);
  for (let p = 0; p < m.particleCount; p++) { const v = m.rep[p]; sim.PX[3 * p] = sim.skinAll[3 * v]; sim.PX[3 * p + 1] = sim.skinAll[3 * v + 1]; sim.PX[3 * p + 2] = sim.skinAll[3 * v + 2]; }
  if (x) m.sim.particles.forEach((p, s) => { sim.PX[3 * p] = x[3 * s]; sim.PX[3 * p + 1] = x[3 * s + 1]; sim.PX[3 * p + 2] = x[3 * s + 2]; });
  return sim.PX;
}

/**
 * Visible-layer penetration: lower-layer vertices (drawn) OUTSIDE the cloth where the cloth covers them, i.e. the
 * vertex projects inside a cloth triangle within `reach` and lies on its outer side by more than tol. That is a
 * speck of jeans / T-shirt / skin showing through the coat. Returns { [layer]: { n, mm } }.
 */
export function pokeThrough(layers, PX, tris, { reach = 0.04, tol = TOL_LAYER, cell = 0.05, cover = false, where = null } = {}) {
  const grid = new Map(), key = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  for (let t = 0; t < tris.length; t += 4) {
    const a = 3 * tris[t], b = 3 * tris[t + 1], c = 3 * tris[t + 2];
    const lo = [0, 1, 2].map(k => Math.floor((Math.min(PX[a + k], PX[b + k], PX[c + k]) - reach) / cell));
    const hi = [0, 1, 2].map(k => Math.floor((Math.max(PX[a + k], PX[b + k], PX[c + k]) + reach) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = key(x, y, z); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(t);
    }
  }
  // is cloth particle q inside the layers? (nearest drawn layer vertex within 5 cm, behind its tangent plane)
  const lg = new Map(), lc = 0.05;
  layers.forEach((L, li) => { for (let i = 0; i < L.count; i++) { if (!L.ok[i]) continue; const k = key(Math.floor(L.pos[3 * i] / lc), Math.floor(L.pos[3 * i + 1] / lc), Math.floor(L.pos[3 * i + 2] / lc)); let l = lg.get(k); if (!l) lg.set(k, (l = [])); l.push(li, i); } });
  const inside = q => {
    const px = PX[3 * q], py = PX[3 * q + 1], pz = PX[3 * q + 2], cx = Math.floor(px / lc), cy = Math.floor(py / lc), cz = Math.floor(pz / lc);
    let bd = lc * lc, sd = 1;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const l = lg.get(key(cx + a, cy + b, cz + c)); if (!l) continue;
      for (let j = 0; j < l.length; j += 2) {
        const L = layers[l[j]], i = l[j + 1], dx = px - L.pos[3 * i], dy = py - L.pos[3 * i + 1], dz = pz - L.pos[3 * i + 2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bd) { bd = d2; sd = dx * L.nrm[3 * i] + dy * L.nrm[3 * i + 1] + dz * L.nrm[3 * i + 2]; }
      }
    }
    return sd < -tol;
  };
  const out = {};
  for (const L of layers) {
    let n = 0, worst = 0, through = 0, throughMm = 0;
    const P = L.pos;
    if (cover) L.covered = new Uint8Array(L.count);
    for (let i = 0; i < L.count; i++) {
      if (!L.ok[i] || (!cover && L.covered && !L.covered[i])) continue;
      const px = P[3 * i], py = P[3 * i + 1], pz = P[3 * i + 2];
      const l = grid.get(key(Math.floor(px / cell), Math.floor(py / cell), Math.floor(pz / cell)));
      if (!l) continue;
      let best = Infinity, sd = 0, bt_ = -1;
      for (const t of l) {
        const a = 3 * tris[t], b = 3 * tris[t + 1], c = 3 * tris[t + 2];
        const ux = PX[b] - PX[a], uy = PX[b + 1] - PX[a + 1], uz = PX[b + 2] - PX[a + 2];
        const vx = PX[c] - PX[a], vy = PX[c + 1] - PX[a + 1], vz = PX[c + 2] - PX[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-12) continue;
        const wx = px - PX[a], wy = py - PX[a + 1], wz = pz - PX[a + 2];
        const s = (wx * nx + wy * ny + wz * nz) / nl;
        if (Math.abs(s) > reach || Math.abs(s) >= best) continue;
        // barycentric of the projection
        const uu = ux * ux + uy * uy + uz * uz, uv = ux * vx + uy * vy + uz * vz, vv = vx * vx + vy * vy + vz * vz;
        const wu = wx * ux + wy * uy + wz * uz, wv = wx * vx + wy * vy + wz * vz, den = uv * uv - uu * vv;
        const bs = (uv * wv - vv * wu) / den, bt = (uv * wu - uu * wv) / den;
        if (bs < 0 || bt < 0 || bs + bt > 1) continue;
        best = Math.abs(s); sd = s * tris[t + 3]; bt_ = t;
      }
      if (cover) { if (best < Infinity) L.covered[i] = 1; continue; }
      if (best < Infinity && sd > tol) {
        n++; worst = Math.max(worst, sd);
        // "through": a particle of the covering triangle is itself inside the layers (the layer really pokes
        // through the fabric). Otherwise the panel lies behind the limb (it left through the front opening).
        const thr = inside(tris[bt_]) || inside(tris[bt_ + 1]) || inside(tris[bt_ + 2]);
        if (thr) { through++; throughMm = Math.max(throughMm, sd); }
        where?.push([L.id, +px.toFixed(3), +py.toFixed(3), +pz.toFixed(3), +(sd * 1000).toFixed(0), thr ? 'T' : 'b']);
      }
    }
    out[L.id] = { n, mm: +(worst * 1000).toFixed(1), through, throughMm: +(throughMm * 1000).toFixed(1) };
  }
  return out;
}
export const TOL_LAYER = 0.002;

const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/**
 * Runs the timeline for one body and a list of garments. Returns metrics (measured part, t >= 0):
 *  stretchP99 (max over frames of the per-frame p99), stretchP99Mean, bodyPen (max count of free particles > 2 mm
 *  inside the skinned body), bodyPenMm (deepest), floorBelow (particles below the floor), crossed (mirror pairs
 *  crossed > 2 mm), hemRise (max over frames of the mean hem height above its idle height, m), hemTrail (max mean
 *  backward offset of the hem vs its skinned anchor in run, m), msPerStep, hash (final positions), steps.
 */
export function runTimeline(D, garmentIds, values = {}, opt = {}) {
  const { hz = HZ, duration = DURATION, preroll = PREROLL, wind = 0, over = {}, measureEvery = 3, onFrame = null,
    dtOf = null } = opt;
  const ch = createCharacter(D, values);
  const defs = clothColliderDefs(D.colliders);
  const caps = new Float32Array(defs.length * 7);
  // collide with the lower layers that are worn (opt.under), unless opt.layerCollide === false (metric only)
  // (an array: collide only with those of them); footwear is not collided with, as in the runtime (collidesAsLayer)
  const collideUnder = opt.under && opt.layerCollide !== false ? opt.under.filter(u => (Array.isArray(opt.layerCollide)
    ? opt.layerCollide.includes(u) : collidesAsLayer(D.catalog.items.find(i => i.id === u)))) : [];
  const sims = garmentIds.map(id => createGarmentSim(D, id, ch, over[id] || over, collideUnder));
  const bs = bodySkin(D, ch);
  // opt.under: lower layers worn under the (single) cloth garment -> visible-layer penetration metric
  const layerSets = opt.under ? (() => {
    const L = layerSurfaces(D, ch, garmentIds[0], opt.under);
    return { update: () => L.map(l => l.update()) };
  })() : null;
  const dt = 1 / hz;
  const n0 = Math.round(preroll * hz), n1 = Math.round(duration * hz);
  const M = Object.fromEntries(garmentIds.map(id => [id, { stretch: [], bodyPen: 0, bodyPenMm: 0, skinPen: 0, skinPenMm: 0, skinStretch: [], floorBelow: 0, crossed: 0,
    hemRise: 0, hemTrail: 0, hemMinY: Infinity, ms: 0, steps: 0 }]));
  let cur = null;
  const hemIdle = {};
  for (let i = -n0; i <= n1; i++) {
    const t = i * dt;
    const want = clipAt(t);
    if (want !== cur) { ch.animator.play(want, { fade: cur ? 0.3 : 0 }); cur = want; }
    ch.animator.update(i === -n0 ? 0 : (dtOf ? dtOf(i) : dt));
    ch.update();
    const f = frameInputs(D, ch, defs, caps, { wind, t });
    const measured = t >= 0;
    if (layerSets && i === -n0) {
      // which layer vertices the (skinned) garment covers in the first idle frame: only these can "poke through"
      const s = sims[0];
      s.tris = clothTris(D, s.id, s.model);
      pokeThrough(layerSets.update(), drawnParticles(D, s.id, s, ch, null), s.tris, { cover: true, reach: 0.06 });
    }
    let bodyFn = null, layers = null;
    if (measured && i % measureEvery === 0) {
      skinPositions(bs.pos, bs.base, D.body.skinIndex, D.body.skinWeight, ch.skinMats);
      skinNormals(bs.nrm, D.body.normals, D.body.skinIndex, D.body.skinWeight, ch.skinMats);
      bodyFn = bodyGrid(bs.pos);
      if (layerSets) layers = layerSets.update();
    }
    for (const s of sims) {
      f.anchors = s.anchorsNow(); f.limit = s.limit;
      f.layer = s.layerNow();
      const t0 = performance.now();
      s.solver.step(f);
      const m = M[s.id];
      m.ms += performance.now() - t0; m.steps++;
      const x = s.solver.positions(), w = s.model.sim.pin;
      // hem = the lowest free particles (bind y within 3 cm of the garment's lowest particle)
      if (!s.hem) {
        let lo = Infinity;
        s.reps.forEach((v, k) => { if (w[k] < 0.5) lo = Math.min(lo, s.base[3 * v + 1]); });
        s.hem = []; s.reps.forEach((v, k) => { if (w[k] < 0.5 && s.base[3 * v + 1] < lo + 0.03) s.hem.push(k); });
      }
      const hemY = s.hem.reduce((a, k) => a + x[3 * k + 1], 0) / s.hem.length;
      const anc = f.anchors;
      const hemTrail = s.hem.reduce((a, k) => a + (anc[3 * k + 2] - x[3 * k + 2]), 0) / s.hem.length;
      if (t < 0) hemIdle[s.id] = hemY;
      if (!measured) continue;
      m.hemRise = Math.max(m.hemRise, hemY - hemIdle[s.id]);
      if (cur === 'run') m.hemTrail = Math.max(m.hemTrail, hemTrail);
      for (const k of s.hem) m.hemMinY = Math.min(m.hemMinY, x[3 * k + 1]);
      if (i % measureEvery === 0) {
        m.stretch.push(s.solver.stretch().p99);
        m.skinStretch.push(s.solver.stretch(anc).p99);   // the skinned targets (cloth off) on the same edges
        let below = 0;
        for (let k = 0; k < s.model.sim.count; k++) if (w[k] < 0.999 && x[3 * k + 1] < -0.002) below++;
        m.floorBelow = Math.max(m.floorBelow, below);
        // crossed mirror pairs
        const Mi = s.model.sim.mirrors, L = f.lateral;
        let crossed = 0;
        for (let k = 0; k < Mi.length; k += 2) {
          const a = 3 * Mi[k], b = 3 * Mi[k + 1];
          if ((x[a] - x[b]) * L[0] + (x[a + 1] - x[b + 1]) * L[1] + (x[a + 2] - x[b + 2]) * L[2] < -0.002) crossed++;
        }
        m.crossed = Math.max(m.crossed, crossed);
        if (bodyFn) {
          let pen = 0, worst = 0;
          for (let k = 0; k < s.model.sim.count; k++) {
            if (w[k] >= 0.999) continue;
            const q = [x[3 * k], x[3 * k + 1], x[3 * k + 2]], j = bodyFn(q);
            if (j < 0) continue;
            const sd = (q[0] - bs.pos[3 * j]) * bs.nrm[3 * j] + (q[1] - bs.pos[3 * j + 1]) * bs.nrm[3 * j + 1] + (q[2] - bs.pos[3 * j + 2]) * bs.nrm[3 * j + 2];
            if (sd < -0.002) {
              pen++; worst = Math.max(worst, -sd);
              if (opt.penWhere) {
                let bj = 0, bw = 0;
                for (let q = 0; q < 4; q++) if (D.body.skinWeight[4 * j + q] > bw) { bw = D.body.skinWeight[4 * j + q]; bj = D.body.skinIndex[4 * j + q]; }
                const nm = D.names[bj]; m.penWhere ??= {}; m.penWhere[nm] = Math.max(m.penWhere[nm] || 0, Math.round(-sd * 1000));
              }
            }
          }
          m.bodyPen = Math.max(m.bodyPen, pen); m.bodyPenMm = Math.max(m.bodyPenMm, worst * 1000);
          // the same metric on the skinned targets (= cloth off) as the reference
          let spen = 0, sworst = 0;
          for (let k = 0; k < s.model.sim.count; k++) {
            if (w[k] >= 0.999) continue;
            const q = [anc[3 * k], anc[3 * k + 1], anc[3 * k + 2]], j = bodyFn(q);
            if (j < 0) continue;
            const sd = (q[0] - bs.pos[3 * j]) * bs.nrm[3 * j] + (q[1] - bs.pos[3 * j + 1]) * bs.nrm[3 * j + 1] + (q[2] - bs.pos[3 * j + 2]) * bs.nrm[3 * j + 2];
            if (sd < -0.002) { spen++; sworst = Math.max(sworst, -sd); }
          }
          m.skinPen = Math.max(m.skinPen, spen); m.skinPenMm = Math.max(m.skinPenMm, sworst * 1000);
        }
        if (layers) {
          s.tris ??= clothTris(D, s.id, s.model);
          const add = (key, r) => {
            for (const [lid, v] of Object.entries(r)) {
              const o = (m[key] ??= {})[lid] ??= { n: 0, mm: 0, through: 0, throughMm: 0, byClip: {}, throughByClip: {} };
              o.n = Math.max(o.n, v.n); o.mm = Math.max(o.mm, v.mm);
              o.through = Math.max(o.through, v.through); o.throughMm = Math.max(o.throughMm, v.throughMm);
              o.byClip[cur] = Math.max(o.byClip[cur] || 0, v.n);
              o.throughByClip[cur] = Math.max(o.throughByClip[cur] || 0, v.through);
            }
          };
          const where = opt.pokeWhere ? [] : null;
          add('layer', pokeThrough(layers, drawnParticles(D, s.id, s, ch, x), s.tris, { where }));
          if (where?.length) (m.pokeWhere ??= []).push(...where.map(w => [+t.toFixed(2), cur, ...w]));
          add('layerSkin', pokeThrough(layers, drawnParticles(D, s.id, s, ch, null), s.tris));
        }
      }
    }
    if (onFrame) onFrame({ i, t, clip: cur, ch, sims, f });
  }
  const out = {};
  for (const s of sims) {
    const m = M[s.id];
    out[s.id] = {
      particles: s.model.sim.count, free: Array.from(s.model.sim.pin).filter(p => p < 0.999).length,
      edges: s.model.sim.edges.length / 2, bends: s.model.sim.bends.length / 2, mirrors: s.model.sim.mirrors.length / 2,
      stretchP99: +Math.max(...m.stretch).toFixed(3), stretchP99Mean: +(m.stretch.reduce((a, b) => a + b, 0) / m.stretch.length).toFixed(3),
      stretchP99Q95: +pct(m.stretch, 0.95).toFixed(3), skinStretchP99: +Math.max(...m.skinStretch).toFixed(3),
      bodyPen: m.bodyPen, bodyPenMm: +m.bodyPenMm.toFixed(1), skinPen: m.skinPen, skinPenMm: +m.skinPenMm.toFixed(1), floorBelow: m.floorBelow, crossed: m.crossed,
      hemRise: +m.hemRise.toFixed(3), hemTrail: +m.hemTrail.toFixed(3), hemMinY: +m.hemMinY.toFixed(3),
      msPerStep: +(m.ms / m.steps).toFixed(3), steps: s.solver.steps, resets: s.solver.resets,
      hash: hashFloats(s.solver.positions()), ...(m.penWhere ? { penWhere: m.penWhere } : {}),
      ...(m.layer ? { layer: m.layer, layerSkin: m.layerSkin } : {}), ...(m.pokeWhere ? { pokeWhere: m.pokeWhere } : {}),
    };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const bodies = (opt('--bodies') || Object.keys(BODIES).join(',')).split(',');
  const seconds = +(opt('--seconds') || DURATION);
  const wind = +(opt('--wind') || 0);
  const under = opt('--under');
  const D = loadData();
  const ids = args.length ? args : D.catalog.items.filter(i => i.cloth).map(i => i.id);
  for (const b of bodies) {
    for (const id of ids) {
      const t0 = performance.now();
      const r = runTimeline(D, [id], BODIES[b], { duration: seconds, wind, under: under ? under.split(',').filter(u => u !== id) : undefined })[id];
      console.log(`CLOTH ${id.padEnd(10)} ${b.padEnd(8)} ${JSON.stringify(r)} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }
}
