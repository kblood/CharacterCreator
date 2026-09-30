// Procedural clips (web/animation/clips.js) against docs/ANIMATION_PLAN.md section 4B, for extreme
// slider bodies built from the joints sidecar. Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Q from '../web/animation/qmath.js';
import { fkPositions, poseToWorld, mirrorJointName } from '../web/animation/canonical.js';
import { headsFromSidecar, restGeometry } from '../web/animation/rig.js';
import { sliderInfluences } from '../web/character.js';
import { CLIPS, makeContext } from '../web/animation/clips.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sidecar = JSON.parse(fs.readFileSync(root + 'output/base_body.joints.json', 'utf8'));

const BODIES = {
  neutral: {}, tall: { height: 1 }, short: { height: -1 }, child: { age: -1 }, childShort: { age: -1, height: -1 },
  old: { age: 1 }, maleTall: { gender: 1, height: 1 }, heavy: { weight: 1 },
};
const SPEEDS = [0.5, 1, 2];
const N = 120;
const rigOf = values => restGeometry(headsFromSidecar(sidecar, sliderInfluences(values)));
const RIGS = Object.fromEntries(Object.entries(BODIES).map(([k, v]) => [k, rigOf(v)]));
const cases = function* (clipNames = Object.keys(CLIPS)) {
  for (const name of clipNames) for (const [body, values] of Object.entries(BODIES)) for (const s of SPEEDS) {
    yield { name, clip: CLIPS[name], body, rig: RIGS[body], ctx: makeContext(RIGS[body], { speedScale: s, body: values }), s };
  }
};
const angleBetween = (u, v) => Math.acos(Math.max(-1, Math.min(1, Q.vDot(Q.vNorm(u), Q.vNorm(v)))));

test('registry: idle, walk, run with the clip contract', () => {
  assert.deepEqual(Object.keys(CLIPS), ['idle', 'walk', 'run']);
  const ctx = makeContext(RIGS.neutral);
  for (const [name, c] of Object.entries(CLIPS)) {
    assert.equal(c.name, name);
    assert.equal(c.loop, true);
    assert.ok(c.duration > 0);
    const tm = c.timing(ctx);
    assert.ok(tm.duration > 0 && tm.speed >= 0 && tm.stride >= 0, name);
    assert.ok(Math.abs(tm.duration - c.duration) / c.duration < 0.02, `${name} metadata duration`);
    const p = c.sample(0, ctx);
    assert.ok(p.joints && p.root && p.root.length === 3);
    assert.ok(Object.keys(p.joints).length >= 22, name);
  }
  assert.equal(makeContext(RIGS.neutral, { speedScale: 9 }).speedScale, 2);
  assert.equal(makeContext(RIGS.neutral, { speedScale: 0.01 }).speedScale, 0.25);
});

test('quats finite and unit; seamless loop sample(0) == sample(duration); deterministic', () => {
  for (const { name, clip, body, ctx, s } of cases()) {
    const T = clip.timing(ctx).duration, tag = `${name}/${body}/${s}`;
    for (let i = 0; i <= N; i++) {
      const p = clip.sample((i * T) / N, ctx);
      for (const [j, q] of Object.entries(p.joints)) {
        assert.ok(q.every(Number.isFinite), `${tag} ${j} finite`);
        assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6, `${tag} ${j} unit`);
      }
      assert.ok(p.root.every(Number.isFinite), tag);
    }
    const a = clip.sample(0, ctx), b = clip.sample(T, ctx), c = clip.sample(0, ctx);
    for (const j of Object.keys(a.joints)) {
      assert.ok(Q.qAngle(a.joints[j], b.joints[j]) < 1e-4, `${tag} loop ${j}`);
      assert.deepEqual(a.joints[j], c.joints[j]);
    }
    assert.ok(Q.vLen(Q.vSub(a.root, b.root)) < 1e-6, `${tag} loop root`);
    // continuity just across the seam (no pop): tiny step on both sides of t = 0
    const e = T / 2000, pm = clip.sample(T - e, ctx), pp = clip.sample(e, ctx);
    for (const j of Object.keys(a.joints)) assert.ok(Q.qAngle(pm.joints[j], pp.joints[j]) < 0.02, `${tag} seam ${j}`);
  }
});

