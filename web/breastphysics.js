// SPDX-License-Identifier: GPL-3.0-or-later
// Limited breast physics (pure JS, no three.js; contract: docs/BREAST_PHYSICS.md).
// A damped spring per axis moves the breast tissue relative to the chest, driven by the chest's own motion:
//   x'' = -w^2 x - 2 zeta w x' + f,   f = (g_local - g_rest) - a_local      (clamped to MAX_FORCE)
// a_local = acceleration of the driver bone (spine_03) in the character's rest frame, g_local = gravity in that frame
// (so leaning forward sags a little). x (m) becomes six non-negative morph weights (dyn_breast_up/down/left/right/
// fwd/back, 1.0 = DYN amplitude 2 cm, blender/build_base.py DYN_MORPHS) scaled by breastMotionScale(): 0 for a male
// or child, more for a large / soft chest, less when a garment covers it. Morph weights only, no bone is moved.
// Axes (glTF rest frame of the character): +x = the character's left, +y = up, +z = forward.

export const BREAST_PHYSICS = {
  frequencyHz: 2.6,        // natural frequency of the tissue spring (unsupported)
  dampingRatio: 0.4,       // < 1: one or two visible oscillations after a step, settles in < 1 s
  maxDisplacement: 0.012,  // m: the spring's travel is limited to this per axis (a soft stop, see createBreastSpring)
  amplitude: 0.02,         // m of tissue motion at morph weight 1 (the dyn_* morphs in the GLB)
  gain: 0.75,              // x -> weight: weight = gain * scale * x / amplitude
  maxWeight: 0.75,         // soft limit of each weight (tanh): sideways, down, forward
  upMaxWeight: 0.6,        // up: less (the tissue hangs; it rises less than it drops)
  backMaxWeight: 0.35,     // into the chest wall: less
  supportStiffness: 2,     // support s (0..1, a garment holding the chest): stiffness x (1 + 2 s) ...
  supportDamping: 0.5,     // ... damping ratio + 0.5 s ...
  supportTravel: 0.5,      // ... travel limit x (1 - 0.5 s)
  maxDt: 0.1,              // s: a longer frame (tab in background, breakpoint) resets instead of integrating
  subStep: 1 / 120,        // s: integration step
  maxForce: 60,            // m/s^2: forcing clamp (pose jumps, first frames)
  jump: 0.25,              // m: driver moved more than this in one frame = teleport, reset
};

/** Combined support of several worn garments (each 0..1): 1 - prod(1 - s). A bra under a T-shirt holds more than
 *  either alone. */
export function combineSupport(list) {
  let free = 1;
  for (const s of list ?? []) free *= 1 - clamp(fin(s), 0, 1);
  return 1 - free;
}

export const DYN_MORPHS = {
  up: 'dyn_breast_up', down: 'dyn_breast_down', left: 'dyn_breast_left',
  right: 'dyn_breast_right', fwd: 'dyn_breast_fwd', back: 'dyn_breast_back',
};
const ZERO = Object.freeze(Object.fromEntries(Object.values(DYN_MORPHS).map(n => [n, 0])));
export const zeroWeights = () => ({ ...ZERO });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fin = v => (Number.isFinite(v) ? v : 0);

/**
 * Motion scale 0..~1.3 from the slider values (web/character.js): gate (female adult, 0..1) x size x softness x
 * support. values.breastSize / breastFirmness in -1..1; support 0..1 = how much the worn garments hold the chest
 * (0 = none; the viewer: bra 0.5, T-shirt 0.2, coat 0.3, combined with combineSupport). The same support is passed
 * to createBreastPhysics().step, which also stiffens, damps and shortens the spring with it.
 */
export function breastMotionScale({ gate = 0, size = 0, firmness = 0, support = 0 } = {}) {
  const s01 = (clamp(fin(size), -1, 1) + 1) / 2, f01 = (clamp(fin(firmness), -1, 1) + 1) / 2;
  return clamp(fin(gate), 0, 1) * (0.25 + 0.9 * s01) * (1.2 - 0.7 * f01) * (1 - clamp(fin(support), 0, 1));
}

/** Rotates v by the inverse of unit quaternion q = [x, y, z, w]. */
function rotInv(q, v) {
  const x = -q[0], y = -q[1], z = -q[2], w = q[3];
  const cx = y * v[2] - z * v[1], cy = z * v[0] - x * v[2], cz = x * v[1] - y * v[0];
  const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx;
  return [v[0] + 2 * (w * cx + dx), v[1] + 2 * (w * cy + dy), v[2] + 2 * (w * cz + dz)];
}

/**
 * The spring alone (unit-testable). update(dt, force [fx, fy, fz] in m/s^2) integrates and returns x (m, 3).
 */
