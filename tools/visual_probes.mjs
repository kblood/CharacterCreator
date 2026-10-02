// Known VISUAL faults as numeric probes (ROADMAP M2b). Each fault that a reviewer saw in a screenshot gets numbers
// that can be re-measured without looking at an image. This tool only MEASURES; it changes no solver / garment.
//   node tools/visual_probes.mjs [--only jaw,dresscoat,dressstep,hair,integrity,animzone] [--quick]
//        [--json [file]] [--commit <sha>]
// Cases (see docs/baseline/README.md "Visual probes" for what each number means and its target):
//   jaw        red fragment under the jaw with the jacket: mouth interior (teeth / tongue) visible from below through
//              hidden skin, hidden skin above the garment top, hidden skin not covered snugly, garment vertices at
//              the jaw underside; 9 bodies x jacket outfits (+ controls), bind pose + idle / idle_look / walk frames.
//   dresscoat  dress + trench coat in the crouched jump / land poses: the outfit rules never give the pair (rules),
//              the FORCED pair (conflicts removed in a copy of the catalog) measured like the integrity matrix
//              (poke / sink vertices + mm) + edge stretch of both cloth garments; the dress alone as the reference.
//   dressstep  dress skirt step at the hips: max normal angle across edges and height jump along the rings in a hip
//              band, posed and in excess of the bind shape, cloth on / off, male / female, idle / walk / run.
//   hair       hair vs collar / hood: hair vertices inside the collar (between collar and neck) and hair edges
//              crossing it, per hair style x jacket / hoodie / coat x idle / walk, viewer hair push off / on.
//   integrity  existing numbers from the M2 integrity baseline (docs/baseline/integrity_*.json): bra in
//              idle_fidget, fingertips through the coat, coat:jeans in jump.
//   animzone   base_body_anim.glb carries the body's _CCZONE attribute (it does not today).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadData, createCharacter, targetWeights, BODIES } from './cloth_sim.mjs';
import { runCase, TIMELINES } from './cloth_integrity.mjs';
import { readGlb, meshParts, jointNames } from './glb.mjs';
import { morphBase, skinPositions } from '../web/cloth/skin.js';
import { resolveOutfit, wearRules, hiddenZoneMask, defaultUnderwear } from '../web/clothing_rules.js';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(PROJECT, 'output');
export const PROBE_BODIES = { ...BODIES, male: { gender: 1 } };
const r1 = x => +x.toFixed(1), r3 = x => +x.toFixed(3);

// ---- geometry helpers -------------------------------------------------------------------------------------------
/** Mesh part of a GLB with skin indices remapped to the body skeleton (D.names). attrs: extra attribute names. */
export function loadPart(D, file, node = null, attrs = []) {
  const g = readGlb(path.join(D.dir ?? OUT, file)), parts = meshParts(g);
  const p = node ? parts[node] : Object.values(parts)[0];
  if (!p) throw new Error(`${file}: no mesh ${node ?? ''}`);
  const prim = p.prims[0], remap = jointNames(g).map(n => D.names.indexOf(n)), flat = a => Float32Array.from(a.flat());
  const out = { file, node: node ?? Object.keys(parts)[0], targetNames: p.targetNames, positions: flat(prim.pos),
    index: Uint32Array.from(prim.indices), normals: flat(prim.attr('NORMAL')), targets: prim.targets.map(flat),
    skinIndex: Uint16Array.from(prim.joints.flat().map(j => remap[j])), skinWeight: flat(prim.weights), attr: {} };
  for (const a of attrs) { const v = prim.attr(a); out.attr[a] = v ? Float32Array.from(v.flat()) : null; }
  return out;
}
/** Morphed (slider shape) bind positions of a part for character ch. */
export const morphed = (g, ch) => { const w = targetWeights(g.targetNames, ch.influences); return morphBase(new Float32Array(g.positions.length), g.positions, g.targets.map((t, k) => (w[k] ? t : null)), w); };
const skinned = (g, base, ch, out = new Float32Array(base.length)) => skinPositions(out, base, g.skinIndex, g.skinWeight, ch.skinMats);
/** Dominant joint name per vertex. */
const dominant = (D, g) => Array.from({ length: g.positions.length / 3 }, (_, v) => {
  let bj = 0, bw = -1;
  for (let q = 0; q < 4; q++) if (g.skinWeight[4 * v + q] > bw) { bw = g.skinWeight[4 * v + q]; bj = g.skinIndex[4 * v + q]; }
  return D.names[bj] || '?';
});
/** Outward sign per triangle (exported vertex normals point away from the body). */
function triSigns(P, N, idx) {
  const s = new Int8Array(idx.length / 3);
  for (let t = 0, k = 0; t < idx.length; t += 3, k++) {
    const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    let d = 0;
    for (const i of [a, b, c]) d += nx * N[i] + ny * N[i + 1] + nz * N[i + 2];
    s[k] = d >= 0 ? 1 : -1;
  }
  return s;
}
const triNormal = (P, a, b, c, o) => {
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
  o[0] = uy * wz - uz * wy; o[1] = uz * wx - ux * wz; o[2] = ux * wy - uy * wx;
  const l = Math.hypot(o[0], o[1], o[2]) || 1; o[0] /= l; o[1] /= l; o[2] /= l; return o;
};

