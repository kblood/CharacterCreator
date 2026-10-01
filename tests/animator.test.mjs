// Animator (web/animation/animator.js) on a fake three.js-like bone tree built from output/base_body.glb.
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Q from '../web/animation/qmath.js';
import { createHumanoid, restHeads } from '../web/humanoid.js';
import { createAnimator } from '../web/animation/animator.js';
import { fkPositions } from '../web/animation/canonical.js';
import { CLIPS } from '../web/animation/clips.js';
import { headsFromSidecar } from '../web/animation/rig.js';
import { sliderInfluences } from '../web/character.js';

const dir = fileURLToPath(new URL('..', import.meta.url));
const buf = fs.readFileSync(dir + 'output/base_body.glb');
const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
const sidecar = JSON.parse(fs.readFileSync(dir + 'output/base_body.joints.json', 'utf8'));

// ---- fake three.js objects (only what humanoid.js / animator.js touch) ----
const vec = ([x, y, z] = [0, 0, 0]) => ({ x, y, z });
const quat = ([x, y, z, w] = [0, 0, 0, 1]) => ({ x, y, z, w, set(a, b, c, d) { this.x = a; this.y = b; this.z = c; this.w = d; return this; } });
function makeScene() {
  const objs = gltf.nodes.map(n => ({ name: n.name, children: [], parent: null, position: vec(n.translation), quaternion: quat(n.rotation) }));
  gltf.nodes.forEach((n, i) => (n.children || []).forEach(c => { objs[c].parent = objs[i]; objs[i].children.push(objs[c]); }));
  const root = { name: 'scene', children: [], parent: null, position: vec(), quaternion: quat() };
  for (const i of gltf.scenes[0].nodes) { objs[i].parent = root; root.children.push(objs[i]); }
  const skin = gltf.skins[0], bones = skin.joints.map(i => objs[i]);
  return { root, objs, mesh: { skeleton: { bones } } };
}
const posArr = o => [o.position.x, o.position.y, o.position.z];
const qArr = o => [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w];
/** Root-space world position of an object with its CURRENT local rotations/positions, plus root offset. */
function worldPos(o) {
  const chain = [];
  for (let x = o; x && x.parent; x = x.parent) chain.unshift(x);
  let p = posArr(chain[0].parent), w = qArr(chain[0].parent);
  for (const c of chain) { p = Q.vAdd(p, Q.qRotate(w, posArr(c))); w = Q.qMul(w, qArr(c)); }
  return p;
}
/** Emulates applySkeleton: move bone positions so rest heads equal headsFromSidecar(values). */
function setBody(h, values) {
  const heads = headsFromSidecar(sidecar, sliderInfluences(values));
  const cur = restHeads(h);
  for (const [j, b] of Object.entries(h.bones)) {
    const d = Q.vSub(heads[j], cur[j]);                        // root-space move of this head
    const pj = Object.entries(h.bones).find(([, x]) => x === b.parent)?.[0];
    const dp = pj ? Q.vSub(heads[pj], cur[pj]) : [0, 0, 0];
    const parentW = h.restWorld[j] && Q.qMul(h.restWorld[j], Q.qConj(h.restLocal[j]));
    const local = Q.qRotate(Q.qConj(parentW), Q.vSub(d, dp));
    b.position.x += local[0]; b.position.y += local[1]; b.position.z += local[2];
  }
}

// Deterministic fake clips (the real ones are tested in clips.test.mjs); they only need the Clip shape.
const fakeClip = (name, speed, T, amp) => ({
  name, loop: true, duration: T,
  timing: ctx => ({ duration: T / ctx.speedScale, speed: speed * ctx.speedScale, stride: speed * T }),
  sample: (t, ctx) => {
    const ph = 2 * Math.PI * t / (T / ctx.speedScale);
    return { joints: { leftUpperLeg: Q.qAxisAngle([1, 0, 0], amp * Math.sin(ph)), spine: Q.qAxisAngle([0, 1, 0], 0.1 * Math.cos(ph)) },
      root: [0.01 * Math.sin(ph), -0.02 * (1 + Math.cos(2 * ph)) / 2, 0] };
  },
  contacts: () => ({ left: 1, right: 1 }),
});
const FAKE = { idle: fakeClip('idle', 0, 4, 0.05), walk: fakeClip('walk', 1.3, 1, 0.4), run: fakeClip('run', 2.9, 0.7, 0.8) };

