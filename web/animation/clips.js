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
function leftArm(rig, { swing = 0, out = 6 * DEG, bend = 15 * DEG, shrug = 0, protract = 0, wrist = 0, twist = 0 }) {
  const d = rig.dir.leftUpperArm;
  const restOut = Math.atan2(d[0], -d[1]);                // A-pose: ~42 deg from vertical
  // twist: rotation about the upper arm's own rest axis (+ = internal rotation, forearm across the body)
  const upper = qMul(rx(swing), rz(out - restOut));
  return {
    leftShoulder: qMul(ry(-protract), rz(shrug)),
    leftUpperArm: twist ? qMul(upper, qAxisAngle(d, twist)) : upper,
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
      return { duration: stride / speed, speed, stride, beta, velocity: [0, 0, speed] };
    }
    // Faster = shorter ground contact; stance length is capped relative to the leg so the pelvis never
    // has to crouch to keep the planted foot (cadence rises instead).
    const beta = clamp(E.beta - E.betaSlope * (s - 1), E.betaMin, E.betaMax);
    const stride = Math.min(E.strideK * hip * Math.sqrt(s) * (1 - 0.06 * old), (E.maxStance * ctx.legLength) / beta);
    return { duration: stride / speed, speed, stride, beta, velocity: [0, 0, speed] };
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
    // bindEarlySwing (walk_back, played reversed): the just-lifted foot keeps constraining the pelvis, so in
    // reverse the leg reaches the floor before contact instead of the pelvis snapping down at touch-down
    const bind = contact ? undefined : E.bindEarlySwing && (p - B) / (1 - B) < E.bindEarlySwing;
    return bind ? { toes: [x, y, z], pitch, toePitch: pitch * toeBlend, contact, bind } : { toes: [x, y, z], pitch, toePitch: pitch * toeBlend, contact };
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

// ---------------------------------------------------------------------------------------------------
// Shared helpers of the clips below (docs/ANIMATION_CLIPS.md): walk back, strafe, idle variants, jump.

const NEUTRAL_LEG = 0.802;                 // rig.legLength of the neutral body (time scaling of the jump)

/** Smooth minimum of 0 and e: always <= min(0, e), C-infinity (k = blend width in metres). */
const softMin0 = (e, k = 0.004) => (e - Math.sqrt(e * e + k * k)) / 2;

/** 1 inside [a, b] (seconds), 0 outside, smoothstep ramps of length r inside the window. */
const bump = (s, a, b, r) => smooth((s - a) / r) * (1 - smooth((s - (b - r)) / r));

/**
 * Monotone cubic keys (Fritsch-Butland tangents, no overshoot between keys): [{u, v, m?}] -> [{u, v, m}].
 * End tangents and keys with an explicit m keep it.
 */
function monotone(keys) {
  const d = keys.slice(1).map((k, i) => (k.v - keys[i].v) / (k.u - keys[i].u));
  return keys.map((k, i) => {
    if (k.m != null) return k;
    if (i === 0 || i === keys.length - 1) return { ...k, m: 0 };
    const a = d[i - 1], b = d[i], h0 = k.u - keys[i - 1].u, h1 = keys[i + 1].u - k.u;
    return { ...k, m: a * b <= 0 ? 0 : (3 * (h0 + h1)) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / b) };
  });
}
const curve = keys => { const k = monotone(keys.map(([u, v, m]) => ({ u, v, m }))); return u => hermite(k, u); };

/** Both feet planted at their rest toes (IK targets). */
const restLegs = (rig, factor = 1) => SIDES.map(side => ({
  side, contact: 1, maxD: maxReach(rig, side, factor),
  tgt: { toes: rig.heads[`${side}Toes`], pitch: 0, toePitch: 0, contact: 1 },
}));

/** Highest root.y that keeps every planted leg reachable for a hips delta and root x/z. */
function plantedY(rig, Dh, root, legs) {
  let y = Infinity;
  for (const { side, tgt, contact, maxD } of legs) {
    if (contact) y = Math.min(y, reachY(hipPos(rig, side, Dh, [root[0], 0, root[2]]), ankleOf(rig, side, tgt), maxD));
  }
  return y;
}

