// Tiny dependency-free quaternion/vector helpers shared by humanoid.js, clips.js, animator.js and the
// node tools. Quaternions are [x, y, z, w] (glTF order), vectors [x, y, z]. Pure functions, no
// mutation of arguments. FROZEN by docs/ANIMATION_PLAN.md: add functions, never change semantics.

export const DEG = Math.PI / 180;

// ---- vectors ----
export const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vLen = a => Math.hypot(a[0], a[1], a[2]);
export const vNorm = a => { const l = vLen(a); return l > 1e-12 ? vScale(a, 1 / l) : [0, 0, 0]; };
export const vLerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Mirror a position/direction across the character's sagittal plane (x -> -x). */
export const vMirrorX = a => [-a[0], a[1], a[2]];

// ---- quaternions ----
export const qIdentity = () => [0, 0, 0, 1];
export const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
export const qConj = a => [-a[0], -a[1], -a[2], a[3]];

export function qNormalize(a) {
  const l = Math.hypot(a[0], a[1], a[2], a[3]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l, a[3] / l] : [0, 0, 0, 1];
}

/** Rotation of `rad` radians about `axis` (need not be unit). Right-hand rule. */
export function qAxisAngle(axis, rad) {
  const n = vNorm(axis), s = Math.sin(rad / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(rad / 2)];
}

/** Hamilton product a*b (apply b first, then a). */
export function qMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotate vector v by unit quaternion q. */
export function qRotate(q, v) {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1], cy = z * v[0] - x * v[2], cz = x * v[1] - y * v[0];
  const c2x = y * cz - z * cy, c2y = z * cx - x * cz, c2z = x * cy - y * cx;
  return [v[0] + 2 * (w * cx + c2x), v[1] + 2 * (w * cy + c2y), v[2] + 2 * (w * cz + c2z)];
}

/** Minimal-arc rotation taking direction u onto direction v (need not be unit). */
export function qFromTo(u, v) {
  const a = vNorm(u), b = vNorm(v), d = vDot(a, b);
  if (d < -0.999999) {                       // antiparallel: any perpendicular axis
    const p = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return qAxisAngle(vCross(a, p), Math.PI);
  }
  const c = vCross(a, b);
  return qNormalize([c[0], c[1], c[2], 1 + d]);
}

/** Shortest-path spherical interpolation. */
export function qSlerp(a, b, t) {
  let d = qDot(a, b), bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) return qNormalize([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/** Angle (radians, 0..pi) between two rotations. */
export const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(qDot(qNormalize(a), qNormalize(b)))));

/** q or -q, whichever is on the same hemisphere as prev (keeps baked tracks continuous). */
export const qAlign = (prev, q) => (qDot(prev, q) < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q);

/**
 * Mirror a character-frame rotation across the sagittal plane (x -> -x). A left-side delta becomes the
 * matching right-side delta: rotations about X keep their sign (flexion stays flexion), rotations
 * about Y and Z flip (abduction stays abduction, turning left becomes turning right).
 */
export const qMirrorX = q => [q[0], -q[1], -q[2], q[3]];

/**
 * Character-frame delta -> bone-local rotation value.
 *   restLocal: the bone's rest local rotation (glTF node rotation / bone.quaternion at rest)
 *   restWorld: the bone's rest rotation relative to the character root (product of rest locals)
 *   q:         parent-relative delta in the character frame (see docs/ANIMATION_PLAN.md)
 * returns restLocal * restWorld^-1 * q * restWorld
 */
export const qToLocal = (restLocal, restWorld, q) => qMul(restLocal, qMul(qConj(restWorld), qMul(q, restWorld)));
