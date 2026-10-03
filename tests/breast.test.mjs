// SPDX-License-Identifier: GPL-3.0-or-later
// Binary sex, breast sliders / gate, breast morphs in the GLBs and the breast physics spring
// (web/character.js, web/breastphysics.js, web/cloth/runtime.js dynBase, docs/BREAST_PHYSICS.md).
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SLIDERS, BREAST_SLIDERS, CORRECTIVES, SEXES, sexOf, genderOfSex, defaultValues, breastGate, sliderInfluences,
  validateMorphs, applySliders,
} from '../web/character.js';
import {
  BREAST_PHYSICS, DYN_MORPHS, createBreastSpring, createBreastPhysics, dynWeights, breastMotionScale, combineSupport,
} from '../web/breastphysics.js';
import { buildDyn, dynBase } from '../web/cloth/runtime.js';
import { createLayerSet } from '../web/cloth/layers.js';
import { readGlb, meshParts } from '../tools/glb.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = f => path.join(root, 'output', f);
const close = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const BREAST_MORPHS = BREAST_SLIDERS.flatMap(s => [s.neg, s.pos]);

// ---- sex -----------------------------------------------------------------------------------------------
test('sex is binary: default male, 0/1 and male/female accepted, sexOf reads it back', () => {
  const g = SLIDERS.find(s => s.id === 'gender');
  assert.equal(g.binary, true);
  assert.equal(g.default, 1);
  assert.equal(defaultValues().gender, SEXES.male);
  assert.equal(sexOf(defaultValues()), 'male');
  assert.equal(sexOf({}), 'male');
  assert.deepEqual([SEXES.male, SEXES.female], [1, -1]);
  for (const [v, want] of [['male', 1], ['female', -1], ['M', 1], ['f', -1], [1, 1], [0, -1], [-1, -1], ['1', 1], ['0', -1], [true, 1], [false, -1]]) {
    assert.equal(genderOfSex(v), want, `genderOfSex(${JSON.stringify(v)})`);
  }
  for (const v of ['x', 2, 0.5, null, undefined, NaN]) assert.equal(genderOfSex(v), null, `genderOfSex(${v}) rejected`);
  assert.equal(sexOf({ gender: -1 }), 'female');
  assert.equal(sexOf({ gender: 1 }), 'male');
});

test('both sexes are exact macro samples: influences 0/1 only on the gender pair', () => {
  for (const [sex, on, off] of [['male', 'gender_male', 'gender_female'], ['female', 'gender_female', 'gender_male']]) {
    const inf = sliderInfluences({ ...defaultValues(), gender: genderOfSex(sex) });
    assert.equal(inf[on], 1, `${sex}: ${on}`);
    assert.equal(inf[off], 0, `${sex}: ${off}`);
    for (const [k, w] of Object.entries(inf)) assert.ok(Number.isFinite(w) && w >= 0 && w <= 1, `${sex} ${k}=${w}`);
  }
});

// ---- breast sliders + gate -----------------------------------------------------------------------------
test('breast sliders: 5 bipolar sliders, defaults in range, gated to a female adult', () => {
  assert.deepEqual(BREAST_SLIDERS.map(s => s.id), ['breastSize', 'breastFirmness', 'breastHeight', 'breastSpacing', 'breastProjection']);
  for (const s of BREAST_SLIDERS) assert.ok(Math.abs(s.default ?? 0) <= 1, s.id);
  assert.equal(breastGate({ gender: 1 }), 0);
  assert.equal(breastGate({ gender: -1 }), 1);
  assert.equal(breastGate({ gender: -1, age: -1 }), 0);          // child
  assert.equal(breastGate({ gender: -1, age: -0.5 }), 0.5);
  assert.equal(breastGate({ gender: -1, age: 1 }), 1);
  const big = { gender: 1, breastSize: 1, breastFirmness: -1, breastHeight: 1, breastSpacing: -1, breastProjection: 1, age: 1, muscle: 1 };
  const male = sliderInfluences(big);
  for (const n of BREAST_MORPHS) assert.equal(male[n], 0, `male: ${n} is 0`);
  for (const c of CORRECTIVES.filter(c => /breast_/.test(c.name))) assert.equal(male[c.name], 0, `male: ${c.name} is 0`);
  const fem = sliderInfluences({ ...big, gender: -1 });
  assert.equal(fem.breast_cup_max, 1);
  assert.equal(fem.breast_firm_min, 1);
  assert.equal(fem.corr_breast_cup_max__breast_firm_min, 1);
  assert.equal(fem.corr_breast_cup_max__age_old, 1);
  assert.equal(fem.corr_breast_cup_max__muscle_max, 1);
  assert.equal(fem.corr_breast_firm_min__age_old, 1);
  // female defaults: a moderate cup, a little firmer than average
  const d = sliderInfluences({ ...defaultValues(), gender: -1 });
  assert.ok(close(d.breast_cup_max, BREAST_SLIDERS[0].default) && d.breast_cup_max > 0);
  assert.equal(d.breast_cup_min, 0);
});