/** Legs for a given root (planted legs clamp root.y to their reach, a safety net), as pose joints. */
function solveLegs(rig, Dh, root, legs) {
  const r = [root[0], Math.min(root[1], plantedY(rig, Dh, root, legs)), root[2]];
  const world = { hips: Dh };
  for (const { side, tgt, maxD } of legs) Object.assign(world, solveLeg(rig, side, Dh, r, tgt, maxD));
  return { root: r, legJoints: worldToPose(world) };
}

/** Relaxed standing arm (same as idle at a neutral breath): hanging ~6 deg off the body, elbow 16 deg. */
const standArm = ctx => ({ swing: 0, out: (6 + 8 * Math.max(0, slider(ctx, 'weight'))) * DEG, bend: 16 * DEG, shrug: 0 });
const addArm = (a, d) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(d)])].map(k => [k, (a[k] || 0) + (d[k] || 0)]));

/** Loop wrapper: the same gait mirrored left <-> right (strafe right from strafe left), half a cycle later so
 *  phase 0 is still a LEFT foot contact (the animator shares one phase between locomotion clips). */
function mirrored(base, name) {
  const shift = ctx => 0.5 * base.timing(ctx).duration;
  return {
    name, loop: true, duration: base.duration,
    timing(ctx) { const tm = base.timing(ctx), v = tm.velocity; return { ...tm, velocity: [-v[0], v[1], v[2]] }; },
    contacts(t, ctx) { const c = base.contacts(t + shift(ctx), ctx); return { left: c.right, right: c.left }; },
    sample: (t, ctx) => mirrorPose(base.sample(t + shift(ctx), ctx)),
  };
}

/**
 * Loop wrapper: a forward gait played backwards in time (walking backwards is close to time-reversed forward
 * walking: Thorstensson 1986, Grasso et al. 1998). Shifted so phase 0 is the LEFT foot contact (the base's
 * left toe-off) like the forward clips: the ball touches first with the heel up, then the heel lowers.
 */
function reversed(base, name) {
  const tmOf = ctx => base.timing(ctx);
  return {
    name, loop: true, duration: base.duration,
    timing(ctx) { const tm = tmOf(ctx); return { ...tm, speed: -tm.speed, velocity: [0, 0, -tm.speed] }; },
    contacts(t, ctx) {
      const tm = tmOf(ctx), ph = phaseOf(t, tm.duration);
      return { left: ph < tm.beta ? 1 : 0, right: wrap01(ph + 0.5) < tm.beta ? 1 : 0 };
    },
    sample(t, ctx) { const tm = tmOf(ctx); return base.sample(tm.beta * tm.duration - t, ctx); },
  };
}

// ---------------------------------------------------------------------------------------------------
// Walk backwards: a slower, shorter-strided walk (about 2/3 of the forward speed, cadence ~95 %), toe-first
// contact (22 deg plantarflexion, heel down within ~30 % of the stance), early knee lift in the swing.

const walkBackBase = locomotion({
  name: 'walk_back',
  froude: 0.0885, strideK: 1.05, reach: 0.995,
  beta: 0.64, betaSlope: 0.05, betaMin: 0.58, betaMax: 0.68, maxStance: 0.9,
  narrow: 0.45, zOffset: -0.05,
  heelLift: 0.7, toeOff: 22 * DEG, rollEnd: 0.45, dorsi: 5 * DEG,
  clearance: 0.085, liftSkew: -0.5, swingTangent: 0.5, bindEarlySwing: 0.35,
  bob: 0.03, bobHighInStance: true, sway: 0.025,
  yaw: 4 * DEG, roll: 3 * DEG, lean: 3 * DEG, counterYaw: 1.5,
  armSwing: 12 * DEG, armLag: 0.04, armOut: 8 * DEG, elbow: 18 * DEG, elbowSwing: 10 * DEG, shoulder: 2 * DEG,
});
const walk_back = reversed(walkBackBase, 'walk_back');

