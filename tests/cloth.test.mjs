// Cloth runtime tests (web/cloth, driven by tools/cloth_sim.mjs = the real animator on the exported skeleton).
// Numbers are printed with their tolerances; docs/CLOTH_RUNTIME.md explains the metrics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { loadData, runTimeline, BODIES, createCharacter, createGarmentSim, frameInputs } from '../tools/cloth_sim.mjs';
import { createSolver, clothParams, advance, hashFloats } from '../web/cloth/solver.js';
import { buildClothModel } from '../web/cloth/model.js';
import { clothColliderDefs } from '../web/cloth/colliders.js';
import { collidesAsLayer } from '../web/clothing_rules.js';

const D = loadData();
const report = (name, v, tol) => console.log(`# ${name}: ${JSON.stringify(v)}  (tolerance ${tol})`);

// a 1 x 1 m sheet, 11 x 11 particles, top row pinned
function sheet() {
  const N = 11, pos = [], pin = [], index = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { pos.push(c / (N - 1) - 0.5, 1.5 - r / (N - 1), 0); pin.push(r === 0 ? 1 : 0); }
  for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) {
    const a = r * N + c; index.push(a, a + 1, a + N, a + 1, a + N + 1, a + N);
  }
  const m = buildClothModel({ positions: Float32Array.from(pos), index: Uint32Array.from(index), pin: Float32Array.from(pin) });
  const X = new Float32Array(m.sim.count * 3);
  m.sim.particles.forEach((p, s) => X.set(pos.slice(3 * m.rep[p], 3 * m.rep[p] + 3), 3 * s));
  return { m, X };
}
const noCaps = new Float32Array(0);

test('determinism: same inputs -> bit-identical coat positions', () => {
  const a = runTimeline(D, ['trenchcoat'], {}, { duration: 1.5, measureEvery: 30 }).trenchcoat.hash;
  const b = runTimeline(D, ['trenchcoat'], {}, { duration: 1.5, measureEvery: 30 }).trenchcoat.hash;
  report('hash', [a, b], 'equal');
  assert.equal(a, b);
});

test('pins hold: kinematic particles sit exactly on their skinned targets', () => {
  const ch = createCharacter(D, {});
  const s = createGarmentSim(D, 'trenchcoat', ch);
  const defs = clothColliderDefs(D.colliders), caps = new Float32Array(defs.length * 7);
  ch.animator.play('run', { fade: 0 });
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    ch.animator.update(1 / 60); ch.update();
    const f = frameInputs(D, ch, defs, caps, {});
    f.anchors = s.anchorsNow(); f.limit = s.limit;
    s.solver.step(f);
    const x = s.solver.positions(), pin = s.model.sim.pin;
    for (let k = 0; k < pin.length; k++) if (pin[k] >= 0.999) {
      worst = Math.max(worst, Math.abs(x[3 * k] - f.anchors[3 * k]), Math.abs(x[3 * k + 1] - f.anchors[3 * k + 1]), Math.abs(x[3 * k + 2] - f.anchors[3 * k + 2]));
    }
  }
  report('pinned max |x - target| (m)', worst, '< 1e-6');
  assert.ok(worst < 1e-6);
});

test('collision pushes a particle out of a capsule, the floor stops it', () => {
  const { m, X } = sheet();
  const sv = createSolver(m.sim, X, clothParams({}, { thickness: 0.01 }));
  // capsule across the sheet's middle, 5 cm behind it, r 10 cm -> the sheet must end outside r + thickness
  const caps = Float32Array.from([-1, 1.0, -0.05, 1, 1.0, -0.05, 0.1]);
  for (let i = 0; i < 90; i++) sv.step({ anchors: X, caps, floorY: 0, lateral: [1, 0, 0], air: [0, 0, 0] });
  const pen = sv.penetrations(caps, 0, 0.002);
  report('sheet vs capsule', pen, '0 inside, 0 below the floor');
  assert.equal(pen.count, 0);
  assert.equal(pen.belowFloor, 0);
  // floor: drop the whole sheet (no pins) from 5 cm
  const f = buildClothModel({ positions: Float32Array.from([0, 0.05, 0, 0.1, 0.05, 0, 0, 0.05, 0.1]), index: Uint32Array.from([0, 1, 2]), pin: new Float32Array(3) });
  const fs = createSolver(f.sim, Float32Array.from([0, 0.05, 0, 0.1, 0.05, 0, 0, 0.05, 0.1]), clothParams({}, { thickness: 0.01 }));
  const A = Float32Array.from([0, 0.05, 0, 0.1, 0.05, 0, 0, 0.05, 0.1]);
  for (let i = 0; i < 120; i++) fs.step({ anchors: A, caps: noCaps, floorY: 0, lateral: [1, 0, 0], air: [0, 0, 0] });
  const ys = [1, 4, 7].map(k => fs.positions()[k]);
  report('dropped triangle y (m)', ys.map(y => +y.toFixed(4)), '= floor + thickness (0.01)');
  for (const y of ys) assert.ok(Math.abs(y - 0.01) < 1e-4);
});

