// Canonical humanoid skeleton (VRM 1.0 humanoid bone names) + pose helpers that need only the
// hierarchy, not a concrete rig. Engine- and rig-agnostic; no imports besides qmath.js.
// FROZEN by docs/ANIMATION_PLAN.md: add joints/functions, never rename or change semantics.
//
// Character frame (glTF scene space of the model root): +X = character's LEFT, +Y = up,
// +Z = forward (the way the character faces), metres.
// Pose = { joints: { <joint>: [x,y,z,w] }, root: [x,y,z] }
//   joints: PARENT-RELATIVE delta rotations expressed in the character frame at rest. A joint's
//           world delta is D(j) = D(parent) * joints[j]; absent joints = identity (rest).
//   root:   translation of the whole character from its rest placement (character frame, metres).

import { qIdentity, qMul, qConj, qRotate, qMirrorX, vAdd, vSub, vMirrorX } from './qmath.js';

const SIDE = ['left', 'right'];
const FINGERS = [['Thumb', ['Metacarpal', 'Proximal', 'Distal']], ['Index', ['Proximal', 'Intermediate', 'Distal']],
  ['Middle', ['Proximal', 'Intermediate', 'Distal']], ['Ring', ['Proximal', 'Intermediate', 'Distal']],
  ['Little', ['Proximal', 'Intermediate', 'Distal']]];

/** [joint, parent] in parent-before-child order. */
export const JOINTS = (() => {
  const j = [['hips', null], ['spine', 'hips'], ['chest', 'spine'], ['upperChest', 'chest'],
    ['neck', 'upperChest'], ['head', 'neck']];
  for (const s of SIDE) {
    j.push([`${s}Shoulder`, 'upperChest'], [`${s}UpperArm`, `${s}Shoulder`], [`${s}LowerArm`, `${s}UpperArm`],
      [`${s}Hand`, `${s}LowerArm`]);
    for (const [f, segs] of FINGERS) segs.forEach((g, i) => j.push([`${s}${f}${g}`, i ? `${s}${f}${segs[i - 1]}` : `${s}Hand`]));
    j.push([`${s}UpperLeg`, 'hips'], [`${s}LowerLeg`, `${s}UpperLeg`], [`${s}Foot`, `${s}LowerLeg`], [`${s}Toes`, `${s}Foot`]);
  }
  return j;
})();
export const JOINT_NAMES = JOINTS.map(([n]) => n);
export const PARENT = Object.fromEntries(JOINTS);

/** Child whose head gives a joint's direction (head -> tip). Joints without an entry have no direction. */
export const TIP = (() => {
  const t = { hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head' };
  for (const s of SIDE) {
    Object.assign(t, { [`${s}Shoulder`]: `${s}UpperArm`, [`${s}UpperArm`]: `${s}LowerArm`, [`${s}LowerArm`]: `${s}Hand`,
      [`${s}Hand`]: `${s}MiddleProximal`, [`${s}UpperLeg`]: `${s}LowerLeg`, [`${s}LowerLeg`]: `${s}Foot`, [`${s}Foot`]: `${s}Toes` });
    for (const [f, segs] of FINGERS) for (let i = 0; i + 1 < segs.length; i++) t[`${s}${f}${segs[i]}`] = `${s}${f}${segs[i + 1]}`;
  }
  return t;
})();

export const mirrorJointName = n => (n.startsWith('left') ? 'right' + n.slice(4) : n.startsWith('right') ? 'left' + n.slice(5) : n);

/** Nearest ancestor of `joint` for which has(ancestor) is true, or null. */
export function presentParent(joint, has) {
  let p = PARENT[joint];
  while (p && !has(p)) p = PARENT[p];
  return p ?? null;
}

/** Mirror a whole pose across the sagittal plane (left <-> right, rotations mirrored, root x flipped). */
export function mirrorPose(pose) {
  const joints = {};
  for (const [n, q] of Object.entries(pose.joints || {})) joints[mirrorJointName(n)] = qMirrorX(q);
  return { joints, root: vMirrorX(pose.root || [0, 0, 0]) };
}

/**
 * World (character-frame, rest-relative) delta per joint -> parent-relative pose joints.
 * Joints absent from `world` inherit their parent's world delta. Only joints in `world` are emitted.
 */
export function worldToPose(world) {
  const D = {}, out = {};
  for (const [j, p] of JOINTS) {
    const dp = p ? D[p] : qIdentity();
    D[j] = world[j] || dp;
    if (world[j]) out[j] = qMul(qConj(dp), world[j]);
  }
  return out;
}

/** Parent-relative pose joints -> world delta for EVERY canonical joint. */
export function poseToWorld(joints) {
  const D = {};
  for (const [j, p] of JOINTS) {
    const dp = p ? D[p] : qIdentity();
    D[j] = joints?.[j] ? qMul(dp, joints[j]) : dp;
  }
  return D;
}

/**
 * Forward kinematics on rest joint heads (character frame, e.g. rig.heads from humanoid.restGeometry).
 * Returns posed head positions for every joint present in `heads`, including pose.root.
 */
export function fkPositions(heads, pose) {
  const D = poseToWorld(pose?.joints), root = pose?.root || [0, 0, 0], P = {};
  const has = j => j in heads;
  for (const [j] of JOINTS) {
    if (!has(j)) continue;
    const p = presentParent(j, has);
    P[j] = p ? vAdd(P[p], qRotate(D[p], vSub(heads[j], heads[p]))) : vAdd(heads[j], root);
  }
  return P;
}