function setup(clips = FAKE, values = {}) {
  const s = makeScene();
  const h = createHumanoid(s.mesh, { root: s.root });
  if (Object.keys(values).length) setBody(h, values);
  const rest = new Map(s.objs.map(o => [o, { q: qArr(o), p: posArr(o) }]));
  const a = createAnimator(h, { clips, getBody: () => values });
  return { ...s, h, a, rest };
}

test('fake humanoid resolves all canonical joints', () => {
  const { h } = setup();
  assert.equal(h.missing.length, 0);
});

test('crossfade weights are monotonic and sum to 1', () => {
  const { a } = setup();
  a.play('walk', { fade: 0.3 });
  const hist = [];
  for (let i = 0; i < 30; i++) { a.update(1 / 60); hist.push(a.weights()); }
  a.play('run', { fade: 0.3 });
  for (let i = 0; i < 30; i++) { a.update(1 / 60); hist.push(a.weights()); }
  const w = (ws, c) => ws.find(x => x.clip === c)?.weight ?? 0;
  for (let i = 1; i < 30; i++) {
    assert.ok(w(hist[i], 'walk') >= w(hist[i - 1], 'walk') - 1e-12);
    assert.ok(w(hist[i], null) <= w(hist[i - 1], null) + 1e-12);
  }
  for (let i = 31; i < 60; i++) {
    assert.ok(w(hist[i], 'run') >= w(hist[i - 1], 'run') - 1e-12);
    assert.ok(w(hist[i], 'walk') <= w(hist[i - 1], 'walk') + 1e-12);
  }
  for (const ws of hist) assert.ok(Math.abs(ws.reduce((s, x) => s + x.weight, 0) - 1) < 1e-9);
  assert.deepEqual(a.weights(), [{ clip: 'run', weight: 1, target: 1 }]);
  assert.equal(a.state().fading, false);
});

test('stop fades to the exact rest pose and root placement; positions never touched', () => {
  const { a, objs, root, rest } = setup();
  a.play('walk');
  for (let i = 0; i < 40; i++) a.update(1 / 60);
  assert.ok(objs.some(o => Q.qAngle(qArr(o), rest.get(o).q) > 1e-3), 'walk moved something');
  a.stop({ fade: 0.2 });
  for (let i = 0; i < 20; i++) a.update(1 / 60);
  assert.equal(a.state().clip, null);
  for (const o of objs) {
    assert.deepEqual(qArr(o), rest.get(o).q, o.name);
    assert.deepEqual(posArr(o), rest.get(o).p, o.name);
  }
  assert.deepEqual(posArr(root), [0, 0, 0]);
});

test('pause freezes time and pose; resume continues', () => {
  const { a, h } = setup();
  a.play('walk', { fade: 0 });
  a.update(0.05);
  a.pause();
  const t0 = a.state().time, q0 = qArr(h.bones.leftUpperLeg);
  for (let i = 0; i < 10; i++) a.update(0.05);
  assert.equal(a.state().time, t0);
  assert.equal(a.state().paused, true);
  assert.deepEqual(qArr(h.bones.leftUpperLeg), q0);
  a.resume(); a.update(0.05);
  assert.ok(Math.abs(a.state().time - t0 - 0.05) < 1e-9);
});

test('walk -> run is phase matched (new time = old phase * new duration)', () => {
  const { a } = setup();
  a.play('walk', { fade: 0 });
  a.seek(0.3);
  const ph = a.state().phase;
  assert.ok(Math.abs(ph - 0.3) < 1e-9);
  a.play('run', { fade: 0.3 });
  const s = a.state();
  assert.equal(s.clip, 'run');
  assert.ok(Math.abs(s.phase - ph) < 1e-9);
  assert.ok(Math.abs(s.time - ph * s.duration) < 1e-9);
  // during the fade both clips keep one shared phase
  let prev = s.phase;
  for (let i = 0; i < 10; i++) { a.update(1 / 60); const p = a.state().phase; assert.ok(p > prev); prev = p; }
});

test('idle does not phase match (starts at 0); setSpeed clamps and scales timing', () => {
  const { a } = setup();
  a.play('walk', { fade: 0 }); a.seek(0.4);
  a.play('idle', { fade: 0 });
  assert.equal(a.state().time, 0);
  a.setSpeed(5); assert.equal(a.state().speedScale, 2);
  a.setSpeed(0.1); assert.equal(a.state().speedScale, 0.25);
  a.setSpeed(1); a.play('walk', { fade: 0 });
  assert.ok(Math.abs(a.state().rootSpeed - 1.3) < 1e-9);
});

