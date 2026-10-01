// Gate for the baked clips (docs/ANIMATION_PLAN.md section 4 D). Exit code 1 on any failure.
//
// Run (project root): node tools/check_anim_glb.mjs [output/base_body_anim.glb] [--base output/base_body.glb]
//                     [--anim-dir output/animations]
//
// Checks: same 53 joints with the same rest TRS as the base GLB (<= 1e-5, keeps the joints sidecar valid),
// same inverse bind matrices, every mesh node of the base (Body + face parts) present with the same
// morph targets (same names/count as the base, >= 12) / vertex counts / skin; one animation per clip in index.json with the JSON's
// frame count/duration; rotation channels only, except one translation channel on the root bone; every
// baked rotation key == qToLocal(restLocal, restWorld, q_json) (<= 0.5 deg), joints the clip does not
// drive stay at rest; Root translation == rest + pose.root (<= 1 mm); loop closure (looping clips); one-shots
// (jump, land) name an existing `next` clip and ordered events inside the clip; bone-level FK on the baked keys
// of every clip: toes y >= -0.005 m; baked bone FK == fkPositions(sidecar heads, JSON pose) (<= 2 mm, an
// independent check of the whole axis/rest-frame conversion).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Q from '../web/animation/qmath.js';
import { fkPositions } from '../web/animation/canonical.js';
import { headsFromSidecar } from '../web/animation/rig.js';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const args = { glb: path.join(PROJECT, 'output', 'base_body_anim.glb'), base: path.join(PROJECT, 'output', 'base_body.glb'),
  animDir: path.join(PROJECT, 'output', 'animations') };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--base') args.base = path.resolve(a[++i]);
    else if (a[i] === '--anim-dir') args.animDir = path.resolve(a[++i]);
    else if (!a[i].startsWith('--')) args.glb = path.resolve(a[i]);
    else throw new Error(`unknown argument ${a[i]}`);
  }
}

let failures = 0;
const fail = msg => { failures++; console.log('FAIL', msg); };
const ok = msg => console.log('ok  ', msg);

function readGlb(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jlen = b.readUInt32LE(12), json = JSON.parse(b.subarray(20, 20 + jlen).toString());
  const binStart = 20 + jlen + 8, bin = b.subarray(binStart, binStart + b.readUInt32LE(20 + jlen));
  const N = { VEC3: 3, VEC4: 4, SCALAR: 1, MAT4: 16 };
  const accessor = i => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView], n = N[a.type];
    if (a.componentType !== 5126) throw new Error(`accessor ${i}: component type ${a.componentType}, expected float`);
    const stride = bv.byteStride || n * 4, off = (bv.byteOffset || 0) + (a.byteOffset || 0), out = [];
    for (let k = 0; k < a.count; k++) {
      const e = [];
      for (let c = 0; c < n; c++) e.push(bin.readFloatLE(off + k * stride + c * 4));
      out.push(n === 1 ? e[0] : e);
    }
    return out;
  };
  const parent = {};
  json.nodes.forEach((nd, i) => (nd.children || []).forEach(c => { parent[c] = i; }));
  const byName = Object.fromEntries(json.nodes.map((nd, i) => [nd.name, i]));
  return { json, accessor, parent, byName, size: b.length };
}

const A = readGlb(args.glb), B = readGlb(args.base);
const index = JSON.parse(fs.readFileSync(path.join(args.animDir, 'index.json'), 'utf8'));
const clips = Object.fromEntries(index.clips.map(n => [n, JSON.parse(fs.readFileSync(path.join(args.animDir, `${n}.json`), 'utf8'))]));
const rel = f => { const r = path.relative(PROJECT, f); return r && !r.startsWith('..') ? r : f; };
const heads0 = headsFromSidecar(JSON.parse(fs.readFileSync(path.join(PROJECT, 'output', 'base_body.joints.json'), 'utf8')), {});
console.log(`CHECK ${rel(args.glb)} (${(A.size / 1e6).toFixed(2)} MB) vs ${rel(args.base)}, clips ${index.clips.join(', ')}`);

