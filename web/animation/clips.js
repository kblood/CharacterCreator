// Procedural humanoid clips (idle / walk / run): pure, deterministic functions of time that return a
// canonical Pose (docs/ANIMATION_PLAN.md section 1 + 4B). No DOM, no three.js; runs in node for tests
// and baking. Body-adaptive: every length comes from ctx.rig (the current slider body), feet are placed
// by analytic two-bone leg IK so they neither slide nor sink for any body.
//
// Pose = { joints: { <canonicalJoint>: [x,y,z,w] }, root: [x,y,z] }  (parent-relative rest deltas,
// character frame +X left, +Y up, +Z forward). Clips are in place: forward travel = timing(ctx).speed.
// New clips: add an entry to CLIPS with { name, loop, duration, timing, sample, contacts }.

import { DEG, qMul, qConj, qAxisAngle, qRotate, qFromTo, qSlerp, vAdd, vSub, vScale, vDot, vCross, vLen, vNorm } from './qmath.js';
import { worldToPose, mirrorPose } from './canonical.js';

const G = 9.81;
const NEUTRAL_HIP_HEIGHT = 0.866;          // rig.hipHeight of the neutral body (metadata durations only)
const TAU = 2 * Math.PI;
const SIDES = ['left', 'right'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const wrap01 = x => x - Math.floor(x);
const rx = a => qAxisAngle([1, 0, 0], a);
const ry = a => qAxisAngle([0, 1, 0], a);
const rz = a => qAxisAngle([0, 0, 1], a);
const slider = (ctx, k) => clamp(Number(ctx.body?.[k]) || 0, -1, 1);
/** Clip-local phase 0..1; t = duration maps to exactly 0 (seamless loop). */
const phaseOf = (t, T) => { const r = ((t % T) + T) % T; return r / T; };

/** Clip context for one body. `rig` = restGeometry(...) of the current body. */
export function makeContext(rig, { speedScale = 1, body = {} } = {}) {
  return {
    rig, body: body || {}, speedScale: clamp(Number(speedScale) || 1, 0.25, 2),
    legLength: rig.legLength, armLength: rig.armLength, height: rig.height, hipHeight: rig.hipHeight,
  };
}

// ---------------------------------------------------------------------------------------------------
// Shared building blocks

/** Longest hip->ankle distance a leg may use: never straighter than the rest leg (no hyperextension). */
function maxReach(rig, side, factor) {
  const a = rig.len[`${side}UpperLeg`], b = rig.len[`${side}LowerLeg`];
  const rest = vLen(vSub(rig.heads[`${side}Foot`], rig.heads[`${side}UpperLeg`]));
  return Math.min(factor * (a + b), rest);
}

/** Hip joint position for a hips world delta and a root offset. */
function hipPos(rig, side, Dh, root) {
  const H = rig.heads;
  return vAdd(vAdd(H.hips, root), qRotate(Dh, vSub(H[`${side}UpperLeg`], H.hips)));
}

/** Ankle position that puts the ball (toes joint) at `toes` with the foot pitched by `pitch` (+X). */
function ankleFor(rig, side, toes, pitch) {
  const H = rig.heads;
  return vSub(toes, qRotate(rx(pitch), vSub(H[`${side}Toes`], H[`${side}Foot`])));
}

/**
 * Highest root.y at which the hip (placed with root.y = 0 -> hip0) still reaches ankle A within maxD.
 * If the target is horizontally out of reach the hip is put at ankle height (the IK then clamps; the
 * stance-length cap in timing() keeps planted feet reachable).
 */
function reachY(hip0, A, maxD) {
  const hx = A[0] - hip0[0], hz = A[2] - hip0[2];
  return A[1] - hip0[1] + Math.sqrt(Math.max(0, maxD * maxD - hx * hx - hz * hz));
}

/**
 * Analytic two-bone leg IK. Returns WORLD (character-frame, rest-relative) deltas for the leg joints.
 *   tgt = { toes:[x,y,z], pitch, toePitch }; pole = hips-yawed forward; knee hinge kept aligned (no twist).
 */
function solveLeg(rig, side, Dh, root, tgt, maxD) {
  const ul = `${side}UpperLeg`, ll = `${side}LowerLeg`, ft = `${side}Foot`, to = `${side}Toes`;
  const hip = hipPos(rig, side, Dh, root);
  const A = ankleFor(rig, side, tgt.toes, tgt.pitch);
  const a = rig.len[ul], b = rig.len[ll];
  const dv = vSub(A, hip), dl = vLen(dv), n = vScale(dv, 1 / dl);
  const d = clamp(dl, Math.abs(a - b) + 1e-4, maxD);
  const f = qRotate(Dh, [0, 0, 1]);
  let pole = vSub([f[0], 0, f[2]], vScale(n, vDot([f[0], 0, f[2]], n)));
  pole = vLen(pole) > 1e-6 ? vNorm(pole) : [0, 0, 1];
  const ca = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), sa = Math.sqrt(1 - ca * ca);
  const K = vAdd(hip, vAdd(vScale(n, a * ca), vScale(pole, a * sa)));
  const Ae = vAdd(hip, vScale(n, d));
  // Thigh: swing rest dir onto hip->knee, then twist so the knee hinge (+X at rest) matches the IK plane.
  const u0 = rig.dir[ul], u1 = vNorm(vSub(K, hip));
  const q1 = qFromTo(u0, u1);
  const h0 = vNorm(vSub([1, 0, 0], vScale(u0, u0[0])));
  const h1 = vNorm(vCross(pole, n));
  const hr = qRotate(q1, h0);
  const Dthigh = qMul(qAxisAngle(u1, Math.atan2(vDot(vCross(hr, h1), u1), vDot(hr, h1))), q1);
  const Dshin = qMul(qFromTo(qRotate(Dthigh, rig.dir[ll]), vSub(Ae, K)), Dthigh);
  return { [ul]: Dthigh, [ll]: Dshin, [ft]: rx(tgt.pitch), [to]: rx(tgt.toePitch) };
}

