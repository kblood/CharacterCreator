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
import { wearRules, resolveOutfit, hiddenZoneMask, coveringZoneMask, filterIndex, collidesAsLayer, defaultUnderwear,
  outfitWithUnderwear, swapUnderwearForSex, isUnderwear } from '../web/clothing_rules.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = f => path.join(root, 'output', f);
const D = C.loadAll();
const CAT = D.catalog;
const ITEMS = Object.fromEntries(CAT.items.map(i => [i.id, i]));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Outfits the penetration tests use: garment -> the lower layers worn under it.
const UNDER = { shoes: [], jeans: ['shoes'], skirt: [], tshirt: ['jeans'], trenchcoat: ['tshirt', 'jeans'],
  shorts: [], shirt: ['jeans'], hoodie: ['jeans'] };
// Generated underwear (layer 0, blender/cc_clothing.py add_generated) and the outer garments over its DRAWN part.
const UNDERWEAR = ['briefs', 'panties', 'bra'];
const OVER_UNDERWEAR = [['jeans', ['shoes', 'briefs']], ['jeans', ['shoes', 'panties']], ['skirt', ['briefs']], ['skirt', ['panties']],
  ['tshirt', ['jeans', 'bra', 'panties']], ['trenchcoat', ['bra', 'panties']], ['trenchcoat', ['briefs']],
  ['shorts', ['briefs']], ['shorts', ['panties']], ['shirt', ['shorts', 'bra', 'panties']], ['shirt', ['jeans', 'briefs']],
  ['hoodie', ['jeans', 'bra', 'panties']], ['hoodie', ['jeans', 'briefs']]];

test('catalog: slots, unique ids, files, bytes, layers, zones, colours, default outfit', () => {
  assert.deepEqual(CAT.slots, ['underwear', 'bra', 'top', 'bottom', 'shoes', 'outerwear']);
  assert.deepEqual(CAT.underwearSlots, ['underwear', 'bra']);
  for (const s of CAT.slots) assert.ok(CAT.slotLabels[s]?.da && CAT.slotLabels[s]?.en, `slot label ${s}`);
  assert.equal(CAT.bodyZoneAttribute, '_CCZONE');
  assert.equal(new Set(CAT.items.map(i => i.id)).size, CAT.items.length);
  for (const s of CAT.slots) assert.ok(CAT.items.some(i => i.slot === s), `an item for ${s}`);
  const hex = /^#[0-9a-f]{6}$/;
  for (const it of CAT.items) {
    assert.equal(it.file, `clothing_${it.id}.glb`);
    assert.equal(fs.statSync(out(it.file)).size, it.bytes, `${it.id}: bytes recorded`);
    assert.ok(CAT.slots.includes(it.slot) && it.occupies.includes(it.slot), `${it.id} slot/occupies`);
    assert.ok(Number.isInteger(it.layer) && (isUnderwear(CAT, it.id) ? it.layer === 0 : it.layer > 0), `${it.id} layer`);
    assert.ok(it.label.da && it.label.en, `${it.id} labels`);
    assert.ok(hex.test(it.colors.primary), `${it.id} primary colour`);
    if (it.colors.secondary) assert.ok(hex.test(it.colors.secondary));
    assert.ok(it.hidesBodyZones.length && it.hidesBodyZones.every(z => CAT.bodyZones[z]), `${it.id} zones`);
    for (const c of it.conflicts) assert.ok(ITEMS[c], `${it.id} conflicts with a known item`);
  }
  assert.ok(ITEMS.trenchcoat.layer > ITEMS.tshirt.layer && ITEMS.tshirt.layer > ITEMS.jeans.layer, 'coat outside tee outside jeans');
  assert.ok(ITEMS.hoodie.layer > ITEMS.tshirt.layer && ITEMS.shirt.layer > ITEMS.jeans.layer && ITEMS.shorts.layer === ITEMS.jeans.layer, 'hoodie / shirt over the bottoms');
  for (const id of ['hoodie', 'shirt', 'shorts']) assert.ok(!ITEMS[id].cloth, `${id}: skinned (pinned), no cloth simulation`);
  assert.ok(ITEMS.shirt.colors.secondary && ITEMS.hoodie.colors.secondary, 'shirt / hoodie: secondary colour (buttons, collar, cuffs / rib bands)');
  for (const id of CAT.default) assert.ok(ITEMS[id]);
  assert.deepEqual(CAT.defaultUnderwear, { male: ['briefs'], female: ['panties', 'bra'] });
  for (const id of UNDERWEAR) {
    assert.ok(isUnderwear(CAT, id) && ITEMS[id].collidesAsLayer === false && !collidesAsLayer(ITEMS[id]), `${id}: underwear, no cloth layer`);
    assert.ok(ITEMS[id].colors.secondary, `${id}: primary + secondary colour`);
  }
  assert.equal(ITEMS.briefs.sex, 'male');
  assert.ok(ITEMS.panties.sex === 'female' && ITEMS.bra.sex === 'female');
});