/** Uniform-grid ray caster over a triangle soup (positions P, flat triangle vertex indices T). */
export function rayCaster(P, T, cell = 0.03) {
  // triangles binned with a margin of cell / 2 and the ray sampled every cell / 2: every point of the ray lies within
  // cell / 4 of a sample, so the sample's cell holds every triangle the ray can meet there
  const g = new Map(), key = (x, y, z) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0, m = cell / 2;
  for (let t = 0; t < T.length; t += 3) {
    const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
    const lo = [0, 1, 2].map(k => Math.floor((Math.min(P[a + k], P[b + k], P[c + k]) - m) / cell));
    const hi = [0, 1, 2].map(k => Math.floor((Math.max(P[a + k], P[b + k], P[c + k]) + m) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = key(x, y, z); let L = g.get(k); if (!L) g.set(k, (L = [])); L.push(t);
    }
  }
  const stamp = new Int32Array(T.length / 3); let sid = 0;
  /** Nearest hit distance in (minT, maxT] of p + t d, or Infinity. */
  return function hit(p, d, maxT, minT = 1e-5) {
    sid++; let best = Infinity, last = null;
    for (let s = 0; s <= maxT + m; s += m) {
      {
        const k = key(Math.floor((p[0] + s * d[0]) / cell), Math.floor((p[1] + s * d[1]) / cell), Math.floor((p[2] + s * d[2]) / cell));
        if (k === last) continue;
        last = k;
        const L = g.get(k); if (!L) continue;
        for (const t of L) {
          if (stamp[t / 3] === sid) continue;
          stamp[t / 3] = sid;
          const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
          const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
          const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x, det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-14) continue;
          const inv = 1 / det, tx = p[0] - P[a], ty = p[1] - P[a + 1], tz = p[2] - P[a + 2], u = (tx * px + ty * py + tz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const h = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (h > minT && h <= maxT && h < best) best = h;
        }
      }
      if (best <= s) break;
    }
    return best;
  };
}

/** Nearest-vertex index over positions P (only `keep` vertices), radius r. */
function nearest(P, keep, r = 0.03) {
  const g = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  for (const i of keep) { const k = key(Math.floor(P[3 * i] / r), Math.floor(P[3 * i + 1] / r), Math.floor(P[3 * i + 2] / r)); let L = g.get(k); if (!L) g.set(k, (L = [])); L.push(i); }
  return (q, maxD = r) => {
    let best = -1, bd = maxD * maxD;
    const cx = Math.floor(q[0] / r), cy = Math.floor(q[1] / r), cz = Math.floor(q[2] / r);
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const L = g.get(key(cx + x, cy + y, cz + z)); if (!L) continue;
      for (const i of L) { const d = (P[3 * i] - q[0]) ** 2 + (P[3 * i + 1] - q[1]) ** 2 + (P[3 * i + 2] - q[2]) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    return best;
  };
}

/** Steps the character's animator through a list of [clip, seconds] with frames every dt; calls fn(clip, t). */
function animate(ch, plan, fn, { dt = 1 / 30, every = 3 } = {}) {
  let i = 0;
  for (const [clip, secs] of plan) {
    ch.animator.play(clip, { fade: i ? 0.3 : 0 });
    const n = Math.round(secs / dt);
    for (let k = 0; k <= n; k++) {
      ch.animator.update(k ? dt : 0); ch.update();
      if (k % every === 0 && k > 0.35 / dt) fn(clip, k * dt);   // skip the crossfade into the clip
    }
    i++;
  }
}

// ---- case 1: red fragment under the jaw ---------------------------------------------------------------------------
const JAW_OUTFITS = {
  'jacket+tee+jeans+shoes': ['tshirt', 'jeans', 'shoes', 'jacket'],
  'jacket+shirt+shorts+boots': ['shirt', 'shorts', 'boots', 'jacket'],
  // controls: the other tops that reach the neck, and no clothes at all (must be 0 everywhere)
  'tee+jeans+shoes': ['tshirt', 'jeans', 'shoes'],
  'shirt+jeans+coat': ['shirt', 'jeans', 'trenchcoat'],
  'hoodie+jeans+shoes': ['hoodie', 'jeans', 'shoes'],
  'dress+shoes': ['dress', 'shoes'],
  naked: [],
};
// directions from a tooth / tongue vertex: straight down and 45 deg down to front / back / sides (a camera under the
// jaw); the mouth opening (forward) is left out on purpose
const DOWN = [[0, -1, 0], [0, -1, 1], [0, -1, -1], [1, -1, 0], [-1, -1, 0]].map(v => { const l = Math.hypot(...v); return v.map(c => c / l); });
const JAW = { escape: 0.5, coverReach: 0.05, topPad: 0.005, nearJaw: 0.01, inside: 0.002 };

export function probeJaw(D, { bodies = Object.keys(PROBE_BODIES), outfits = Object.keys(JAW_OUTFITS), quick = false, bindOnly = false } = {}) {
  const teeth = loadPart(D, 'base_body.glb', 'Teeth'), tongue = loadPart(D, 'base_body.glb', 'Tongue');
  const body = D.body, bodyBone = dominant(D, body), garments = id => D.garments[id];
  const plan = quick ? [['idle_look', 2]] : [['idle', 1.5], ['idle_look', 6], ['walk', 1.5]];
  const rows = [];
  for (const bn of bodies) {
    const values = PROBE_BODIES[bn];
    for (const on of outfits) {
      const ch = createCharacter(D, values);
      const sex = (Number(values.gender ?? 1) || 0) < 0 ? 'female' : 'male';
      const worn = resolveOutfit(D.catalog, [...defaultUnderwear(D.catalog, sex), ...JAW_OUTFITS[on]]);
      const mask = hiddenZoneMask(D.catalog, worn);
      const bBase = morphed(body, ch), tBase = morphed(teeth, ch), gBase = Object.fromEntries(worn.map(id => [id, morphed(garments(id), ch)]));
      // zones (slider shape): jaw = head-weighted skin below the lowest tooth (the underside of jaw and chin),
      // neck = neck_01-weighted skin
      let teethMinY = Infinity;
      for (let i = 1; i < tBase.length; i += 3) teethMinY = Math.min(teethMinY, tBase[i]);
      const nb = body.positions.length / 3, zone = new Uint8Array(nb);   // 1 jaw, 2 neck
      for (let v = 0; v < nb; v++) zone[v] = bodyBone[v] === 'head' && bBase[3 * v + 1] < teethMinY ? 1 : bodyBone[v] === 'neck_01' ? 2 : 0;
      const hid = v => body.zone && (body.zone[v] & mask);
      const bI = body.index, drawnBody = [], hiddenZ = [];
      for (let t = 0; t < bI.length; t += 3) {
        const a = bI[t], b = bI[t + 1], c = bI[t + 2];
        if (hid(a) && hid(b) && hid(c)) { if (zone[a] || zone[b] || zone[c]) hiddenZ.push(t); } else drawnBody.push(a, b, c);
      }
      // hidden skin above the top of the garment that hides it (+ 5 mm): the build rule of the late fix
      const tops = Object.fromEntries(worn.map(id => { let m = -Infinity; const B = gBase[id]; for (let i = 1; i < B.length; i += 3) m = Math.max(m, B[i]); return [id, m]; }));
      let aboveTop = 0, aboveTopMm = 0;
      for (let v = 0; v < nb; v++) {
        if (!zone[v] || !hid(v)) continue;
        let top = -Infinity;
        for (const id of worn) { const it = D.catalog.items.find(i => i.id === id); const bits = (it.hidesBodyZones ?? []).reduce((m, z) => m | (D.catalog.bodyZones[z] ?? 0), 0); if (body.zone[v] & bits) top = Math.max(top, tops[id]); }
        const over = bBase[3 * v + 1] - (top + JAW.topPad);
        if (over > 0) { aboveTop++; aboveTopMm = Math.max(aboveTopMm, over * 1000); }
      }
      const row = { body: bn, outfit: on, worn, hiddenJawNeckTris: hiddenZ.length, hiddenAboveTopVerts: aboveTop, hiddenAboveTopMm: r1(aboveTopMm), frames: 0,
        teethVisibleBelow: 0, tongueVisibleBelow: 0, uncoveredHiddenTris: 0, garmentVertsAtJaw: 0, garmentVertsInsideJawNeck: 0, worst: null };
      const bPos = new Float32Array(bBase.length), tPos = new Float32Array(tBase.length), oBase = morphed(tongue, ch), oPos = new Float32Array(oBase.length);
      const gPos = Object.fromEntries(worn.map(id => [id, new Float32Array(gBase[id].length)]));
      const zoneVerts = Int32Array.from({ length: nb }, (_, i) => i).filter(i => zone[i]);
      const measure = (clip, t) => {
        skinned(body, bBase, ch, bPos); skinned(teeth, tBase, ch, tPos); skinned(tongue, oBase, ch, oPos);
        for (const id of worn) skinned(garments(id), gBase[id], ch, gPos[id]);
        // one soup: drawn body + every worn garment (all their triangles)
        const parts = [[bPos, Uint32Array.from(drawnBody)], ...worn.map(id => [gPos[id], garments(id).index])];
        let n = 0; for (const [p] of parts) n += p.length;
        const P = new Float32Array(n), T = [];
        let off = 0;
        for (const [p, idx] of parts) { P.set(p, off); const o = off / 3; for (const i of idx) T.push(i + o); off += p.length; }
        const hit = rayCaster(P, Int32Array.from(T));
        // the same soup with the WHOLE body (nothing hidden): a ray that escapes there too leaves through the mouth
        // opening / past the lips, not through hidden skin, and does not count
        let hitAll = hit;
        if (hiddenZ.length || drawnBody.length !== bI.length) {
          const P2 = new Float32Array(P.length), T2 = [];
          P2.set(P); for (let k = 0; k < bI.length; k++) T2.push(bI[k]);
          for (let k = drawnBody.length; k < T.length; k++) T2.push(T[k]);
          hitAll = rayCaster(P2, Int32Array.from(T2));
        }
        const vis = (Q) => { let c = 0; const p = [0, 0, 0]; for (let i = 0; i < Q.length; i += 3) { p[0] = Q[i]; p[1] = Q[i + 1]; p[2] = Q[i + 2]; if (DOWN.some(d => hit(p, d, JAW.escape) === Infinity && hitAll(p, d, JAW.escape) < Infinity)) c++; } return c; };
        const tv = vis(tPos), ov = vis(oPos);
        // hidden jaw / neck skin with no garment surface within coverReach along its normal (garments only)
        const gParts = worn.map(id => [gPos[id], garments(id).index]);
        let gn = 0; for (const [p] of gParts) gn += p.length;
        const GP = new Float32Array(gn), GT = []; off = 0;
        for (const [p, idx] of gParts) { GP.set(p, off); const o = off / 3; for (const i of idx) GT.push(i + o); off += p.length; }
        const ghit = worn.length ? rayCaster(GP, Int32Array.from(GT)) : () => Infinity;
        let unc = 0; const m = [0, 0, 0], nrm = [0, 0, 0];
        for (const t of hiddenZ) {
          const a = 3 * bI[t], b = 3 * bI[t + 1], c = 3 * bI[t + 2];
          for (let k = 0; k < 3; k++) m[k] = (bPos[a + k] + bPos[b + k] + bPos[c + k]) / 3;
          triNormal(bPos, a, b, c, nrm);
          if (ghit(m, nrm, JAW.coverReach) === Infinity) unc++;
        }
        // garment vertices within 1 cm of the jaw underside / > 2 mm inside the jaw or neck skin
        const nJaw = nearest(bPos, zoneVerts.filter(v => zone[v] === 1)), nZ = nearest(bPos, zoneVerts);
        let atJaw = 0, inside = 0; const q = [0, 0, 0];
        for (const id of worn) { const G = gPos[id]; for (let i = 0; i < G.length; i += 3) {
          q[0] = G[i]; q[1] = G[i + 1]; q[2] = G[i + 2];
          if (nJaw(q, JAW.nearJaw) >= 0) atJaw++;
          const j = nZ(q, 0.02);
          if (j >= 0) {
            // sign against the skinned body normal of j (body normals are rigid-skinned with the vertex: use the
            // offset from the zone vertex projected on the bind normal rotated by the dominant joint -> approximate
            // with the local triangle fan normal below)
            const s = (q[0] - bPos[3 * j]) * fanN[3 * j] + (q[1] - bPos[3 * j + 1]) * fanN[3 * j + 1] + (q[2] - bPos[3 * j + 2]) * fanN[3 * j + 2];
            if (s < -JAW.inside) inside++;
          }
        } }
        row.frames++;
        const sc = tv + ov + unc;
        if (!row.worst || sc > row.worst.score) row.worst = { clip, t: r3(t), score: sc, teeth: tv, tongue: ov, uncovered: unc };
        row.teethVisibleBelow = Math.max(row.teethVisibleBelow, tv); row.tongueVisibleBelow = Math.max(row.tongueVisibleBelow, ov);
        row.uncoveredHiddenTris = Math.max(row.uncoveredHiddenTris, unc); row.garmentVertsAtJaw = Math.max(row.garmentVertsAtJaw, atJaw);
        row.garmentVertsInsideJawNeck = Math.max(row.garmentVertsInsideJawNeck, inside);
      };
      // area-weighted vertex normals of the skinned body (recomputed per frame, cheap)
      const fanN = new Float32Array(bBase.length);
      const fan = () => { fanN.fill(0); const n = [0, 0, 0]; for (let t = 0; t < bI.length; t += 3) { const a = 3 * bI[t], b = 3 * bI[t + 1], c = 3 * bI[t + 2];
        const ux = bPos[b] - bPos[a], uy = bPos[b + 1] - bPos[a + 1], uz = bPos[b + 2] - bPos[a + 2], wx = bPos[c] - bPos[a], wy = bPos[c + 1] - bPos[a + 1], wz = bPos[c + 2] - bPos[a + 2];
        n[0] = uy * wz - uz * wy; n[1] = uz * wx - ux * wz; n[2] = ux * wy - uy * wx;
        for (const i of [a, b, c]) { fanN[i] += n[0]; fanN[i + 1] += n[1]; fanN[i + 2] += n[2]; } }
        for (let i = 0; i < fanN.length; i += 3) { const l = Math.hypot(fanN[i], fanN[i + 1], fanN[i + 2]) || 1; fanN[i] /= l; fanN[i + 1] /= l; fanN[i + 2] /= l; } };
      // orientation of the body's triangle winding vs its exported normals (fan normals must point out)
      const bodySign = triSigns(body.positions, body.normals, bI).reduce((a, s) => a + s, 0) >= 0 ? 1 : -1;
      const measureFrame = (clip, t) => { skinned(body, bBase, ch, bPos); fan(); if (bodySign < 0) for (let i = 0; i < fanN.length; i++) fanN[i] = -fanN[i]; measure(clip, t); };
      ch.update(); measureFrame('bind', 0);
      if (!bindOnly) animate(ch, plan, measureFrame, { every: quick ? 15 : 12 });
      rows.push(row);
    }
  }
  const jacket = rows.filter(r => r.outfit.startsWith('jacket'));
  const tot = k => jacket.reduce((a, r) => a + r[k], 0);
  return {
    what: 'Red fragment under the jaw with the jacket (ROADMAP M2b). Per body x outfit, max over the bind pose and the sampled frames.',
    method: { teethVisibleBelow: 'tooth vertices from which a ray down / 45 deg down (front, back, sides) escapes 0.5 m without hitting drawn skin or any worn garment, but would hit the skin if nothing were hidden (mouth interior seen through hidden skin; rays leaving past the lips do not count)',
      tongueVisibleBelow: 'the same for the tongue', hiddenJawNeckTris: 'body triangles hidden by the outfit zones (_CCZONE) with a vertex in the jaw (head-weighted, below the lowest tooth) or neck (neck_01-weighted) zone',
      hiddenAboveTopVerts: 'hidden jaw / neck skin vertices above the top of the garment that hides them + 5 mm (the rule of the late fix in blender/cc_clothing.py)',
      uncoveredHiddenTris: 'hidden jaw / neck triangles whose outward ray meets no garment within 5 cm (tests/clothing.test.mjs uses 20 cm, which the jacket collar satisfied)',
      garmentVertsAtJaw: 'garment vertices within 1 cm of the jaw-underside skin', garmentVertsInsideJawNeck: 'garment vertices > 2 mm inside the jaw / neck skin (nearest skin vertex, fan normal)',
      frames: quick ? 'bind + idle_look every 0.5 s' : 'bind + idle 1.5 s, idle_look 6 s, walk 1.5 s, every 0.4 s (30 fps animator, 0.35 s fade skipped)' },
    target: 'teethVisibleBelow = tongueVisibleBelow = hiddenAboveTopVerts = uncoveredHiddenTris = 0 on every body (jacket outfits)',
    jacketTotals: { rows: jacket.length, teethVisibleBelow: tot('teethVisibleBelow'), tongueVisibleBelow: tot('tongueVisibleBelow'), hiddenAboveTopVerts: tot('hiddenAboveTopVerts'),
      uncoveredHiddenTris: tot('uncoveredHiddenTris'), garmentVertsAtJaw: tot('garmentVertsAtJaw'), garmentVertsInsideJawNeck: tot('garmentVertsInsideJawNeck') },
    rows,
  };
}

// ---- case 2: dress + trench coat, crouched (jump / land) -----------------------------------------------------------
const STRETCH_IDS = ['dress', 'trenchcoat'];
/** Copy of D whose catalog has the conflicts between the ids removed (the FORCED pair; D is not modified). */
export function forcePair(D, ids) {
  const items = D.catalog.items.map(i => (ids.includes(i.id) ? { ...i, conflicts: (i.conflicts ?? []).filter(c => !ids.includes(c)) } : i));
  return { ...D, catalog: { ...D.catalog, items } };
}
export function dressCoatRules(catalog) {
  const orders = [['dress', 'trenchcoat'], ['trenchcoat', 'dress']];
  const res = orders.map(o => ({ order: o, resolveOutfit: resolveOutfit(catalog, o), wearRules: wearRules(catalog, [o[0]], o[1]) }));
  const both = r => r.includes('dress') && r.includes('trenchcoat');
  return { orders: res, pairReachable: res.some(r => both(r.resolveOutfit) || both(r.wearRules)) };
}
export function probeDressCoat(D, { bodies = ['female', 'male', 'neutral'], quick = false } = {}) {
  const rules = dressCoatRules(D.catalog);
  const DF = forcePair(D, ['dress', 'trenchcoat']);
  const runs = [];
  const tls = quick ? [['moves', ['jump']]] : [['moves', ['jump']], ['land', ['land']]];
  for (const bn of bodies) for (const [tl, clips] of tls) for (const [name, data, outfit] of [['dress+coat (forced)', DF, ['dress', 'trenchcoat']], ['dress (reference)', D, ['dress']]]) {
    const st = {};
    const r = runCase(data, outfit, PROBE_BODIES[bn], { clips, cfg: { ...TIMELINES[tl] }, onFrame: ({ label, sims }) => {
      for (const s of sims) {
        if (!STRETCH_IDS.includes(s.id) || !s.drawX) continue;
        const x = s.solver.stretch(s.drawX), o = ((st[s.id] ??= {})[label] ??= { p99: 0, max: 0 });
        o.p99 = Math.max(o.p99, x.p99); o.max = Math.max(o.max, x.max);
      }
    } });
    const pairs = {};
    for (const [pk, byClip] of Object.entries(r.pairs)) for (const [clip, v] of Object.entries(byClip)) {
      if (!v.poke.n && !v.sink.n) continue;
      (pairs[pk] ??= {})[clip] = { poke: { n: v.poke.n, mm: v.poke.mm, at: v.poke.at?.bone ?? null }, sink: { n: v.sink.n, mm: v.sink.mm, at: v.sink.at?.bone ?? null } };
    }
    for (const id in st) for (const c in st[id]) st[id][c] = { p99: r3(st[id][c].p99), max: r3(st[id][c].max) };
    const sum = k => Object.values(pairs).reduce((a, byC) => a + Object.values(byC).reduce((b, v) => b + v[k].n, 0), 0);
    const mm = k => Object.values(pairs).reduce((a, byC) => Math.max(a, ...Object.values(byC).map(v => v[k].mm)), 0);
    runs.push({ body: bn, timeline: tl, clips, outfit: name, worn: r.outfit, measured: r.measured, pokeVerts: sum('poke'), pokeMm: mm('poke'), sinkVerts: sum('sink'), sinkMm: mm('sink'),
      dressBody: pairs['dress:body'] ?? null, coatDress: pairs['trenchcoat:dress'] ?? null, edgeStretch: st, pairs });
  }
  return {
    what: 'Dress + trench coat in the crouched jump / land poses (ROADMAP M2b). The pair is in CONFLICTS; it is measured FORCED (conflicts removed in a copy of the catalog).',
    method: { rules: 'resolveOutfit / wearRules in both orders on the real catalog', penetration: 'tools/cloth_integrity.mjs runCase (worker path, drawfix, layers; moves timeline measured in jump, land timeline in land): per pair max vertices / deepest mm over the frames; pokeVerts / sinkVerts = sum over pairs and clips',
      edgeStretch: 'solver.stretch() of the DRAWN cloth shape (drawX): p99 and max edge length / rest length over the measured frames' },
    target: 'rules.pairReachable = false (the test in tests/visual_probes.test.mjs). The forced numbers are a baseline, no target: the pair is not offered.',
    rules, runs,
  };
}

// ---- case 3: dress skirt step at the hips -----------------------------------------------------------------------------
const STEP = { below: 0.15, above: 0.10, ringSlope: 0.25, sides: [45, 135] };
// the hip SIDES (where the step was seen): edges whose angle around the vertical axis (atan2(x, z), 0 = front) is in
// [45, 135] deg on either side; 'all' also holds the front / back (the crotch fold between the legs in walk / run)
const side = deg => Math.abs(deg) >= STEP.sides[0] && Math.abs(deg) <= STEP.sides[1];
const blank = () => ({ frames: 0, angleMaxDeg: 0, angleExcessDeg: 0, ringJumpMm: 0, ringJumpExcessMm: 0, worstAngle: null, worstRing: null });
export function probeDressStep(D, { bodies = ['male', 'female'], quick = false } = {}) {
  const rows = [];
  for (const bn of bodies) for (const cloth of [true, false]) {
    const values = PROBE_BODIES[bn], rest = createCharacter(D, values);
    const pelvisY = rest.jointPos('pelvis')[1], thighY = (rest.jointPos('thigh_l')[1] + rest.jointPos('thigh_r')[1]) / 2;
    const lo = thighY - STEP.below, hi = pelvisY + STEP.above;
    let E = null;
    const acc = {};
    const cfg = quick ? { timeline: [[-1, 'preroll', 'idle'], [0, 'idle', 'idle'], [1.5, 'walk', 'walk']], duration: 3 } : {};
    runCase(D, ['dress', 'shoes'], values, { cloth, clips: ['idle', 'walk', 'run'], cfg, onFrame: ({ label, surfaces }) => {
      const S = surfaces.find(s => s.id === 'dress');
      if (!S) return;
      if (!E) {
        // edges between two drawn triangles (welded by bind position: the UV seams split vertices), in the band
        const B = S.base, wk = v => `${B[3 * v].toFixed(5)},${B[3 * v + 1].toFixed(5)},${B[3 * v + 2].toFixed(5)}`;
        const weld = new Map(), id = v => { const k = wk(v); if (!weld.has(k)) weld.set(k, v); return weld.get(k); };
        const em = new Map();
        for (let t = 0, k = 0; t < S.tris.length; t += 3, k++) for (let e = 0; e < 3; e++) {
          const a = S.tris[t + e], b = S.tris[t + (e + 1) % 3], A = id(a), Bv = id(b), key = A < Bv ? `${A}_${Bv}` : `${Bv}_${A}`;
          let r = em.get(key); if (!r) em.set(key, (r = { a, b, t: [] })); r.t.push(k);
        }
        const bindN = k => { const o = [0, 0, 0]; triNormal(B, 3 * S.tris[3 * k], 3 * S.tris[3 * k + 1], 3 * S.tris[3 * k + 2], o); const s = S.sign[k]; return o.map(c => c * s); };
        const ang = (n1, n2) => Math.acos(Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]))) * 180 / Math.PI;
        E = { dihedral: [], ring: [] };
        for (const r of em.values()) {
          const ya = B[3 * r.a + 1], yb = B[3 * r.b + 1], ym = (ya + yb) / 2;
          if (ym < lo || ym > hi) continue;
          const dx = B[3 * r.b] - B[3 * r.a], dy = yb - ya, dz = B[3 * r.b + 2] - B[3 * r.a + 2], len = Math.hypot(dx, dy, dz);
          const around = Math.round(Math.atan2((B[3 * r.a] + B[3 * r.b]) / 2, (B[3 * r.a + 2] + B[3 * r.b + 2]) / 2) * 180 / Math.PI);
          if (r.t.length === 2) E.dihedral.push({ t: r.t, bind: ang(bindN(r.t[0]), bindN(r.t[1])), y: ym, around });
          if (Math.abs(dy) < STEP.ringSlope * len) E.ring.push({ a: r.a, b: r.b, bind: Math.abs(dy), y: ym, around });
        }
      }
      const P = S.pos, TN = S.triN, A = (acc[label] ??= { all: blank(), sides: blank() });
      A.all.frames++; A.sides.frames++;
      for (const d of E.dihedral) {
        const o = A[side(d.around) ? 'sides' : 'all'], oa = A.all;
        const [k1, k2] = d.t, a = Math.acos(Math.max(-1, Math.min(1, TN[3 * k1] * TN[3 * k2] + TN[3 * k1 + 1] * TN[3 * k2 + 1] + TN[3 * k1 + 2] * TN[3 * k2 + 2]))) * 180 / Math.PI;
        for (const q of new Set([o, oa])) {
          q.angleMaxDeg = Math.max(q.angleMaxDeg, a);
          if (a - d.bind > q.angleExcessDeg) { q.angleExcessDeg = a - d.bind; q.worstAngle = { deg: r1(a), bindDeg: r1(d.bind), yAboveThighMm: Math.round((d.y - thighY) * 1000), aroundDeg: d.around }; }
        }
      }
      for (const e of E.ring) {
        const j = Math.abs(P[3 * e.b + 1] - P[3 * e.a + 1]);
        for (const q of new Set([A[side(e.around) ? 'sides' : 'all'], A.all])) {
          q.ringJumpMm = Math.max(q.ringJumpMm, j * 1000);
          if ((j - e.bind) * 1000 > q.ringJumpExcessMm) { q.ringJumpExcessMm = (j - e.bind) * 1000; q.worstRing = { mm: r1(j * 1000), bindMm: r1(e.bind * 1000), yAboveThighMm: Math.round((e.y - thighY) * 1000), aroundDeg: e.around }; }
        }
      }
    } });
    const fmt = o => ({ angleMaxDeg: r1(o.angleMaxDeg), angleExcessDeg: r1(o.angleExcessDeg), ringJumpMm: r1(o.ringJumpMm), ringJumpExcessMm: r1(o.ringJumpExcessMm), worstAngle: o.worstAngle, worstRing: o.worstRing });
    for (const [clip, A] of Object.entries(acc)) rows.push({ body: bn, cloth, clip, frames: A.all.frames,
      band: { fromAboveThighMm: -STEP.below * 1000, toAbovePelvisMm: STEP.above * 1000, edges: E.dihedral.length, ringEdges: E.ring.length, sideEdges: E.dihedral.filter(d => side(d.around)).length },
      bindAngleMaxDeg: r1(Math.max(...E.dihedral.map(d => d.bind))), all: fmt(A.all), hipSides: fmt(A.sides) });
  }
  return {
    what: 'Step / bump in the dress skirt at the hips (ROADMAP M2b), cloth on and off, male and female.',
    method: { band: `dress edges with bind midpoint between ${STEP.below * 100} cm under the thigh joints and ${STEP.above * 100} cm over the pelvis joint (rest pose, slider shape)`,
      angleMaxDeg: 'max angle between the normals of the two drawn triangles of an edge (welded at UV seams), max over frames',
      angleExcessDeg: 'max over edges and frames of (posed angle - bind angle): the belt rim and other built-in creases cancel out',
      ringJumpMm: `max |dy| along ring edges (bind |dy| < ${STEP.ringSlope} x length), posed`, ringJumpExcessMm: 'the same minus the bind |dy| of that edge',
      all_hipSides: `every number twice: 'all' = the whole band, 'hipSides' = edges ${STEP.sides[0]}-${STEP.sides[1]} deg around from the front on either side (atan2(x, z) of the bind midpoint)`,
      frames: 'tools/cloth_integrity.mjs runCase default timeline (worker path), measured every 3rd 60 Hz frame in idle / walk / run' },
    target: 'none yet (cause unknown): the cloth-on rows should come close to the cloth-off rows; this is the baseline',
    rows,
  };
}

