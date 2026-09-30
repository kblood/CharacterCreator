// Measures the 6 test bodies from output/base_body.glb (read-only) -> data/bodies.json:
//   heads    rest joint heads (canonical names, character frame) from the joints sidecar
//   capsules { name: { a, b, r } } radius = 75th percentile of the distance of the capsule's own vertices
//            (dominant skin weight, middle 70 % of the segment) to the segment
//   profile  body silhouette for fitting the skirt: rows every PROFILE_DY metres from the waist down to
//            below the knee, PROFILE_BINS polar bins around (0, hips.z): max radius of body vertices
//            (arms/hands excluded) in that slice.
// Run: node prep_bodies.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, meshParts, jointNames } from '../../tools/glb.mjs';
import { sliderInfluences } from '../../web/character.js';
import { headsFromSidecar } from '../../web/animation/rig.js';
import { BODIES, CAPSULES, PROFILE_BINS, PROFILE_DY, capsuleEnds } from './lib/bodies.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const sidecar = JSON.parse(fs.readFileSync(path.join(REPO, 'output/base_body.joints.json'), 'utf8'));
const g = readGlb(path.join(REPO, 'output/base_body.glb'));
const body = meshParts(g).Body;
const nd = body.nodeDef;
if (nd.translation || nd.rotation || nd.scale || nd.matrix) console.warn('Body node has a transform - ignored');
const prim = body.prims[0];
const names = jointNames(g);
const tIndex = Object.fromEntries(body.targetNames.map((n, i) => [n, i]));
const dominant = prim.joints.map((js, i) => {
  const w = prim.weights[i]; let k = 0;
  for (let c = 1; c < 4; c++) if (w[c] > w[k]) k = c;
  return names[js[k]];
});
const ARMS = /^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky|clavicle)_/;

function segDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2));
  const d = [ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]];
  return [Math.hypot(d[0], d[1], d[2]), t];
}
const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r4 = v => Math.round(v * 1e4) / 1e4;

const out = { generated: 'prep_bodies.mjs from output/base_body.glb + base_body.joints.json', PROFILE_BINS, PROFILE_DY, bodies: {} };
for (const [id, values] of Object.entries(BODIES)) {
  const inf = sliderInfluences(values);
  const heads = headsFromSidecar(sidecar, inf);
  const active = Object.entries(inf).filter(([n, w]) => w && tIndex[n] !== undefined).map(([n, w]) => [prim.targets[tIndex[n]], w]);
  const P = prim.pos.map((p, i) => {
    const q = [...p];
    for (const [T, w] of active) { const d = T[i]; q[0] += w * d[0]; q[1] += w * d[1]; q[2] += w * d[2]; }
    return q;
  });
  let minY = Infinity, maxY = -Infinity;
  for (const p of P) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }

  const capsules = {};
  for (const def of CAPSULES) {
    const [name, ja, jb, bones, t0 = 0, t1 = 1] = def;
    const [a, b] = capsuleEnds(def, heads), ds = [];
    P.forEach((p, i) => {
      if (!bones.includes(dominant[i])) return;
      const [d, t] = segDist(p, a, b);
      if (t > (t0 > 0 ? 0 : 0.15) && t < (t1 < 1 ? 1 : 0.85)) ds.push(d);
    });
    capsules[name] = { a: ja, b: jb, t0, t1, r: r4(pct(ds, 0.75)), n: ds.length };
  }

  // silhouette rows: from the waist (spine joint = spine_01 head) down to 12 cm below the knee
  const cz = heads.hips[2];
  const yTop = heads.spine[1] + 0.02, yBot = (heads.leftLowerLeg[1] + heads.rightLowerLeg[1]) / 2 - 0.12;
  const rows = [];
  for (let y = yTop; y >= yBot; y -= PROFILE_DY) {
    const r = new Array(PROFILE_BINS).fill(0);
    P.forEach((p, i) => {
      if (Math.abs(p[1] - y) > PROFILE_DY * 0.6 || ARMS.test(dominant[i])) return;
      const dx = p[0], dz = p[2] - cz, a = Math.atan2(dx, dz);          // angle 0 = front (+Z), +pi/2 = left (+X)
      const k = ((Math.round(a / (2 * Math.PI) * PROFILE_BINS) % PROFILE_BINS) + PROFILE_BINS) % PROFILE_BINS;
      r[k] = Math.max(r[k], Math.hypot(dx, dz));
    });
    rows.push({ y: r4(y), r: r.map(r4) });
  }
  out.bodies[id] = {
    values, heads: Object.fromEntries(Object.entries(heads).map(([k, v]) => [k, v.map(r4)])),
    meshMinY: r4(minY), meshMaxY: r4(maxY), capsules, profile: { cz: r4(cz), rows },
  };
  console.log(id.padEnd(8), 'height', (maxY - minY).toFixed(3), 'caps', Object.entries(capsules).map(([k, c]) => `${k}=${c.r.toFixed(3)}`).join(' '));
}
fs.mkdirSync(path.join(HERE, 'data'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'data/bodies.json'), JSON.stringify(out));
console.log('wrote data/bodies.json');
