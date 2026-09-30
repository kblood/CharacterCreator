// Clothing (output/clothing.json + clothing_<id>.glb, built by blender/cc_clothing.py): catalog, licences, size
// budget, skin/morph/tint structure, morph follow, penetration at the morph extremes and in walk/run, body zones
// (hidden skin is really covered), cloth-ready data (pin mask + extras + colliders), and the outfit rules.
// Measurements: tools/cloth_check.mjs (same code as the CLI report `node tools/cloth_check.mjs`).
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jointNames } from '../tools/glb.mjs';
import * as C from '../tools/cloth_check.mjs';
import { wearRules, resolveOutfit, hiddenZoneMask, coveringZoneMask, filterIndex } from '../web/clothing_rules.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = f => path.join(root, 'output', f);
const D = C.loadAll();
const CAT = D.catalog;
const ITEMS = Object.fromEntries(CAT.items.map(i => [i.id, i]));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Outfits the penetration tests use: garment -> the lower layers worn under it.
const UNDER = { shoes: [], jeans: ['shoes'], skirt: [], tshirt: ['jeans'], trenchcoat: ['tshirt', 'jeans'] };

test('catalog: slots, unique ids, files, bytes, layers, zones, colours, default outfit', () => {
  assert.deepEqual(CAT.slots, ['top', 'bottom', 'shoes', 'outerwear']);
  for (const s of CAT.slots) assert.ok(CAT.slotLabels[s]?.da && CAT.slotLabels[s]?.en, `slot label ${s}`);
  assert.equal(CAT.bodyZoneAttribute, '_CCZONE');
  assert.equal(new Set(CAT.items.map(i => i.id)).size, CAT.items.length);
  for (const s of ['top', 'bottom', 'shoes', 'outerwear']) assert.ok(CAT.items.some(i => i.slot === s), `an item for ${s}`);
  const hex = /^#[0-9a-f]{6}$/;
  for (const it of CAT.items) {
    assert.equal(it.file, `clothing_${it.id}.glb`);
    assert.equal(fs.statSync(out(it.file)).size, it.bytes, `${it.id}: bytes recorded`);
    assert.ok(CAT.slots.includes(it.slot) && it.occupies.includes(it.slot), `${it.id} slot/occupies`);
    assert.ok(Number.isInteger(it.layer) && it.layer > 0);
    assert.ok(it.label.da && it.label.en, `${it.id} labels`);
    assert.ok(hex.test(it.colors.primary), `${it.id} primary colour`);
    if (it.colors.secondary) assert.ok(hex.test(it.colors.secondary));
    assert.ok(it.hidesBodyZones.length && it.hidesBodyZones.every(z => CAT.bodyZones[z]), `${it.id} zones`);
    for (const c of it.conflicts) assert.ok(ITEMS[c], `${it.id} conflicts with a known item`);
  }
  assert.ok(ITEMS.trenchcoat.layer > ITEMS.tshirt.layer && ITEMS.tshirt.layer > ITEMS.jeans.layer, 'coat outside tee outside jeans');
  for (const id of CAT.default) assert.ok(ITEMS[id]);
});

test('size budget: every garment < 1 MB, the trench coat < 1.5 MB', () => {
  for (const it of CAT.items) {
    const max = it.id === 'trenchcoat' ? 1.5e6 : 1.0e6;
    assert.ok(it.bytes < max, `${it.id}: ${it.bytes} bytes`);
  }
});

test('licences: CC0 MakeHuman system assets only; the coat extension is marked project-original', () => {
  const lic = path.join(root, 'build', 'blend', 'asset_licenses.json');
  const recorded = fs.existsSync(lic) ? JSON.parse(fs.readFileSync(lic, 'utf8')) : null;   // build/ is not in git
  const notes = fs.readFileSync(path.join(root, 'LICENSE-NOTES.md'), 'utf8');
  for (const it of CAT.items) {
    assert.ok(it.license.startsWith('CC0'), `${it.id}: ${it.license}`);
    const pack = it.source.match(/clothes\/(\w+)/)?.[1];
    assert.ok(pack, `${it.id}: source pack`);
    assert.ok(notes.includes(pack), `${it.id}: ${pack} documented in LICENSE-NOTES.md`);
    if (recorded) {
      const rows = recorded.filter(r => r.asset === pack && r.type === 'clothes');
      assert.ok(rows.length >= 2 && rows.every(r => r.license === 'CC0' && r.author === 'makehuman_system'),
        `${pack}: mhclo + mhmat recorded CC0 by makehuman_system`);
    }
  }
  assert.equal(ITEMS.trenchcoat.license, 'CC0 source + project-original extension');
  assert.match(ITEMS.trenchcoat.projectOriginal, /coat_skirt/);
});