test('feet: no penetration, no float/slide while planted, knees sane, feet do not cross', () => {
  for (const { name, clip, body, rig, ctx, s } of cases()) {
    const { duration: T, speed } = clip.timing(ctx), tag = `${name}/${body}/${s}`;
    const runs = { left: [], right: [] }, cur = { left: null, right: null };
    for (let i = 0; i < 2 * N; i++) {                     // two cycles so stance runs that wrap are whole
      const t = (i * T) / N, p = clip.sample(t, ctx), P = fkPositions(rig.heads, p), c = clip.contacts(t, ctx);
      for (const side of ['left', 'right']) {
        const toes = P[`${side}Toes`], foot = P[`${side}Foot`], hip = P[`${side}UpperLeg`], knee = P[`${side}LowerLeg`];
        const restToes = rig.heads[`${side}Toes`][1], restFoot = rig.heads[`${side}Foot`][1];
        assert.ok(toes[1] >= restToes - 0.005, `${tag} ${side} toes below floor ${toes[1]} @${i}`);
        assert.ok(foot[1] >= restFoot - 0.01, `${tag} ${side} ankle below floor @${i}`);
        const flex = angleBetween(Q.vSub(knee, hip), Q.vSub(foot, knee));
        assert.ok(flex >= rig.restBend[`${side}LowerLeg`] - 1 * Q.DEG, `${tag} ${side} knee hyperextended ${flex / Q.DEG} @${i}`);
        const line = Q.vNorm(Q.vSub(foot, hip)), kv = Q.vSub(knee, hip);
        const perp = Q.vSub(kv, Q.vScale(line, Q.vDot(kv, line)));
        assert.ok(perp[2] > -1e-3, `${tag} ${side} knee behind the leg line @${i}`);
        if (c[side]) {
          assert.ok(toes[1] <= restToes + 0.005, `${tag} ${side} planted toes float ${toes[1] - restToes} @${i}`);
          (cur[side] ||= []).push(toes[2] + speed * t);
        } else if (cur[side]) { runs[side].push(cur[side]); cur[side] = null; }
      }
      assert.ok(P.leftToes[0] - P.rightToes[0] >= 0.5 * rig.hipWidth, `${tag} feet cross @${i}`);
    }
    for (const side of ['left', 'right']) {
      if (cur[side]) runs[side].push(cur[side]);
      assert.ok(runs[side].length > 0, `${tag} ${side} never planted`);
      for (const r of runs[side]) assert.ok(Math.max(...r) - Math.min(...r) < 0.01, `${tag} ${side} foot slides ${Math.max(...r) - Math.min(...r)}`);
    }
  }
});

test('idle: feet stay at rest the whole loop, both planted', () => {
  for (const { clip, body, rig, ctx, s } of cases(['idle'])) {
    const T = clip.timing(ctx).duration;
    for (let i = 0; i < N; i++) {
      const t = (i * T) / N, P = fkPositions(rig.heads, clip.sample(t, ctx));
      assert.deepEqual(clip.contacts(t, ctx), { left: 1, right: 1 });
      for (const j of ['leftToes', 'rightToes', 'leftFoot', 'rightFoot']) {
        assert.ok(Q.vLen(Q.vSub(P[j], rig.heads[j])) < 0.005, `idle/${body}/${s} ${j} @${i}`);
      }
    }
  }
});