test('dt spikes and teleports: fixed steps stay stable, a teleport restarts cleanly', () => {
  // frame dt jitter + 0.25 s hitches every 2 s (the animator jumps ahead; the cloth sees one big pose change)
  const r = runTimeline(D, ['trenchcoat'], {}, { duration: 6, measureEvery: 6, dtOf: i => (i % 120 === 0 ? 0.25 : 1 / 60 * (1 + 0.5 * Math.sin(i))) }).trenchcoat;
  report('coat with dt spikes', { stretchP99: r.stretchP99, resets: r.resets, floorBelow: r.floorBelow }, 'stretch p99 < 1.8, finite');
  assert.ok(Number.isFinite(r.stretchP99) && r.stretchP99 < 1.8);
  // teleport: every target 1 m away in one step -> reset to the targets, no explosion
  const { m, X } = sheet();
  const sv = createSolver(m.sim, X, clothParams({}));
  for (let i = 0; i < 30; i++) sv.step({ anchors: X, caps: noCaps, floorY: 0, lateral: [1, 0, 0], air: [0, 0, 0] });
  const moved = X.map((v, i) => (i % 3 === 0 ? v + 1 : v));
  const resets0 = sv.resets;
  sv.step({ anchors: moved, caps: noCaps, floorY: 0, lateral: [1, 0, 0], air: [0, 0, 0] });
  const st = sv.stretch();
  report('teleport', { resets: sv.resets - resets0, stretchMax: +st.max.toFixed(3) }, '1 reset, stretch max < 1.05');
  assert.equal(sv.resets - resets0, 1);
  assert.ok(st.max < 1.05);
});

// 10 s: walk 0-3, run 3-5.5, idle 5.5-7.5, idle -> run 7.5-10 (tools/cloth_sim.mjs TIMELINE)
const COAT_BODIES = ['neutral', 'tall', 'short', 'heavy', 'child', 'old', 'muscular', 'female'];
for (const b of COAT_BODIES) {
  test(`long coat, ${b}: stretch, penetration, floor, front panels, hem over 10 s`, () => {
    const r = runTimeline(D, ['trenchcoat'], BODIES[b], { measureEvery: 6 }).trenchcoat;
    const v = { stretchP99: r.stretchP99, stretchP99Mean: r.stretchP99Mean, skinStretchP99: r.skinStretchP99, bodyPen: r.bodyPen,
      bodyPenMm: r.bodyPenMm, skinPen: r.skinPen, floorBelow: r.floorBelow, crossed: r.crossed, hemMinY: r.hemMinY,
      hemTrail: r.hemTrail, hemRise: r.hemRise, msPerStep: r.msPerStep };
    report(`coat ${b}`, v, 'p99 <= 1.65, mean <= 1.3, pen <= 6 particles and <= 25 mm and <= cloth off, floor 0, crossed 0, hem >= floor, trail >= 0.15 m, rise <= 0.3 m');
    assert.ok(r.stretchP99 <= 1.65 && r.stretchP99Mean <= 1.3);
    assert.ok(r.bodyPen <= 6 && r.bodyPenMm <= 25 && r.bodyPen <= r.skinPen);
    assert.equal(r.floorBelow, 0);
    assert.equal(r.crossed, 0);
    assert.ok(r.hemMinY >= 0);
    assert.ok(r.hemTrail >= 0.15 && r.hemRise <= 0.3);
  });
}