test('pose.root goes on the root object, bones get rotations only', () => {
  const { a, root, objs, rest } = setup();
  a.play('walk', { fade: 0 }); a.seek(0.25); a.update(0);
  const r = a.lastPose().root;
  assert.ok(r[0] > 0.009);                         // lateral sway reaches the root object
  assert.ok(r[1] >= -1e-9);                        // pelvis drop with straight legs: ground guard lifted it
  assert.ok(Q.vLen(Q.vSub(posArr(root), r)) < 1e-12);
  for (const o of objs) assert.deepEqual(posArr(o), rest.get(o).p, o.name);
});

test('bodyChanged re-measures the skeleton written by applySkeleton', () => {
  const { a, h } = setup();
  const l0 = a.rig.legLength;
  setBody(h, { height: 1 });
  a.bodyChanged();
  assert.ok(a.rig.legLength > l0 + 0.05, `${a.rig.legLength} vs ${l0}`);
  const ref = headsFromSidecar(sidecar, sliderInfluences({ height: 1 }));
  assert.ok(Q.vLen(Q.vSub(a.rig.heads.leftFoot, ref.leftFoot)) < 1e-3);
});

// ---- real clips, end to end through bones: feet stay on the floor through play/crossfade ----
const BODIES = { neutral: {}, tall: { height: 1 }, childShort: { age: -1, height: -1 }, heavy: { weight: 1 } };
for (const [bname, values] of Object.entries(BODIES)) {
  test(`real clips on ${bname}: toes/feet never below the floor, even mid-crossfade`, () => {
    const { a, h, rest } = setup(CLIPS, values);
    const heads = restHeads(h);
    const floorOf = j => heads[j][1];
    let worst = Infinity;
    const check = () => {
      for (const j of ['leftToes', 'rightToes', 'leftFoot', 'rightFoot']) {
        const y = worldPos(h.bones[j]);
        worst = Math.min(worst, y[1] - floorOf(j));
      }
    };
    const run = (n, dt = 1 / 30) => { for (let i = 0; i < n; i++) { a.update(dt); check(); } };
    a.play('idle'); run(30);
    a.play('walk'); run(60);
    a.setSpeed(1.6); run(20);
    a.play('run'); run(60);
    a.play('walk', { fade: 0.5 }); run(40);
    a.stop(); run(20);
    assert.ok(worst >= -0.01, `lowest foot joint ${worst.toFixed(4)} m below its rest height`);
    for (const [o, r] of rest) assert.deepEqual(posArr(o), r.p, 'bone positions untouched');
  });
}

// ---- one-shots (jump), once-played loops (idle variation), velocity ----
const oneShot = (name, T, next) => ({ ...fakeClip(name, 0, T, 0.3), loop: false, next,
  timing: ctx => ({ duration: T / ctx.speedScale, speed: 0, stride: 0, velocity: [0, 0, 0] }) });
const FAKE2 = { ...FAKE, hop: oneShot('hop', 1, 'idle'), look: fakeClip('look', 0, 2, 0.1),
  side: { ...fakeClip('side', 0, 1, 0.3), timing: ctx => ({ duration: 1 / ctx.speedScale, speed: 0, stride: 0.5, velocity: [0.5 * ctx.speedScale, 0, 0] }) } };

