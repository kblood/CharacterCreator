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
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || path.join(fileURLToPath(new URL('..', import.meta.url)), 'output'));
  const c = buildColliders(dir);
  fs.writeFileSync(path.join(dir, 'body_colliders.json'), JSON.stringify(c, null, 1));
  for (const k of c.capsules) console.log(`COLLIDER ${k.name.padEnd(11)} r ${(k.radius * 100).toFixed(1)} cm, morphs ${Object.keys(k.radiusMorphs).length}`);
}