export function createBreastSpring(opts = {}) {
  const P = { ...BREAST_PHYSICS, ...opts };
  const x = [0, 0, 0], v = [0, 0, 0];
  function reset() { x.fill(0); v.fill(0); }
  /** Spring constants for a support 0..1 (stiffer, more damped, shorter travel when a garment holds the chest). */
  function tune(support = 0) {
    const s = clamp(fin(support), 0, 1);
    const w = 2 * Math.PI * P.frequencyHz * Math.sqrt(1 + P.supportStiffness * s);
    const zeta = P.dampingRatio + P.supportDamping * s;
    return { k: w * w, c: 2 * zeta * w, lim: P.maxDisplacement * (1 - P.supportTravel * s) };
  }
  // update(dt, force, support = 0): travel is limited per axis to `lim` by a soft stop: past half of it the spring
  // stiffens (x 1 + 8 u^2, u = how far into the last half), at `lim` the motion stops (outward velocity dropped)
  function update(dt, force, support = 0) {
    dt = fin(dt);
    if (dt <= 0) return x;
    if (dt > P.maxDt) { reset(); return x; }
    const { k, c, lim } = tune(support);
    const f = [0, 1, 2].map(i => clamp(fin(force?.[i]), -P.maxForce, P.maxForce));
    const n = Math.max(1, Math.ceil(dt / P.subStep - 1e-9)), h = dt / n;
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < 3; i++) {                 // semi-implicit Euler: stable for w h < 2 (here <= 0.27)
        const u = Math.max(0, Math.abs(x[i]) / lim - 0.5) * 2;
        v[i] += h * (f[i] - k * (1 + 8 * u * u) * x[i] - c * v[i]);
        x[i] += h * v[i];
        if (Math.abs(x[i]) > lim) {
          x[i] = Math.sign(x[i]) * lim;
          if (v[i] * x[i] > 0) v[i] = 0;
        }
      }
    }
    if (!x.every(Number.isFinite) || !v.every(Number.isFinite)) reset();
    return x;
  }
  return { update, reset, tune, state: () => ({ x: [...x], v: [...v] }), params: P };
}

/** x (m, rest frame) and scale -> the six dyn morph weights (each >= 0, soft-limited). */
export function dynWeights(x, scale, P = BREAST_PHYSICS) {
  const out = zeroWeights();
  const s = clamp(fin(scale), 0, 2) * P.gain / P.amplitude;
  if (!s) return out;
  const soft = (u, m) => m * Math.tanh(u / m);
  const put = (pos, neg, u, mPos = P.maxWeight, mNeg = P.maxWeight) => {
    if (u > 0) out[DYN_MORPHS[pos]] = soft(u, mPos);
    else if (u < 0) out[DYN_MORPHS[neg]] = soft(-u, mNeg);
  };
  put('left', 'right', s * fin(x[0]));
  put('up', 'down', s * fin(x[1]), P.upMaxWeight ?? P.maxWeight);
  put('fwd', 'back', s * fin(x[2]), P.maxWeight, P.backMaxWeight);
  return out;
}

/**
 * Spring + driver: step(dt, pos, rot, scale) with pos = driver bone world position [x, y, z] (m) and rot = its world
 * rotation relative to its rest rotation [x, y, z, w] (current * rest^-1), scale = breastMotionScale().
 * Returns the dyn morph weights. reset() after a pose jump (clip change from / to none, seek, Reset).
 */
export function createBreastPhysics(opts = {}) {
  const spring = createBreastSpring(opts);
  const P = spring.params;
  let p1 = null, p2 = null, dt1 = 0, weights = zeroWeights(), lastForce = [0, 0, 0];
  function reset() { spring.reset(); p1 = p2 = null; dt1 = 0; weights = zeroWeights(); lastForce = [0, 0, 0]; }
  function step(dt, pos, rot, scale, support = 0) {
    dt = fin(dt);
    if (!(scale > 0)) { if (p1 || spring.state().x.some(Boolean)) reset(); return weights; }
    if (dt <= 0) return weights;
    if (dt > P.maxDt || !pos || !pos.every(Number.isFinite)) { reset(); return weights; }
    const q = rot && rot.every(Number.isFinite) ? rot : [0, 0, 0, 1];
    if (p1 && Math.hypot(pos[0] - p1[0], pos[1] - p1[1], pos[2] - p1[2]) > P.jump) reset();
    let a = [0, 0, 0];
    if (p1 && p2 && dt1 > 0) {
      const h = (dt + dt1) / 2;
      a = [0, 1, 2].map(i => ((pos[i] - p1[i]) / dt - (p1[i] - p2[i]) / dt1) / h);
    }
    p2 = p1; p1 = [...pos]; dt1 = dt;
    const aL = rotInv(q, a), gL = rotInv(q, [0, -9.81, 0]);
    lastForce = [gL[0] - aL[0], gL[1] + 9.81 - aL[1], gL[2] - aL[2]];
    const x = spring.update(dt, lastForce, support);
    weights = dynWeights(x, scale, P);
    return weights;
  }
  return {
    step, reset,
    weights: () => ({ ...weights }),
    state: () => ({ ...spring.state(), force: lastForce.map(v => +v.toFixed(3)), weights: { ...weights } }),
    params: P,
  };
}
