// SPDX-License-Identifier: GPL-3.0-or-later
// The extra clips (docs/ANIMATION_CLIPS.md): jump / fall / land, strafe_left / strafe_right, walk_back and the
// idle variants: biomechanics in documented human ranges for several bodies, plus breast physics through a jump.
// The generic contract (finite, unit, seamless loops, planted feet, no sliding, no hyperextension) is checked for
// every clip in clips.test.mjs. Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Q from '../web/animation/qmath.js';
import { fkPositions, poseToWorld, mirrorJointName } from '../web/animation/canonical.js';
import { headsFromSidecar, restGeometry } from '../web/animation/rig.js';
import { sliderInfluences } from '../web/character.js';
import { CLIPS, makeContext } from '../web/animation/clips.js';
import { createBreastPhysics, breastMotionScale, BREAST_PHYSICS } from '../web/breastphysics.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sidecar = JSON.parse(fs.readFileSync(root + 'output/base_body.joints.json', 'utf8'));
const BODIES = {
  neutral: {}, tall: { height: 1 }, child: { age: -1 }, childShort: { age: -1, height: -1 },
  old: { age: 1 }, female: { gender: -1 }, heavy: { weight: 1 }, maleTall: { gender: 1, height: 1 },
};
const RIGS = Object.fromEntries(Object.entries(BODIES).map(([k, v]) => [k, restGeometry(headsFromSidecar(sidecar, sliderInfluences(v)))]));
const ctxOf = (body, s = 1) => makeContext(RIGS[body], { speedScale: s, body: BODIES[body] });
const DEGS = r => r / Q.DEG;
const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1, Q.vDot(Q.vNorm(u), Q.vNorm(v)))));
const knee = (X, side) => DEGS(angle(Q.vSub(X[`${side}LowerLeg`], X[`${side}UpperLeg`]), Q.vSub(X[`${side}Foot`], X[`${side}LowerLeg`])));
/** Heel lift: angle of the ankle->ball line above its rest angle (deg, + = heel up / plantarflexed). */
const heel = (X, rig, side) => {
  const a = Q.vSub(X[`${side}Foot`], X[`${side}Toes`]), b = Q.vSub(rig.heads[`${side}Foot`], rig.heads[`${side}Toes`]);
  return DEGS(Math.atan2(a[1], Math.hypot(a[0], a[2])) - Math.atan2(b[1], Math.hypot(b[0], b[2])));
};

// ---- jump ----------------------------------------------------------------------------------------------
test('jump: countermovement timing, knee depth, take-off plantarflexion in measured human ranges (neutral)', () => {
  const ctx = ctxOf('neutral'), rig = RIGS.neutral, tm = CLIPS.jump.timing(ctx), e = tm.events;
  // references (docs/ANIMATION_CLIPS.md): unweighting+braking ~0.4-0.6 s, propulsion ~0.2-0.3 s, flight ~0.4-0.5 s
  assert.ok(e.takeoff >= 0.6 && e.takeoff <= 1.0, `take-off at ${e.takeoff}`);
  const flight = e.touchdown - e.takeoff;
  assert.ok(flight >= 0.35 && flight <= 0.6, `flight ${flight}`);
  assert.ok(e.settled - e.touchdown >= 0.5 && e.settled - e.touchdown <= 1.0, `landing to upright ${e.settled - e.touchdown}`);
  assert.ok(tm.duration >= 1.6 && tm.duration <= 2.6, `total ${tm.duration}`);
  let kMax = 0, pf = -Infinity;
  for (let i = 0; i <= 400; i++) {
    const t = (i * e.takeoff) / 400, X = fkPositions(rig.heads, CLIPS.jump.sample(t, ctx));
    kMax = Math.max(kMax, knee(X, 'left'));
    pf = Math.max(pf, heel(X, rig, 'left'));
  }
  assert.ok(kMax >= 70 && kMax <= 110, `knee at the bottom of the countermovement ${kMax}`);
  assert.ok(pf >= 30 && pf <= 50, `plantarflexion at take-off ${pf}`);
});