test('one-shot: plays once from 0, holds, then fades back to idle by itself; no double trigger', () => {
  const { a } = setup(FAKE2);
  a.play('idle', { fade: 0 }); a.update(0.5);
  a.play('hop', { fade: 0.1 });
  assert.equal(a.state().clip, 'hop'); assert.equal(a.state().time, 0); assert.equal(a.state().oneShot, true);
  assert.equal(a.state().next, 'idle');
  for (let i = 0; i < 18; i++) a.update(1 / 60);
  const t = a.state().time;
  a.play('hop'); assert.ok(Math.abs(a.state().time - t) < 1e-12, 'retrigger mid-jump ignored');
  let back = null;
  for (let i = 0; i < 120 && back == null; i++) { a.update(1 / 60); if (a.state().clip === 'idle') back = i; }
  assert.ok(back != null, 'returned to idle');
  // the hand-over starts fadeOut (0.25 * 1 s) before the end
  assert.ok(Math.abs(0.3 + (back + 1) / 60 - 0.75) < 2 / 60, `hand-over at ${0.3 + (back + 1) / 60}`);
  for (let i = 0; i < 30; i++) a.update(1 / 60);
  assert.deepEqual(a.weights(), [{ clip: 'idle', weight: 1, target: 1 }]);
  // seek clamps a one-shot instead of wrapping
  a.play('hop', { fade: 0 }); a.pause(); a.seek(-1); assert.equal(a.state().phase, 0); a.seek(5); assert.equal(a.state().phase, 1);
  // after it ends, a new play starts it again from 0
  a.resume(); a.play('hop', { fade: 0, then: 'walk', fadeOut: 0 });
  for (let i = 0; i < 70; i++) a.update(1 / 60);
  assert.equal(a.state().clip, 'walk');
});

test('once: a looping clip played once returns to idle after one cycle; rootVelocity reports sideways travel', () => {
  const { a } = setup(FAKE2);
  a.play('idle', { fade: 0 });
  a.play('look', { fade: 0.2, once: true });
  for (let i = 0; i < 100; i++) a.update(1 / 60);
  assert.equal(a.state().clip, 'look');
  for (let i = 0; i < 40; i++) a.update(1 / 60);
  assert.equal(a.state().clip, 'idle');
  a.play('side', { fade: 0 });
  assert.deepEqual(a.state().rootVelocity, [0.5, 0, 0]);
  assert.equal(a.state().rootSpeed, 0);
  // side has velocity -> locomotion; walk travels another way, so it joins at the phase whose feet match best
  // (not the shared phase), and the fade still advances one shared clock
  a.seek(0.25); a.play('walk', { fade: 0.3 });
  const p0 = a.state().phase; a.update(1 / 60);
  assert.ok(Math.abs(a.state().phase - p0 - (1 / 60) / 1) < 0.02);
});

test('idle variation: deterministic per seed, only from settled idle, never repeats a variant twice in a row', async () => {
  const { createIdleVariation } = await import('../web/animation/idlevary.js');
  const run = seed => {
    const { a } = setup({ ...FAKE2, idle_look: fakeClip('idle_look', 0, 3, 0.1), idle_breathe: fakeClip('idle_breathe', 0, 2, 0.1), idle_fidget: fakeClip('idle_fidget', 0, 2.5, 0.1) });
    const iv = createIdleVariation({ seed, first: 2, gap: [1, 3], fade: 0.3 });
    a.play('idle', { fade: 0 });
    const log = [];
    for (let i = 0; i < 60 * 60; i++) {
      if (i === 60 * 20) a.play('walk');                // walking: no variants
      if (i === 60 * 30) a.play('idle');
      a.update(1 / 60);
      const v = iv.update(1 / 60, a);
      if (v) log.push([i, v]);
    }
    return log;
  };
  const A = run(1), B = run(1), C = run(7);
  assert.deepEqual(A, B);
  assert.notDeepEqual(A, C);
  assert.ok(A.length >= 6, `variants played ${A.length}`);
  for (let k = 1; k < A.length; k++) assert.notEqual(A[k][1], A[k - 1][1]);
  assert.ok(!A.some(([i]) => i >= 60 * 20 && i < 60 * 30), 'nothing while walking');
});

