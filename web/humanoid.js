// SPDX-License-Identifier: GPL-3.0-or-later
// Binds a skinned mesh (three.js, used duck-typed: no three import) to the canonical humanoid skeleton
// of web/animation/canonical.js and writes canonical poses onto its bones. Contract and conventions:
// docs/ANIMATION_PLAN.md sections 1 and 4A.
//
// * Pose deltas are rotations in the CHARACTER frame (root space: +X left, +Y up, +Z forward), parent-
//   relative, relative to rest. They become bone-local values via
//     local = restLocal * restWorld^-1 * q * restWorld          (qToLocal)
//   so bone roll / A-pose rest orientations never leak into the convention.
// * Only bone.quaternion is written. bone.position belongs to applySkeleton() (per-morph joint offsets),
//   pose.root belongs to the animator (it moves the root object).
// * Canonical joints the rig lacks are skipped; their deltas are folded into the nearest present
//   descendant so the rest of the body still poses as the canonical chain says.
// * The rig is assumed to have no (non-unit) scale between the root and the bones (true for MPFB).

import { JOINTS, JOINT_NAMES, PARENT, presentParent } from './animation/canonical.js';
import { MPFB_GAME_ENGINE, restGeometry } from './animation/rig.js';
import { qIdentity, qMul, qRotate, qNormalize, qToLocal, vAdd } from './animation/qmath.js';

// Same sanitising three.js GLTFLoader applies to node names (PropertyBinding.sanitizeNodeName);
// kept identical to web/character.js.
const sanitize = n => String(n).replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');

/** Topmost ancestor below a THREE.Scene (== gltf.scene), same rule as character.js. */
function sceneRoot(obj) {
  let r = obj;
  while (r.parent && !r.parent.isScene) r = r.parent;
  return r;
}

const qOf = o => [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w];
const posOf = o => [o.position.x, o.position.y, o.position.z];

/** Every object below `root` (depth first), duck-typed on `.children`. */
function descendants(root) {
  const out = [], stack = [...(root?.children || [])];
  while (stack.length) { const o = stack.pop(); out.push(o); if (o.children) stack.push(...o.children); }
  return out;
}

const warned = new Set();
function warnOnce(msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

/**
 * MUST be called at rest (before any pose is applied): it snapshots the rest rotations.
 * Returns { mesh, root, map, bones, missing, restLocal, restWorld } (+ internal `_` fields).
 */
export function createHumanoid(skinnedMesh, { map = MPFB_GAME_ENGINE, root } = {}) {
  root = root ?? sceneRoot(skinnedMesh);

  // Candidate bones: the skeleton first, then everything under the root (rigs with unskinned bones).
  const byName = new Map();
  const add = o => { if (!o?.name) return; if (!byName.has(o.name)) byName.set(o.name, o); const s = sanitize(o.name); if (!byName.has(s)) byName.set(s, o); };
  (skinnedMesh?.skeleton?.bones || []).forEach(add);
  descendants(root).forEach(add);

  const bones = {}, missing = [];
  for (const j of JOINT_NAMES) {
    const name = map[j];
    const b = name != null ? byName.get(name) ?? byName.get(sanitize(name)) : undefined;
    if (b) bones[j] = b; else missing.push(j);
  }
  if (missing.length) warnOnce(`[humanoid] rig lacks ${missing.length} canonical joint(s): ${missing.join(', ')}`);

  // Rest rotation of every object on a path root -> bone (bones and non-joint ancestors like Root/Armature).
  const restQ = new Map();
  const chains = {};                     // joint -> [top ancestor below root, ..., bone]
  for (const [j, b] of Object.entries(bones)) {
    const chain = [];
    for (let o = b; o && o !== root; o = o.parent) chain.unshift(o);
    if (chain[0]?.parent !== root) warnOnce(`[humanoid] bone "${b.name}" is not below the root; using its topmost ancestor as the character frame`);
    for (const o of chain) if (!restQ.has(o)) restQ.set(o, qOf(o));
    chains[j] = chain;
  }

  const restLocal = {}, restWorld = {};
  for (const [j, chain] of Object.entries(chains)) {
    let w = qIdentity();
    for (const o of chain) w = qMul(w, restQ.get(o));
    restLocal[j] = restQ.get(bones[j]);
    restWorld[j] = qNormalize(w);
  }

  // Delta folding for skipped canonical joints: a present joint receives the product of the deltas of
  // its missing canonical ancestors (top-down) and its own delta.
  const has = j => j in bones;
  const fold = {};
  for (const [j] of JOINTS) {
    if (!has(j)) continue;
    const pp = presentParent(j, has), path = [j];
    for (let p = PARENT[j]; p && p !== pp; p = PARENT[p]) path.unshift(p);
    fold[j] = path;
  }

  return { mesh: skinnedMesh, root, map, bones, missing, restLocal, restWorld, _chains: chains, _restQ: restQ, _fold: fold };
}

/** Effective parent-relative delta of a present joint (null = rest). */
function effectiveDelta(h, j, joints) {
  let q = null;
  for (const n of h._fold[j]) {
    const d = joints[n];
    if (d) q = q ? qMul(q, d) : d;
  }
  return q;
}

/**
 * Writes ONLY bone.quaternion for every mapped joint: qToLocal(restLocal, restWorld, delta), or the rest
 * rotation when the pose has no delta for it. Never touches bone.position or the root (pose.root).
 */
export function applyPose(h, pose) {
  const joints = pose?.joints || {};
  for (const [j, bone] of Object.entries(h.bones)) {
    const d = effectiveDelta(h, j, joints);
    const q = d ? qNormalize(qToLocal(h.restLocal[j], h.restWorld[j], d)) : h.restLocal[j];
    bone.quaternion.set(q[0], q[1], q[2], q[3]);
  }
}

/** Restores the rest rotations captured by createHumanoid, exactly. */
export function resetPose(h) {
  for (const [j, bone] of Object.entries(h.bones)) {
    const q = h.restLocal[j];
    bone.quaternion.set(q[0], q[1], q[2], q[3]);
  }
}

/**
 * Rest-pose joint heads in the character frame for the CURRENT bone.position values (i.e. after
 * applySkeleton): FK with the captured rest rotations + current positions. Independent of the pose.
 */
export function restHeads(h) {
  const memo = new Map();                // object -> { p, w } (root-space head position, rest rotation)
  const eval_ = (chain, k) => {
    const o = chain[k];
    let e = memo.get(o);
    if (e) return e;
    const par = k > 0 ? eval_(chain, k - 1) : { p: [0, 0, 0], w: qIdentity() };
    e = { p: vAdd(par.p, qRotate(par.w, posOf(o))), w: qMul(par.w, h._restQ.get(o)) };
    memo.set(o, e);
    return e;
  };
  const heads = {};
  for (const [j, chain] of Object.entries(h._chains)) heads[j] = eval_(chain, chain.length - 1).p;
  return heads;
}

/** Rest geometry of the current body (ctx.rig for the clips). */
export function measure(h) {
  return restGeometry(restHeads(h));
}

// Exposed for tests / tools that want to reproduce the lookup.
export { sanitize as sanitizeNodeName };