// Visible-layer penetration (tools/cloth_sim.mjs pokeThrough): jeans / T-shirt / skin showing through the coat
// fabric. "through" = a covered layer vertex lies > 2 mm outside a coat triangle that itself has a particle inside
// the layers (the blue holes in the knee / hem during walk and run). Cloth off (skinned coat) is the reference.
for (const b of COAT_BODIES) {
  test(`long coat over T-shirt + jeans, ${b}: no layer pokes through the coat in walk / run`, () => {
    const r = runTimeline(D, ['trenchcoat'], BODIES[b], { measureEvery: 6, under: ['tshirt', 'jeans'] }).trenchcoat;
    const v = {}, sum = o => Object.values(o).reduce((a, x) => a + x.through, 0);
    for (const [id, x] of Object.entries(r.layer)) v[id] = { walk: x.throughByClip.walk ?? 0, run: x.throughByClip.run ?? 0, mm: x.throughMm };
    report(`coat layers ${b}`, { ...v, clothOff: sum(r.layerSkin), stretchP99: r.stretchP99, bodyPen: r.bodyPen },
      'per layer walk/run through <= 1 and <= 15 mm, total < cloth off, p99 <= 1.65, pen <= 6');
    for (const x of Object.values(v)) assert.ok(x.walk <= 1 && x.run <= 1 && x.mm <= 15);
    assert.ok(sum(r.layer) < sum(r.layerSkin));
    assert.ok(r.stretchP99 <= 1.65 && r.bodyPen <= 6);
    assert.equal(r.crossed, 0);
  });
}

test('footwear is not a collision layer, trousers / shirts / skirts are', () => {
  const byId = id => D.catalog.items.find(i => i.id === id);
  assert.equal(collidesAsLayer(byId('shoes')), false);
  for (const id of ['tshirt', 'jeans', 'skirt']) assert.equal(collidesAsLayer(byId(id)), true, id);
});

for (const b of ['neutral', 'short', 'child', 'female']) {
  test(`skirt, ${b}: same system, less stretch than the skinned skirt`, () => {
    const r = runTimeline(D, ['skirt'], BODIES[b], { measureEvery: 6 }).skirt;
    report(`skirt ${b}`, { stretchP99: r.stretchP99, skinStretchP99: r.skinStretchP99, bodyPen: r.bodyPen, bodyPenMm: r.bodyPenMm, skinPen: r.skinPen, crossed: r.crossed },
      'p99 <= 2.4 and < cloth off, pen <= 12 and <= cloth off, crossed 0');
    assert.ok(r.stretchP99 <= 2.4 && r.stretchP99 < r.skinStretchP99);
    assert.ok(r.bodyPen <= 12 && r.bodyPen <= r.skinPen);
    assert.equal(r.crossed, 0);
  });
}

for (const under of [[], ['tshirt', 'jeans']]) test(`worker (worker_threads) and main thread give bit-identical results${under.length ? ', with lower layers' : ''}`, async () => {
  const ch = createCharacter(D, { height: 0.5 });
  const s = createGarmentSim(D, 'trenchcoat', ch, {}, under);
  const defs = clothColliderDefs(D.colliders), caps = new Float32Array(defs.length * 7);
  const restX = new Float32Array(s.model.sim.count * 3);
  s.reps.forEach((v, k) => restX.set(s.base.subarray(3 * v, 3 * v + 3), 3 * k));
  const local = createSolver(s.model.sim, restX, s.params);
  const w = new Worker(new URL('../web/cloth/worker.js', import.meta.url));
  const replies = [];
  let wake = null;
  w.on('message', m => { if (m.type === 'done') { replies.push(m); wake?.(); } });
  w.postMessage({ type: 'init', key: 'c', sim: s.model.sim, restX, params: s.params });
  ch.animator.play('run', { fade: 0 });
  let lastA = null, lastC = null, lastL = null, localHash = '';
  for (let i = 0; i < 40; i++) {
    ch.animator.update(1 / 60); ch.update();
    const f = frameInputs(D, ch, defs, caps, { wind: 0.5, t: i / 60 });
    const A1 = Float32Array.from(s.anchorsNow()), L = s.layerNow(), L1 = L ? Float32Array.from(L) : undefined;
    const job = { n: 1 + (i % 3), A0: lastA, A1, C0: lastC, C1: Float32Array.from(caps), L0: lastL ?? undefined, L1, floorY: 0, lateral: f.lateral,
      air: f.air, limit: s.limit, reset: i === 0, settle: i === 0 ? 5 : 0 };
    localHash = hashFloats(advance(local, job));
    w.postMessage({ type: 'job', key: 'c', seq: i, job });
    lastA = A1; lastC = job.C1; lastL = L1;
  }
  while (replies.length < 40) await new Promise(r => { wake = r; });
  await w.terminate();
  const remoteHash = hashFloats(replies[39].x);
  if (under.length) assert.ok(lastL.length > 0);   // the layers really took part
  report(`worker vs sync hash${under.length ? ' (layers)' : ''}`, [remoteHash, localHash], 'equal');
  assert.equal(remoteHash, localHash);
});