// ---- crossfades between the real clips: no pops ----
// Reference: the same clips played alone (A continuing, B started at the time the crossfade gives it). A linear
// crossfade moves a point per frame at most about 1.5 x max(own step of A, of B) + |A - B| / fade-frames, plus 8 mm
// for the ground guard (a blend of a deep crouch with standing lifts the root a little: jump/land -> idle ~6.5 mm per
// frame). A pop (a snap of the pelvis, a foot or the head) exceeds that. Every ordered pair of clips, fade 0.3 s,
// neutral and short child. ANIM_REPORT=1 prints the worst cases.
test('crossfade between any two clips: pelvis / feet / head never jump between frames', () => {
  const names = Object.keys(CLIPS), dt = 1 / 60, fade = 0.3, nf = Math.round(fade / dt);
  const worst = [], fails = [];
  for (const values of [{}, { age: -1, height: -1 }]) {
    const a = setup(CLIPS, values).a, ra = setup(CLIPS, values).a, rb = setup(CLIPS, values).a;
    const P = x => { const X = fkPositions(x.rig.heads, x.lastPose()); return [X.hips, X.leftToes, X.rightToes, X.head]; };
    const dist = (p, q, k) => Q.vLen(Q.vSub(p[k], q[k]));
    for (const A of names) for (const B of names) {
      if (A === B) continue;
      for (const x of [a, ra, rb]) x.stop({ fade: 0 });
      for (const x of [a, ra]) { x.play(A, { fade: 0 }); x.update(0); for (let i = 0; i < 24; i++) x.update(dt); }
      a.play(B, { fade });
      rb.play(B, { fade: 0 }); rb.seek(a.state().time); rb.update(0);
      let pa = P(a), pA = P(ra), pB = P(rb);
      const own = [0, 0, 0, 0], gap = [0, 0, 0, 0], step = [0, 0, 0, 0];
      for (let i = 0; i < nf + 2; i++) {
        for (const x of [a, ra, rb]) x.update(dt);
        const qa = P(a), qA = P(ra), qB = P(rb);
        for (let k = 0; k < 4; k++) {
          own[k] = Math.max(own[k], dist(qA, pA, k), dist(qB, pB, k));
          gap[k] = Math.max(gap[k], dist(qA, qB, k));
          step[k] = Math.max(step[k], dist(qa, pa, k));
        }
        pa = qa; pA = qA; pB = qB;
      }
      for (let k = 0; k < 4; k++) {
        const lim = 1.5 * own[k] + (1.25 * gap[k]) / nf + 0.008;
        worst.push({ r: step[k] / lim, d: step[k], A, B, k, body: values.age ? 'child' : 'neutral' });
        if (step[k] > lim) fails.push(`${values.age ? 'child' : 'neutral'} ${A}->${B} ${['hips', 'lToes', 'rToes', 'head'][k]} ${(step[k] * 1000).toFixed(1)} mm/frame (limit ${(lim * 1000).toFixed(1)})`);
      }
    }
  }
  if (process.env.ANIM_REPORT) {
    const show = w => `${w.body} ${w.A}->${w.B} ${['hips', 'lToes', 'rToes', 'head'][w.k]} ${(w.d * 1000).toFixed(1)}mm/frame r${w.r.toFixed(2)}`;
    worst.sort((x, y) => y.r - x.r); console.log('worst ratio:', worst.slice(0, 6).map(show));
    worst.sort((x, y) => y.d - x.d); console.log('largest step:', worst.slice(0, 6).map(show));
  }
  assert.deepEqual(fails, []);
});

test('real jump end to end: idle -> jump -> (auto) idle, fall -> land -> (auto) idle; smooth, feet never below the floor', () => {
  for (const values of [{}, { age: -1, height: -1 }, { weight: 1 }]) {
    const { a } = setup(CLIPS, values), dt = 1 / 60;
    const P = () => { const X = fkPositions(a.rig.heads, a.lastPose()); return [X.hips, X.leftToes, X.rightToes, X.head]; };
    const floor = ['leftToes', 'rightToes', 'leftFoot', 'rightFoot'];
    let prev = null, maxStep = 0, low = Infinity;
    const run = n => {
      for (let i = 0; i < n; i++) {
        a.update(dt);
        const X = fkPositions(a.rig.heads, a.lastPose()), p = P();
        for (const j of floor) low = Math.min(low, X[j][1] - a.rig.heads[j][1]);
        if (prev) maxStep = Math.max(maxStep, Q.vLen(Q.vSub(p[0], prev[0])));
        prev = p;
      }
    };
    a.play('idle', { fade: 0 }); run(30);
    a.play('jump', { fade: 0.2 });
    const T = a.state().duration;
    run(Math.ceil(T / dt) + 30);
    assert.equal(a.state().clip, 'idle');
    assert.equal(a.state().fading, false);
    a.play('fall', { fade: 0.3 }); run(40);
    a.play('land', { fade: 0.15 }); run(Math.ceil(1.2 / dt) + 30);
    assert.equal(a.state().clip, 'idle');
    // take-off speed of a 0.24 m pelvis rise is ~2.2 m/s = 37 mm per 60 fps frame
    assert.ok(maxStep < 0.045, `pelvis step ${maxStep}`);
    assert.ok(low > -0.002, `foot below floor ${low}`);
  }
});