// ---- GLBs ----------------------------------------------------------------------------------------------
const G = readGlb(out('base_body.glb'));
const P = meshParts(G);
const BODY = P.Body, names = BODY.targetNames, prim = BODY.prims[0];

test('base GLB: every breast slider morph, breast corrective and dyn morph present on every part; validateMorphs clean', () => {
  for (const n of [...BREAST_MORPHS, ...CORRECTIVES.map(c => c.name), ...Object.values(DYN_MORPHS)]) assert.ok(names.includes(n), n);
  const dict = Object.fromEntries(names.map((n, i) => [n, i]));
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(' '));
  assert.deepEqual(validateMorphs({ morphTargetDictionary: dict }), []);
  const mesh = { morphTargetDictionary: dict, morphTargetInfluences: new Array(names.length).fill(0) };
  applySliders(mesh, { ...defaultValues(), gender: -1 });
  applySliders(mesh, defaultValues());
  console.warn = warn;
  assert.deepEqual(warned, []);
  // male default: no breast morph active at all
  for (const n of [...BREAST_MORPHS, ...Object.values(DYN_MORPHS)]) assert.equal(mesh.morphTargetInfluences[dict[n]], 0, n);
  for (const [pn, part] of Object.entries(P)) assert.deepEqual(part.targetNames, names, `${pn} target names`);
});

const maxDelta = (t, filt = () => true) => {
  let m = 0, at = null;
  prim.targets[t].forEach((d, i) => { const l = Math.hypot(...d); if (l > m && filt(prim.pos[i])) { m = l; at = prim.pos[i]; } });
  return [m, at];
};

test('breast morphs move the chest only (both sides, symmetric), cup max adds volume forward', () => {
  for (const n of [...BREAST_MORPHS.filter(n => n.startsWith('breast_') || n.startsWith('bdet_'))]) {
    const t = names.indexOf(n);
    const [m, at] = maxDelta(t);
    assert.ok(m > 0.003 && m < 0.12, `${n}: max ${(m * 1000).toFixed(1)} mm`);
    assert.ok(at[1] > 1.0 && at[1] < 1.45 && at[2] > 0, `${n}: largest move on the front of the chest (${at.map(v => v.toFixed(2))})`);
    const [l] = maxDelta(t, p => p[0] > 0.01), [r] = maxDelta(t, p => p[0] < -0.01);
    assert.ok(Math.abs(l - r) < 0.15 * Math.max(l, r) + 5e-4, `${n}: left ${l} vs right ${r}`);
  }
  // cup max pushes the tip forward (+Z glTF) by several cm
  const t = names.indexOf('breast_cup_max');
  const [m, at] = maxDelta(t);
  const i = prim.pos.findIndex(p => p === at);
  assert.ok(prim.targets[t][i][2] > 0.02, `cup max tip dz ${prim.targets[t][i][2]}`);
  assert.ok(m > 0.05, `cup max ${m}`);
});