// ---------------------------------------------------------------------------------------------------
// Strafe (sidestep / shuffle, facing forward): authored travelling toward +X (the character's LEFT), the
// left foot leads, the right foot closes; the feet never cross. Planted feet move at exactly -velocity
// (IK), the pelvis bobs (high in single support) and follows the feet's midpoint a little.

function sidestep(P) {
  function timing(ctx) {
    const s = ctx.speedScale, old = Math.max(0, slider(ctx, 'age')), rig = ctx.rig;
    const T = (P.period * Math.sqrt(ctx.hipHeight / NEUTRAL_HIP_HEIGHT) * (1 + 0.08 * old)) / s ** P.cadenceExp;
    const restGap = rig.heads.leftToes[0] - rig.heads.rightToes[0];
    const gap = P.gap * restGap * (1 + P.gapSpeed * (s - 1));            // mean distance of the feet (toes joints)
    const stride = Math.min(P.strideK * ctx.legLength * s ** (1 - P.cadenceExp) * (1 - 0.15 * old),
      2 * (gap - P.minGap * rig.hipWidth));                               // closing step keeps minGap * hipWidth
    return { duration: T, speed: 0, stride, beta: P.beta, gap, velocity: [stride / T, 0, 0] };
  }

  function footTarget(ctx, tm, side, p) {
    const H = ctx.rig.heads, L = ctx.legLength, S = tm.stride, B = tm.beta;
    const xc = (side === 'left' ? 0.5 : -0.5) * tm.gap, toes = H[`${side}Toes`];
    let x, y = toes[1], pitch, toePitch = 0, contact;
    if (p < B) {                                                 // stance: ball planted, moving -X at the speed
      const s = p / B;
      contact = 1;
      x = xc + B * S * (0.5 - s);
      pitch = P.push * smooth((s - 0.7) / 0.3);                  // small push-off over the ball
    } else {                                                     // swing: +X, low arc
      const u = (p - B) / (1 - B), u2 = u * u, u3 = u2 * u;
      contact = 0;
      const x0 = xc - 0.5 * B * S, x1 = xc + 0.5 * B * S, m = -P.swingTangent * (1 - B) * S;
      x = (2 * u3 - 3 * u2 + 1) * x0 + (u3 - 2 * u2 + u) * m + (-2 * u3 + 3 * u2) * x1 + (u3 - u2) * m;
      y += P.clearance * L * Math.sin(Math.PI * (u + P.liftSkew * u * (1 - u)));
      pitch = P.push * (1 - smooth(u / 0.3)) - P.dorsi * Math.sin(Math.PI * u) ** 2;
      toePitch = pitch * smooth(u / 0.3);
    }
    return { toes: [x, y, toes[2] + P.zOffset * L], pitch, toePitch, contact };
  }

  const legsAt = (ctx, tm, phase) => SIDES.map((side, i) => {
    const tgt = footTarget(ctx, tm, side, wrap01(phase + 0.5 * i));
    return { side, tgt, contact: tgt.contact, bind: false, maxD: maxReach(ctx.rig, side, P.reach) };
  });

  /** Pelvis x: the low-passed midpoint of the feet (harmonics 1..3), so the hips ride between them. */
  function swayFit(ctx, tm) {
    const N = 120, K = 3, a = new Array(K + 1).fill(0), b = new Array(K + 1).fill(0);
    for (let i = 0; i < N; i++) {
      const ph = i / N, [l, r] = legsAt(ctx, tm, ph), m = 0.5 * (l.tgt.toes[0] + r.tgt.toes[0]);
      for (let k = 1; k <= K; k++) { a[k] += (2 / N) * m * Math.cos(TAU * k * ph); b[k] += (2 / N) * m * Math.sin(TAU * k * ph); }
    }
    return ph => { let x = 0; for (let k = 1; k <= K; k++) x += a[k] * Math.cos(TAU * k * ph) + b[k] * Math.sin(TAU * k * ph); return P.sway * x; };
  }

  function frame(ctx, tm, sway, phase) {
    const st = TAU * (phase - tm.beta / 2);                     // 0 at left mid-stance
    const roll = P.roll * Math.cos(st);                         // stance-side hip up
    const Dh = qMul(rz(roll), rx(P.lean * 0.4));
    return { phase, roll, Dh, rootX: sway(phase), shape: Math.cos(2 * st), legs: legsAt(ctx, tm, phase) };
  }

  const prep = ctx => cached(ctx, P.name, () => {
    const tm = timing(ctx), sway = swayFit(ctx, tm);
    return { tm, sway, pelvis: fitPelvis(ctx, 240, ph => frame(ctx, tm, sway, ph), P.bob * ctx.legLength, true) };
  });

  function armParams(ctx, tm, p, i) {
    const lift = p >= tm.beta ? Math.sin((Math.PI * (p - tm.beta)) / (1 - tm.beta)) : 0;   // own leg in swing
    const base = standArm(ctx);
    return {
      swing: P.armSwing * Math.cos(TAU * p), out: base.out + P.armOut * lift * (i === 0 ? 1 : 0.6),
      bend: P.elbow + 8 * DEG * lift, shrug: 1.5 * DEG * lift, wrist: 0,
    };
  }

  return {
    name: P.name, loop: true, duration: P.period,
    timing: ctx => prep(ctx).tm,
    contacts(t, ctx) {
      const { tm } = prep(ctx), ph = phaseOf(t, tm.duration);
      return { left: ph < tm.beta ? 1 : 0, right: wrap01(ph + 0.5) < tm.beta ? 1 : 0 };
    },
    sample(t, ctx) {
      const { tm, sway, pelvis } = prep(ctx), ph = phaseOf(t, tm.duration);
      const fr = frame(ctx, tm, sway, ph);
      const { root, legJoints } = placeLegs(ctx, fr, pelvis);
      const up = torso(fr.Dh, { roll: -0.8 * fr.roll + P.sideLean, pitch: P.lean * 0.6, headWorld: rx(0.25 * P.lean) });
      const arms = bothArms(ctx.rig, armParams(ctx, tm, ph, 0), armParams(ctx, tm, wrap01(ph + 0.5), 1));
      return { joints: { ...legJoints, ...up, ...arms }, root };
    },
  };
}