test('garment GLBs: one skinned mesh on body joints, the 60 body morph targets, tint + mask extras', () => {
  const bodyJoints = new Set(jointNames(D.G));
  for (const [id, g] of Object.entries(D.garments)) {
    assert.equal(g.parts.length, 1, `${id}: one mesh`);
    assert.equal(g.parts[0].prims.length, 1, `${id}: one primitive`);
    assert.deepEqual(g.targetNames, D.names, `${id}: morph names == body`);
    assert.equal(g.prim.targets.length, D.names.length);
    for (const n of jointNames(g.glb)) assert.ok(bodyJoints.has(n), `${id}: joint ${n}`);
    g.prim.weights.forEach((w, i) => assert.ok(Math.abs(w.reduce((s, x) => s + x, 0) - 1) < 0.01, `${id} v${i} weights`));
    const mat = g.glb.json.materials[0];
    assert.equal(mat.extras?.tint?.default, ITEMS[id].colors.primary, `${id} tint default == catalog`);
    assert.ok(mat.extras.tint.gain > 1 && mat.extras.tint.gain < 4, `${id} tint gain`);
    if (ITEMS[id].colors.secondary) {
      assert.equal(mat.extras.tint.secondaryDefault, ITEMS[id].colors.secondary);
      assert.ok(Number.isInteger(mat.extras.ccMask?.index), `${id}: ccMask texture`);
    }
    // face morphs / blink / look must not move clothes
    D.names.forEach((n, t) => {
      if (['expr', 'look'].includes(C.kindOf(n))) assert.ok(Math.max(...g.prim.targets[t].map(v => Math.hypot(...v))) < 1e-4, `${id} ${n}`);
    });
  }
});

test('morph follow: every garment moves with the skin under it (every macro extreme + corrective corner)', () => {
  const bpos = D.body.pos, sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  for (const [id, g] of Object.entries(D.garments)) {
    const pos = g.prim.pos, step = Math.max(1, Math.floor(pos.length / 300));
    const near = C.grid(bpos, 0.02);
    const pairs = [];
    let sampled = 0;
    for (let k = 0; k < pos.length; k += step) {
      const i = near(pos[k]);
      if (i >= 0) pairs.push([k, i]);
      // cloth garments: the free part (pin < 0.5, e.g. the long coat's skirt) hangs away from the body by design
      if (!g.pin || g.pin[k] >= 0.5) sampled++;
    }
    assert.ok(pairs.length > 0.4 * sampled, `${id}: most sampled (skinned) vertices within 3 cm of the skin`);
    for (const s of C.shapes(D.names)) {
      if (s.name === 'neutral') continue;
      const gm = C.morphed(g.prim, s.w), bm = C.morphed(D.body, s.w);
      let err = 0, mag = 0;
      for (const [k, i] of pairs) {
        const db = sub(bm[i], bpos[i]);
        err += Math.hypot(...sub(sub(gm[k], pos[k]), db)) / pairs.length; mag += Math.hypot(...db) / pairs.length;
      }
      // mean drift of garment vertex vs its nearest skin vertex: 30 % + 20 mm. MHCLO fitting follows reference
      // triangles and the build pushes clothes out of the skin per shape, so loose parts (skirt flare) deviate
      // up to ~23 mm at muscle/weight corners; a garment that did not follow fails height_tall (~0.5 m of motion).
      assert.ok(err < 0.3 * mag + 0.02, `${id} ${s.name}: mean drift ${(err * 1000).toFixed(1)} mm vs skin ${(mag * 1000).toFixed(1)} mm`);
      if (mag > 0.2) assert.ok(err < 0.05 * mag, `${id} ${s.name}: follows large motion (${(err * 1000).toFixed(1)} of ${(mag * 1000).toFixed(1)} mm)`);
    }
  }
});

