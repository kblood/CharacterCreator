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

/** IK ankle target of a foot target: explicit `ankle` (run swing) or derived from ball + pitch. */
const ankleOf = (rig, side, tgt) => tgt.ankle || ankleFor(rig, side, tgt.toes, tgt.pitch);

/**
 * Largest foot pitch (+X plantarflex) that keeps the ball at or above its rest height for an ankle at
 * height `ay`: the ball is |v| from the ankle at angle phi below horizontal at rest (v = ankle -> ball).
 */
function maxPitchAbove(rig, side, ay) {
  const H = rig.heads, v = vSub(H[`${side}Toes`], H[`${side}Foot`]);
  const R = Math.hypot(v[1], v[2]), phi = Math.atan2(-v[1], v[2]), h = ay - H[`${side}Toes`][1];
  return h >= R ? Math.PI / 2 - phi : Math.asin(clamp(h / R, -1, 1)) - phi;
}

/** Cubic Hermite through keys [{u, v, m}] (m = dv/du), clamped to the key range. */
function hermite(keys, u) {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].u) i++;
  const a = keys[i], b = keys[i + 1], h = b.u - a.u, x = clamp((u - a.u) / h, 0, 1);
  const x2 = x * x, x3 = x2 * x;
  return (2 * x3 - 3 * x2 + 1) * a.v + (x3 - 2 * x2 + x) * h * a.m + (-2 * x3 + 3 * x2) * b.v + (x3 - x2) * h * b.m;
}