// Neutral 1x: 0.9 s per cycle (133 steps/min), 0.40 m per cycle, 0.45 m/s; feet 0.15 .. 0.55 m apart.
const strafe_left = sidestep({
  name: 'strafe_left', period: 0.9, cadenceExp: 0.5, beta: 0.6,
  gap: 0.95, gapSpeed: 0.25, minGap: 0.7, strideK: 0.5, reach: 0.995,
  zOffset: -0.01, clearance: 0.06, liftSkew: 0.3, swingTangent: 0.5, push: 10 * DEG, dorsi: 5 * DEG,
  bob: 0.02, sway: 0.5, roll: 2.5 * DEG, lean: 3 * DEG, sideLean: -2 * DEG,
  armSwing: 4 * DEG, armOut: 7 * DEG, elbow: 20 * DEG,
});
const strafe_right = mirrored(strafe_left, 'strafe_right');

// ---------------------------------------------------------------------------------------------------
// Idle variants: feet pinned to rest (IK), the pelvis as high as the planted feet allow (smooth), arms
// relaxed like idle. pose(ph, ctx) -> { yaw, roll, shift (root.x, leg lengths), torso, head, arms }.

function idleVariant({ name, period, pose }) {
  const timing = ctx => ({ duration: period / ctx.speedScale, speed: 0, stride: 0, velocity: [0, 0, 0] });
  return {
    name, loop: true, duration: period, timing,
    contacts: () => ({ left: 1, right: 1 }),
    sample(t, ctx) {
      const ph = phaseOf(t, timing(ctx).duration), p = pose(ph, ctx), { rig } = ctx;
      const Dh = qMul(ry(p.yaw || 0), rz(p.roll || 0));
      const legs = restLegs(rig), rootX = (p.shift || 0) * ctx.legLength;
      const { root, legJoints } = solveLegs(rig, Dh, [rootX, softMin0(plantedY(rig, Dh, [rootX, 0, 0], legs)) - 1e-4, 0], legs);
      const up = torso(Dh, { ...p.torso, headWorld: p.head });
      return { joints: { ...legJoints, ...up, ...bothArms(rig, p.arms[0], p.arms[1]) }, root };
    },
  };
}