// ---- rest skeleton, skin, morphs --------------------------------------------------------------------
const skinA = A.json.skins?.[0], skinB = B.json.skins?.[0];
const namesA = skinA.joints.map(i => A.json.nodes[i].name), namesB = skinB.joints.map(i => B.json.nodes[i].name);
if (namesA.length === 53 && namesA.join() === namesB.join()) ok('53 skin joints, same names/order as the base');
else fail(`skin joints ${namesA.length} vs base ${namesB.length} (or order differs)`);

let trs = 0;
for (const [i, nd] of B.json.nodes.entries()) {
  const j = A.byName[nd.name];
  if (j === undefined) { fail(`node ${nd.name} missing`); continue; }
  const o = A.json.nodes[j];
  for (const [k, def] of [['translation', [0, 0, 0]], ['rotation', [0, 0, 0, 1]], ['scale', [1, 1, 1]]]) {
    const u = nd[k] || def, v = o[k] || def;
    u.forEach((x, c) => { trs = Math.max(trs, Math.abs(x - v[c])); });
  }
  if ((B.parent[i] === undefined) !== (A.parent[j] === undefined) ||
      (B.parent[i] !== undefined && B.json.nodes[B.parent[i]].name !== A.json.nodes[A.parent[j]].name)) fail(`node ${nd.name}: parent differs`);
}
if (trs <= 1e-5) ok(`node rest TRS equal to base (max diff ${trs.toExponential(1)})`); else fail(`node rest TRS differ by ${trs}`);

{
  const ia = A.accessor(skinA.inverseBindMatrices), ib = B.accessor(skinB.inverseBindMatrices);
  let m = 0; ia.forEach((mat, k) => mat.forEach((x, c) => { m = Math.max(m, Math.abs(x - ib[k][c])); }));
  if (m <= 1e-5) ok(`inverse bind matrices equal (max diff ${m.toExponential(1)})`); else fail(`inverse bind matrices differ by ${m}`);
}
{
  // every mesh node of the base (Body + eyes/brows/lashes/teeth/tongue) must be in the anim GLB with the
  // same morph targets, vertex counts per primitive and skin
  const meshNodes = g => g.json.nodes.filter(nd => nd.mesh !== undefined);
  const bodyName = B.json.meshes[B.json.nodes[B.byName.Body]?.mesh ?? 0].extras?.targetNames || [];
  for (const nb of meshNodes(B)) {
    const j = A.byName[nb.name];
    const na = j === undefined ? null : A.json.nodes[j];
    if (!na || na.mesh === undefined) { fail(`mesh node ${nb.name} missing in the anim GLB`); continue; }
    const ma = A.json.meshes[na.mesh], mb = B.json.meshes[nb.mesh];
    const names = ma.extras?.targetNames || [];
    const va = ma.primitives.map(p => A.json.accessors[p.attributes.POSITION].count);
    const vb = mb.primitives.map(p => B.json.accessors[p.attributes.POSITION].count);
    const nt = ma.primitives.map(p => (p.targets || []).length);
    const good = nt.every(n => n === bodyName.length && n >= 12) && names.join() === (mb.extras?.targetNames || []).join() &&
      names.join() === bodyName.join() && va.join() === vb.join() && na.skin === 0;
    if (good) ok(`${nb.name}: ${nt[0]} morph targets (same names as the base), ${va.join('+')} vertices, skin 0`);
    else fail(`${nb.name}: targets ${nt.join('/')} names ${names.join()}, vertices ${va.join('+')} vs ${vb.join('+')}, skin ${na.skin}`);
  }
  const extraMeshes = meshNodes(A).filter(nd => B.byName[nd.name] === undefined).map(nd => nd.name);
  if (extraMeshes.length) fail(`anim GLB has meshes the base lacks: ${extraMeshes.join(', ')}`);
}