test('dyn morphs: 2 cm rigid translation of the breast tissue along their axis, nothing else moves', () => {
  const axes = { up: [0, 1, 0], down: [0, -1, 0], left: [1, 0, 0], right: [-1, 0, 0], fwd: [0, 0, 1], back: [0, 0, -1] };
  for (const [k, n] of Object.entries(DYN_MORPHS)) {
    const t = names.indexOf(n), a = axes[k];
    let moved = 0, max = 0;
    prim.targets[t].forEach((d, i) => {
      const l = Math.hypot(...d);
      if (!l) return;
      moved++; max = Math.max(max, l);
      const cos = (d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) / l;
      assert.ok(cos > 0.999, `${n}: vertex ${i} moves along the axis`);
      const p = prim.pos[i];
      assert.ok(p[1] > 0.95 && p[1] < 1.45 && Math.abs(p[0]) < 0.25 && p[2] > -0.02, `${n}: vertex ${i} on the chest (${p.map(v => v.toFixed(2))})`);
    });
    assert.ok(Math.abs(max - BREAST_PHYSICS.amplitude) < 1e-3, `${n}: max ${max}`);
    assert.ok(moved > 150 && moved < 800, `${n}: ${moved} vertices`);
  }
  // the joints sidecar has no offsets for them (morph only, no bone moves)
  const joints = JSON.parse(fs.readFileSync(out('base_body.joints.json'), 'utf8'));
  for (const n of Object.values(DYN_MORPHS)) assert.ok(!joints.morphs[n] || !Object.keys(joints.morphs[n]).length, `${n}: no joint offsets`);
});

test('ccJiggle mesh extras on Body (base and animated GLB) match web/breastphysics.js', () => {
  for (const f of ['base_body.glb', 'base_body_anim.glb']) {
    const g = readGlb(out(f));
    const node = g.json.nodes.find(n => n.name === 'Body');
    const j = g.json.meshes[node.mesh].extras?.ccJiggle;
    assert.ok(j, `${f}: ccJiggle`);
    assert.equal(j.version, 1);
    assert.equal(j.amplitude, BREAST_PHYSICS.amplitude);
    assert.equal(j.frequencyHz, BREAST_PHYSICS.frequencyHz);
    assert.equal(j.dampingRatio, BREAST_PHYSICS.dampingRatio);
    assert.equal(j.backMaxWeight, BREAST_PHYSICS.backMaxWeight);
    for (const k of ['maxWeight', 'upMaxWeight', 'gain', 'maxDisplacement', 'supportStiffness', 'supportDamping', 'supportTravel']) {
      assert.equal(j[k], BREAST_PHYSICS[k], `${f}: ${k}`);
    }
    assert.deepEqual(Object.values(j.morphs).sort(), Object.values(DYN_MORPHS).sort());
    assert.equal(j.driverBone, 'spine_03');
  }
});

test('garments over the chest carry the dyn morphs with the body (T-shirt and coat move with the breasts)', () => {
  const catalog = JSON.parse(fs.readFileSync(out('clothing.json'), 'utf8'));
  for (const id of ['tshirt', 'trenchcoat']) {
    const g = readGlb(out(catalog.items.find(i => i.id === id).file));
    const part = Object.values(meshParts(g))[0], gp = part.prims[0];
    assert.deepEqual(part.targetNames, names, `${id} target names`);
    const t = names.indexOf('dyn_breast_fwd');
    const moved = gp.targets[t].filter(d => Math.hypot(...d) > 0.01).length;
    assert.ok(moved > 20, `${id}: ${moved} vertices follow dyn_breast_fwd by > 1 cm`);
    const far = gp.targets[t].filter((d, i) => Math.hypot(...d) > 1e-4 && gp.pos[i][1] < 0.9).length;
    assert.equal(far, 0, `${id}: nothing below the waist moves with the breasts`);
  }
});

// ---- physics -------------------------------------------------------------------------------------------
const W = Object.values(DYN_MORPHS);
const finite = w => W.every(n => Number.isFinite(w[n]) && w[n] >= 0);