/** Catmull-Rom tangents for interior keys; end tangents given. keys: [{u, v}] -> [{u, v, m}]. */
function withTangents(keys, m0, m1) {
  return keys.map((k, i) => ({
    ...k,
    m: i === 0 ? m0 : i === keys.length - 1 ? m1 : (keys[i + 1].v - keys[i - 1].v) / (keys[i + 1].u - keys[i - 1].u),
  }));
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
  const A = ankleOf(rig, side, tgt);
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
  // Swing feet may derive their pitch from the solved shin (foot carried by the lower leg).
  let { pitch, toePitch } = tgt;
  if (tgt.pitchFromShin) {
    const s0 = rig.dir[ll], s1 = qRotate(Dshin, s0);
    ({ pitch, toePitch } = tgt.pitchFromShin(Math.atan2(s0[2], -s0[1]) - Math.atan2(s1[2], -s1[1]), Ae[1]));
  }
  return { [ul]: Dthigh, [ll]: Dshin, [ft]: rx(pitch), [to]: rx(toePitch) };
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
  for (const { side, tgt, contact, bind, maxD } of fr.legs) {
    if (!contact && !bind) continue;
    y = Math.min(y, reachY(hipPos(rig, side, fr.Dh, [fr.rootX, 0, 0]), ankleOf(rig, side, tgt), maxD));
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
  for (const { side, tgt, contact, bind, maxD } of fr.legs) {
    if (!contact && !bind) continue;
    y = Math.min(y, reachY(hipPos(rig, side, fr.Dh, [fr.rootX, 0, 0]), ankleOf(rig, side, tgt), maxD));
  }
  const root = [fr.rootX, y, 0];
  const world = { hips: fr.Dh };
  for (const { side, tgt, maxD } of fr.legs) Object.assign(world, solveLeg(rig, side, fr.Dh, root, tgt, maxD));
  return { root, legJoints: worldToPose(world) };
}

// ---------------------------------------------------------------------------------------------------
// Locomotion (walk, run): one parameterised gait, authored for the left side, right = half a cycle later.

/**
 * Run pelvis bob shape (-1..1, 2 per cycle): a sine dip over the stance (lowest at mid-stance) and a
 * ballistic parabola over the flight (highest mid-flight). The touchdown/toe-off level h0 makes the
 * curve C1 at both contacts for any duty factor B.
 */
function ballisticBob(phase, B) {
  const q = wrap01(phase) % 0.5, F = 0.5 - B;
  if (F <= 1e-6) return -Math.cos(TAU * 2 * q);
  const h0 = (4 * B - Math.PI * F) / (4 * B + Math.PI * F);
  if (q < B) return h0 - (h0 + 1) * Math.sin((Math.PI * q) / B);
  const f = (q - B) / F;
  return h0 + (1 - h0) * 4 * f * (1 - f);
}

function locomotion(P) {
  /**
   * Effective parameters for a body/speed: P, overridden by P.speedPresets (piecewise, smoothstep-eased
   * in speedScale, e.g. slow jog -> jog -> fast run). Walk has no presets, so its parameters are P as is.
   */
  function params(ctx) {
    const ps = P.speedPresets;
    if (!ps) return P;
    const s = ctx.speedScale;
    let i = 0;
    while (i < ps.length - 2 && s > ps[i + 1].s) i++;
    const a = ps[i], b = ps[i + 1], k = smooth((s - a.s) / (b.s - a.s));
    const E = { ...P };
    for (const key of Object.keys(a)) if (key !== 's') E[key] = a[key] + (b[key] - a[key]) * k;
    return E;
  }

  function timing(ctx, E) {
    const s = ctx.speedScale, old = Math.max(0, slider(ctx, 'age')), heavy = Math.max(0, slider(ctx, 'weight'));
    const hip = ctx.hipHeight;
    const speed = s * Math.sqrt(E.froude * G * hip) * (1 - 0.12 * old);
    if (E.cadence) {
      // Run: step frequency scales with sqrt(g / hipHeight) (dynamic similarity) and rises slowly with
      // speed (~168 spm at a jog, ~195 at speedScale 2); stride = speed / cadence takes the rest. The
      // contact share (beta) falls with speed, is longer for heavy/old bodies, and the stance length is
      // capped relative to the leg so the planted foot stays reachable without crouching.
      const f = E.cadence * s ** E.cadenceExp * Math.sqrt(G / hip) * (1 - 0.04 * old);    // steps per second
      const stride = (2 * speed) / f;
      const beta = Math.min(clamp(E.beta + 0.03 * heavy + 0.04 * old, E.betaMin, E.betaMax), (E.maxStance * ctx.legLength) / stride);
      return { duration: stride / speed, speed, stride, beta };
    }
    // Faster = shorter ground contact; stance length is capped relative to the leg so the pelvis never
    // has to crouch to keep the planted foot (cadence rises instead).
    const beta = clamp(E.beta - E.betaSlope * (s - 1), E.betaMin, E.betaMax);
    const stride = Math.min(E.strideK * hip * Math.sqrt(s) * (1 - 0.06 * old), (E.maxStance * ctx.legLength) / beta);
    return { duration: stride / speed, speed, stride, beta };
  }

  /** Stance centre of the ball (toes joint) along z: hip-relative (run) or rest-toes-relative (walk). */
  function stanceCentre(ctx, E, side, S) {
    const H = ctx.rig.heads;
    return E.zCenter != null ? H[`${side}UpperLeg`][2] + E.zCenter * ctx.legLength : H[`${side}Toes`][2] + E.zOffset * S;
  }

  /** Foot target for a leg at its own phase p (0 = foot strike). */
  function footTarget(ctx, E, side, p, tm) {
    const { rig } = ctx, H = rig.heads, L = ctx.legLength, S = tm.stride, B = tm.beta;
    const toesRest = H[`${side}Toes`];
    const narrow = E.narrow * (1 - 0.6 * Math.max(0, slider(ctx, 'weight')));
    const x = toesRest[0] + (H[`${side}UpperLeg`][0] - toesRest[0]) * narrow;
    const zc = stanceCentre(ctx, E, side, S);
    const sH = E.heelLift;
    let z, y = toesRest[1], tau, contact, dorsi = 0, toeBlend = 0;
    if (p < B) {                                             // stance: ball planted, moving back at `speed`
      const s = p / B;
      contact = 1;
      z = zc + B * S * (0.5 - s);
      tau = s < sH ? 0 : 0.5 * (s - sH) / (1 - sH);
    } else if (E.ankleSwing) {
      return ankleSwing(ctx, E, side, (p - B) / (1 - B), tm, x, zc);
    } else {                                                 // swing
      const u = (p - B) / (1 - B);
      contact = 0;
      const z0 = zc - 0.5 * B * S, z1 = zc + 0.5 * B * S, m = -E.swingTangent * (1 - B) * S;
      const u2 = u * u, u3 = u2 * u;
      z = (2 * u3 - 3 * u2 + 1) * z0 + (u3 - 2 * u2 + u) * m + (-2 * u3 + 3 * u2) * z1 + (u3 - u2) * m;
      const w = u + E.liftSkew * u * (1 - u);                 // skewed so the foot lifts early
      y += E.clearance * L * Math.sin(Math.PI * w);
      tau = Math.min(1, 0.5 + 0.5 * u / E.rollEnd);
      dorsi = -E.dorsi * Math.sin(Math.PI * u) ** 2;
      toeBlend = smooth(u / 0.3);
    }
    const pitch = E.toeOff * Math.sin(Math.PI * tau) ** 2 + dorsi;
    return { toes: [x, y, z], pitch, toePitch: pitch * toeBlend, contact };
  }

  /**
   * Run swing, authored as an ANKLE path (not a ball path): from toe-off it keeps drifting back while it
   * rises toward the glutes (heel recovery), passes forward under the knee, reaches slightly past the
   * strike point and pulls back onto it ("paw back"). z keys are fractions of the toe-off -> strike
   * distance, heights are in leg lengths; end tangents equal the stance velocity (C1 at both contacts).
   * The foot pitch follows the solved shin (plus some plantarflexion), blended from the toe-off pitch
   * and back to flat for the strike, and is clamped so the ball never dips below the floor.
   */
  function ankleSwing(ctx, E, side, u, tm, x, zc) {
    const { rig } = ctx, H = rig.heads, L = ctx.legLength, S = tm.stride, B = tm.beta;
    const toesY = H[`${side}Toes`][1];
    const A0 = ankleFor(rig, side, [x, toesY, zc - 0.5 * B * S], E.toeOff);    // stance end (toe-off)
    const A1 = ankleFor(rig, side, [x, toesY, zc + 0.5 * B * S], 0);           // next strike
    // Swing heights are in leg lengths, scaled down for short-thighed bodies (child+short: thigh 38 % of
    // the leg vs 49 % neutral), whose hips would otherwise flex into a high-knees drill.
    const thigh = rig.len[`${side}UpperLeg`] / (rig.len[`${side}UpperLeg`] + rig.len[`${side}LowerLeg`]);
    const hs = clamp(thigh / 0.49, 0.7, 1);
    const ay = H[`${side}Foot`][1], dz = A1[2] - A0[2], mz = -(1 - B) * S;
    const ks = [[0, 0, 0], [E.k1u, E.k1z, E.k1y], [E.k2u, E.k2z, E.k2y], [E.k3u, E.k3z, E.k3y], [1, 1, 0]];
    const zk = withTangents(ks.map(([ku, kz]) => ({ u: ku, v: A0[2] + kz * dz })), E.liftTangent * mz, mz);
    const yk = withTangents(ks.map(([ku, , ky], i) => ({ u: ku, v: i === 0 ? A0[1] : i === ks.length - 1 ? A1[1] : ay + hs * ky * L })), E.liftUp * L, 0);
    const ankle = [A0[0], hermite(yk, u), hermite(zk, u)];
    const w0 = smooth(u / E.pitchIn), w1 = smooth((u - E.pitchOut) / (1 - E.pitchOut)), tb = smooth(u / 0.3);
    return {
      ankle, contact: 0, bind: u > 0.5, pitch: 0, toePitch: 0,
      pitchFromShin(shin, ankleY) {
        const follow = shin + E.swingPlantar;
        let pitch = (1 - w1) * ((1 - w0) * E.toeOff + w0 * follow);
        pitch = Math.min(pitch, maxPitchAbove(rig, side, ankleY));
        return { pitch, toePitch: pitch * tb };
      },
    };
  }

  /** Everything except the pelvis height solve, as a function of the cycle phase. */
  function frame(ctx, E, phase, tm) {
    const B = tm.beta, L = ctx.legLength;
    const old = Math.max(0, slider(ctx, 'age'));
    const st = TAU * (phase - B / 2);                       // 0 at left mid-stance
    const yaw = -E.yaw * Math.cos(TAU * phase);              // left hip forward at left strike
    const roll = E.roll * Math.cos(st);                      // swing-side hip drops
    const lean = E.lean + 4 * DEG * old;
    const Dh = qMul(ry(yaw), qMul(rz(roll), rx(lean * 0.4)));
    const rootX = E.sway * L * Math.cos(st);                 // pelvis over the stance foot
    const shape = E.ballistic ? ballisticBob(phase, B) : (E.bobHighInStance ? 1 : -1) * Math.cos(2 * st);
    const legs = SIDES.map((side, i) => {
      const tgt = footTarget(ctx, E, side, wrap01(phase + 0.5 * i), tm);
      // bind: the pelvis curve also keeps the late-swing foot reachable (run: the leg reaches the strike
      // point before contact, so there is no snap at touchdown).
      return { side, tgt, contact: tgt.contact, bind: !!tgt.bind, maxD: maxReach(ctx.rig, side, E.reach) };
    });
    return { phase, yaw, roll, lean, Dh, rootX, shape, legs };
  }

  function prep(ctx) {
    return cached(ctx, P.name, () => {
      const E = params(ctx), tm = timing(ctx, E);
      return { E, tm, pelvis: fitPelvis(ctx, 240, ph => frame(ctx, E, ph, tm), E.bob * ctx.legLength, E.bobHighInStance) };
    });
  }

  function armParams(ctx, E, phase) {
    const old = Math.max(0, slider(ctx, 'age')), heavy = Math.max(0, slider(ctx, 'weight'));
    const c = Math.cos(TAU * (phase - E.armLag));            // +1: left arm fully back (left leg forward)
    const amp = E.armSwing * (1 - 0.35 * old) * (P.speedPresets ? 1 : Math.sqrt(ctx.speedScale));
    return {
      swing: amp * c + (E.armBack || 0),
      out: E.armOut + 8 * DEG * heavy - (E.armAcross || 0) * 0.5 * (1 - c),
      bend: E.elbow + E.elbowSwing * 0.5 * (1 - c),
      protract: -E.shoulder * c, wrist: 0.15 * amp * c,
    };
  }

  const neutralDuration = () => {
    const E = params({ speedScale: 1 });
    if (!E.cadence) return (E.strideK * NEUTRAL_HIP_HEIGHT) / Math.sqrt(E.froude * G * NEUTRAL_HIP_HEIGHT);
    return 2 / (E.cadence * Math.sqrt(G / NEUTRAL_HIP_HEIGHT));
  };

  return {
    name: P.name, loop: true,
    duration: neutralDuration(),
    timing: ctx => prep(ctx).tm,
    contacts(t, ctx) {
      const { tm } = prep(ctx), ph = phaseOf(t, tm.duration);
      return { left: ph < tm.beta ? 1 : 0, right: wrap01(ph + 0.5) < tm.beta ? 1 : 0 };
    },
    sample(t, ctx) {
      const { E, tm, pelvis } = prep(ctx), ph = phaseOf(t, tm.duration);
      const fr = frame(ctx, E, ph, tm);
      const { root, legJoints } = placeLegs(ctx, fr, pelvis);
      const up = torso(fr.Dh, {
        yaw: -E.counterYaw * fr.yaw, roll: -0.8 * fr.roll, pitch: fr.lean * 0.6,
        headWorld: rx(0.25 * fr.lean),
      });
      const arms = bothArms(ctx.rig, armParams(ctx, E, ph), armParams(ctx, E, wrap01(ph + 0.5)));
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

// Run (docs/RUN_ANIMATION.md): speed presets blend a slow jog (0.25), a jog (1) and a fast run (2).
// Swing keys k<i> = (u = swing fraction, z = fraction of the toe-off -> strike distance, y = ankle lift in
// leg lengths). zCenter = stance centre of the ball relative to the hip joint, in leg lengths.
const run = locomotion({
  name: 'run',
  froude: 1.0, reach: 0.99, cadenceExp: 0.28,
  betaMin: 0.18, betaMax: 0.46, maxStance: 0.85,
  narrow: 0.75, ankleSwing: true, liftTangent: 0.4, liftUp: 0.8,
  heelLift: 0.45, rollEnd: 0.4,
  bobHighInStance: false, ballistic: true,
  counterYaw: 1.6, armLag: 0.03, armOut: 10 * DEG, shoulder: 4 * DEG,
  speedPresets: [
    { s: 0.25, cadence: 0.832, beta: 0.42, zCenter: 0.0, toeOff: 35 * DEG, bob: 0.018, sway: 0.015,
      k1u: 0.3, k1z: -0.06, k1y: 0.16, k2u: 0.6, k2z: 0.5, k2y: 0.14, k3u: 0.86, k3z: 1.03, k3y: 0.04,
      pitchIn: 0.35, pitchOut: 0.7, swingPlantar: 10 * DEG,
      yaw: 6 * DEG, roll: 3 * DEG, lean: 6 * DEG,
      armSwing: 22 * DEG, armBack: 6 * DEG, armAcross: 4 * DEG, elbow: 80 * DEG, elbowSwing: 10 * DEG },
    { s: 1, cadence: 0.832, beta: 0.32, zCenter: -0.04, toeOff: 50 * DEG, bob: 0.035, sway: 0.012,
      k1u: 0.3, k1z: -0.08, k1y: 0.42, k2u: 0.6, k2z: 0.55, k2y: 0.34, k3u: 0.86, k3z: 1.06, k3y: 0.08,
      pitchIn: 0.35, pitchOut: 0.7, swingPlantar: 15 * DEG,
      yaw: 8 * DEG, roll: 4 * DEG, lean: 9 * DEG,
      armSwing: 32 * DEG, armBack: 10 * DEG, armAcross: 6 * DEG, elbow: 82 * DEG, elbowSwing: 18 * DEG },
    { s: 2, cadence: 0.832, beta: 0.27, zCenter: -0.06, toeOff: 62 * DEG, bob: 0.03, sway: 0.01,
      k1u: 0.3, k1z: -0.06, k1y: 0.62, k2u: 0.58, k2z: 0.6, k2y: 0.48, k3u: 0.86, k3z: 1.08, k3y: 0.12,
      pitchIn: 0.35, pitchOut: 0.72, swingPlantar: 20 * DEG,
      yaw: 9 * DEG, roll: 4 * DEG, lean: 14 * DEG,
      armSwing: 45 * DEG, armBack: 12 * DEG, armAcross: 8 * DEG, elbow: 80 * DEG, elbowSwing: 30 * DEG },
  ],
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