/** idle_look (10 s): weight onto the right leg + glance left, back, weight onto the left leg + glance right. */
const idle_look = idleVariant({
  name: 'idle_look', period: 10,
  pose(ph, ctx) {
    const s = ph * 10, breath = Math.sin(TAU * 3 * ph);                   // 3 breaths (18 / min)
    const shift = bump(s, 5.1, 9.3, 1.0) - bump(s, 0.7, 4.8, 1.0);        // + = weight on the LEFT leg
    const gL = bump(s, 1.5, 3.9, 0.55), gR = bump(s, 6.0, 8.4, 0.6);
    const look = 38 * DEG * gL - 32 * DEG * gR;                           // head yaw (+ = to the left)
    const base = standArm(ctx), roll = 4 * DEG * shift;                   // weight-bearing hip higher
    const arm = (i, off) => addArm(base, { swing: 1.5 * DEG * Math.sin(TAU * ph + off), bend: 2 * DEG * breath,
      out: 2 * DEG * Math.max(0, i ? shift : -shift), shrug: 0.8 * DEG * breath });
    return {
      yaw: 0.06 * look, roll, shift: 0.035 * shift,
      torso: { yaw: 0.2 * look, roll: -1.3 * roll, breath: 1.2 * DEG * breath },
      head: qMul(ry(look), qMul(rz(-3 * DEG * gR + 2 * DEG * gL), rx(2 * DEG))),
      arms: [arm(0, 0.4), arm(1, 1.9)],
    };
  },
});

/** idle_breathe (8 s): two slow deep breaths (15 / min) with visible chest, shoulders and arm sway. */
const idle_breathe = idleVariant({
  name: 'idle_breathe', period: 8,
  pose(ph, ctx) {
    const b = 0.5 - 0.5 * Math.cos(TAU * 2 * ph);                         // 0 exhaled .. 1 inhaled
    const w = Math.sin(TAU * ph), base = standArm(ctx);
    const arm = off => addArm(base, { swing: 3.5 * DEG * Math.sin(TAU * ph + off), out: 2.5 * DEG * b, bend: 5 * DEG * b,
      shrug: 3.5 * DEG * b, protract: -1.5 * DEG * b });
    return {
      yaw: 1 * DEG * Math.sin(TAU * ph + 1), roll: 1.5 * DEG * w, shift: 0.01 * w,
      torso: { roll: -1.8 * DEG * w, breath: 3.2 * DEG * (2 * b - 1), pitch: -1 * DEG * b },
      head: qMul(ry(2 * DEG * Math.sin(TAU * ph + 2.1)), rx(2 * DEG - 2 * DEG * b)),
      arms: [arm(0.4), arm(1.9)],
    };
  },
});

/** idle_fidget (9 s): a shoulder roll, then the left forearm comes up across the body and the eyes check the hand. */
const idle_fidget = idleVariant({
  name: 'idle_fidget', period: 9,
  pose(ph, ctx) {
    const s = ph * 9, breath = Math.sin(TAU * 2 * ph), w = Math.sin(TAU * ph);
    const k = clamp((s - 0.6) / 2.2, 0, 1), roll = Math.sin(Math.PI * k);   // shoulder roll: up+forward, up, back, down
    const wa = bump(s, 3.2, 7.4, 0.9), look = bump(s, 3.9, 6.8, 0.5);        // left forearm raised / eyes on the wrist
    const base = standArm(ctx);
    const shoulders = { shrug: 7 * DEG * roll * roll, protract: 4 * DEG * Math.sin(TAU * k) };
    const left = addArm(base, { ...shoulders, swing: -25 * DEG * wa + 1.5 * DEG * Math.sin(TAU * ph + 0.4), bend: 75 * DEG * wa + 2 * DEG * breath,
      twist: 75 * DEG * wa, out: -3 * DEG * wa, wrist: -12 * DEG * wa });
    const right = addArm(base, { ...shoulders, swing: 1.5 * DEG * Math.sin(TAU * ph + 1.9), bend: 2 * DEG * breath });
    return {
      yaw: 1.5 * DEG * look, roll: 2 * DEG * w, shift: 0.015 * w,
      torso: { yaw: 6 * DEG * look, roll: -2.6 * DEG * w, breath: 1.2 * DEG * breath, pitch: 4 * DEG * look },
      head: qMul(ry(4 * DEG * look), rx(2 * DEG + 30 * DEG * look)),
      arms: [left, right],
    };
  },
});