test('penetration at every morph extreme / corrective corner: no garment inside visible skin or lower layers', () => {
  // counts of garment vertices > 2 mm inside (tools/cloth_check.mjs TOL). Seen: tee 4, jeans 2 (+2 inside the shoe tops), others 0 skin;
  // coat vs drawn tee+jeans up to 20 (of 2584) at gender_female+weight_max, at the open front edges.
  const MAX_SKIN = 5, MAX_LAYERS = { jeans: 5, trenchcoat: 35 };
  for (const [id, under] of Object.entries(UNDER)) {
    const rows = C.morphReport(D, id, under);
    for (const r of rows) {
      assert.ok(r.skin <= MAX_SKIN, `${id} ${r.shape}: ${r.skin} vertices inside visible skin`);
      assert.ok(r.layers <= (MAX_LAYERS[id] ?? 0), `${id} ${r.shape}: ${r.layers} vertices inside ${under.join('+')}`);
    }
  }
});

test('penetration in walk / run (linear blend skinning of the clip frames, neutral body)', { skip: !D.clips.walk }, () => {
  // limits = measured + margin (numbers: docs/STATUS.md). The tee side at the armpit sits inside the inner upper
  // arm when the arm swings down from the A pose (same arm-into-torso overlap as the bare body): up to ~50 verts.
  // Coat layers = coat vertices inside the *drawn* tee (the tee triangles under the pinned coat are dropped):
  // up to 78 (was 116 before the tee under the coat was hidden).
  const LIM = {
    shoes: { skin: 2, mm: 5, layers: 0 }, jeans: { skin: 2, mm: 5, layers: 10 }, skirt: { skin: 20, mm: 30, layers: 0 },
    tshirt: { skin: 60, mm: 30, layers: 10 }, trenchcoat: { skin: 12, mm: 25, layers: 100, legs: 12 },
  };
  for (const [id, under] of Object.entries(UNDER)) {
    for (const clip of ['walk', 'run']) {
      if (!D.clips[clip]) continue;
      for (const r of C.poseReport(D, id, clip, under, 4)) {
        const L = LIM[id], at = `${id} ${clip} f${r.frame}`;
        assert.ok(r.skin <= L.skin, `${at}: ${r.skin} vertices inside visible skin`);
        assert.ok(-r.worst <= L.mm, `${at}: ${r.worst} mm deep`);
        assert.ok(r.layers <= L.layers, `${at}: ${r.layers} inside lower layers`);
        if (L.legs !== undefined) assert.ok(r.legInside <= L.legs, `${at}: coat skirt cuts into the legs (${r.legInside})`);
        assert.ok(r.stretchP99 < 3.5, `${at}: edge stretch p99 ${r.stretchP99}`);
      }
    }
  }
});

test('body zones: _CCZONE on the body, hidden skin is covered by the garment (no holes)', () => {
  assert.ok(D.zone && D.zone.length === D.body.pos.length, 'Body _CCZONE attribute');
  const all = Object.values(CAT.bodyZones).reduce((a, b) => a | b, 0);
  assert.ok(D.zone.every(z => Number.isInteger(z) && (z & ~all) === 0), 'zone values are bitmasks of known zones');
  // hidden body triangles whose outward ray hits no garment triangle within 20 cm. Shoes: the foot soles face
  // the ground under the shoe sole (never visible).
  const MAX = { shoes: 40, tshirt: 4, jeans: 4, skirt: 0, trenchcoat: 0 };
  for (const it of CAT.items) {
    const h = C.holes(D, [it.id]);
    assert.ok(h.hidden > 100, `${it.id}: hides skin (${h.hidden} triangles)`);
    assert.ok(h.bad <= MAX[it.id], `${it.id}: ${h.bad} hidden triangles not covered, e.g. ${JSON.stringify(h.where.slice(0, 2))}`);
  }
});

