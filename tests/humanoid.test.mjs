// SPDX-License-Identifier: GPL-3.0-or-later
// Tests web/humanoid.js against the real rig in output/base_body.glb (docs/ANIMATION_PLAN.md 4A).
// Run: node --test "tests/*.test.mjs"
// Fake three-like objects are built from the GLB nodes, so no npm dependency is needed. If the env var
// THREE_DIR points at an installed `three` package directory (node_modules/three, version as in
// web/index.html), an extra test loads the GLB with the real GLTFLoader + applySkeleton.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Q from '../web/animation/qmath.js';
import { JOINT_NAMES, fkPositions, mirrorPose, mirrorJointName } from '../web/animation/canonical.js';
import { MPFB_GAME_ENGINE, MPFB_ROOT_BONE, headsFromSidecar, restGeometry } from '../web/animation/rig.js';
import { sliderInfluences } from '../web/character.js';
import { createHumanoid, applyPose, resetPose, restHeads, measure } from '../web/humanoid.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const buf = fs.readFileSync(path.join(repo, 'output/base_body.glb'));
const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
const sidecar = JSON.parse(fs.readFileSync(path.join(repo, 'output/base_body.joints.json'), 'utf8'));
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

// ---- fake three.js-like scene from the GLB nodes ----
function obj(name) {
  const o = { name, parent: null, children: [], position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
  o.quaternion.set = (x, y, z, w) => Object.assign(o.quaternion, { x, y, z, w });
  return o;
}
const link = (p, c) => { c.parent = p; p.children.push(c); };

function buildScene({ rename = {} } = {}) {
  const scene = Object.assign(obj('THREE.Scene'), { isScene: true });
  const groot = obj('Scene');                         // == gltf.scene
  link(scene, groot);
  const objs = gltf.nodes.map(n => {
    const o = obj(rename[n.name] ?? n.name);
    const [tx, ty, tz] = n.translation || [0, 0, 0], [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1];
    Object.assign(o.position, { x: tx, y: ty, z: tz });
    o.quaternion.set(qx, qy, qz, qw);
    return o;
  });
  gltf.nodes.forEach((n, i) => (n.children || []).forEach(c => link(objs[i], objs[c])));
  for (const i of gltf.scenes[0].nodes) link(groot, objs[i]);
  const meshIdx = gltf.nodes.findIndex(n => n.skin !== undefined);
  const mesh = objs[meshIdx];
  mesh.skeleton = { bones: gltf.skins[0].joints.map(i => objs[i]) };
  return { scene, groot, mesh, objs };
}

/** Root-space world rotation/position of an object from its CURRENT local values (no scale in the rig). */
function world(o, root) {
  if (!o || o === root) return { w: Q.qIdentity(), p: [0, 0, 0] };
  const par = world(o.parent, root);
  const q = [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w];
  return { w: Q.qMul(par.w, q), p: Q.vAdd(par.p, Q.qRotate(par.w, [o.position.x, o.position.y, o.position.z])) };
}
const bonePositions = h => Object.fromEntries(Object.entries(h.bones).map(([j, b]) => [j, world(b, h.root).p]));
const snapshot = h => Object.values(h.bones).map(b => [b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]);
const maxDist = (A, B, keys) => Math.max(...keys.map(k => Q.vLen(Q.vSub(A[k], B[k]))));

/** Same math as character.js applySkeleton (bone.position part), on the fake objects. */
function fakeApplySkeleton(mesh, root, influences, restPos) {
  const bones = mesh.skeleton.bones, set = new Set(bones);
  const delta = new Map(bones.map(b => [b, [0, 0, 0]]));
  for (const [m, w] of Object.entries(influences)) {
    if (!w) continue;
    for (const [name, d] of Object.entries(sidecar.morphs[m] || {})) {
      const b = bones.find(x => x.name === name);
      if (b) delta.set(b, Q.vAdd(delta.get(b), Q.vScale(d, w)));
    }
  }
  const restW = new Map(bones.map(b => [b, world(b.parent, root).w]));   // parent rest rotations
  bones.forEach((b, i) => {
    let t = delta.get(b);
    if (set.has(b.parent)) t = Q.vSub(t, delta.get(b.parent));
    t = Q.qRotate(Q.qConj(restW.get(b)), t);
    Object.assign(b.position, { x: restPos[i][0] + t[0], y: restPos[i][1] + t[1], z: restPos[i][2] + t[2] });
  });
}

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
const randomPose = (scale = 1.2) => ({ joints: Object.fromEntries(JOINT_NAMES.map(j => [j, Q.qAxisAngle([rnd(), rnd(), rnd()], scale * rnd())])) });

// ---- tests ----
test('map resolves 52/52 canonical joints on the GLB skeleton, root = gltf.scene', () => {
  const { groot, mesh } = buildScene();
  const h = createHumanoid(mesh);
  assert.equal(h.root, groot);
  assert.deepEqual(h.missing, []);
  assert.equal(Object.keys(h.bones).length, 52);
  for (const j of JOINT_NAMES) {
    assert.equal(h.bones[j].name, MPFB_GAME_ENGINE[j], j);
    assert.ok(mesh.skeleton.bones.includes(h.bones[j]), `${j} is a skin joint`);
    assert.ok(Math.abs(Math.hypot(...h.restWorld[j]) - 1) < 1e-6, j);
  }
  assert.ok(mesh.skeleton.bones.some(b => b.name === MPFB_ROOT_BONE));
});

test('bone lookup falls back to the three.js-sanitised name; missing joints never throw', () => {
  const { mesh } = buildScene({ rename: { spine_01: 'rigSpine01' } });
  const h = createHumanoid(mesh, { map: { ...MPFB_GAME_ENGINE, spine: 'rig:Spine.01', leftToes: 'no_such_bone' } });
  assert.equal(h.bones.spine.name, 'rigSpine01');
  assert.deepEqual(h.missing, ['leftToes']);
  applyPose(h, { joints: { leftToes: Q.qAxisAngle(X, 0.5) } });   // no throw
});

test('rest capture: restHeads == sidecar heads (neutral), measure == restGeometry', () => {
  const { mesh } = buildScene();
  const h = createHumanoid(mesh);
  const heads = restHeads(h), side = headsFromSidecar(sidecar, {});
  assert.ok(maxDist(heads, side, JOINT_NAMES) < 1e-3);
  assert.ok(maxDist(heads, bonePositions(h), JOINT_NAMES) < 1e-9);
  const g = measure(h), g2 = restGeometry(side);
  assert.ok(Math.abs(g.legLength - g2.legLength) < 1e-3 && Math.abs(g.hipHeight - g2.hipHeight) < 1e-3);
});

test('applyPose + bone-level FK == fkPositions, positions never written, resetPose exact', () => {
  const { mesh } = buildScene();
  const h = createHumanoid(mesh);
  const rest = snapshot(h), heads = restHeads(h), pose = randomPose();
  applyPose(h, pose);
  const P = bonePositions(h), H = fkPositions(heads, pose);
  assert.ok(maxDist(P, H, JOINT_NAMES) < 1e-6, 'vs restHeads FK');
  assert.ok(maxDist(P, fkPositions(headsFromSidecar(sidecar, {}), pose), JOINT_NAMES) < 1e-3, 'vs sidecar FK');
  const now = snapshot(h);
  now.forEach((s, i) => assert.deepEqual(s.slice(0, 3), rest[i].slice(0, 3)));
  // and posed restHeads are independent of the current pose
  assert.ok(maxDist(restHeads(h), heads, JOINT_NAMES) < 1e-12);
  resetPose(h);
  assert.deepEqual(snapshot(h), rest);
  applyPose(h, pose); applyPose(h, { joints: {} });                // empty pose == rest, exactly
  assert.deepEqual(snapshot(h), rest);
});

test('restHeads follows applySkeleton offsets (tall, child+short, male+old) and poses stay exact', () => {
  for (const values of [{ height: 1 }, { age: -1, height: -1 }, { gender: 1, age: 1, proportions: 1 }]) {
    const { mesh, groot } = buildScene();
    const h = createHumanoid(mesh);                                  // at rest, before offsets (as main.js)
    const restPos = mesh.skeleton.bones.map(b => [b.position.x, b.position.y, b.position.z]);
    const inf = sliderInfluences(values);
    fakeApplySkeleton(mesh, groot, inf, restPos);
    const heads = restHeads(h);
    assert.ok(maxDist(heads, headsFromSidecar(sidecar, inf), JOINT_NAMES) < 1e-3, JSON.stringify(values));
    const pose = randomPose(0.8);
    applyPose(h, pose);
    assert.ok(maxDist(bonePositions(h), fkPositions(heads, pose), JOINT_NAMES) < 1e-6, JSON.stringify(values));
    assert.ok(maxDist(restHeads(h), heads, JOINT_NAMES) < 1e-12);
  }
});

test('L/R: mirrored deltas give mirrored bone rotations and an exactly mirrored body', () => {
  const { mesh } = buildScene();
  const h = createHumanoid(mesh);
  const left = { joints: {} };
  for (const j of JOINT_NAMES.filter(n => n.startsWith('left'))) left.joints[j] = Q.qAxisAngle([rnd(), rnd(), rnd()], rnd());
  applyPose(h, { joints: { ...left.joints, ...mirrorPose(left).joints } });
  const P = bonePositions(h);
  for (const j of Object.keys(left.joints)) {
    const r = mirrorJointName(j), bl = h.bones[j].quaternion, br = h.bones[r].quaternion;
    // this rig is built symmetric: right bone locals are the qMirrorX of the left ones
    assert.ok(Q.qAngle([br.x, br.y, br.z, br.w], Q.qMirrorX([bl.x, bl.y, bl.z, bl.w])) < 1e-4, j);
    assert.ok(Q.vLen(Q.vSub(P[j], Q.vMirrorX(P[r]))) < 1e-3, j);
  }
});

test('signs through humanoid: knee +X flexes back, hip -X swings forward, arm +Z raises (both sides)', () => {
  const { mesh } = buildScene();
  const h = createHumanoid(mesh);
  const R = bonePositions(h);
  const d = (P, j) => Q.vSub(P[j], R[j]);
  const both = (j, q) => ({ joints: { [j]: q, ...mirrorPose({ joints: { [j]: q } }).joints } });
  applyPose(h, both('leftLowerLeg', Q.qAxisAngle(X, 40 * Q.DEG)));
  let P = bonePositions(h);
  for (const s of ['left', 'right']) { const v = d(P, `${s}Foot`); assert.ok(v[2] < -0.2 && v[1] > 0.08 && Math.abs(v[0]) < 1e-3, s); }
  applyPose(h, both('leftUpperLeg', Q.qAxisAngle(X, -30 * Q.DEG)));
  P = bonePositions(h);
  for (const s of ['left', 'right']) assert.ok(d(P, `${s}LowerLeg`)[2] > 0.15, s);
  applyPose(h, both('leftUpperArm', Q.qAxisAngle(Z, 60 * Q.DEG)));
  P = bonePositions(h);
  assert.ok(d(P, 'leftLowerArm')[1] > 0.2 && d(P, 'leftLowerArm')[0] > 0);
  assert.ok(d(P, 'rightLowerArm')[1] > 0.2 && d(P, 'rightLowerArm')[0] < 0);
  applyPose(h, { joints: { hips: Q.qAxisAngle(Y, 90 * Q.DEG) } });  // +Y turns left: nose (+Z) -> +X
  P = bonePositions(h);
  assert.ok(P.leftUpperLeg[2] < -0.05 && P.rightUpperLeg[2] > 0.05);
});

test('a canonical joint missing on the rig: its delta folds into the child', () => {
  const full = buildScene(), part = buildScene();
  const hf = createHumanoid(full.mesh);
  const { chest, ...map } = MPFB_GAME_ENGINE;                        // spine_02 stays as a non-joint bone
  const hp = createHumanoid(part.mesh, { map });
  assert.deepEqual(hp.missing, ['chest']);
  const pose = randomPose(0.7);
  applyPose(hf, pose); applyPose(hp, pose);
  // every present bone ends with the same world orientation as on the full rig ...
  for (const j of Object.keys(hp.bones)) assert.ok(Q.qAngle(world(hf.bones[j], hf.root).w, world(hp.bones[j], hp.root).w) < 1e-6, j);
  // ... and positions follow fkPositions on the present joints (the unarticulated chest segment stays rigid)
  const heads = restHeads(hp);
  assert.ok(!('chest' in heads));
  assert.ok(maxDist(bonePositions(hp), fkPositions(heads, pose), Object.keys(hp.bones)) < 1e-6);
});

// ---- optional: the real three.js loader + character.js applySkeleton ----
const THREE_DIR = process.env.THREE_DIR;
test('real three.js GLTFLoader + applySkeleton (set THREE_DIR to run)', { skip: !THREE_DIR && 'THREE_DIR not set' }, async () => {
  const THREE = await import(pathToFileURL(path.join(THREE_DIR, 'build/three.module.js')).href);
  const { GLTFLoader } = await import(pathToFileURL(path.join(THREE_DIR, 'examples/jsm/loaders/GLTFLoader.js')).href);
  const { applySkeleton } = await import('../web/character.js');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const g = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  const scene = new THREE.Scene();
  scene.add(g.scene);
  let mesh; g.scene.traverse(o => { if (o.isSkinnedMesh) mesh = o; });
  const h = createHumanoid(mesh);
  assert.equal(h.root, g.scene);
  assert.deepEqual(h.missing, []);
  const tp = new THREE.Vector3();
  const three = () => { g.scene.updateMatrixWorld(true); return Object.fromEntries(Object.entries(h.bones).map(([j, b]) => [j, b.getWorldPosition(tp).toArray()])); };
  for (const values of [{}, { height: 1 }, { age: -1, height: -1 }]) {
    applySkeleton(mesh, sidecar, values);
    const heads = restHeads(h);
    assert.ok(maxDist(heads, headsFromSidecar(sidecar, sliderInfluences(values)), JOINT_NAMES) < 1e-3, JSON.stringify(values));
    const pos = snapshot(h).map(s => s.slice(0, 3));
    const pose = randomPose(0.8);
    applyPose(h, pose);
    assert.ok(maxDist(three(), fkPositions(heads, pose), JOINT_NAMES) < 1e-5, JSON.stringify(values));
    snapshot(h).forEach((s, i) => assert.deepEqual(s.slice(0, 3), pos[i]));
    resetPose(h);
  }
});