// ---------------------------------------------------------------------------------------------------
// Jump (standing countermovement jump), plus `fall` (airborne loop at the apex) and `land` (apex -> landing
// -> standing). One plan per body: ground phases scale with sqrt(legLength) (dynamic similarity), the jump
// height with the leg length, the flight is ballistic (g = 9.81) between the take-off and touch-down pelvis
// heights the legs can reach. root = [0, y, z]: y = the pelvis arc (Root translation), z = hips back in the
// crouch. Timing references: docs/ANIMATION_CLIPS.md.

const JUMP = {
  hold: 0.10, crouch: 0.45, push: 0.25, recover: 0.55, settle: 0.12,     // s for the neutral leg length
  depth: 0.28, height: 0.30, absorb: 0.20,                               // pelvis drop / rise, leg lengths
  takeoffPitch: 40 * DEG, landPitch: 22 * DEG, landReach: 0.98,          // ankle plantarflexion; leg reach at touch-down
  heelRise: 0.12, heelDown: 0.07,                                        // s: heel lift before take-off / heel down after touch-down
  hipBack: 0.35,                                                         // hips back per metre of pelvis drop
  lean: 40 * DEG, toLean: 10 * DEG, apexLean: 4 * DEG, tdLean: 8 * DEG, landLean: 28 * DEG,
  tuck: 0.12, tuckFwd: 0.03,                                             // ankle tuck in flight (leg lengths)
  fallPeriod: 1.2,
};

/** Smallest foot pitch that lets a planted leg reach a pelvis at root (bisection; 0 if the flat foot reaches). */
function pitchToReach(rig, side, Dh, root, toes, maxD) {
  const hip0 = hipPos(rig, side, Dh, [root[0], 0, root[2]]);
  const ok = p => reachY(hip0, ankleFor(rig, side, toes, p), maxD) >= root[1];
  if (ok(0)) return 0;
  let lo = 0, hi = 60 * DEG;
  if (!ok(hi)) return hi;
  for (let i = 0; i < 40; i++) { const m = 0.5 * (lo + hi); if (ok(m)) hi = m; else lo = m; }
  return hi;
}

