// Animator (web/animation/animator.js) on a fake three.js-like bone tree built from output/base_body.glb.
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Q from '../web/animation/qmath.js';
import { createHumanoid, restHeads } from '../web/humanoid.js';
import { createAnimator } from '../web/animation/animator.js';
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