/**
 * Upper-body chain (parent-relative joints) from hips world delta + counter motion.
 *   counterYaw/counterRoll/lean spread over spine/chest/upperChest; neck+head stabilise to headWorld.
 */
function torso(Dh, { yaw = 0, roll = 0, pitch = 0, breath = 0, headWorld }) {
  const spine = qMul(ry(0.3 * yaw), qMul(rz(0.4 * roll), rx(0.4 * pitch)));
  const chest = qMul(ry(0.35 * yaw), qMul(rz(0.35 * roll), rx(0.3 * pitch + 0.3 * breath)));
  const upperChest = qMul(ry(0.35 * yaw), qMul(rz(0.25 * roll), rx(0.3 * pitch - breath)));
  const Dup = qMul(Dh, qMul(spine, qMul(chest, upperChest)));
  const Wneck = qSlerp(Dup, headWorld, 0.45);
  return { spine, chest, upperChest, neck: qMul(qConj(Dup), Wneck), head: qMul(qConj(Wneck), headWorld) };
}

/**
 * Left arm (parent-relative). swing: + = back (about X), out: angle of the upper arm from vertical (rad),
 * bend: elbow flexion (rad, absolute), shrug: shoulder +Z, protract: shoulder -Y.
 */
function leftArm(rig, { swing = 0, out = 6 * DEG, bend = 15 * DEG, shrug = 0, protract = 0, wrist = 0 }) {
  const d = rig.dir.leftUpperArm;
  const restOut = Math.atan2(d[0], -d[1]);                // A-pose: ~42 deg from vertical
  return {
    leftShoulder: qMul(ry(-protract), rz(shrug)),
    leftUpperArm: qMul(rx(swing), rz(out - restOut)),
    leftLowerArm: qAxisAngle(rig.axes.leftLowerArm, bend - rig.restBend.leftLowerArm),
    leftHand: rx(wrist),
  };
}

const bothArms = (rig, left, right) => ({ ...leftArm(rig, left), ...mirrorPose({ joints: leftArm(rig, right) }).joints });

/** Per-ctx cache of body-dependent constants (pelvis curve), so sample() stays cheap and periodic. */
const cache = new WeakMap();
// Keyed by the ctx object and also by its content, so a ctx mutated in place never serves stale values.
function cached(ctx, name, make) {
  let m = cache.get(ctx);
  if (!m || m.rig !== ctx.rig) cache.set(ctx, (m = Object.assign(new Map(), { rig: ctx.rig })));
  const key = `${name}|${ctx.speedScale}|${JSON.stringify(ctx.body)}`;
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
}

