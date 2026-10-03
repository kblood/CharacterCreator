// SPDX-License-Identifier: GPL-3.0-or-later
// Hair/loose-part colliders per test body from output/base_body.glb (read-only) -> data/hair_colliders.json
//   headSphere  centre (rest, character frame) = bbox centre of head-weighted vertices, r = 80th pct distance
//   capsules    neck (neck -> head), chest (upperChest -> neck), shoulderL/R (Shoulder -> UpperArm), radius =
//               75th pct distance of the bone's own (dominant weight) vertices, as in prep_bodies.mjs; the chest
//               only uses the middle strip |x| < 6 cm (front/back depth; the shoulders are wider than a capsule)
// Run: node prep_hair.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, meshParts, jointNames } from '../../tools/glb.mjs';
import { sliderInfluences } from '../../web/character.js';
import { headsFromSidecar } from '../../web/animation/rig.js';
import { BODIES } from './lib/bodies.mjs';

export const HAIR_CAPSULES = [
  ['neck', 'neck', 'head', ['neck_01']],
  ['chest', 'upperChest', 'neck', ['spine_03'], 0.06],
  ['shoulderL', 'leftShoulder', 'leftUpperArm', ['clavicle_l']],
  ['shoulderR', 'rightShoulder', 'rightUpperArm', ['clavicle_r']],
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const sidecar = JSON.parse(fs.readFileSync(path.join(REPO, 'output/base_body.joints.json'), 'utf8'));
const g = readGlb(path.join(REPO, 'output/base_body.glb'));
const prim = meshParts(g).Body.prims[0];
const names = jointNames(g);
const tIndex = Object.fromEntries(meshParts(g).Body.targetNames.map((n, i) => [n, i]));
const dominant = prim.joints.map((js, i) => { const w = prim.weights[i]; let k = 0; for (let c = 1; c < 4; c++) if (w[c] > w[k]) k = c; return names[js[k]]; });
const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r4 = v => Math.round(v * 1e4) / 1e4;
function segDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
  return [Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]), t];
}

const out = { generated: 'prep_hair.mjs', bodies: {} };
for (const [id, values] of Object.entries(BODIES)) {
  const inf = sliderInfluences(values);
  const heads = headsFromSidecar(sidecar, inf);
  const active = Object.entries(inf).filter(([n, w]) => w && tIndex[n] !== undefined).map(([n, w]) => [prim.targets[tIndex[n]], w]);
  const P = prim.pos.map((p, i) => { const q = [...p]; for (const [T, w] of active) { q[0] += w * T[i][0]; q[1] += w * T[i][1]; q[2] += w * T[i][2]; } return q; });
  const hv = P.filter((_, i) => dominant[i] === 'head');
  const c = [0, 1, 2].map(k => { let lo = Infinity, hi = -Infinity; for (const p of hv) { lo = Math.min(lo, p[k]); hi = Math.max(hi, p[k]); } return (lo + hi) / 2; });
  const headSphere = { c: c.map(r4), r: r4(pct(hv.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])), 0.8)), n: hv.length };
  const capsules = {};
  for (const [name, ja, jb, bones, maxX] of HAIR_CAPSULES) {
    const ds = [];
    P.forEach((p, i) => { if (!bones.includes(dominant[i]) || (maxX && Math.abs(p[0]) > maxX)) return; const [d, t] = segDist(p, heads[ja], heads[jb]); if (t > 0.1 && t < 0.9) ds.push(d); });
    capsules[name] = { a: ja, b: jb, r: r4(pct(ds, 0.75)), n: ds.length };
  }
  out.bodies[id] = { headSphere, capsules };
  console.log(id.padEnd(8), 'head r', headSphere.r, Object.entries(capsules).map(([k, v]) => `${k}=${v.r}`).join(' '));
}
fs.writeFileSync(path.join(HERE, 'data/hair_colliders.json'), JSON.stringify(out, null, 1));
console.log('wrote data/hair_colliders.json');