function jumpPlan(ctx) {
  return cached(ctx, 'jump', () => {
    const { rig } = ctx, J = JUMP, L = ctx.legLength, s = ctx.speedScale;
    const old = Math.max(0, slider(ctx, 'age')), heavy = Math.max(0, slider(ctx, 'weight'));
    const ts = Math.sqrt(L / NEUTRAL_LEG) * (1 + 0.15 * old);
    const h = J.height * L * (0.75 + 0.25 * s) * (1 - 0.35 * old) * (1 - 0.2 * heavy);
    const dC = J.depth * L * (1 - 0.25 * old), dA = J.absorb * L;
    const Dh = lean => rx(0.45 * lean);
    const reachAll = (lean, pitch, f) => Math.min(...SIDES.map(side => reachY(hipPos(rig, side, Dh(lean), [0, 0, 0]),
      ankleFor(rig, side, rig.heads[`${side}Toes`], pitch), maxReach(rig, side, f))));
    const yTo = reachAll(J.toLean, J.takeoffPitch, 1), yLand = reachAll(J.tdLean, J.landPitch, J.landReach);
    const v0 = Math.sqrt(2 * G * h), vLand = Math.sqrt(v0 * v0 + 2 * G * (yTo - yLand)), tf = (v0 + vLand) / G;
    const t1 = J.hold * ts, t2 = t1 + J.crouch * ts, t3 = t2 + J.push * ts, t4 = t3 + tf;
    const t5 = t4 + (2 * (yLand + dA)) / vLand, t6 = t5 + J.recover * ts, T = t6 + J.settle * ts, tApex = t3 + v0 / G;
    // ankle relative to the root at take-off / touch-down: the flight legs blend between the two
    const rel = (pitch, y) => Object.fromEntries(SIDES.map(side =>
      [side, vSub(ankleFor(rig, side, rig.heads[`${side}Toes`], pitch), [0, y, 0])]));
    const D = 1 / DEG;
    return {
      ts, h, dC, dA, v0, vLand, tf, yTo, yLand, t1, t2, t3, t4, t5, t6, T, tApex,
      relTo: rel(J.takeoffPitch, yTo), relLand: rel(J.landPitch, yLand),
      // pelvis y: hold, smooth crouch, Hermite push ending at the take-off velocity, then the flight parabola
      push: monotone([{ u: t2, v: -dC, m: 0 }, { u: t3, v: yTo, m: v0 }]),
      lean: curve([[0, 0], [t1, 0], [t2, J.lean], [t3, J.toLean], [tApex, J.apexLean], [t4, J.tdLean], [t5, J.landLean], [t6, 2 * DEG], [T, 0]]),
      z: curve([[0, 0], [t1, 0], [t2, -J.hipBack * dC], [t3, 0], [t4, 0], [t5, -J.hipBack * dA], [t6, 0], [T, 0]]),
      swing: curve([[0, 0], [t1, 0], [t2, 50 / D], [t3, -85 / D], [tApex, -78 / D], [t4, -55 / D], [t5, -28 / D], [t6, -4 / D], [T, 0]]),
      bend: curve([[0, 16 / D], [t1, 16 / D], [t2, 22 / D], [t3, 12 / D], [tApex, 35 / D], [t4, 25 / D], [t5, 30 / D], [t6, 18 / D], [T, 16 / D]]),
      out: curve([[0, 0], [t1, 0], [t2, 6 / D], [t3, 20 / D], [tApex, 25 / D], [t4, 20 / D], [t5, 16 / D], [t6, 3 / D], [T, 0]]),
      shrug: curve([[0, 0], [t1, 0], [t2, -2 / D], [t3, 8 / D], [tApex, 5 / D], [t4, 2 / D], [t5, -2 / D], [T, 0]]),
    };
  });
}

/** Pelvis height of the jump at time t (piecewise, C1 except at take-off / touch-down where g takes over). */
function jumpY(P, t) {
  if (t <= P.t1) return 0;
  if (t <= P.t2) return -P.dC * smooth((t - P.t1) / (P.t2 - P.t1));
  if (t <= P.t3) return hermite(P.push, t);
  if (t <= P.t4) { const u = t - P.t3; return P.yTo + P.v0 * u - 0.5 * G * u * u; }
  if (t <= P.t5) { const x = (t - P.t4) / (P.t5 - P.t4); return P.yLand - (P.yLand + P.dA) * (2 * x - x * x); }
  if (t <= P.t6) return -P.dA * (1 - smooth((t - P.t5) / (P.t6 - P.t5)));
  return 0;
}