/** Highest root.y that keeps every planted foot of a frame reachable (Infinity when nothing is planted). */
function envelope(rig, fr) {
  let y = Infinity;
  for (const { side, tgt, contact, maxD } of fr.legs) {
    if (!contact) continue;
    y = Math.min(y, reachY(hipPos(rig, side, fr.Dh, [fr.rootX, 0, 0]), ankleFor(rig, side, tgt.toes, tgt.pitch), maxD));
  }
  return y;
}

/**
 * Pelvis height curve root.y = c0 + amp * shape(phase), fitted once per body so it stays under the reach
 * envelope of the planted feet over the whole cycle (sampled densely) while keeping the pelvis as high as
 * possible: amp in [0, ampMax] (grid), c0 = max feasible. Smooth and periodic by construction.
 */
function fitPelvis(ctx, N, frame, ampMax, fitAmp = true) {
  const E = [], S = [];
  for (let i = 0; i < N; i++) { const fr = frame(i / N); E.push(envelope(ctx.rig, fr)); S.push(fr.shape); }
  let best = { c0: -Infinity, amp: 0 };
  const steps = ampMax > 0 && fitAmp ? 24 : 0;
  for (let k = 0; k <= steps; k++) {
    const amp = steps ? (ampMax * k) / steps : ampMax;
    let c0 = Infinity;
    for (let i = 0; i < N; i++) if (E[i] < Infinity) c0 = Math.min(c0, E[i] - amp * S[i]);
    if (c0 === Infinity) c0 = 0;
    if (c0 > best.c0 + 1e-6) best = { c0, amp };
  }
  return { c0: Math.min(best.c0, 0) - 1e-4, amp: best.amp };
}

/** Final root/legs for one frame: root.y = pelvis curve, clamped to the reach of every planted leg. */
function placeLegs(ctx, fr, pelvis) {
  const { rig } = ctx;
  let y = pelvis.c0 + pelvis.amp * fr.shape;
  for (const { side, tgt, contact, maxD } of fr.legs) {
    if (!contact) continue;
    y = Math.min(y, reachY(hipPos(rig, side, fr.Dh, [fr.rootX, 0, 0]), ankleFor(rig, side, tgt.toes, tgt.pitch), maxD));
  }
  const root = [fr.rootX, y, 0];
  const world = { hips: fr.Dh };
  for (const { side, tgt, maxD } of fr.legs) Object.assign(world, solveLeg(rig, side, fr.Dh, root, tgt, maxD));
  return { root, legJoints: worldToPose(world) };
}

// ---------------------------------------------------------------------------------------------------
// Locomotion (walk, run): one parameterised gait, authored for the left side, right = half a cycle later.