// ---- case 4: hair vs collar / hood ------------------------------------------------------------------------------------
// The viewer's hair capsule push (web/materials.js createHairCollider + the vertex shader) re-implemented numerically:
// constants imported, the code is a port (no three.js in node). Kept close to the original line by line.
const HAIR_CAPSULES = [['upperarm_l', 'lowerarm_l', 0.45, 0.06, false], ['upperarm_r', 'lowerarm_r', 0.45, 0.06, false], ['spine_03', 'neck_01', 0.8, 0.11, true]];
const HAIR_CLEAR = { gap: 0.006, maxR: 0.2, halfWidth: 0.1, from: 0.0, to: 0.05 };
const HAIR_COLLIDE_FROM = 0.05;
/** web/materials.js imports three.js through the CDN import map, so node cannot import it: check the copies above
 *  (and the two lines of logic they feed) against its source text instead. */
export function hairConstantsMatch() {
  const src = fs.readFileSync(path.join(PROJECT, 'web', 'materials.js'), 'utf8').replace(/\s+/g, ' ');
  const caps = HAIR_CAPSULES.map(c => `[${c.map(x => (typeof x === 'string' ? `'${x}'` : x)).join(', ')}]`);
  return [...caps, '{ gap: 0.006, maxR: 0.2, halfWidth: 0.1, from: 0.0, to: 0.05 }', `HAIR_COLLIDE_FROM = ${HAIR_COLLIDE_FROM};`,
    'ccCollideTo.value = cleared ? HAIR_CLEAR.to : HAIR_COLLIDE_FROM + 0.08', 'radii[k] = Math.max(0, Math.min(maxR, 0.96 * best[k]))',
    'if (v.z > c.z - 0.02 || Math.abs(v.x - c.x) > HAIR_CLEAR.halfWidth) continue']
    .every(s => src.includes(s));
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function restHeads(D, ch) {
  // rest bone head = bind head (inverse of the rigid inverse-bind matrix) + the slider joint offset (cloth_sim setSliders)
  const delta = D.names.map(() => [0, 0, 0]);
  for (const [m, w] of Object.entries(ch.influences)) { if (!w) continue; for (const [bn, d] of Object.entries(D.joints.morphs[m] || {})) { const i = D.names.indexOf(bn); if (i >= 0) for (let k = 0; k < 3; k++) delta[i][k] += w * d[k]; } }
  return D.names.map((_, i) => { const m = D.ibm[i], t = [m[12], m[13], m[14]];
    return [-(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]) + delta[i][0], -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]) + delta[i][1], -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]) + delta[i][2]]; });
}
function hairCollider(D, hair, hBase, ch, garmentBases) {
  const len = hair.attr._CCHAIR, idx = HAIR_CAPSULES.map(([a, b]) => [D.names.indexOf(a), D.names.indexOf(b)]);
  const ok = !!len && idx.every(([a, b]) => a >= 0 && b >= 0);
  if (!ok) return { ok, push: () => {}, radii: [0, 0, 0], cleared: false };
  const heads = restHeads(D, ch), verts = [];
  for (let i = 0; i < len.length; i++) if (len[i] > HAIR_COLLIDE_FROM) verts.push(i);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const segDist = (p, a, b) => { const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-12))); return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t); };
  const caps = HAIR_CAPSULES.map(([, , frac], k) => { const a = heads[idx[k][0]], b = heads[idx[k][1]]; return [a, [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac]]; });
  const best = HAIR_CAPSULES.map(() => Infinity);
  for (const i of verts) { const v = [hBase[3 * i], hBase[3 * i + 1], hBase[3 * i + 2]]; caps.forEach(([a, b], k) => { const d = segDist(v, a, b); if (d < best[k]) best[k] = d; }); }
  const radii = [0, 0, 0]; let cleared = false;
  const garmentBack = (a, b) => {
    const ab = sub(b, a), l2 = Math.max(dot(ab, ab), 1e-12); let far = 0;
    for (const G of garmentBases) for (let i = 0; i < G.length; i += 3) {
      const v = [G[i], G[i + 1], G[i + 2]], t = Math.min(1, dot(sub(v, a), ab) / l2);
      if (t <= 0) continue;
      const c = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
      if (v[2] > c[2] - 0.02 || Math.abs(v[0] - c[0]) > HAIR_CLEAR.halfWidth) continue;
      far = Math.max(far, Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]));
    }
    return far;
  };
  HAIR_CAPSULES.forEach(([, , , maxR, clears], k) => {
    radii[k] = Math.max(0, Math.min(maxR, 0.96 * best[k]));
    if (clears && garmentBases.length) { const far = garmentBack(caps[k][0], caps[k][1]), r = Math.min(HAIR_CLEAR.maxR, far + HAIR_CLEAR.gap); if (far && r > radii[k]) { radii[k] = r; cleared = true; } }
  });
  const from = cleared ? HAIR_CLEAR.from : HAIR_COLLIDE_FROM, to = cleared ? HAIR_CLEAR.to : HAIR_COLLIDE_FROM + 0.08;
  // posed: capsules from the animated bones (world = mesh space here), push every weighted vertex out (vertex shader)
  const push = (X) => {
    const C = HAIR_CAPSULES.map(([, , frac], k) => { const a = ch.jointPos(D.names[idx[k][0]]), b = ch.jointPos(D.names[idx[k][1]]); return [a, [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac]]; });
    for (let i = 0; i < len.length; i++) {
      const w = smooth(from, to, len[i]);
      if (!(w > 0)) continue;
      for (let k = 0; k < 3; k++) {
        const [A, B] = C[k], ab = sub(B, A), p = [X[3 * i], X[3 * i + 1], X[3 * i + 2]];
        const h = Math.max(0, Math.min(1, dot(sub(p, A), ab) / Math.max(dot(ab, ab), 1e-8)));
        const d = [p[0] - A[0] - ab[0] * h, p[1] - A[1] - ab[1] * h, p[2] - A[2] - ab[2] * h], l = Math.hypot(...d);
        if (l < radii[k] && l > 1e-5) { const f = (radii[k] - l) * w / l; X[3 * i] += d[0] * f; X[3 * i + 1] += d[1] * f; X[3 * i + 2] += d[2] * f; }
      }
    }
  };
  return { ok, push, radii: radii.map(r3), cleared };
}
const HAIR_OUTFITS = { jacket: ['tshirt', 'jeans', 'jacket'], hoodie: ['hoodie', 'jeans'], coat: ['tshirt', 'jeans', 'trenchcoat'] };
const HAIR_GARMENT = { jacket: 'jacket', hoodie: 'hoodie', coat: 'trenchcoat' };
const COLLAR = { reach: 0.03, inside: 0.002, jacketNeckDrop: 0.07, jacketRadius: 0.14 };
export async function probeHair(D, { bodies = ['male', 'female'], styles = null, quick = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(D.dir ?? OUT, 'hair.json'), 'utf8'));
  const ids = styles ?? manifest.styles.map(s => s.id);
  const hairs = Object.fromEntries(ids.map(id => { const s = manifest.styles.find(x => x.id === id); return [id, loadPart(D, s.file, null, ['_CCHAIR'])]; }));
  const garmentParts = { jacket: loadPart(D, 'clothing_jacket.glb'), hoodie: loadPart(D, 'clothing_hoodie.glb', null, ['_CCCOLLAR']), trenchcoat: loadPart(D, 'clothing_trenchcoat.glb', null, ['_CCCOLLAR']) };
  const constantsMatch = hairConstantsMatch();
  const plan = quick ? [['idle', 1], ['walk', 1]] : [['idle', 3], ['walk', 2]];
  const rows = [];
  for (const bn of bodies) {
    const values = PROBE_BODIES[bn], sex = (Number(values.gender ?? 1) || 0) < 0 ? 'female' : 'male';
    for (const [oname, outfit] of Object.entries(HAIR_OUTFITS)) {
      const gid = HAIR_GARMENT[oname], G = garmentParts[gid];
      const worn = resolveOutfit(D.catalog, [...defaultUnderwear(D.catalog, sex), ...outfit]);
      for (const hid of ids) for (const pushOn of [false, true]) {
        const ch = createCharacter(D, values), H = hairs[hid];
        const hBase = morphed(H, ch), gBase = morphed(G, ch);
        // collar / hood region (triangles): _CCCOLLAR on the coat collar and the hoodie hood; the jacket (CC0 collar,
        // no attribute) = vertices within jacketRadius of the neck joint horizontally and above neck - jacketNeckDrop
        const neck = restHeads(D, ch)[D.names.indexOf('neck_01')];
        const inR = v => (G.attr._CCCOLLAR ? G.attr._CCCOLLAR[v] > 0.5
          : gBase[3 * v + 1] >= neck[1] - COLLAR.jacketNeckDrop && Math.hypot(gBase[3 * v] - neck[0], gBase[3 * v + 2] - neck[2]) <= COLLAR.jacketRadius);
        const region = [], sgn = triSigns(G.positions, G.normals, G.index), rs = [];
        for (let t = 0, k = 0; t < G.index.length; t += 3, k++) if (inR(G.index[t]) && inR(G.index[t + 1]) && inR(G.index[t + 2])) { region.push(G.index[t], G.index[t + 1], G.index[t + 2]); rs.push(sgn[k]); }
        const RT = Int32Array.from(region), RS = Int8Array.from(rs);
        const col = pushOn ? hairCollider(D, H, hBase, ch, worn.map(id => morphed(D.garments[id], ch))) : null;
        const hPos = new Float32Array(hBase.length), gPos = new Float32Array(gBase.length);
        const acc = {};
        const frame = (clip) => {
          skinned(H, hBase, ch, hPos); skinned(G, gBase, ch, gPos);
          if (col) col.push(hPos);
          // inside: nearest region triangle (projection inside it, |plane distance| <= reach) on its inner side
          const cell = 0.04, grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
          for (let t = 0; t < RT.length; t += 3) {
            const lo = [0, 1, 2].map(k => Math.floor((Math.min(gPos[3 * RT[t] + k], gPos[3 * RT[t + 1] + k], gPos[3 * RT[t + 2] + k]) - COLLAR.reach) / cell));
            const hi = [0, 1, 2].map(k => Math.floor((Math.max(gPos[3 * RT[t] + k], gPos[3 * RT[t + 1] + k], gPos[3 * RT[t + 2] + k]) + COLLAR.reach) / cell));
            for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = key(x, y, z); let L = grid.get(k); if (!L) grid.set(k, (L = [])); L.push(t); }
          }
          let inside = 0, deep = 0;
          const n = [0, 0, 0];
          for (let v = 0; v < hPos.length / 3; v++) {
            const p = [hPos[3 * v], hPos[3 * v + 1], hPos[3 * v + 2]], L = grid.get(key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)));
            if (!L) continue;
            let best = Infinity, sd = 0;
            for (const t of L) {
              const a = 3 * RT[t], b = 3 * RT[t + 1], c = 3 * RT[t + 2];
              triNormal(gPos, a, b, c, n);
              const s = (p[0] - gPos[a]) * n[0] + (p[1] - gPos[a + 1]) * n[1] + (p[2] - gPos[a + 2]) * n[2];
              if (Math.abs(s) > COLLAR.reach || Math.abs(s) >= best) continue;
              const ux = gPos[b] - gPos[a], uy = gPos[b + 1] - gPos[a + 1], uz = gPos[b + 2] - gPos[a + 2], vx = gPos[c] - gPos[a], vy = gPos[c + 1] - gPos[a + 1], vz = gPos[c + 2] - gPos[a + 2];
              const wx = p[0] - gPos[a], wy = p[1] - gPos[a + 1], wz = p[2] - gPos[a + 2];
              const uu = ux * ux + uy * uy + uz * uz, uv = ux * vx + uy * vy + uz * vz, vv = vx * vx + vy * vy + vz * vz, wu = wx * ux + wy * uy + wz * uz, wv = wx * vx + wy * vy + wz * vz, den = uv * uv - uu * vv;
              if (Math.abs(den) < 1e-18) continue;
              const bs = (uv * wv - vv * wu) / den, bt = (uv * wu - uu * wv) / den;
              if (bs < 0 || bt < 0 || bs + bt > 1) continue;
              best = Math.abs(s); sd = s * RS[t / 3];
            }
            if (best < Infinity && sd < -COLLAR.inside) { inside++; deep = Math.max(deep, -sd); }
          }
          // hair triangle edges that cross a region triangle (segment-triangle intersection)
          const hit = rayCaster(gPos, RT, 0.03), HI = H.index, seen = new Set();
          let crossing = 0;
          for (let t = 0; t < HI.length; t += 3) for (let e = 0; e < 3; e++) {
            const a = HI[t + e], b = HI[t + (e + 1) % 3], k = a < b ? a * 1e6 + b : b * 1e6 + a;
            if (seen.has(k)) continue; seen.add(k);
            const A = [hPos[3 * a], hPos[3 * a + 1], hPos[3 * a + 2]], d = [hPos[3 * b] - A[0], hPos[3 * b + 1] - A[1], hPos[3 * b + 2] - A[2]], l = Math.hypot(...d);
            if (l < 1e-9) continue;
            // cheap reject: both ends far from the collar grid
            if (!grid.get(key(Math.floor(A[0] / cell), Math.floor(A[1] / cell), Math.floor(A[2] / cell))) && !grid.get(key(Math.floor(hPos[3 * b] / cell), Math.floor(hPos[3 * b + 1] / cell), Math.floor(hPos[3 * b + 2] / cell)))) continue;
            if (hit(A, d.map(c => c / l), l, 0) < Infinity) crossing++;
          }
          const o = (acc[clip] ??= { frames: 0, hairInside: 0, hairInsideMm: 0, edgesCrossing: 0 });
          o.frames++; o.hairInside = Math.max(o.hairInside, inside); o.hairInsideMm = Math.max(o.hairInsideMm, deep * 1000); o.edgesCrossing = Math.max(o.edgesCrossing, crossing);
        };
        animate(ch, plan, frame, { every: quick ? 10 : 5 });
        for (const [clip, o] of Object.entries(acc)) rows.push({ body: bn, hair: hid, garment: oname, push: pushOn, clip, regionTris: RT.length / 3, hairVerts: hBase.length / 3,
          frames: o.frames, hairInside: o.hairInside, edgesCrossing: o.edgesCrossing, ...(col ? { capsuleRadii: col.radii, cleared: col.cleared } : {}) });
      }
    }
  }
  return {
    what: 'Hair against the collar / hood (ROADMAP M2b): hair is static and skinned to head / neck / upper spine / clavicles.',
    method: { region: 'coat collar and hoodie hood: _CCCOLLAR = 1 triangles; jacket (CC0 collar, no attribute): triangles within 14 cm of the neck joint horizontally and above neck - 7 cm (rest pose)',
      hairInside: 'max per frame of hair vertices whose nearest region triangle (projection inside it, within 3 cm) has them 2-30 mm on its INNER side (between collar / hood and neck). Placement, not necessarily visible: nape hair of short styles under a standing collar counts too',
      edgesCrossing: 'max per frame of hair triangle edges that intersect a region triangle (hair through the collar / hood: the visible clipping; docs/STATUS.md counted the same for the coat collar)', push: 'false = skinned hair as exported; true = the viewer default (?hairCollide on): the capsule push of web/materials.js ported to node (constants checked against the source: constantsMatch)',
      frames: quick ? 'idle 1 s, walk 1 s, every 1/3 s' : 'idle 3 s, walk 2 s (30 fps animator), every 1/6 s, 0.35 s fade skipped', garments: 'skinned (the coat collar is fully pinned, so cloth does not move it)' },
    constantsMatch,
    target: 'none set by the roadmap (count only); fewer is better, 0 = no hair inside or through the collar',
    rows,
  };
}