test('spring: settles to zero at rest, bounded under any forcing, NaN / dt spikes reset instead of exploding', () => {
  const s = createBreastSpring();
  for (let i = 0; i < 30; i++) s.update(1 / 60, [0, -20, 0]);    // push
  assert.ok(s.state().x[1] < -0.005, 'pushed down');
  for (let i = 0; i < 180; i++) s.update(1 / 60, [0, 0, 0]);     // 3 s of rest
  assert.ok(s.state().x.every(v => Math.abs(v) < 1e-4), `settled ${s.state().x}`);
  // bounded: worst case, max force at resonance for 10 s
  const r = createBreastSpring();
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    const f = BREAST_PHYSICS.maxForce * 10 * Math.sin(2 * Math.PI * BREAST_PHYSICS.frequencyHz * i / 60);
    r.update(1 / 60, [f, f, f]);
    peak = Math.max(peak, ...r.state().x.map(Math.abs));
  }
  const bound = BREAST_PHYSICS.maxForce / (2 * Math.PI * BREAST_PHYSICS.frequencyHz) ** 2 / (2 * BREAST_PHYSICS.dampingRatio) * 1.5;
  assert.ok(peak < bound, `peak ${peak} < ${bound}`);
  // NaN / Infinity forcing, huge / negative / NaN dt
  for (const [dt, f] of [[1 / 60, [NaN, Infinity, -Infinity]], [5, [0, 50, 0]], [-1, [0, 1, 0]], [NaN, [1, 1, 1]], [1e-9, [1, 1, 1]]]) {
    r.update(dt, f);
    assert.ok(r.state().x.every(Number.isFinite) && r.state().v.every(Number.isFinite), `finite after dt=${dt}`);
  }
  r.update(1, [0, 10, 0]);                                         // > maxDt: reset
  assert.deepEqual(r.state().x, [0, 0, 0]);
});

test('dyn weights: non-negative, soft-limited, back limited, zero scale = zero', () => {
  const big = dynWeights([1, -1, -1], 1);
  assert.ok(finite(big));
  assert.ok(big.dyn_breast_left <= BREAST_PHYSICS.maxWeight && big.dyn_breast_left > 0.9 * BREAST_PHYSICS.maxWeight);
  assert.ok(big.dyn_breast_down <= BREAST_PHYSICS.maxWeight && big.dyn_breast_down > 0.9 * BREAST_PHYSICS.maxWeight);
  assert.ok(dynWeights([0, 1, 0], 1).dyn_breast_up <= BREAST_PHYSICS.upMaxWeight + 1e-9, 'up limited');
  assert.ok(BREAST_PHYSICS.upMaxWeight < BREAST_PHYSICS.maxWeight && BREAST_PHYSICS.maxWeight <= 0.75);
  assert.ok(big.dyn_breast_back <= BREAST_PHYSICS.backMaxWeight + 1e-9);
  assert.equal(big.dyn_breast_right + big.dyn_breast_up + big.dyn_breast_fwd, 0);
  assert.ok(W.every(n => dynWeights([0.05, 0.05, 0.05], 0)[n] === 0));
  assert.ok(finite(dynWeights([NaN, Infinity, -Infinity], NaN)));
  // amplitude: x = 1 cm at scale 1 -> gain * 0.5 of the 2 cm morph (before the soft limit)
  const w = dynWeights([0, 0.001, 0], 1).dyn_breast_up;
  assert.ok(close(w, BREAST_PHYSICS.gain * 0.05, 1e-4), `small x linear: ${w}`);
});

test('motion scale: 0 for male / child, larger for a large soft chest, smaller with support', () => {
  assert.equal(breastMotionScale({ gate: 0, size: 1, firmness: -1 }), 0);
  const soft = breastMotionScale({ gate: 1, size: 1, firmness: -1 });
  const firm = breastMotionScale({ gate: 1, size: 1, firmness: 1 });
  const small = breastMotionScale({ gate: 1, size: -1, firmness: -1 });
  assert.ok(soft > firm && soft > small && firm > 0 && small > 0, `${soft} ${firm} ${small}`);
  assert.ok(breastMotionScale({ gate: 1, size: 1, firmness: -1, support: 0.4 }) < soft);
  assert.ok(soft <= 1.4, `${soft}`);
});