function locomotion(P) {
  function timing(ctx) {
    const s = ctx.speedScale, old = Math.max(0, slider(ctx, 'age'));
    const hip = ctx.hipHeight;
    const speed = s * Math.sqrt(P.froude * G * hip) * (1 - 0.12 * old);
    // Faster = shorter ground contact; stance length is capped relative to the leg so the pelvis never
    // has to crouch to keep the planted foot (cadence rises instead).
    const beta = clamp(P.beta - P.betaSlope * (s - 1), P.betaMin, P.betaMax);
    const stride = Math.min(P.strideK * hip * Math.sqrt(s) * (1 - 0.06 * old), (P.maxStance * ctx.legLength) / beta);
    return { duration: stride / speed, speed, stride, beta };
  }

  /** Foot target for a leg at its own phase p (0 = foot strike). */
  function footTarget(ctx, side, p, tm) {
    const { rig } = ctx, H = rig.heads, L = ctx.legLength, S = tm.stride, B = tm.beta;
    const toesRest = H[`${side}Toes`];
    const narrow = P.narrow * (1 - 0.6 * Math.max(0, slider(ctx, 'weight')));
    const x = toesRest[0] + (H[`${side}UpperLeg`][0] - toesRest[0]) * narrow;
    const zc = toesRest[2] + P.zOffset * S;
    const sH = P.heelLift;
    let z, y = toesRest[1], tau, contact, dorsi = 0, toeBlend = 0;
    if (p < B) {                                             // stance: ball planted, moving back at `speed`
      const s = p / B;
      contact = 1;
      z = zc + B * S * (0.5 - s);
      tau = s < sH ? 0 : 0.5 * (s - sH) / (1 - sH);
    } else {                                                 // swing
      const u = (p - B) / (1 - B);
      contact = 0;
      const z0 = zc - 0.5 * B * S, z1 = zc + 0.5 * B * S, m = -P.swingTangent * (1 - B) * S;
      const u2 = u * u, u3 = u2 * u;
      z = (2 * u3 - 3 * u2 + 1) * z0 + (u3 - 2 * u2 + u) * m + (-2 * u3 + 3 * u2) * z1 + (u3 - u2) * m;
      const w = u + P.liftSkew * u * (1 - u);                 // skewed so the foot lifts early
      y += P.clearance * L * Math.sin(Math.PI * w);
      tau = Math.min(1, 0.5 + 0.5 * u / P.rollEnd);
      dorsi = -P.dorsi * Math.sin(Math.PI * u) ** 2;
      toeBlend = smooth(u / 0.3);
    }
    const pitch = P.toeOff * Math.sin(Math.PI * tau) ** 2 + dorsi;
    return { toes: [x, y, z], pitch, toePitch: pitch * toeBlend, contact };
  }

  /** Everything except the pelvis height solve, as a function of the cycle phase. */
  function frame(ctx, phase, tm) {
    const B = tm.beta, L = ctx.legLength;
    const old = Math.max(0, slider(ctx, 'age'));
    const st = TAU * (phase - B / 2);                       // 0 at left mid-stance
    const yaw = -P.yaw * Math.cos(TAU * phase);              // left hip forward at left strike
    const roll = P.roll * Math.cos(st);                      // swing-side hip drops
    const lean = P.lean + 4 * DEG * old;
    const Dh = qMul(ry(yaw), qMul(rz(roll), rx(lean * 0.4)));
    const rootX = P.sway * L * Math.cos(st);                 // pelvis over the stance foot
    const shape = (P.bobHighInStance ? 1 : -1) * Math.cos(2 * st);    // pelvis bob shape, 2 per cycle
    const legs = SIDES.map((side, i) => {
      const tgt = footTarget(ctx, side, wrap01(phase + 0.5 * i), tm);
      return { side, tgt, contact: tgt.contact, maxD: maxReach(ctx.rig, side, P.reach) };
    });
    return { phase, yaw, roll, lean, Dh, rootX, shape, legs };
  }

  function prep(ctx) {
    return cached(ctx, P.name, () => {
      const tm = timing(ctx);
      return { tm, pelvis: fitPelvis(ctx, 240, ph => frame(ctx, ph, tm), P.bob * ctx.legLength, P.bobHighInStance) };
    });
  }

  function armParams(ctx, phase) {
    const old = Math.max(0, slider(ctx, 'age')), heavy = Math.max(0, slider(ctx, 'weight'));
    const c = Math.cos(TAU * (phase - P.armLag));            // +1: left arm fully back (left leg forward)
    const amp = P.armSwing * (1 - 0.35 * old) * Math.sqrt(ctx.speedScale);
    return {
      swing: amp * c,
      out: P.armOut + 8 * DEG * heavy,
      bend: P.elbow + P.elbowSwing * 0.5 * (1 - c),
      protract: -P.shoulder * c, wrist: 0.15 * amp * c,
    };
  }

  return {
    name: P.name, loop: true,
    duration: (P.strideK * NEUTRAL_HIP_HEIGHT) / Math.sqrt(P.froude * G * NEUTRAL_HIP_HEIGHT),
    timing: ctx => prep(ctx).tm,
    contacts(t, ctx) {
      const { tm } = prep(ctx), ph = phaseOf(t, tm.duration);
      return { left: ph < tm.beta ? 1 : 0, right: wrap01(ph + 0.5) < tm.beta ? 1 : 0 };
    },
    sample(t, ctx) {
      const { tm, pelvis } = prep(ctx), ph = phaseOf(t, tm.duration);
      const fr = frame(ctx, ph, tm);
      const { root, legJoints } = placeLegs(ctx, fr, pelvis);
      const up = torso(fr.Dh, {
        yaw: -P.counterYaw * fr.yaw, roll: -0.8 * fr.roll, pitch: fr.lean * 0.6,
        headWorld: rx(0.25 * fr.lean),
      });
      const arms = bothArms(ctx.rig, armParams(ctx, ph), armParams(ctx, wrap01(ph + 0.5)));
      return { joints: { ...legJoints, ...up, ...arms }, root };
    },
  };
}