// ---- case 5: existing integrity numbers ------------------------------------------------------------------------------
export function probeIntegrity(dir = path.join(PROJECT, 'docs', 'baseline')) {
  const files = ['default', 'moves', 'land'].map(t => [t, path.join(dir, `integrity_${t}.json`)]).filter(([, f]) => fs.existsSync(f));
  const finger = /^(hand|thumb|index|middle|ring|pinky)/;
  const pick = { braIdleFidget: [], fingersThroughCoat: [], coatJeansJump: [] };
  const src = {};
  for (const [tl, f] of files) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    src[tl] = { commit: j.commit, measured: j.measured, cases: j.cases, failing: j.failing };
    for (const r of [...j.failingRows, ...j.hitRows]) {
      const row = { timeline: tl, outfit: r.outfit, body: r.body, pair: r.pair, clip: r.clip, poke: { n: r.poke.n, mm: r.poke.mm, bone: r.poke.at?.bone ?? null }, sink: { n: r.sink.n, mm: r.sink.mm, bone: r.sink.at?.bone ?? null }, fail: r.fail };
      if (r.pair.startsWith('bra:') && r.clip === 'idle_fidget') pick.braIdleFidget.push(row);
      if (r.pair === 'trenchcoat:body' && finger.test(r.poke.at?.bone ?? '')) pick.fingersThroughCoat.push(row);
      if (r.pair === 'trenchcoat:jeans' && r.clip === 'jump') pick.coatJeansJump.push(row);
    }
  }
  return {
    what: 'Existing numbers from the M2 integrity baseline, kept as the baseline of three faults (ROADMAP M2b). No new run.',
    method: { source: 'docs/baseline/integrity_{default,moves,land}.json (failingRows + hitRows; rows without any hit are not stored there, i.e. 0)',
      braIdleFidget: 'pair bra:<inner> in clip idle_fidget (every outfit and body)', fingersThroughCoat: 'pair trenchcoat:body whose deepest POKE vertex is on a hand / finger bone (any clip; the count n is all poke vertices of that case, the bone is only that of the deepest)',
      coatJeansJump: 'pair trenchcoat:jeans in clip jump' },
    note: 'dress / jacket outfits have no bra row in idle_fidget: the bra under them had no hit above 2 mm in the baseline; the reported 3 v / 29.9 mm is the female underwear-only and boots outfits',
    sources: src, ...pick,
  };
}