test('neutral tempo: walk/run speed and cadence in human ranges; body adapts', () => {
  const ctx = makeContext(RIGS.neutral);
  const w = CLIPS.walk.timing(ctx), r = CLIPS.run.timing(ctx);
  assert.ok(w.speed >= 1.1 && w.speed <= 1.6, `walk speed ${w.speed}`);
  assert.ok(r.speed >= 2.4 && r.speed <= 3.6, `run speed ${r.speed}`);
  assert.ok(120 / w.duration >= 90 && 120 / w.duration <= 130, `walk cadence ${120 / w.duration}`);
  assert.ok(120 / r.duration >= 150 && 120 / r.duration <= 190, `run cadence ${120 / r.duration}`);
  assert.equal(CLIPS.idle.timing(ctx).speed, 0);
  assert.ok(Math.abs(w.speed * w.duration - w.stride) < 1e-9);
  // longer legs -> longer stride and faster; faster speedScale -> faster and longer stride
  const tall = CLIPS.walk.timing(makeContext(RIGS.tall)), child = CLIPS.walk.timing(makeContext(RIGS.childShort));
  assert.ok(tall.stride > w.stride && child.stride < w.stride && tall.speed > w.speed && child.speed < w.speed);
  const fast = CLIPS.walk.timing(makeContext(RIGS.neutral, { speedScale: 2 }));
  assert.ok(fast.speed > w.speed && fast.stride > w.stride && fast.duration < w.duration);
});

test('gait looks like a gait: arms oppose legs, spine counter-rotates, run is airborne', () => {
  const ctx = makeContext(RIGS.neutral), rig = RIGS.neutral;
  const P = fkPositions(rig.heads, CLIPS.walk.sample(0, ctx));   // left foot strike: left leg forward
  assert.ok(P.leftToes[2] > P.rightToes[2]);
  assert.ok(P.rightHand[2] > P.leftHand[2], 'right arm forward when left leg forward');
  // run has a flight phase (both feet off), walk has double support
  const both = (clip, want) => {
    const T = clip.timing(ctx).duration;
    for (let i = 0; i < N; i++) { const c = clip.contacts((i * T) / N, ctx); if (c.left + c.right === want) return true; }
    return false;
  };
  assert.ok(both(CLIPS.run, 0) && both(CLIPS.walk, 2) && !both(CLIPS.walk, 0));
  // pelvis turns the left hip forward at left strike, the upper chest turns the other way
  const W = poseToWorld(CLIPS.walk.sample(0, ctx).joints);
  assert.ok(Q.qRotate(W.hips, [1, 0, 0])[2] > 0.02 && Q.qRotate(W.upperChest, [1, 0, 0])[2] < -0.01);
});

test('locomotion is left/right symmetric: pose at t + T/2 is the mirror of pose at t', () => {
  for (const { name, clip, body, rig, ctx, s } of cases(['walk', 'run'])) {
    const T = clip.timing(ctx).duration;
    for (let i = 0; i < 12; i++) {
      const t = (i * T) / 12, A = fkPositions(rig.heads, clip.sample(t, ctx)), B = fkPositions(rig.heads, clip.sample(t + T / 2, ctx));
      for (const j of Object.keys(A)) {
        const m = mirrorJointName(j), b = B[m];
        assert.ok(Q.vLen(Q.vSub(A[j], [-b[0], b[1], b[2]])) < 3e-3, `${name}/${body}/${s} ${j} @${i}`);
      }
    }
  }
});