test('jump: ballistic flight (root y" = -g), height scales with leg length, feet clear the floor, both feet planted on the ground', () => {
  const rel = {};
  for (const body of Object.keys(BODIES)) for (const s of [0.5, 1, 2]) {
    const ctx = ctxOf(body, s), rig = RIGS[body], tm = CLIPS.jump.timing(ctx), e = tm.events, tag = `jump/${body}/${s}`;
    const y = t => CLIPS.jump.sample(t, ctx).root[1], h = 1e-3;
    for (let i = 1; i < 10; i++) {
      const t = e.takeoff + ((e.touchdown - e.takeoff) * i) / 10;
      const acc = (y(t + h) - 2 * y(t) + y(t - h)) / (h * h);
      assert.ok(Math.abs(acc + 9.81) < 0.05, `${tag} flight acceleration ${acc}`);
      assert.deepEqual(CLIPS.jump.contacts(t, ctx), { left: 0, right: 0 });
    }
    const rise = y(e.apex) - y(e.takeoff);
    assert.ok(Math.abs(rise - tm.height) < 2e-3, `${tag} apex ${rise} vs ${tm.height}`);
    if (s === 1) rel[body] = rise / ctx.legLength;
    const X = fkPositions(rig.heads, CLIPS.jump.sample(e.apex, ctx));
    for (const side of ['left', 'right']) {
      assert.ok(X[`${side}Toes`][1] - rig.heads[`${side}Toes`][1] > 0.15 * ctx.legLength, `${tag} ${side} toes at apex`);
    }
    // root continuous across take-off / touch-down (no snap): |dy| per ms below the take-off speed
    for (const ev of [e.takeoff, e.touchdown]) assert.ok(Math.abs(y(ev + 1e-3) - y(ev - 1e-3)) < 6e-3, `${tag} root at ${ev}`);
    // pelvis back at standing at the end, both feet planted
    const end = CLIPS.jump.sample(tm.duration, ctx);
    assert.ok(Math.abs(end.root[1]) < 0.01 && Math.abs(end.root[2]) < 1e-6, `${tag} end root ${end.root}`);
    assert.deepEqual(CLIPS.jump.contacts(tm.duration, ctx), { left: 1, right: 1 });
  }
  // same relative height for young bodies of any size; older / heavier jump less
  for (const b of ['tall', 'child', 'childShort', 'female', 'maleTall']) assert.ok(Math.abs(rel[b] - rel.neutral) < 1e-6, `${b} ${rel[b]}`);
  assert.ok(rel.old < rel.neutral && rel.heavy < rel.neutral);
  assert.ok(rel.neutral > 0.25 && rel.neutral < 0.35);
});

test('fall loops at the apex, land = the jump from the apex on (fall -> land and land -> idle meet)', () => {
  for (const body of ['neutral', 'childShort', 'tall']) {
    const ctx = ctxOf(body), rig = RIGS.neutral && RIGS[body], jt = CLIPS.jump.timing(ctx), lt = CLIPS.land.timing(ctx);
    assert.ok(Math.abs(lt.duration - (jt.duration - jt.events.apex)) < 1e-9);
    const a = CLIPS.fall.sample(0, ctx), b = CLIPS.land.sample(0, ctx);
    assert.ok(Math.abs(a.root[1] - b.root[1]) < 1e-9, 'fall and land start at the apex height');
    for (const j of Object.keys(b.joints)) assert.ok(Q.qAngle(a.joints[j], b.joints[j]) < 12 * Q.DEG, `${body} fall/land ${j}`);
    const T = CLIPS.fall.timing(ctx).duration;
    for (let i = 0; i < 24; i++) {
      const X = fkPositions(rig.heads, CLIPS.fall.sample((i * T) / 24, ctx));
      assert.ok(X.leftToes[1] - rig.heads.leftToes[1] > 0.1 * ctx.legLength, `${body} fall toes up`);
    }
    const end = CLIPS.land.sample(lt.duration, ctx), idle = CLIPS.idle.sample(0, ctx);
    assert.ok(Math.abs(end.root[1] - idle.root[1]) < 0.01);
    assert.equal(CLIPS.land.next, 'idle');
  }
});