const walk = locomotion({
  name: 'walk',
  froude: 0.2, strideK: 1.5, reach: 0.995,
  beta: 0.62, betaSlope: 0.06, betaMin: 0.54, betaMax: 0.66, maxStance: 1.1,
  narrow: 0.55, zOffset: -0.09,
  heelLift: 0.35, toeOff: 48 * DEG, rollEnd: 0.45, dorsi: 6 * DEG,
  clearance: 0.1, liftSkew: 0.7, swingTangent: 0.5,
  bob: 0.035, bobHighInStance: true, sway: 0.025,
  yaw: 5 * DEG, roll: 3 * DEG, lean: 2 * DEG, counterYaw: 1.5,
  armSwing: 18 * DEG, armLag: 0.04, armOut: 7 * DEG, elbow: 15 * DEG, elbowSwing: 15 * DEG, shoulder: 2 * DEG,
});

const run = locomotion({
  name: 'run',
  froude: 1.0, strideK: 2.4, reach: 0.99,
  beta: 0.3, betaSlope: 0.05, betaMin: 0.24, betaMax: 0.36, maxStance: 0.85,
  narrow: 0.75, zOffset: -0.02,
  heelLift: 0.5, toeOff: 55 * DEG, rollEnd: 0.4, dorsi: 10 * DEG,
  clearance: 0.3, liftSkew: 0.8, swingTangent: 0.5,
  bob: 0.02, bobHighInStance: false, sway: 0.012,
  yaw: 8 * DEG, roll: 3 * DEG, lean: 10 * DEG, counterYaw: 1.6,
  armSwing: 35 * DEG, armLag: 0.03, armOut: 12 * DEG, elbow: 80 * DEG, elbowSwing: 15 * DEG, shoulder: 4 * DEG,
});

// ---------------------------------------------------------------------------------------------------
// Idle: 8 s loop (at speedScale 1), two breaths, one weight shift, feet pinned to rest.

const IDLE_PERIOD = 8;
const idle = (() => {
  const timing = ctx => ({ duration: IDLE_PERIOD / ctx.speedScale, speed: 0, stride: 0 });
  function frame(ctx, ph) {
    const { rig } = ctx, L = ctx.legLength, w = Math.sin(TAU * ph);
    const roll = 2 * DEG * w, yaw = 1 * DEG * Math.sin(TAU * ph + 1);
    const Dh = qMul(ry(yaw), rz(roll));
    const legs = SIDES.map(side => ({
      side, contact: 1, maxD: maxReach(rig, side, 1),
      tgt: { toes: rig.heads[`${side}Toes`], pitch: 0, toePitch: 0, contact: 1 },
    }));
    return { phase: ph, yaw, roll, Dh, rootX: 0.015 * L * w, shape: 0, legs };
  }
  const prep = ctx => cached(ctx, 'idle', () => ({ tm: timing(ctx), pelvis: fitPelvis(ctx, 240, ph => frame(ctx, ph), 0) }));
  return {
    name: 'idle', loop: true, duration: IDLE_PERIOD,
    timing: ctx => prep(ctx).tm,
    contacts: () => ({ left: 1, right: 1 }),
    sample(t, ctx) {
      const { tm, pelvis } = prep(ctx), ph = phaseOf(t, tm.duration);
      const fr = frame(ctx, ph);
      const { root, legJoints } = placeLegs(ctx, fr, pelvis);
      const breath = Math.sin(TAU * 2 * ph);                // 2 breaths per loop, + = inhale
      const heavy = Math.max(0, slider(ctx, 'weight'));
      const up = torso(fr.Dh, {
        yaw: -0.8 * fr.yaw, roll: -1.2 * fr.roll, pitch: 0, breath: 1.2 * DEG * breath,
        headWorld: qMul(ry(3 * DEG * Math.sin(TAU * ph + 2.1)), rx(2 * DEG)),
      });
      const arm = sgn => ({
        swing: 1.5 * DEG * Math.sin(TAU * ph + (sgn > 0 ? 0.4 : 1.9)), out: (6 + 8 * heavy) * DEG,
        bend: (16 + 2 * breath) * DEG, shrug: 1 * DEG * breath,
      });
      return { joints: { ...legJoints, ...up, ...bothArms(ctx.rig, arm(1), arm(-1)) }, root };
    },
  };
})();

/** Clip registry: new clips = new entries (names double as i18n keys `clip_<name>`). */
export const CLIPS = { idle, walk, run };