test('driver: a still or uniformly moving chest gives no motion; a vertical bounce gives a bounded bounce', () => {
  const ph = createBreastPhysics();
  const q = [0, 0, 0, 1];
  let w;
  for (let i = 0; i < 120; i++) w = ph.step(1 / 60, [0, 1.3, 0.02 * i], q, 1);   // walking forward at 1.2 m/s
  assert.ok(W.every(n => w[n] < 1e-6), 'constant velocity: no motion');
  // 3 cm vertical bounce at 2.8 Hz (running): up/down weights appear, bounded, left/right stay ~0
  let peak = 0, lat = 0;
  for (let i = 0; i < 240; i++) {
    const t = i / 60;
    w = ph.step(1 / 60, [0, 1.3 + 0.03 * Math.sin(2 * Math.PI * 2.8 * t), 0.05 * i], q, 1);
    assert.ok(finite(w));
    peak = Math.max(peak, w.dyn_breast_up, w.dyn_breast_down);
    lat = Math.max(lat, w.dyn_breast_left, w.dyn_breast_right);
  }
  assert.ok(peak > 0.2 && peak <= BREAST_PHYSICS.maxWeight, `run bounce peak weight ${peak}`);
  assert.ok(lat < 1e-6, `no lateral motion ${lat}`);
  // teleport (pose jump) resets instead of kicking
  w = ph.step(1 / 60, [5, 1.3, 0], q, 1);
  assert.ok(W.every(n => w[n] === 0), 'teleport resets');
  // stops: back at rest, settles to exactly zero
  for (let i = 0; i < 300; i++) w = ph.step(1 / 60, [5, 1.3, 0], q, 1);
  assert.ok(W.every(n => w[n] < 1e-4), 'settles');
  // scale 0 (male / physics off): zero at once
  w = ph.step(1 / 60, [5, 1.4, 0], q, 0);
  assert.ok(W.every(n => w[n] === 0));
  // leaning forward 30 deg: gravity sags the tissue forward/down a little, static
  const lean = [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)];
  const p2 = createBreastPhysics();
  for (let i = 0; i < 300; i++) w = p2.step(1 / 60, [0, 1.3, 0], lean, 1);
  assert.ok(w.dyn_breast_fwd > 0.01 && w.dyn_breast_fwd < 0.6, `lean forward sag ${w.dyn_breast_fwd}`);
});

// review 2026-10-01: at size 1 / firmness -0.5 the run bounce saturated the spring (x[1] +-0.048 m, weights up 0.89 /
// down 0.86) and a bra / coat did not change the spring at all (only the output scale).
const runBounce = (support, scale, secs = 6) => {
  const ph = createBreastPhysics(), q = [0, 0, 0, 1];
  let xMax = 0, wMax = 0, up = 0, down = 0;
  for (let i = 0; i < secs * 60; i++) {
    const t = i / 60;     // 6 cm vertical bounce at 2.7 Hz (near resonance) + 2 cm sway at 1.35 Hz: harsher than the run clip
    const w = ph.step(1 / 60, [0.02 * Math.sin(Math.PI * 2.7 * t), 1.3 + 0.06 * Math.sin(2 * Math.PI * 2.7 * t), 0.06 * i], q, scale, support);
    xMax = Math.max(xMax, ...ph.state().x.map(Math.abs));
    wMax = Math.max(wMax, ...W.map(n => w[n]));
    up = Math.max(up, w.dyn_breast_up); down = Math.max(down, w.dyn_breast_down);
  }
  return { xMax, wMax, up, down };
};

test('breast physics is limited: travel <= maxDisplacement, weights well below 1 even for a large soft chest', () => {
  const scale = breastMotionScale({ gate: 1, size: 1, firmness: -0.5 });
  const r = runBounce(0, scale);
  assert.ok(r.xMax <= BREAST_PHYSICS.maxDisplacement + 1e-12, `travel ${r.xMax}`);
  assert.ok(r.up <= 0.5 && r.down <= 0.6, `peak weights up ${r.up} down ${r.down}`);
  assert.ok(r.up > 0.15 && r.down > 0.15, `still visible: up ${r.up} down ${r.down}`);
  // worst case: max force at resonance, scale 2 (beyond any slider): still inside the limits
  const s = createBreastSpring();
  for (let i = 0; i < 600; i++) {
    const f = 1e3 * Math.sin(2 * Math.PI * BREAST_PHYSICS.frequencyHz * i / 60);
    s.update(1 / 60, [f, f, f]);
    assert.ok(s.state().x.every(v => Math.abs(v) <= BREAST_PHYSICS.maxDisplacement + 1e-12));
  }
  const w = dynWeights(s.state().x.map(() => BREAST_PHYSICS.maxDisplacement), 2);
  assert.ok(W.every(n => w[n] <= BREAST_PHYSICS.maxWeight + 1e-9));
});

