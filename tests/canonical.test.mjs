// SPDX-License-Identifier: GPL-3.0-or-later
// Locks the pose convention of docs/ANIMATION_PLAN.md against the real rig in output/base_body.glb.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Q from '../web/animation/qmath.js';
import { JOINT_NAMES, fkPositions, mirrorPose, worldToPose, poseToWorld } from '../web/animation/canonical.js';
import { MPFB_GAME_ENGINE, MPFB_ROOT_BONE, headsFromSidecar, restGeometry } from '../web/animation/rig.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const buf = fs.readFileSync(root + 'output/base_body.glb');
const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
const sidecar = JSON.parse(fs.readFileSync(root + 'output/base_body.joints.json', 'utf8'));
const N = gltf.nodes, parent = {};
N.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
const byName = Object.fromEntries(N.map((n, i) => [n.name, i]));
const jointOf = Object.fromEntries(Object.entries(MPFB_GAME_ENGINE).map(([j, b]) => [b, j]));

const RW = {}, RP = {};
(function rest() {
  const go = i => {
    if (RW[i]) return;
    const r = N[i].rotation || [0, 0, 0, 1], t = N[i].translation || [0, 0, 0], p = parent[i];
    if (p === undefined) { RW[i] = r; RP[i] = t; return; }
    go(p); RW[i] = Q.qMul(RW[p], r); RP[i] = Q.vAdd(RP[p], Q.qRotate(RW[p], t));
  };
  N.forEach((_, i) => go(i));
})();

// Bone-level FK exactly as an engine does it: local = restLocal * restWorld^-1 * q * restWorld.
function boneFK(pose) {
  const W = {}, P = {};
  const go = i => {
    if (W[i]) return;
    let r = N[i].rotation || [0, 0, 0, 1];
    const t = N[i].translation || [0, 0, 0], p = parent[i], j = jointOf[N[i].name];
    if (j && pose.joints[j]) r = Q.qToLocal(r, RW[i], pose.joints[j]);
    if (p === undefined) { W[i] = r; P[i] = Q.vAdd(t, pose.root || [0, 0, 0]); return; }
    go(p); W[i] = Q.qMul(W[p], r); P[i] = Q.vAdd(P[p], Q.qRotate(W[p], t));
  };
  N.forEach((_, i) => go(i));
  return j => P[byName[MPFB_GAME_ENGINE[j]]];
}
const rest = boneFK({ joints: {} });
const d = (P, j) => Q.vSub(P(j), rest(j));
const both = (joint, q) => ({ joints: { [joint]: q, ...mirrorPose({ joints: { [joint]: q } }).joints } });
const X = [1, 0, 0], Z = [0, 0, 1];

test('rig map covers all 52 canonical joints + Root (53 skin joints)', () => {
  for (const j of JOINT_NAMES) assert.ok(MPFB_GAME_ENGINE[j] in byName, j);
  assert.ok(MPFB_ROOT_BONE in byName);
  assert.equal(gltf.skins[0].joints.length, JOINT_NAMES.length + 1);
});

test('sidecar heads == GLB rest heads, restGeometry sane', () => {
  const heads = headsFromSidecar(sidecar, {});
  for (const j of JOINT_NAMES) assert.ok(Q.vLen(Q.vSub(heads[j], rest(j))) < 1e-3, j);
  const g = restGeometry(heads);
  assert.ok(Math.abs(g.legLength - 0.802) < 0.01 && Math.abs(g.hipHeight - 0.866) < 0.01);
});

test('canonical heads FK == bone-level FK for a random full pose', () => {
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const joints = {};
  for (const j of JOINT_NAMES) joints[j] = Q.qAxisAngle([rnd(), rnd(), rnd()], 1.5 * rnd());
  const pose = { joints, root: [0.1, -0.05, 0.2] };
  const P = boneFK(pose), H = fkPositions(headsFromSidecar(sidecar, {}), pose);
  for (const j of JOINT_NAMES) assert.ok(Q.vLen(Q.vSub(P(j), H[j])) < 2e-3, j);   // sidecar rounding ~1e-5
});

test('signs: knee +X flexes backwards, hip -X flexes forwards, both sides equal', () => {
  const k = boneFK(both('leftLowerLeg', Q.qAxisAngle(X, 40 * Q.DEG)));
  for (const s of ['left', 'right']) { const v = d(k, `${s}Foot`); assert.ok(v[2] < -0.2 && v[1] > 0.08 && Math.abs(v[0]) < 1e-3, s); }
  const h = boneFK(both('leftUpperLeg', Q.qAxisAngle(X, -30 * Q.DEG)));
  for (const s of ['left', 'right']) assert.ok(d(h, `${s}LowerLeg`)[2] > 0.15, s);
});

test('signs: left +Z raises the left arm, mirrored pose raises the right arm', () => {
  const P = boneFK(both('leftUpperArm', Q.qAxisAngle(Z, 60 * Q.DEG)));
  assert.ok(d(P, 'leftLowerArm')[1] > 0.2 && d(P, 'leftLowerArm')[0] > 0);
  assert.ok(d(P, 'rightLowerArm')[1] > 0.2 && d(P, 'rightLowerArm')[0] < 0);
});

test('elbow hinge axis from restGeometry: + angle flexes, - extends, mirrored', () => {
  const g = restGeometry(headsFromSidecar(sidecar, {}));
  const bend = (P, s) => Q.vLen(Q.vSub(P(`${s}Hand`), P(`${s}UpperArm`)));
  const P = boneFK({ joints: { leftLowerArm: Q.qAxisAngle(g.axes.leftLowerArm, -30 * Q.DEG), rightLowerArm: Q.qAxisAngle(g.axes.rightLowerArm, -30 * Q.DEG) } });
  for (const s of ['left', 'right']) assert.ok(bend(P, s) > bend(rest, s) + 0.02, s);    // straighter arm = longer
  assert.deepEqual(g.axes.rightLowerArm.map(v => +v.toFixed(4)), Q.qMirrorX([...g.axes.leftLowerArm, 0]).slice(0, 3).map(v => +v.toFixed(4)));
});

test('mirrorPose gives an exactly mirrored body', () => {
  const left = { joints: { leftUpperLeg: Q.qAxisAngle([1, 0.3, 0.2], -0.6), leftLowerLeg: Q.qAxisAngle(X, 0.9),
    leftUpperArm: Q.qMul(Q.qAxisAngle(X, 0.4), Q.qAxisAngle(Z, -0.7)), leftShoulder: Q.qAxisAngle(Z, 0.2) } };
  const P = boneFK({ joints: { ...left.joints, ...mirrorPose(left).joints } });
  for (const j of JOINT_NAMES.filter(n => n.startsWith('left'))) {
    const a = P(j), b = P('right' + j.slice(4));
    assert.ok(Q.vLen(Q.vSub(a, [-b[0], b[1], b[2]])) < 1e-3, j);
  }
});

test('worldToPose inverts poseToWorld', () => {
  const joints = { hips: Q.qAxisAngle([0, 1, 0], 0.2), spine: Q.qAxisAngle(X, 0.1), leftUpperLeg: Q.qAxisAngle(X, -0.5), leftLowerLeg: Q.qAxisAngle(X, 0.7) };
  const back = worldToPose(poseToWorld(joints));
  for (const j of Object.keys(joints)) assert.ok(Q.qAngle(back[j], joints[j]) < 1e-6, j);
});