// ---- run biomechanics (docs/RUN_ANIMATION.md): flight, planting, joint ranges, speed scaling ----
const RUN_BODIES = { ...BODIES, muscle: { muscle: 1 } };
const runCases = function* (speeds = [1, 2]) {
  for (const [body, values] of Object.entries(RUN_BODIES)) for (const s of speeds) {
    const rig = RIGS[body] || rigOf(values);
    yield { body, rig, s, ctx: makeContext(rig, { speedScale: s, body: values }) };
  }
};
const DEGS = r => r / Q.DEG;
/** Per-frame run measurements for one body/speed (left leg; the right is the mirrored half cycle). */
function runFrames(rig, ctx, n = 240) {
  const clip = CLIPS.run, tm = clip.timing(ctx), out = [];
  for (let i = 0; i < n; i++) {
    const t = (i * tm.duration) / n, p = clip.sample(t, ctx), X = fkPositions(rig.heads, p), c = clip.contacts(t, ctx);
    const air = side => Math.min(X[`${side}Toes`][1] - rig.heads[`${side}Toes`][1], X[`${side}Foot`][1] - rig.heads[`${side}Foot`][1]);
    const th = Q.vSub(X.leftLowerLeg, X.leftUpperLeg), tr = Q.vSub(X.neck, X.hips), tr0 = Q.vSub(rig.heads.neck, rig.heads.hips);
    out.push({
      t, c, root: p.root, X, airL: air('left'), airR: air('right'),
      knee: DEGS(angleBetween(th, Q.vSub(X.leftFoot, X.leftLowerLeg))),
      hipFlex: DEGS(Math.atan2(th[2], -th[1])),                              // + thigh forward of vertical
      lean: DEGS(Math.atan2(tr[2], tr[1]) - Math.atan2(tr0[2], tr0[1])),
      elbow: DEGS(angleBetween(Q.vSub(X.leftLowerArm, X.leftUpperArm), Q.vSub(X.leftHand, X.leftLowerArm))),
    });
  }
  return { tm, out };
}

test('run: real flight phase, both feet clearly off the floor mid-flight', () => {
  for (const { body, rig, ctx, s } of runCases()) {
    const { tm, out } = runFrames(rig, ctx), tag = `run/${body}/${s}`;
    const flight = out.filter(f => !f.c.left && !f.c.right).length / out.length;
    assert.ok(flight >= 0.2 && flight <= 0.65, `${tag} flight share ${flight}`);
    // mid-flight after left toe-off: phase beta + (0.5 - beta) / 2
    const mid = CLIPS.run.sample((tm.beta + (0.5 - tm.beta) / 2) * tm.duration, ctx), X = fkPositions(rig.heads, mid);
    for (const side of ['left', 'right']) {
      assert.ok(X[`${side}Toes`][1] - rig.heads[`${side}Toes`][1] > 0.02 * ctx.legLength, `${tag} ${side} toes low mid-flight`);
      assert.ok(X[`${side}Foot`][1] - rig.heads[`${side}Foot`][1] > 0.02 * ctx.legLength, `${tag} ${side} ankle low mid-flight`);
    }
    const airborne = out.filter(f => f.airL > 0.005 && f.airR > 0.005).length / out.length;
    assert.ok(airborne >= (s > 1 ? 0.35 : 0.15), `${tag} visibly airborne share ${airborne}`);
  }
});

test('run: stance foot exactly planted, no floor penetration, at 1x and 2x for every body', () => {
  for (const { body, rig, ctx, s } of runCases()) {
    const { tm, out } = runFrames(rig, ctx), tag = `run/${body}/${s}`;
    let minAir = Infinity;
    const runs = [];
    let cur = null;
    for (const f of [...out, ...out.map(g => ({ ...g, t: g.t + tm.duration }))]) {
      minAir = Math.min(minAir, f.airL, f.airR);
      if (f.c.left) {
        assert.ok(Math.abs(f.X.leftToes[1] - rig.heads.leftToes[1]) < 5e-4, `${tag} planted ball height`);
        (cur ||= []).push(f.X.leftToes[2] + tm.speed * f.t);
      } else if (cur) { runs.push(cur); cur = null; }
    }
    assert.ok(minAir > -1e-3, `${tag} foot below floor ${minAir}`);
    for (const r of runs) assert.ok(Math.max(...r) - Math.min(...r) < 1e-3, `${tag} stance slide ${Math.max(...r) - Math.min(...r)}`);
  }
});

