// Body collision capsules for cloth simulation (docs/CLOTH_SPEC.md), derived from the exported body:
//   node tools/make_colliders.mjs [output-dir]      -> <output-dir>/body_colliders.json
//
// Each capsule runs between two joint heads of output/base_body.joints.json (so its ends move with the sliders
// exactly like the skeleton: head + sum(weight * morph offset)), with a radius measured on the body mesh:
// the 25th percentile of the distances to the segment of the body vertices skinned mainly (> 0.5) to the capsule's bone and
// lying between the two ends. radiusMorphs[m] = radius at morph m (weight 1) - radius at neutral, so
//   radius(sliders) = radius + sum(weight_m * radiusMorphs[m])   (same linear model as the morph targets).
// Only macro morphs and correctives are measured (face morphs do not change the body silhouette).
// Units: metres, glTF Y-up bind pose (the frame of base_body.glb and the joints sidecar).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, meshParts, jointNames } from './glb.mjs';
import * as Q from '../web/animation/qmath.js';

// name, bone the vertices belong to, from joint, to joint (or [joint, offset] for the head sphere / hand end)
export const CAPSULES = [
  ['pelvis', 'pelvis', 'pelvis', 'spine_01'],
  ['abdomen', 'spine_01', 'spine_01', 'spine_02'],
  ['chest', 'spine_02', 'spine_02', 'spine_03'],
  ['upperChest', 'spine_03', 'spine_03', 'neck_01'],
  ['neck', 'neck_01', 'neck_01', 'head'],
  ['head', 'head', 'head', 'head'],
  ['upperarm_l', 'upperarm_l', 'upperarm_l', 'lowerarm_l'], ['upperarm_r', 'upperarm_r', 'upperarm_r', 'lowerarm_r'],
  ['lowerarm_l', 'lowerarm_l', 'lowerarm_l', 'hand_l'], ['lowerarm_r', 'lowerarm_r', 'lowerarm_r', 'hand_r'],
  ['thigh_l', 'thigh_l', 'thigh_l', 'calf_l'], ['thigh_r', 'thigh_r', 'thigh_r', 'calf_r'],
  ['calf_l', 'calf_l', 'calf_l', 'foot_l'], ['calf_r', 'calf_r', 'calf_r', 'foot_r'],
  ['foot_l', 'foot_l', 'foot_l', 'ball_l'], ['foot_r', 'foot_r', 'foot_r', 'ball_r'],
];

// Cloth collision set (web/cloth, docs/CLOTH_RUNTIME.md): thicker radii (quantile q of the distances, i.e. close
// to the skin surface instead of inscribed) and legs/arms split into sub-segments t0..t1 of from -> to, so a
// segment's radius fits its own part of the limb. name, bones measured, from, to, t0, t1, q.
// limit groups: a garment lists the groups (ccCloth.limit, default "arms,hips") whose capsules push a particle
// out no further than its skinned target lies (+ solver limitSlack). Where the garment's own cut already lies
// inside them (hands at the coat's sides, a tight skirt over the hips / upper thighs) the cloth must not fight
// its pins. A long coat keeps the thighs hard (the knee must not poke through in run); lower legs, feet and the
// floor are always hard.
export const CLOTH_LIMIT = { arms: /^(upperarm|lowerarm|hand)_[lr]$/, hips: /^(torso|hips)$/, thighs: /^thighUp_[lr]$/ };
const limitGroup = name => Object.keys(CLOTH_LIMIT).find(k => CLOTH_LIMIT[k].test(name));
export const CLOTH_CAPSULES = [
  ['torso', ['spine_01', 'spine_02'], 'spine_01', 'spine_03', 0, 1, 0.35],
  ['hips', ['pelvis'], 'thigh_r', 'thigh_l', 0, 1, 0.55],
  ['thighUp_l', ['thigh_l'], 'thigh_l', 'calf_l', 0, 0.5, 0.75], ['thighUp_r', ['thigh_r'], 'thigh_r', 'calf_r', 0, 0.5, 0.75],
  ['thighLo_l', ['thigh_l'], 'thigh_l', 'calf_l', 0.5, 1, 0.75], ['thighLo_r', ['thigh_r'], 'thigh_r', 'calf_r', 0.5, 1, 0.75],
  ['calfUp_l', ['calf_l'], 'calf_l', 'foot_l', 0, 0.5, 0.85], ['calfUp_r', ['calf_r'], 'calf_r', 'foot_r', 0, 0.5, 0.85],
  ['calfLo_l', ['calf_l'], 'calf_l', 'foot_l', 0.5, 1, 0.85], ['calfLo_r', ['calf_r'], 'calf_r', 'foot_r', 0.5, 1, 0.85],
  // heel (t < 0) to toe tips (t > 1)
  ['foot_l', ['foot_l', 'ball_l'], 'foot_l', 'ball_l', -0.3, 1.5, 0.75], ['foot_r', ['foot_r', 'ball_r'], 'foot_r', 'ball_r', -0.3, 1.5, 0.75],
  ['upperarm_l', ['upperarm_l'], 'upperarm_l', 'lowerarm_l', 0, 1, 0.7], ['upperarm_r', ['upperarm_r'], 'upperarm_r', 'lowerarm_r', 0, 1, 0.7],
  ['lowerarm_l', ['lowerarm_l'], 'lowerarm_l', 'hand_l', 0, 1, 0.7], ['lowerarm_r', ['lowerarm_r'], 'lowerarm_r', 'hand_r', 0, 1, 0.7],
  // palm + fingers: wrist to past the knuckles, measured on the hand and finger vertices
  ...['l', 'r'].map(s => [`hand_${s}`, ['hand', 'thumb_01', 'thumb_02', 'thumb_03', 'index_01', 'index_02', 'index_03', 'middle_01',
    'middle_02', 'middle_03', 'ring_01', 'ring_02', 'ring_03', 'pinky_01', 'pinky_02', 'pinky_03'].map(b => `${b}_${s}`),
  `hand_${s}`, `middle_01_${s}`, 0, 1.9, 0.8]),
];