// ---- strafe ---------------------------------------------------------------------------------------------
test('strafe: sideways travel at sidestep speed/cadence, facing forward, right = mirrored left', () => {
  const ctx = ctxOf('neutral'), l = CLIPS.strafe_left.timing(ctx), r = CLIPS.strafe_right.timing(ctx);
  assert.ok(l.velocity[0] > 0 && r.velocity[0] < 0 && l.velocity[2] === 0 && l.speed === 0, 'left = +X');
  assert.ok(Math.abs(l.velocity[0] + r.velocity[0]) < 1e-12);
  // reference: self-paced side-stepping ~0.4-0.6 m/s at ~120-140 steps/min (docs/ANIMATION_CLIPS.md)
  assert.ok(l.velocity[0] >= 0.35 && l.velocity[0] <= 0.65, `strafe speed ${l.velocity[0]}`);
  assert.ok(120 / l.duration >= 115 && 120 / l.duration <= 150, `cadence ${120 / l.duration}`);
  const fast = CLIPS.strafe_left.timing(ctxOf('neutral', 2)), child = CLIPS.strafe_left.timing(ctxOf('childShort'));
  assert.ok(fast.velocity[0] > l.velocity[0] && child.velocity[0] < l.velocity[0]);
  for (const body of ['neutral', 'childShort', 'heavy']) {
    const c = ctxOf(body), rig = RIGS[body], T = CLIPS.strafe_left.timing(c).duration;
    for (let i = 0; i < 24; i++) {
      const t = (i * T) / 24, pl = CLIPS.strafe_left.sample(t, c), A = fkPositions(rig.heads, pl);
      const B = fkPositions(rig.heads, CLIPS.strafe_right.sample(t + T / 2, c));
      for (const j of Object.keys(A)) {
        const b = B[mirrorJointName(j)];
        assert.ok(Q.vLen(Q.vSub(A[j], [-b[0], b[1], b[2]])) < 3e-3, `${body} mirror ${j} @${i}`);
      }
      const fwd = Q.qRotate(poseToWorld(pl.joints).hips, [0, 0, 1]);
      assert.ok(fwd[2] > Math.cos(6 * Q.DEG), `${body} pelvis faces forward @${i}`);
      assert.ok(A.leftToes[0] - A.rightToes[0] >= 0.65 * rig.hipWidth, `${body} feet too close @${i}`);
    }
  }
});

// ---- walk backward --------------------------------------------------------------------------------------
test('walk_back: slower and shorter than forward walking, toe-first contact, arms still swing', () => {
  for (const body of ['neutral', 'tall', 'childShort']) {
    const ctx = ctxOf(body), rig = RIGS[body], b = CLIPS.walk_back.timing(ctx), w = CLIPS.walk.timing(ctx);
    assert.ok(b.speed < 0 && b.velocity[2] === b.speed);
    const ratio = -b.speed / w.speed;
    // reference: preferred backward walking speed ~60-75 % of forward, shorter strides (Thorstensson 1986; Laufer 2005)
    assert.ok(ratio >= 0.55 && ratio <= 0.8, `${body} speed ratio ${ratio}`);
    assert.ok(b.stride < w.stride, `${body} stride`);
    // contact starts on the ball: heel above its rest height at the first planted frame of each stance
    const T = b.duration, n = 240;
    let prev = CLIPS.walk_back.contacts(-T / n, ctx).left, found = 0, swing = [Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const t = (i * T) / n, c = CLIPS.walk_back.contacts(t, ctx).left, X = fkPositions(rig.heads, CLIPS.walk_back.sample(t, ctx));
      if (c && !prev) {
        found++;
        assert.ok(X.leftFoot[1] - rig.heads.leftFoot[1] > 0.01, `${body} toe-first: heel ${X.leftFoot[1] - rig.heads.leftFoot[1]}`);
        assert.ok(Math.abs(X.leftToes[1] - rig.heads.leftToes[1]) < 5e-3);
      }
      const hz = X.leftHand[2] - X.hips[2];
      swing = [Math.min(swing[0], hz), Math.max(swing[1], hz)];
      prev = c;
    }
    assert.equal(found, 1, `${body} one left touch-down per cycle`);
    assert.ok(swing[1] - swing[0] > 0.08 * ctx.legLength, `${body} arm swing ${swing[1] - swing[0]}`);
  }
});