// ---- case 6: _CCZONE in the animation GLB ---------------------------------------------------------------------------
export function probeAnimZone(dir = OUT) {
  const per = f => { const g = readGlb(path.join(dir, f)), P = meshParts(g); return Object.fromEntries(Object.entries(P).map(([n, p]) => [n, Object.keys(g.json.meshes[p.nodeDef.mesh].primitives[0].attributes).includes('_CCZONE')])); };
  const base = per('base_body.glb'), anim = per('base_body_anim.glb');
  return { what: 'base_body_anim.glb carries the body _CCZONE attribute like base_body.glb (ROADMAP M2b; hidden-skin zones are lost in the animation GLB without it).',
    baseBodyHasZone: base.Body === true, animBodyHasZone: anim.Body === true, perMesh: { 'base_body.glb': base, 'base_body_anim.glb': anim }, target: 'animBodyHasZone = true' };
}

// ---- CLI -----------------------------------------------------------------------------------------------------------------
export const CASES = ['jaw', 'dresscoat', 'dressstep', 'hair', 'integrity', 'animzone'];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : ''; };
  const only = (opt('--only') || CASES.join(',')).split(','), quick = opt('--quick') !== null, json = opt('--json');
  let commit = opt('--commit');
  if (!commit) try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PROJECT }).toString().trim(); } catch { commit = null; }
  const D = loadData();
  const t0 = Date.now(), cases = {}, ms = {};
  const run = async (k, f) => { if (!only.includes(k)) return; const t = Date.now(); console.error(`# ${k} ...`); cases[k] = await f(); ms[k] = Date.now() - t; console.error(`# ${k} done in ${((Date.now() - t) / 1000).toFixed(1)} s`); };
  await run('animzone', () => probeAnimZone());
  await run('integrity', () => probeIntegrity());
  await run('jaw', () => probeJaw(D, { quick }));
  await run('dressstep', () => probeDressStep(D, { quick }));
  await run('hair', () => probeHair(D, { quick }));
  await run('dresscoat', () => probeDressCoat(D, { quick }));
  const rep = { tool: 'visual_probes', roadmap: 'M2b', commit, node: process.version, measured: new Date().toISOString().slice(0, 10), quick, ms, cases };
  const s = JSON.stringify(rep, null, 1);
  if (json) fs.writeFileSync(path.resolve(json), s + '\n'); else console.log(s);
  console.error(`# all done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