test('cloth-ready data: pin mask attribute + ccCloth extras on skirt and coat, colliders sidecar', () => {
  for (const [id, g] of Object.entries(D.garments)) {
    const c = ITEMS[id].cloth;
    if (!c) continue;
    assert.equal(c.pinAttribute, '_CLOTH_PIN');
    for (const k of ['maxDistance', 'damping', 'gravityScale', 'wind']) assert.ok(typeof c[k] === 'number', `${id} ${k}`);
    assert.ok(c.stiffness.stretch > 0 && c.stiffness.bend > 0);
    assert.deepEqual(g.mesh.extras?.ccCloth, c, `${id}: mesh extras ccCloth == catalog`);
    const pin = g.pin;
    assert.ok(pin && pin.length === g.prim.pos.length, `${id}: _CLOTH_PIN per vertex`);
    assert.ok(pin.every(p => p >= 0 && p <= 1));
    const ys = g.prim.pos.map(p => p[1]), top = Math.max(...ys), bot = Math.min(...ys);
    const band = (lo, hi) => pin.filter((_, i) => ys[i] >= lo && ys[i] <= hi);
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    assert.ok(mean(band(top - 0.05, top)) > 0.99, `${id}: top pinned`);
    assert.ok(mean(band(bot, bot + 0.05)) < 0.01, `${id}: hem free`);
    assert.ok(pin.filter(p => p > 0.05 && p < 0.95).length > 10, `${id}: smooth gradient`);
  }
  assert.ok(ITEMS.trenchcoat.cloth && ITEMS.skirt.cloth, 'coat + skirt carry cloth data');
  const col = JSON.parse(fs.readFileSync(out('body_colliders.json'), 'utf8'));
  const joints = JSON.parse(fs.readFileSync(out('base_body.joints.json'), 'utf8'));
  assert.ok(col.capsules.length >= 16);
  for (const k of col.capsules) {
    assert.ok(joints.bones[k.from] && joints.bones[k.to], `${k.name}: ends on sidecar joints`);
    assert.ok(k.radius > 0.01 && k.radius < 0.15, `${k.name}: radius ${k.radius}`);
    for (const m of Object.keys(k.radiusMorphs)) assert.ok(D.names.includes(m), `${k.name}: morph ${m}`);
  }
});

test('outfit rules: occupies / conflicts / layering / resolveOutfit / zone mask / index filter', () => {
  assert.deepEqual(resolveOutfit(CAT, ['tshirt', 'jeans', 'shoes', 'trenchcoat']), ['tshirt', 'jeans', 'shoes', 'trenchcoat']);
  assert.deepEqual(wearRules(CAT, ['tshirt', 'jeans'], 'skirt'), ['tshirt', 'skirt'], 'skirt replaces jeans (same slot)');
  assert.deepEqual(resolveOutfit(CAT, ['nope', 'shoes']), ['shoes'], 'unknown ids dropped');
  // a dress occupies top + bottom and conflicts both ways (synthetic catalog)
  const cat = { bodyZones: { a: 1, b: 2, c: 4 }, items: [
    { id: 'tee', slot: 'top', occupies: ['top'], conflicts: [], hidesBodyZones: ['a'] },
    { id: 'pants', slot: 'bottom', occupies: ['bottom'], conflicts: [], hidesBodyZones: ['b'] },
    { id: 'dress', slot: 'top', occupies: ['top', 'bottom'], conflicts: [], hidesBodyZones: ['a', 'b'] },
    { id: 'coat', slot: 'outerwear', occupies: ['outerwear'], conflicts: [], hidesBodyZones: ['c'] },
    { id: 'cape', slot: 'outerwear2', occupies: ['outerwear2'], conflicts: ['coat'], hidesBodyZones: [] },
  ] };
  assert.deepEqual(resolveOutfit(cat, ['tee', 'pants', 'coat', 'dress']), ['coat', 'dress']);
  assert.deepEqual(wearRules(cat, ['dress', 'coat'], 'pants'), ['coat', 'pants']);
  assert.deepEqual(wearRules(cat, ['coat'], 'cape'), ['cape']);
  assert.deepEqual(wearRules(cat, ['cape'], 'coat'), ['coat'], 'conflicts apply in both directions');
  assert.equal(hiddenZoneMask(cat, ['dress', 'coat']), 7);
  cat.items.forEach((it, k) => { it.layer = [2, 1, 2, 4, 5][k]; });
  assert.equal(coveringZoneMask(cat, ['tee', 'pants', 'coat'], 'tee'), 4, 'the coat covers the tee');
  assert.equal(coveringZoneMask(cat, ['tee', 'pants'], 'tee'), 0, 'nothing over the tee');
  assert.equal(coveringZoneMask(cat, ['tee', 'coat'], 'coat'), 0, 'nothing over the coat');
  const idx = new Uint16Array([0, 1, 2, 1, 2, 3]), zone = { array: new Float32Array([1, 1, 3, 0]) };
  assert.deepEqual([...filterIndex(idx, zone, 1)], [1, 2, 3]);
  assert.equal(filterIndex(idx, zone, 0), idx);
  assert.equal(hiddenZoneMask(CAT, CAT.items.map(i => i.id)), Object.values(CAT.bodyZones).reduce((a, b) => a | b, 0));
});