function segDist(p, a, b) {
  const ab = Q.vSub(b, a), l2 = Q.vDot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Q.vDot(Q.vSub(p, a), ab) / l2;
  return { d: Q.vLen(Q.vSub(p, Q.vAdd(a, Q.vScale(ab, Math.min(1, Math.max(0, t)))))), t };
}
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * q)] : 0; };
const RQ = 0.25;                     // radius = 25th percentile of the distances (inscribed rather than enclosing)

export function buildColliders(dir) {
  const G = readGlb(path.join(dir, 'base_body.glb'));
  const P = meshParts(G).Body, prim = P.prims[0], names = jointNames(G);
  const joints = JSON.parse(fs.readFileSync(path.join(dir, 'base_body.joints.json'), 'utf8'));
  const dominant = prim.joints.map((j, i) => {
    let best = -1, bw = 0.5;
    j.forEach((ji, k) => { if (prim.weights[i][k] > bw) { bw = prim.weights[i][k]; best = ji; } });
    return best >= 0 ? names[best] : null;
  });
  const morphs = P.targetNames.map((n, t) => [n, t]).filter(([n]) => !/^(face_|blink_|look_)/.test(n));
  const parts = n => (n.startsWith('corr_') ? n.slice(5).split('__') : []);
  const headAt = (bone, w) => {
    let h = joints.bones[bone];
    for (const [m, x] of Object.entries(w)) { const o = joints.morphs[m]?.[bone]; if (o) h = Q.vAdd(h, Q.vScale(o, x)); }
    return h;
  };
  const measure = (c, w) => {
    const [, bone, from, to] = c;
    const a = headAt(from, w);
    let b = headAt(to, w);
    const pos = prim.pos.map((p, i) => {
      let q = p;
      for (const [m, x] of Object.entries(w)) q = Q.vAdd(q, Q.vScale(prim.targets[P.targetNames.indexOf(m)][i], x));
      return q;
    });
    const sel = pos.filter((_, i) => dominant[i] === bone);
    if (from === to) {               // head sphere: centre = bounding-box centre of the head vertices
      const lo = [0, 1, 2].map(k => Math.min(...sel.map(p => p[k]))), hi = [0, 1, 2].map(k => Math.max(...sel.map(p => p[k])));
      const cen = lo.map((v, k) => (v + hi[k]) / 2);
      return { a: cen, b: cen, r: pct(sel.map(p => Q.vLen(Q.vSub(p, cen))), RQ) };
    }
    const ds = sel.map(p => segDist(p, a, b)).filter(x => x.t > 0.1 && x.t < 0.9).map(x => x.d);
    return { a, b, r: pct(ds, RQ) };
  };
  const measureCloth = (c, w) => {
    const [, bones, from, to, t0, t1, q] = c;
    const A = headAt(from, w), B = headAt(to, w);
    const a = Q.vAdd(A, Q.vScale(Q.vSub(B, A), t0)), b = Q.vAdd(A, Q.vScale(Q.vSub(B, A), t1));
    const ds = [];
    prim.pos.forEach((p, i) => {
      if (!bones.includes(dominant[i])) return;
      let v = p;
      for (const [m, x] of Object.entries(w)) v = Q.vAdd(v, Q.vScale(prim.targets[P.targetNames.indexOf(m)][i], x));
      const s = segDist(v, a, b);
      if (s.t > 0.05 && s.t < 0.95) ds.push(s.d);
    });
    return { r: pct(ds, q) };
  };
  const cloth = [];
  for (const c of CLOTH_CAPSULES) {
    const r0 = measureCloth(c, {}).r;
    const radiusMorphs = {};
    for (const [n] of morphs) {
      let r = measureCloth(c, { [n]: 1 }).r - r0;
      if (n.startsWith('corr_')) {
        const [x, y] = parts(n);
        r = measureCloth(c, { [x]: 1, [y]: 1, [n]: 1 }).r - r0 - (radiusMorphs[x] ?? 0) - (radiusMorphs[y] ?? 0);
      }
      if (Math.abs(r) > 5e-4) radiusMorphs[n] = +r.toFixed(4);
    }
    const [name, bones, from, to, t0, t1, q] = c;
    cloth.push({ name, bones, from, to, t0, t1, quantile: q, ...(limitGroup(name) ? { clothLimit: limitGroup(name) } : {}),
      radius: +r0.toFixed(4), radiusMorphs });
  }
  const out = [];
  for (const c of CAPSULES) {
    const m0 = measure(c, {});
    const radiusMorphs = {};
    for (const [n] of morphs) {
      const w = { [n]: 1 };
      let r = measure(c, w).r - m0.r;
      if (n.startsWith('corr_')) {        // corrective: corner minus the two single extremes
        const [x, y] = parts(n);
        r = measure(c, { [x]: 1, [y]: 1, [n]: 1 }).r - m0.r - (radiusMorphs[x] ?? 0) - (radiusMorphs[y] ?? 0);
      }
      if (Math.abs(r) > 5e-4) radiusMorphs[n] = +r.toFixed(4);
    }
    const [name, bone, from, to] = c;
    out.push({ name, bone, from, to, sphere: from === to, radius: +m0.r.toFixed(4),
      ...(from === to ? { center: m0.a.map(v => +v.toFixed(4)) } : {}), radiusMorphs });
  }
  return {
    version: 1, units: 'metres, glTF Y-up, bind pose (base_body.glb)',
    source: 'tools/make_colliders.mjs from base_body.glb + base_body.joints.json',
    ends: 'capsule ends = joint heads of base_body.joints.json (move with the sliders like applySkeleton); '
      + 'in a pose they follow the skinned joints (from/to bone world positions)',
    radiusModel: 'radius + sum(morphWeight * radiusMorphs[morph]); correctives weight = product of their two macro weights',
    capsules: out,
    cloth: {
      use: 'collision set of the cloth runtime (web/cloth): ends = from + t0 * (to - from) .. from + t1 * (to - from) '
        + 'of the posed joint positions; radius = quantile of the skin distances (near the surface), same radius model; '
        + 'clothLimit (group): for garments listing the group in ccCloth.limit the capsule pushes a particle out no '
        + 'further than its skinned target lies (+ solver limitSlack)',
      capsules: cloth,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || path.join(fileURLToPath(new URL('..', import.meta.url)), 'output'));
  const c = buildColliders(dir);
  fs.writeFileSync(path.join(dir, 'body_colliders.json'), JSON.stringify(c, null, 1));
  for (const k of c.capsules) console.log(`COLLIDER ${k.name.padEnd(11)} r ${(k.radius * 100).toFixed(1)} cm, morphs ${Object.keys(k.radiusMorphs).length}`);
  for (const k of c.cloth.capsules) console.log(`CLOTH    ${k.name.padEnd(11)} r ${(k.radius * 100).toFixed(1)} cm, morphs ${Object.keys(k.radiusMorphs).length}`);
}