test('support (bra / garments) stiffens, damps and shortens the spring, not just the output scale', () => {
  assert.equal(combineSupport([]), 0);
  assert.ok(close(combineSupport([0.5, 0.2]), 0.6, 1e-12));
  assert.ok(combineSupport([0.5, 0.2, 0.3]) < 1 && combineSupport([NaN, 2, -1]) === 1);
  const sp = createBreastSpring(), t0 = sp.tune(0), t1 = sp.tune(0.5);
  assert.ok(t1.k > t0.k && t1.c > t0.c && t1.lim < t0.lim);
  const gate = { gate: 1, size: 1, firmness: -0.5 };
  const free = runBounce(0, breastMotionScale(gate));
  const bra = runBounce(0.5, breastMotionScale({ ...gate, support: 0.5 }));
  const all = runBounce(combineSupport([0.5, 0.2, 0.3]), breastMotionScale({ ...gate, support: combineSupport([0.5, 0.2, 0.3]) }));
  assert.ok(bra.xMax < 0.8 * free.xMax, `bra spring travel ${bra.xMax} vs ${free.xMax}`);
  assert.ok(bra.wMax < 0.5 * free.wMax, `bra weights ${bra.wMax} vs ${free.wMax}`);
  assert.ok(all.wMax < bra.wMax, `bra + T-shirt + coat ${all.wMax} vs bra ${bra.wMax}`);
  // the same physics with the same support at scale 1: support alone (without the scale) reduces the travel
  assert.ok(runBounce(0.5, 1).xMax < runBounce(0, 1).xMax);
});

test('driver cost: 1000 frames well under 0.3 ms each', () => {
  const ph = createBreastPhysics();
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) ph.step(1 / 60, [0, 1.3 + 0.03 * Math.sin(i / 3), i * 0.02], [0, 0, 0, 1], 1);
  const ms = (performance.now() - t0) / 1000;
  assert.ok(ms < 0.05, `${ms} ms per frame`);
});

// ---- cloth runtime: dyn morphs stay out of the rest shape --------------------------------------------------
test('cloth runtime: dyn targets are added sparsely per frame, base untouched, zero weights cost nothing', () => {
  const n = 5, pos = new Float32Array(n * 3).map((_, i) => i * 0.1);
  const tA = new Float32Array(n * 3), tB = new Float32Array(n * 3);
  tA[3] = 0.02; tB[7] = -0.02; tB[13] = 0.01;
  const targets = [new Float32Array(n * 3), tA, tB];
  const dyn = buildDyn(targets, [1, 2, 0], pos.length);
  assert.deepEqual(dyn.keys, [1, 2]);                   // the all-zero target is dropped
  assert.deepEqual([...dyn.list], [1, 2, 4]);
  assert.equal(dynBase(dyn, pos, [0, 0, 0]), pos, 'idle: the base itself');
  const cur = dynBase(dyn, pos, [0, 1, 0.5]);
  assert.notEqual(cur, pos);
  assert.ok(close(cur[3], pos[3] + 0.02, 1e-6) && close(cur[7], pos[7] - 0.01, 1e-6) && close(cur[13], pos[13] + 0.005, 1e-6));
  assert.ok(close(cur[0], pos[0]) && close(cur[1], pos[1]), 'unlisted vertices = base');
  const back = dynBase(dyn, pos, [0, 0, 0]);
  assert.equal(back, pos);
  assert.ok(close(dyn.cur[3], pos[3], 1e-7), 'cur returned to base');
  assert.equal(buildDyn(targets, [0], pos.length), null);
});

test('cloth layers: targets that do not touch the picked vertices are ignored (no per-frame re-morph)', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const si = new Uint16Array(12), sw = new Float32Array(12); sw[0] = sw[4] = sw[8] = 1;
  const far = new Float32Array(9); far[6] = 0.1;              // moves only vertex 2 (not picked)
  const near = new Float32Array(9); near[1] = 0.05;           // moves vertex 0
  const set = createLayerSet([{ positions: pos, normals: nrm, skinIndex: si, skinWeight: sw, targets: [far, near], list: Int32Array.from([0, 1]) }]);
  const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let o = set.update(() => I, () => [0, 1]);
  assert.ok(close(o[1], 0.05, 1e-6));
  o = set.update(() => I, () => [0.7, 1]);                   // only the far target changed: result unchanged
  assert.ok(close(o[1], 0.05, 1e-6) && close(o[8], 0, 1e-6));
  o = set.update(() => I, () => [0.7, 0]);
  assert.ok(close(o[1], 0, 1e-6));
});
