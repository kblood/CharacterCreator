// Slider model (face sliders, correctives) and eye life (blink timer, gaze) - pure logic, no three.js.
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { SLIDERS, FACE_SLIDERS, CORRECTIVES, sliderInfluences, applySliders } from '../web/character.js';
import { createEyeLife, blinkCurve, clampGaze, gazeWeights, BLINK, LOOK, applyMorphWeights } from '../web/eyelife.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('face sliders: 13 bipolar sliders onto face_<stem>_decr / _incr, ids unique', () => {
  assert.equal(FACE_SLIDERS.length, 13);
  const ids = SLIDERS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of FACE_SLIDERS) {
    assert.match(s.neg, /^face_[a-z_]+_decr$/);
    assert.equal(s.pos, s.neg.replace(/_decr$/, '_incr'));
  }
  const inf = sliderInfluences({ noseWidth: -0.5, forehead: 1 });
  assert.equal(inf.face_nose_width_decr, 0.5);
  assert.equal(inf.face_nose_width_incr, 0);
  assert.ok(inf.face_forehead_incr > 0 && inf.face_forehead_incr <= 1);
});

test('correctives: 32 (8 pairs x 4 corners), influence = product of the two part influences', () => {
  assert.equal(CORRECTIVES.length, 32);
  assert.equal(new Set(CORRECTIVES.map(c => c.name)).size, 32);
  const inf = sliderInfluences({ gender: 1, age: -0.5, weight: 0.8, muscle: 0.5 });
  assert.equal(inf.corr_gender_male__age_child, 0.5);
  assert.equal(inf.corr_gender_female__age_child, 0);
  assert.ok(close(inf.corr_weight_max__muscle_max, 0.4));
  assert.ok(close(inf.corr_gender_male__weight_max, 0.8));
  assert.equal(inf.corr_weight_min__muscle_max, 0);
  // neutral body: every corrective is 0
  for (const c of CORRECTIVES) assert.equal(sliderInfluences({})[c.name], 0);
  // corners: exactly 1
  assert.equal(sliderInfluences({ weight: -1, muscle: -1 }).corr_weight_min__muscle_min, 1);
});

test('applySliders leaves blink/look morphs alone and skips missing correctives silently', () => {
  const names = ['gender_female', 'gender_male', 'blink_left', 'look_left', 'face_chin_decr', 'face_chin_incr'];
  const mesh = { morphTargetDictionary: Object.fromEntries(names.map((n, i) => [n, i])), morphTargetInfluences: [0, 0, 0.7, 0.3, 0, 0] };
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(' '));
  applySliders(mesh, { gender: 1, chin: -1 });
  console.warn = warn;
  assert.deepEqual(mesh.morphTargetInfluences, [0, 1, 0.7, 0.3, 1, 0]);
  assert.ok(!warned.some(w => /corr_|breast_|bdet_/.test(w)), 'no warning for correctives / breast morphs the mesh lacks');
});

// deterministic rng
const seq = vals => { let i = 0; return () => vals[i++ % vals.length]; };
const mulberry = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

test('blinkCurve: 0 at the ends, 1 at the close point, monotone close and open', () => {
  assert.equal(blinkCurve(0), 0); assert.equal(blinkCurve(1), 0);
  assert.ok(close(blinkCurve(BLINK.closeFrac), 1));
  let prev = 0;
  for (let u = 0.01; u < BLINK.closeFrac; u += 0.01) { assert.ok(blinkCurve(u) >= prev); prev = blinkCurve(u); }
  prev = 1;
  for (let u = BLINK.closeFrac + 0.01; u < 1; u += 0.01) { assert.ok(blinkCurve(u) <= prev + 1e-12); prev = blinkCurve(u); }
});