/** Jump pose at time t (clamped). wob = fall-loop phase (small airborne flailing on top of the apex pose). */
function jumpSample(ctx, t, wob = null) {
  const P = jumpPlan(ctx), J = JUMP, { rig } = ctx, L = ctx.legLength;
  t = clamp(t, 0, P.T);
  const lean = P.lean(t), Dh = rx(0.45 * lean);
  const root = [0, jumpY(P, t), P.z(t)];
  const air = t > P.t3 && t < P.t4;
  const legs = SIDES.map((side, i) => {
    const toes = rig.heads[`${side}Toes`], maxD = maxReach(rig, side, 1);
    if (!air) {
      const auth = t <= P.t3 ? J.takeoffPitch * smooth((t - (P.t3 - J.heelRise * P.ts)) / (J.heelRise * P.ts))
        : J.landPitch * (1 - smooth((t - P.t4) / (J.heelDown * P.ts)));
      const pitch = Math.max(auth, pitchToReach(rig, side, Dh, root, toes, maxD));
      return { side, contact: 1, maxD, tgt: { toes, pitch, toePitch: 0, contact: 1 } };
    }
    const u = (t - P.t3) / P.tf, k = smooth(u), sn = Math.sin(Math.PI * u);
    const a = P.relTo[side], b = P.relLand[side];
    const kick = wob == null ? 0 : (i ? -1 : 1) * 0.04 * L * Math.sin(TAU * wob);
    const ankle = [a[0] + (b[0] - a[0]) * k, root[1] + a[1] + (b[1] - a[1]) * k + J.tuck * L * sn * sn,
      root[2] + a[2] + (b[2] - a[2]) * k + J.tuckFwd * L * sn + kick];
    const pitch = J.takeoffPitch + (J.landPitch - J.takeoffPitch) * k;
    return { side, contact: 0, maxD, tgt: { ankle, pitch, toePitch: 0.4 * pitch * sn, contact: 0 } };
  });
  const { root: r, legJoints } = solveLegs(rig, Dh, root, legs);
  const up = torso(Dh, { pitch: 0.55 * lean, headWorld: rx(0.3 * lean + 2 * DEG) });
  const base = standArm(ctx);
  const arm = i => {
    const f = wob == null ? 0 : Math.sin(TAU * wob + (i ? Math.PI : 0));
    return addArm(base, { swing: P.swing(t) + 8 * DEG * f, out: P.out(t) + 5 * DEG * f, bend: P.bend(t) - 16 * DEG, shrug: P.shrug(t) });
  };
  return { joints: { ...legJoints, ...up, ...bothArms(rig, arm(0), arm(1)) }, root: r };
}

const jumpTiming = ctx => {
  const P = jumpPlan(ctx);
  return { duration: P.T, speed: 0, stride: 0, velocity: [0, 0, 0], height: P.h,
    events: { takeoff: P.t3, apex: P.tApex, touchdown: P.t4, settled: P.t6 } };
};
/** Both feet planted outside the flight (take-off and touch-down instants count as planted). */
const jumpContacts = (P, t) => { t = clamp(t, 0, P.T); const c = t <= P.t3 || t >= P.t4 ? 1 : 0; return { left: c, right: c }; };

// Neutral body, speedScale 1: 2.07 s; pelvis rise 0.24 m above take-off, 0.45 s flight.
const jump = {
  name: 'jump', loop: false, duration: 2.07, next: 'idle',
  timing: jumpTiming,
  contacts: (t, ctx) => jumpContacts(jumpPlan(ctx), t),
  sample: (t, ctx) => jumpSample(ctx, t),
};

/** fall: airborne loop at the jump apex (root.y = apex height, so fall -> land blends without a jump). */
const fall = {
  name: 'fall', loop: true, duration: JUMP.fallPeriod,
  timing: ctx => ({ duration: JUMP.fallPeriod / ctx.speedScale, speed: 0, stride: 0, velocity: [0, 0, 0] }),
  contacts: () => ({ left: 0, right: 0 }),
  sample: (t, ctx) => jumpSample(ctx, jumpPlan(ctx).tApex, phaseOf(t, JUMP.fallPeriod / ctx.speedScale)),
};

/** land: from the apex (fall pose) down, touch-down, absorb, stand up. One-shot, then idle. */
const land = {
  name: 'land', loop: false, duration: 1.06, next: 'idle',
  timing: ctx => { const P = jumpPlan(ctx); return { duration: P.T - P.tApex, speed: 0, stride: 0, velocity: [0, 0, 0],
    events: { touchdown: P.t4 - P.tApex, settled: P.t6 - P.tApex } }; },
  contacts: (t, ctx) => { const P = jumpPlan(ctx); return jumpContacts(P, P.tApex + clamp(t, 0, P.T - P.tApex)); },
  sample: (t, ctx) => { const P = jumpPlan(ctx); return jumpSample(ctx, P.tApex + clamp(t, 0, P.T - P.tApex)); },
};

/** Clip registry: new clips = new entries (names double as i18n keys `clip_<name>`). loop: false = one-shot
 *  (the animator returns to `next`, default idle). */
export const CLIPS = { idle, walk, run, idle_look, idle_breathe, idle_fidget, walk_back, strafe_left, strafe_right, jump, fall, land };