test('size budget: every garment < 1 MB, the trench coat < 1.5 MB, underwear < 0.3 MB', () => {
  for (const it of CAT.items) {
    const max = it.id === 'trenchcoat' ? 1.5e6 : isUnderwear(CAT, it.id) ? 0.3e6 : 1.0e6;
    assert.ok(it.bytes < max, `${it.id}: ${it.bytes} bytes`);
  }
});

test('licences: CC0 MakeHuman system assets or project-original geometry, marked in the catalog + LICENSE-NOTES', () => {
  const lic = path.join(root, 'build', 'blend', 'asset_licenses.json');
  const recorded = fs.existsSync(lic) ? JSON.parse(fs.readFileSync(lic, 'utf8')) : null;   // build/ is not in git
  const notes = fs.readFileSync(path.join(root, 'LICENSE-NOTES.md'), 'utf8');
  for (const it of CAT.items) {
    if (it.license === 'project-original') {          // generated underwear: no third-party asset at all
      assert.match(it.projectOriginal, /add_generated/, `${it.id}: generator recorded`);
      assert.ok(!/clothes\//.test(it.source), `${it.id}: no asset source`);
      assert.ok(notes.includes(`clothing_${it.id}.glb`), `${it.id}: documented in LICENSE-NOTES.md`);
      continue;
    }
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
  assert.equal(ITEMS.hoodie.license, 'CC0 source + project-original extension');
  assert.match(ITEMS.hoodie.projectOriginal, /hood_down/);
  for (const id of ['shirt', 'shorts']) assert.equal(ITEMS[id].license, 'CC0', `${id}: plain CC0 asset`);
});

test('garment GLBs: one skinned mesh on body joints, the 92 body morph targets, tint + mask extras', () => {
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
    // measured (2026-10-01): shorts skin 2 / 14.3 mm (run, inner thigh), shirt 15 / 26.7 mm and hoodie 10 / 23.7 mm
    // (the sleeve at the armpit, like the tee), layers 1
    shorts: { skin: 4, mm: 20, layers: 0, legs: 4 }, shirt: { skin: 25, mm: 30, layers: 4 }, hoodie: { skin: 20, mm: 30, layers: 4 },
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
  const MAX = { shoes: 40, tshirt: 4, jeans: 4, skirt: 0, trenchcoat: 0, briefs: 0, panties: 0, bra: 0, shorts: 0, shirt: 0, hoodie: 0 };
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
  assert.deepEqual(wearRules(CAT, ['hoodie', 'jeans'], 'trenchcoat'), ['jeans', 'trenchcoat'], 'the coat takes the hoodie off (conflict)');
  assert.deepEqual(wearRules(CAT, ['trenchcoat', 'jeans'], 'hoodie'), ['jeans', 'hoodie'], 'conflict both ways');
  assert.deepEqual(wearRules(CAT, ['tshirt', 'jeans'], 'shirt'), ['jeans', 'shirt'], 'one top');
  assert.deepEqual(wearRules(CAT, ['shirt', 'jeans'], 'shorts'), ['shirt', 'shorts'], 'shorts replace the jeans');
  assert.deepEqual(resolveOutfit(CAT, ['shirt', 'jeans', 'trenchcoat', 'shoes']), ['shirt', 'jeans', 'trenchcoat', 'shoes']);
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

// ---- underwear (generated, layer 0; docs/CLOTH_SPEC.md "Underwear") ------------------------------------------------
const drawnTris = (id, worn) => {
  const g = D.garments[id].prim;
  return filterIndex(g.indices, { array: g.attr('_CCZONE') }, coveringZoneMask(CAT, worn, id)).length / 3;
};

test('underwear coverage: fully covered = nothing drawn, partial cover (skirt, open coat) = only the visible part', () => {
  const full = id => D.garments[id].prim.indices.length / 3;
  // fully covered: no triangle left -> web/clothing.js hides the mesh (not drawn, not skinned)
  for (const [id, over] of [['bra', ['tshirt']], ['bra', ['tshirt', 'skirt', 'trenchcoat']], ['bra', ['hoodie']]]) {
    assert.equal(drawnTris(id, [id, ...over]), 0, `${id} under ${over.join('+')}: nothing drawn`);
  }
  // Under the jeans a few triangles stay drawn (measured: briefs 73-76 of 892, panties 62 of 588): the waistband
  // along the jeans top edge (rule `edge`) and the crotch, whose skin the jeans do not hide either (a dropped
  // underwear triangle over skin hidden by the underwear's own zone was a hole through the body: the T-shirt-hem
  // holes of review 2026-10-01, tests/integrity.test.mjs 'no hole through the body'). Before that fix this asserted 0 drawn.
  for (const [id, over] of [['briefs', ['tshirt', 'jeans']], ['panties', ['tshirt', 'jeans']], ['briefs', ['jeans']],
    ['briefs', ['tshirt', 'jeans', 'trenchcoat', 'shoes']], ['panties', ['jeans']], ['briefs', ['hoodie', 'jeans']],
    ['briefs', ['shirt', 'shorts']]]) {
    const n = drawnTris(id, [id, ...over]);
    assert.ok(n <= 0.12 * full(id), `${id} under ${over.join('+')}: ${n} of ${full(id)} drawn (only waistband + crotch)`);
  }
  // the shorts (cut jeans, per-triangle cover test) leave a little more of the panties' leg line drawn (measured 81 of
  // 588); the open shirt collar leaves the top of the bra cups drawn (measured 20 of 860)
  assert.ok(drawnTris('panties', ['panties', 'shirt', 'shorts']) <= 0.15 * full('panties'), 'panties under shirt + shorts');
  assert.ok(drawnTris('bra', ['bra', 'shirt']) <= 0.05 * full('bra'), 'bra under the shirt: only the collar opening');
  // partial: the skirt hangs free below the hips (pin < 0.99 is never a cover), the coat is open at the front
  for (const [id, over] of [['briefs', ['tshirt', 'skirt']], ['panties', ['tshirt', 'skirt']], ['bra', ['trenchcoat']]]) {
    const n = drawnTris(id, [id, ...over]);
    assert.ok(n > 0.05 * full(id) && n < 0.8 * full(id), `${id} under ${over.join('+')}: partly drawn (${n} of ${full(id)})`);
  }
  assert.equal(drawnTris('briefs', ['briefs', 'trenchcoat']), full('briefs'), 'the open coat covers no briefs (its skirt is free)');
  // the underwear never hides other garments and is not hidden by another underwear item
  assert.equal(coveringZoneMask(CAT, ['panties', 'bra'], 'panties'), 0);
  for (const it of CAT.items.filter(i => !isUnderwear(CAT, i.id))) {
    assert.equal(coveringZoneMask(CAT, [it.id, ...UNDERWEAR], it.id) & hiddenZoneMask(CAT, UNDERWEAR), 0, `${it.id} not covered by underwear`);
  }
});

test('underwear on the skin: every morph extreme / corrective corner / breast extreme (bra follows breast morphs + dyn)', () => {
  // vertices > 2 mm inside VISIBLE skin (tools/cloth_check.mjs). Measured: briefs <= 4, panties <= 7 (edge vertices
  // at concave creases), bra <= 12 except two breast extremes where the body overlaps itself: at cup max + old +
  // firmness min the sagging breast folds over the underbust band (33 band vertices inside the breast, the skin covers
  // the band - no fabric pokes out) and at dyn_breast_back (full physics deflection, 20). Bra over the chest at
  // ordinary shapes: 0.
  const LIM = { briefs: 5, panties: 8, bra: 12 };
  const BRA_FOLD = { 'gender_female+breast_cup_max+age_old+breast_firm_min': 35, 'gender_female+breast_cup_max+dyn_breast_back': 22 };
  for (const id of UNDERWEAR) {
    for (const r of C.morphReport(D, id, [])) {
      const lim = (id === 'bra' && BRA_FOLD[r.shape]) || LIM[id];
      assert.ok(r.skin <= lim, `${id} ${r.shape}: ${r.skin} vertices inside visible skin (limit ${lim})`);
    }
  }
  // the bra follows the breast motion morphs (it carries them like the body)
  const g = D.garments.bra.prim, t = D.names.indexOf('dyn_breast_fwd');
  assert.ok(g.targets[t].filter(d => Math.hypot(...d) > 0.01).length > 20, 'bra follows dyn_breast_fwd');
});

test('underwear in walk / run, and outer garments over the drawn underwear (no underwear through jeans / skirt / coat)', { skip: !D.clips.walk }, () => {
  // measured: underwear skin <= 6 (<= 4.6 mm); outer over drawn underwear: jeans 3, skirt 2 (run), others 0
  for (const id of UNDERWEAR) {
    for (const clip of ['walk', 'run']) {
      for (const r of C.poseReport(D, id, clip, [], 4)) {
        assert.ok(r.skin <= 8 && Math.abs(r.worst) <= 6, `${id} ${clip} f${r.frame}: ${r.skin} inside skin, ${r.worst} mm`);
        assert.ok(r.stretchP99 < 3.5, `${id} ${clip} f${r.frame}: stretch ${r.stretchP99}`);
      }
    }
  }
  for (const [id, under] of OVER_UNDERWEAR) {
    // morph shapes: the garment's vertices inside the drawn underwear alone (the underwear zones still hide the skin)
    const uw = under.filter(u => UNDERWEAR.includes(u));
    const base = C.morphReport(D, id, under.filter(u => !uw.includes(u)));
    C.morphReport(D, id, under).forEach((r, k) => {
      const n = r.layers - base[k].layers;
      assert.ok(n <= 4, `${id} over ${under.join('+')} ${r.shape}: ${n} vertices inside the drawn underwear`);
    });
    for (const clip of ['walk', 'run']) {
      // The skinned (cloth off) coat sleeve swings into the torso at the armpit when the arm comes down from the A
      // pose (16-27 coat vertices inside the visible skin with NO underwear, 21-25 mm deep: the overlap the coat
      // limits above already carry). The bra cups the open coat leaves drawn sit there, so those same vertices count
      // again; the underwear may not add any beyond that bare-coat overlap (cloth on, the sleeve is simulated and
      // tools/cloth_integrity.mjs outfits 'coat' / 'coat+shoes' measure the coat over the underwear).
      const bare = C.poseReport(D, id, clip, [], 4);
      C.poseReport(D, id, clip, under.filter(u => UNDERWEAR.includes(u)), 4).forEach((r, k) => {
        const lim = Math.max(4, bare[k].skin);
        assert.ok(r.layers <= lim, `${id} over ${under.join('+')} ${clip} f${r.frame}: ${r.layers} inside the drawn underwear (limit ${lim}: bare ${id} skin ${bare[k].skin})`);
      });
    }
  }
});

test('underwear rules: default per sex, swap on sex change, explicit naked, kept / removed by the outfit', () => {
  assert.deepEqual(defaultUnderwear(CAT, 'male'), ['briefs']);
  assert.deepEqual(defaultUnderwear(CAT, 'female'), ['panties', 'bra']);
  assert.deepEqual(outfitWithUnderwear(CAT, null, 'male'), ['briefs'], 'nothing requested: default underwear');
  assert.deepEqual(outfitWithUnderwear(CAT, null, 'female'), ['panties', 'bra']);
  assert.deepEqual(outfitWithUnderwear(CAT, 'none', 'male'), [], '?outfit=none = naked');
  assert.deepEqual(outfitWithUnderwear(CAT, '', 'male'), [], '?outfit= = naked');
  assert.deepEqual(outfitWithUnderwear(CAT, [], 'female'), [], 'empty list = naked');
  assert.deepEqual(outfitWithUnderwear(CAT, 'tshirt,jeans', 'male'), ['briefs', 'tshirt', 'jeans']);
  assert.deepEqual(outfitWithUnderwear(CAT, ['tshirt', 'skirt'], 'female'), ['panties', 'bra', 'tshirt', 'skirt']);
  assert.deepEqual(outfitWithUnderwear(CAT, 'tshirt,jeans', 'male', false), ['tshirt', 'jeans'], '?underwear=0');
  assert.deepEqual(outfitWithUnderwear(CAT, 'panties,jeans', 'male'), ['panties', 'jeans'], 'explicit underwear kept');
  assert.deepEqual(swapUnderwearForSex(CAT, ['briefs', 'tshirt'], 'female'), ['panties', 'bra', 'tshirt']);
  assert.deepEqual(swapUnderwearForSex(CAT, ['panties', 'bra', 'jeans'], 'male'), ['briefs', 'jeans']);
  assert.deepEqual(swapUnderwearForSex(CAT, ['tshirt'], 'female'), ['tshirt'], 'taken off stays off');
  assert.deepEqual(swapUnderwearForSex(CAT, ['briefs'], 'male'), ['briefs']);
  assert.deepEqual(wearRules(CAT, ['briefs', 'jeans'], 'panties'), ['jeans', 'panties'], 'one item per underwear slot');
  assert.deepEqual(wearRules(CAT, ['panties', 'bra'], 'tshirt'), ['panties', 'bra', 'tshirt'], 'bra slot is separate');
  // body zones: the underwear hides the skin under it (the body triangles under the underwear are dropped)
  for (const id of UNDERWEAR) assert.ok(hiddenZoneMask(CAT, [id]) > 0 && C.holes(D, [id]).hidden > 100, `${id} hides skin`);
});