test('blink timer: intervals 2-6 s, durations 120-180 ms, independent of anything else', () => {
  const e = createEyeLife({ rng: mulberry(3) });
  const dt = 1 / 120, starts = [], durs = [];
  let t = 0, was = false, start = 0;
  for (let k = 0; k < 120 * 600; k++) {       // 10 minutes
    t += dt;
    const w = e.update(dt, null);
    const on = e.state().blinking;
    if (on && !was) { starts.push(t); start = t; }
    if (!on && was) durs.push(t - start);
    was = on;
    assert.ok(w.blink_left >= 0 && w.blink_left <= 1 && w.blink_left === w.blink_right);
  }
  assert.ok(starts.length > 100 && starts.length < 330, `${starts.length} blinks in 10 min`);
  for (const d of durs) assert.ok(d >= BLINK.minDur - 2 * dt && d <= BLINK.maxDur + 2 * dt, `duration ${d}`);
  // gaps: a double blink may follow within 0.12-0.25 s (+ the blink itself); every other gap is 2-6 s
  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  const doubles = gaps.filter(g => g < 1);
  for (const g of gaps) assert.ok(g < 1 ? g <= BLINK.maxDur + BLINK.doubleGap[1] + 3 * dt : (g >= BLINK.minInterval - 3 * dt && g <= BLINK.maxInterval + BLINK.maxDur + BLINK.doubleGap[1] + 3 * dt), `gap ${g}`);
  assert.ok(doubles.length > 0 && doubles.length < gaps.length * 0.3, `double blinks ${doubles.length}/${gaps.length}`);
});

test('blink can be switched off; a huge frame time does not skip past a whole blink', () => {
  const e = createEyeLife({ rng: seq([0]), blink: true });       // first blink after 2 s
  for (let k = 0; k < 19; k++) e.update(0.1);
  assert.equal(e.state().blinking, false);
  e.update(5);                                                   // dt clamped to 0.1 s: the blink starts ...
  assert.equal(e.state().blinking, true);
  e.update(5);                                                   // ... and is still running (0.1 s < 0.12 s)
  assert.ok(e.state().blinking && e.update(0).blink_left > 0);
  e.setBlinkEnabled(false);
  assert.equal(e.update(0.01).blink_left, 0);
  for (let k = 0; k < 1000; k++) assert.equal(e.update(0.05).blink_left, 0);
});

test('gaze: clamps, gives up behind the head, weights never exceed the clamp, left = +yaw', () => {
  const deg = Math.PI / 180;
  assert.deepEqual(clampGaze(80 * deg, 0), { yaw: 0, pitch: 0 });                // target behind: look ahead
  const c = clampGaze(40 * deg, -40 * deg);
  assert.ok(close(c.yaw, LOOK.maxYaw) && close(c.pitch, -LOOK.maxDown));
  const w = gazeWeights(LOOK.maxYaw, LOOK.maxUp);
  assert.ok(w.look_left > 0 && w.look_left <= 0.85 && w.look_right === 0 && w.look_up > 0 && w.look_down === 0);
  const e = createEyeLife({ rng: seq([0.5]), blink: false });
  let out;
  for (let k = 0; k < 60; k++) out = e.update(1 / 60, { yaw: 10 * deg, pitch: 0 });
  assert.ok(out.look_left > 0.3 && out.look_right === 0, JSON.stringify(out));
  // small target jitter below the saccade threshold does not start new saccades
  const n = e.state().saccades;
  for (let k = 0; k < 60; k++) e.update(1 / 60, { yaw: (10 + (k % 2 ? 0.5 : -0.5)) * deg, pitch: 0 });
  assert.equal(e.state().saccades, n);
  // looking down lowers the upper lid a little
  for (let k = 0; k < 60; k++) out = e.update(1 / 60, { yaw: 0, pitch: -15 * deg });
  assert.ok(out.look_down > 0.4 && out.blink_left > 0.1 && out.blink_left < 0.35, JSON.stringify(out));
});

test('applyMorphWeights writes only the names a mesh has', () => {
  const mesh = { morphTargetDictionary: { blink_left: 1 }, morphTargetInfluences: [0.2, 0] };
  applyMorphWeights(mesh, { blink_left: 0.9, look_up: 1 });
  assert.deepEqual(mesh.morphTargetInfluences, [0.2, 0.9]);
});
