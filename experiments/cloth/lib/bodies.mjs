// Body shapes used by the experiment + the capsule collider set. Pure JS (node + browser).
// Capsule endpoints are canonical joints (docs/ANIMATION_PLAN.md), radii are measured from the body mesh
// per body shape by prep_bodies.mjs (weight/muscle move no joints, so only the mesh knows a heavy thigh).

export const BODIES = {
  neutral: {},
  tall: { height: 1 },
  short: { height: -1 },
  heavy: { weight: 1 },
  child: { age: -1 },
  old: { age: 1 },
};

// [name, jointA, jointB, bones whose (dominant-weight) vertices define the radius, t0, t1]
// The capsule runs from lerp(A, B, t0) to lerp(A, B, t1); thighs are split in two (they taper a lot).
export const CAPSULES = [
  ['pelvis', 'leftUpperLeg', 'rightUpperLeg', ['pelvis']],
  ['torso', 'hips', 'upperChest', ['spine_01', 'spine_02']],
  ['thighL', 'leftUpperLeg', 'leftLowerLeg', ['thigh_l'], 0, 0.5],
  ['thighR', 'rightUpperLeg', 'rightLowerLeg', ['thigh_r'], 0, 0.5],
  ['kneeL', 'leftUpperLeg', 'leftLowerLeg', ['thigh_l', 'calf_l'], 0.5, 1],
  ['kneeR', 'rightUpperLeg', 'rightLowerLeg', ['thigh_r', 'calf_r'], 0.5, 1],
  ['shinL', 'leftLowerLeg', 'leftFoot', ['calf_l']],
  ['shinR', 'rightLowerLeg', 'rightFoot', ['calf_r']],
];

// Skirt profile sampling (prep): polar bins around the body axis, 1 cm height steps.
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Capsule endpoints for joint positions P (rest heads or posed). */
export function capsuleEnds(def, P) { const [, ja, jb, , t0 = 0, t1 = 1] = def; return [lerp3(P[ja], P[jb], t0), lerp3(P[ja], P[jb], t1)]; }

export const PROFILE_BINS = 72;
export const PROFILE_DY = 0.01;