// rest rotations/positions relative to the scene (character) root
const N = A.json.nodes, RW = {}, RP = {};
const rest = i => {
  if (RW[i]) return;
  const r = N[i].rotation || [0, 0, 0, 1], t = N[i].translation || [0, 0, 0], p = A.parent[i];
  if (p === undefined) { RW[i] = r; RP[i] = t; return; }
  rest(p); RW[i] = Q.qMul(RW[p], r); RP[i] = Q.vAdd(RP[p], Q.qRotate(RW[p], t));
};
N.forEach((_, i) => rest(i));

// ---- animations -------------------------------------------------------------------------------------
const anims = Object.fromEntries((A.json.animations || []).map(a => [a.name, a]));
const extra = Object.keys(anims).filter(n => !clips[n]);
if (extra.length) fail(`unexpected animations: ${extra.join(', ')}`);

for (const [name, clip] of Object.entries(clips)) {
  const an = anims[name];
  if (!an) { fail(`animation ${name} missing`); continue; }
  const n = clip.frames, fps = clip.fps, boneMap = clip.boneMap, rootBone = clip.rootBone;
  const jointOfBone = Object.fromEntries(Object.entries(boneMap).map(([j, b]) => [b, j]));
  let maxDeg = 0, maxRoot = 0, maxT = 0, maxClose = 0, bad = 0, dur = 0;
  const rotKeys = {};   // node index -> [local quats]
  let rootKeys = null;
  for (const ch of an.channels) {
    const s = an.samplers[ch.sampler], node = ch.target.node, bone = N[node].name, p = ch.target.path;
    const times = A.accessor(s.input), vals = A.accessor(s.output);
    dur = Math.max(dur, times[times.length - 1]);
    if (s.interpolation !== 'LINEAR') { bad++; fail(`${name}/${bone}: interpolation ${s.interpolation}`); }
    if (times.length !== n + 1) { bad++; fail(`${name}/${bone}.${p}: ${times.length} keys, expected ${n + 1}`); continue; }
    times.forEach((t, i) => { maxT = Math.max(maxT, Math.abs(t - i / fps)); });
    if (p === 'rotation') {
      const joint = jointOfBone[bone];
      if (!joint) { bad++; fail(`${name}: rotation channel on unmapped node ${bone}`); continue; }
      const track = clip.joints[joint];
      vals.forEach((v, i) => {
        const want = Q.qToLocal(N[node].rotation || [0, 0, 0, 1], RW[node], track ? track[i] : [0, 0, 0, 1]);
        maxDeg = Math.max(maxDeg, Q.qAngle(v, want) / Q.DEG);
      });
      maxClose = Math.max(maxClose, Q.qAngle(vals[0], vals[n]) / Q.DEG);
      // q -> -q between keys: fine for slerp, but component-wise/Euler importers spin there
      const flips = vals.filter((v, i) => i > 0 && Q.qDot(vals[i - 1], v) < 0).length;
      if (flips) { bad++; fail(`${name}/${bone}: ${flips} quaternion sign flip(s) between keys`); }
      rotKeys[node] = vals;
    } else if (p === 'translation' && bone === rootBone) {
      const par = A.parent[node], toParent = par === undefined ? [0, 0, 0, 1] : Q.qConj(RW[par]);
      vals.forEach((v, i) => {
        const want = Q.vAdd(N[node].translation || [0, 0, 0], Q.qRotate(toParent, clip.root[i]));
        maxRoot = Math.max(maxRoot, Q.vLen(Q.vSub(v, want)));
      });
      rootKeys = vals;
    } else { bad++; fail(`${name}: forbidden channel ${bone}.${p}`); }
  }
  const nTrans = an.channels.filter(c => c.target.path === 'translation').length;
  if (nTrans !== 1 || !rootKeys) { bad++; fail(`${name}: ${nTrans} translation channels, expected exactly 1 on ${rootBone}`); }
  const missingJ = Object.keys(clip.joints).filter(j => !rotKeys[A.byName[boneMap[j]]]);
  if (missingJ.length) { bad++; fail(`${name}: no rotation channel for ${missingJ.join(', ')}`); }
  if (Math.abs(dur - n / fps) > 1e-4 || Math.abs(dur - clip.duration) > 1e-3) { bad++; fail(`${name}: duration ${dur} vs JSON ${clip.duration} (${n}/${fps})`); }
  if (maxT > 1e-4) { bad++; fail(`${name}: key times off by ${maxT}`); }
  if (maxDeg > 0.5) { bad++; fail(`${name}: rotation keys differ from qToLocal by ${maxDeg.toFixed(3)} deg`); }
  if (maxRoot > 1e-3) { bad++; fail(`${name}: Root translation off by ${(maxRoot * 1000).toFixed(2)} mm`); }
  if (clip.loop && maxClose > 0.01) { bad++; fail(`${name}: loop not closed (${maxClose.toFixed(3)} deg)`); }
  if (!clip.loop && !clips[clip.next]) { bad++; fail(`${name}: one-shot without a valid next clip (${clip.next})`); }
  if (clip.events) {
    const ev = Object.values(clip.events);
    if (!ev.every((t, k) => t >= 0 && t <= clip.duration + 1e-4 && (k === 0 || t >= ev[k - 1]))) { bad++; fail(`${name}: events out of order / range ${JSON.stringify(clip.events)}`); }
  }

  // bone-level FK on the baked keys (engine view): lowest toes / ankle
  let minToes = Infinity, minFoot = Infinity, maxFk = 0;
  const toes = ['ball_l', 'ball_r'].map(b => A.byName[b]), feet = ['foot_l', 'foot_r'].map(b => A.byName[b]);
  for (let i = 0; i <= n; i++) {
    const W = {}, P = {};
    const go = k => {
      if (W[k]) return;
      const r = rotKeys[k] ? rotKeys[k][i] : (N[k].rotation || [0, 0, 0, 1]);
      const t = N[k].name === rootBone && rootKeys ? rootKeys[i] : (N[k].translation || [0, 0, 0]);
      const p = A.parent[k];
      if (p === undefined) { W[k] = r; P[k] = t; return; }
      go(p); W[k] = Q.qMul(W[p], r); P[k] = Q.vAdd(P[p], Q.qRotate(W[p], t));
    };
    for (const k of toes) { go(k); minToes = Math.min(minToes, P[k][1]); }
    for (const k of feet) { go(k); minFoot = Math.min(minFoot, P[k][1]); }
    const H = fkPositions(heads0, { joints: Object.fromEntries(Object.entries(clip.joints).map(([j, t]) => [j, t[i]])), root: clip.root[i] });
    for (const [j, b] of Object.entries(boneMap)) {
      const k = A.byName[b];
      if (k === undefined || !H[j]) continue;
      go(k); maxFk = Math.max(maxFk, Q.vLen(Q.vSub(P[k], H[j])));
    }
  }
  const floorOk = minToes >= -0.005;
  if (maxFk > 2e-3) { bad++; fail(`${name}: baked FK differs from fkPositions(JSON) by ${(maxFk * 1000).toFixed(2)} mm`); }
  if (!floorOk) { bad++; fail(`${name}: toes go ${(-minToes * 1000).toFixed(1)} mm below the floor`); }
  if (!bad) {
    ok(`${name}: ${an.channels.length} channels (${an.channels.length - 1} rotation + Root translation), ${n + 1} keys, ` +
      `${dur.toFixed(4)} s, max rot err ${maxDeg.toFixed(4)} deg, root err ${(maxRoot * 1000).toFixed(3)} mm, ` +
      `FK vs JSON ${(maxFk * 1000).toFixed(2)} mm, min toes y ${minToes.toFixed(4)} m, min ankle y ${minFoot.toFixed(4)} m` +
      (clip.loop ? '' : `, one-shot -> ${clip.next}`));
  }
}

console.log(failures ? `CHECK FAILED (${failures})` : 'CHECK OK');
process.exit(failures ? 1 : 0);