// ---- idle variants ----------------------------------------------------------------------------------------
test('idle variants: feet pinned, pelvis near standing height, head within neck range, visibly different from idle', () => {
  for (const name of ['idle_look', 'idle_breathe', 'idle_fidget']) for (const body of Object.keys(BODIES)) {
    const ctx = ctxOf(body), rig = RIGS[body], T = CLIPS[name].timing(ctx).duration, tag = `${name}/${body}`;
    let head = 0, diff = 0;
    for (let i = 0; i < 120; i++) {
      const t = (i * T) / 120, p = CLIPS[name].sample(t, ctx), X = fkPositions(rig.heads, p);
      assert.deepEqual(CLIPS[name].contacts(t, ctx), { left: 1, right: 1 });
      for (const j of ['leftToes', 'rightToes', 'leftFoot', 'rightFoot']) assert.ok(Q.vLen(Q.vSub(X[j], rig.heads[j])) < 0.005, `${tag} ${j} @${i}`);
      assert.ok(p.root[1] > -0.03 * ctx.legLength && p.root[1] <= 0, `${tag} pelvis ${p.root[1]}`);
      assert.ok(Math.abs(p.root[0]) < 0.05 * ctx.legLength, `${tag} weight shift ${p.root[0]}`);
      head = Math.max(head, DEGS(Q.qAngle(poseToWorld(p.joints).head, [0, 0, 0, 1])));
      assert.ok(X.leftHand[1] < X.head[1] && X.rightHand[1] < X.head[1], `${tag} hands below the head`);
      const I = fkPositions(rig.heads, CLIPS.idle.sample(t, ctx));
      diff = Math.max(diff, Q.vLen(Q.vSub(X.head, I.head)), Q.vLen(Q.vSub(X.leftHand, I.leftHand)));
    }
    assert.ok(head <= 45, `${tag} head turn ${head}`);
    assert.ok(diff > 0.02, `${tag} barely differs from idle (${diff})`);
  }
  // idle_fidget raises the left forearm in front of the body (wrist check), clear of the torso
  const ctx = ctxOf('neutral'), rig = RIGS.neutral, X = fkPositions(rig.heads, CLIPS.idle_fidget.sample(5.3, ctx));
  assert.ok(X.leftHand[1] > X.leftLowerArm[1] && X.leftHand[2] - X.upperChest[2] > 0.15, 'wrist raised in front');
});

// ---- breast physics through a jump -------------------------------------------------------------------------
test('breast physics: jump / land drive stays finite and bounded at 30, 60 and 144 fps', () => {
  const scale = breastMotionScale({ gate: 1, size: 1, firmness: -1 });
  for (const body of ['female', 'neutral', 'heavy']) for (const fps of [30, 60, 144]) {
    const ctx = ctxOf(body), rig = RIGS[body], ph = createBreastPhysics(), dt = 1 / fps;
    const seq = [['idle', 0.5], ['jump', CLIPS.jump.timing(ctx).duration], ['jump', CLIPS.jump.timing(ctx).duration], ['fall', 1], ['land', CLIPS.land.timing(ctx).duration]];
    let xMax = 0, wMax = 0;
    for (const [name, T] of seq) for (let t = 0; t < T; t += dt) {
      const p = CLIPS[name].sample(t, ctx), X = fkPositions(rig.heads, p);
      const w = ph.step(dt, X.upperChest, poseToWorld(p.joints).upperChest, scale, 0);
      for (const v of Object.values(w)) { assert.ok(Number.isFinite(v) && v >= 0, `${body}/${fps} weight ${v}`); wMax = Math.max(wMax, v); }
      xMax = Math.max(xMax, ...ph.state().x.map(Math.abs));
    }
    assert.ok(xMax <= BREAST_PHYSICS.maxDisplacement + 1e-9, `${body}/${fps} travel ${xMax}`);
    assert.ok(wMax <= BREAST_PHYSICS.maxWeight + 1e-9 && wMax > 0.05, `${body}/${fps} weight ${wMax}`);
  }
});