test('run: joint angles in human running ranges, not "sitting"', () => {
  for (const { body, rig, ctx, s } of runCases()) {
    const { tm, out } = runFrames(rig, ctx), tag = `run/${body}/${s}`;
    const st = out.filter(f => f.c.left), sw = out.filter(f => !f.c.left);
    const max = (a, k) => Math.max(...a.map(f => f[k])), min = (a, k) => Math.min(...a.map(f => f[k]));
    assert.ok(st[0].knee <= 35, `${tag} knee at strike ${st[0].knee}`);
    assert.ok(max(st, 'knee') <= 56, `${tag} stance knee flexion ${max(st, 'knee')}`);
    assert.ok(max(st, 'knee') >= 25, `${tag} stance knee too stiff ${max(st, 'knee')}`);
    assert.ok(max(sw, 'knee') >= 95 && max(sw, 'knee') <= 150, `${tag} swing knee ${max(sw, 'knee')} (heel recovery)`);
    assert.ok(min(out, 'hipFlex') <= -12 && min(out, 'hipFlex') >= -35, `${tag} hip extension at toe-off ${min(out, 'hipFlex')}`);
    assert.ok(max(out, 'hipFlex') >= 40 && max(out, 'hipFlex') <= 90, `${tag} hip flexion ${max(out, 'hipFlex')}`);
    assert.ok(min(out, 'lean') >= 3 && max(out, 'lean') <= 17, `${tag} trunk lean ${min(out, 'lean')}..${max(out, 'lean')}`);
    assert.ok(min(out, 'elbow') >= 60 && max(out, 'elbow') <= 120, `${tag} elbow ${min(out, 'elbow')}..${max(out, 'elbow')}`);
    // pelvis: lowest around mid-stance, highest in flight, and never low like a crouch
    const ys = out.map(f => f.root[1]), iMin = ys.indexOf(Math.min(...ys));
    const ph = (iMin / out.length) % 0.5;
    assert.ok(Math.abs(ph - tm.beta / 2) < 0.06, `${tag} pelvis low point at phase ${ph} (mid-stance ${tm.beta / 2})`);
    assert.ok(Math.max(...ys) > -0.08 * ctx.legLength, `${tag} pelvis never rises ${Math.max(...ys)}`);
    assert.ok(Math.min(...ys) > -0.13 * ctx.legLength, `${tag} pelvis crouch ${Math.min(...ys)}`);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 0.03 * ctx.legLength, `${tag} no vertical bob`);
  }
});

test('run: cadence and stride grow with speed; tempo scales with the body', () => {
  const t = s => CLIPS.run.timing(makeContext(RIGS.neutral, { speedScale: s }));
  const cad = tm => 120 / tm.duration;
  const [a, b, c] = [0.5, 1, 2].map(t);
  assert.ok(cad(a) < cad(b) && cad(b) < cad(c), 'cadence rises with speed');
  assert.ok(a.stride < b.stride && b.stride < c.stride, 'stride rises with speed');
  assert.ok(a.beta > b.beta && b.beta > c.beta, 'contact share falls with speed');
  assert.ok(cad(c) >= 185 && cad(c) <= 215, `fast cadence ${cad(c)}`);
  assert.ok(c.stride / b.stride > 1.4, 'most of the speed gain comes from stride');
  const child = CLIPS.run.timing(makeContext(RIGS.childShort)), tall = CLIPS.run.timing(makeContext(RIGS.tall));
  assert.ok(cad(child) > cad(b) && cad(tall) < cad(b) && child.stride < b.stride && tall.stride > b.stride);
});

test('no crouching: pelvis never drops more than 15% of the leg length (any body, speed <= 2)', () => {
  for (const { name, clip, body, ctx, s } of cases()) {
    const T = clip.timing(ctx).duration;
    for (let i = 0; i < N; i++) {
      const y = clip.sample((i * T) / N, ctx).root[1];
      assert.ok(y > -0.15 * ctx.legLength, `${name}/${body}/${s} pelvis ${y}`);
    }
  }
});
