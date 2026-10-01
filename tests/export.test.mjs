// glTF export helpers (web/export/util.js, web/export/glbpack.js): settings JSON round trip / URL param,
// export options, tint baking math, name sanitising, credits metadata, bone table, animation helpers and the
// GLB morph-target compaction on a synthetic GLB. The browser part (web/export/exporter.js, GLTFExporter) is
// verified end to end in headless Chrome + gltf-validator + Blender, see docs/EXPORT.md "Verification".
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as U from '../web/export/util.js';
import { parseGlb, buildGlb, readFloatAccessor, compactMorphTargets, dedupeSkins, applyMetadata, postProcessGlb } from '../web/export/glbpack.js';
import { SLIDERS } from '../web/character.js';
import { CLIPS } from '../web/animation/clips.js';
import { JOINT_NAMES } from '../web/animation/canonical.js';
import { MPFB_GAME_ENGINE } from '../web/animation/rig.js';

const dir = fileURLToPath(new URL('..', import.meta.url));
const readJson = f => JSON.parse(fs.readFileSync(`${dir}/output/${f}`, 'utf8'));
const SLIDER_IDS = SLIDERS.map(s => s.id);
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} != ${b}`);

// ---- settings -----------------------------------------------------------------------------------------

const STATE = {
  sex: 'female',
  values: { height: 0.25, weight: -0.123456, breastSize: 0.8, gender: -1 },
  colors: { skin: '#C08060', eyeColor: '#336699', hairColor: '#d8b070', browColor: '#202020' },
  hair: 'long01', outfit: ['skirt', 'shirt'],
  clothColors: { shirt: { primary: '#3060c0', secondary: '#ffffff' }, skirt: { primary: '#222222' }, jeans: { primary: '#000000' } },
};

test('settings: makeSettings -> JSON -> normalizeSettings round trip', () => {
  const s = U.makeSettings(STATE, SLIDER_IDS);
  assert.equal(s.format, U.SETTINGS_FORMAT);
  assert.equal(s.version, U.SETTINGS_VERSION);
  assert.equal(s.sex, 'female');
  assert.equal(s.values.gender, undefined, 'sex is stored as sex, not as the gender slider');
  assert.equal(s.values.weight, -0.1235, 'values rounded to 4 decimals');
  assert.equal(s.colors.skin, '#c08060', 'colours lower-cased');
  assert.deepEqual(Object.keys(s.clothColors).sort(), ['shirt', 'skirt'], 'only worn items keep colours');
  const back = U.normalizeSettings(JSON.parse(JSON.stringify(s)), SLIDER_IDS);
  assert.deepEqual(back, s);
});

test('settings: normalizeSettings cleans hostile / sloppy input', () => {
  const s = U.normalizeSettings({
    values: { height: 7, weight: 'x', notASlider: 0.5, gender: -0.9 }, colors: { skin: 'red', eyeColor: '#ABCDEF' },
    hair: '../../etc', outfit: 'tshirt, jeans,,none,<script>,jeans', clothColors: { tshirt: { primary: '#123456', secondary: 'blue' }, 'a b': { primary: '#000000' } },
  }, SLIDER_IDS);
  assert.equal(s.sex, 'female', 'legacy gender value < 0 -> female');
  assert.deepEqual(s.values, { height: 1 });
  assert.deepEqual(s.colors, { eyeColor: '#abcdef' });
  assert.equal(s.hair, null);
  assert.deepEqual(s.outfit, ['tshirt', 'jeans']);
  assert.deepEqual(s.clothColors, { tshirt: { primary: '#123456' } });
  assert.throws(() => U.normalizeSettings({ format: 'something.else' }, SLIDER_IDS), /format/);
  assert.throws(() => U.normalizeSettings({ format: U.SETTINGS_FORMAT, version: 99 }, SLIDER_IDS), /version/);
  assert.throws(() => U.normalizeSettings([], SLIDER_IDS));
});

test('settings: ?character= param (base64url, inline JSON, URL) and settingsFromAny', () => {
  const s = U.makeSettings({ ...STATE, hair: 'short02', colors: { ...STATE.colors } }, SLIDER_IDS);
  const p = U.encodeSettingsParam(s);
  assert.match(p, /^[A-Za-z0-9_-]+$/, 'URL-safe without padding');
  assert.deepEqual(U.decodeSettingsParam(p).settings, s);
  assert.deepEqual(U.decodeSettingsParam(JSON.stringify(s)).settings, s);
  assert.deepEqual(U.decodeSettingsParam(` ${JSON.stringify(s)} `).settings, s, 'inline JSON, trimmed');
  assert.equal(U.fromBase64Url(U.toBase64Url('æøå ✓')), 'æøå ✓', 'UTF-8 safe');
  assert.deepEqual(U.decodeSettingsParam('https://example.org/c.json'), { url: 'https://example.org/c.json' });
  assert.deepEqual(U.decodeSettingsParam('./chars/a.json'), { url: './chars/a.json' });
  assert.deepEqual(U.decodeSettingsParam('mine.json'), { url: 'mine.json' });
  assert.throws(() => U.decodeSettingsParam(''));
  assert.throws(() => U.decodeSettingsParam('!!!not base64!!!'));
  // GLB extras -> settings
  assert.deepEqual(U.settingsFromAny({ characterCreator: { format: 'charactercreator.export', settings: s } }), s);
  assert.deepEqual(U.settingsFromAny({ format: 'charactercreator.export', settings: s }), s);
  assert.deepEqual(U.settingsFromAny(s), s);
});

test('export options: defaults, aliases, clamping, file name', () => {
  const d = U.normalizeExportOptions();
  assert.equal(d.shape, 'baked'); assert.equal(d.pose, 'rest'); assert.equal(d.animations, 'none');
  assert.equal(d.fps, 60); assert.equal(d.textureSize, 0); assert.equal(d.removeHiddenSkin, true);
  assert.equal(d.quantize, false, 'auto quantize only for morph mode');
  const m = U.normalizeExportOptions({ shape: 'morphTargets', animations: true, fps: 1000, textureSize: '512', merge: 1, pose: 'current' });
  assert.equal(m.shape, 'morphs'); assert.equal(m.animations, 'all'); assert.equal(m.fps, 120);
  assert.equal(m.textureSize, 512); assert.equal(m.merge, true); assert.equal(m.pose, 'current'); assert.equal(m.quantize, true);
  assert.deepEqual(U.normalizeExportOptions({ animations: ['walk', 3] }).animations, ['walk', '3']);
  assert.equal(U.exportFileName({ sex: 'male' }, m), 'character_male_morphs_anim.glb');
  assert.equal(U.exportFileName(null, d), 'character_x_baked.glb');
});

// ---- names --------------------------------------------------------------------------------------------

test('names: sanitizeName / uniqueNamer', () => {
  assert.equal(U.sanitizeName('Cloth_tshirt'), 'Cloth_tshirt');
  assert.equal(U.sanitizeName('Øjenbryn (venstre)'), 'Ojenbryn_venstre');
  assert.equal(U.sanitizeName('Hårfarve æble'), 'Harfarve_aeble');
  assert.equal(U.sanitizeName('Café crème'), 'Cafe_creme', 'accents folded');
  assert.equal(U.sanitizeName('  '), 'node');
  assert.equal(U.sanitizeName('', 'Mesh'), 'Mesh');
  assert.equal(U.sanitizeName('3d model'), '_3d_model', 'no leading digit');
  assert.equal(U.sanitizeName('a'.repeat(100)).length, 63);
  assert.match(U.sanitizeName('x/y\\z:w*"<>|'), /^[A-Za-z0-9_.-]+$/);
  const n = U.uniqueNamer();
  assert.deepEqual(['Body', 'Body', 'Body', 'Eyes', 'Body_1'].map(x => n(x)), ['Body', 'Body_1', 'Body_2', 'Eyes', 'Body_1_1']);
});

// ---- tints --------------------------------------------------------------------------------------------

test('tint: sRGB <-> linear and hexToLinear', () => {
  for (const v of [0, 0.002, 0.04, 0.2, 0.5, 0.9, 1]) near(U.linearToSrgb(U.srgbToLinear(v)), v, 1e-9);
  assert.deepEqual(U.hexToLinear('#000000'), [0, 0, 0]);
  assert.deepEqual(U.hexToLinear('#ffffff'), [1, 1, 1]);
  near(U.hexToLinear('#808080')[0], 0.2158605, 1e-6);
});

test('tint: planTint factor / bake decisions', () => {
  // in range, no secondary: factor only, no bake
  let p = U.planTint([0.5, 0.25, 1]);
  assert.deepEqual(p.factor, [0.5, 0.25, 1]); assert.equal(p.bake, false); assert.deepEqual(p.primaryMul, [1, 1, 1]);
  // over-range (grey-normalisation gain): factor clamped, the rest baked
  p = U.planTint([1.6, 0.8, 0.4]);
  assert.deepEqual(p.factor, [1, 0.8, 0.4]); assert.equal(p.bake, true);
  near(p.primaryMul[0], 1.6); near(p.primaryMul[1], 1); near(p.primaryMul[2], 1);
  // secondary: always baked, factor = max of both, factor * mul reproduces each colour
  const prim = [0.2, 0.6, 1.3], sec = [0.9, 0.1, 0.5];
  p = U.planTint(prim, sec);
  assert.equal(p.bake, true);
  assert.deepEqual(p.factor, [0.9, 0.6, 1]);
  for (let i = 0; i < 3; i++) { near(p.factor[i] * p.primaryMul[i], prim[i]); near(p.factor[i] * p.secondaryMul[i], sec[i]); }
  // black channel: no division by zero
  p = U.planTint([0, 0.5, 0.5]);
  assert.deepEqual(p.primaryMul, [0, 1, 1]); assert.equal(p.bake, false);
});

test('tint: bakeTintPixels reproduces texel * tint (factor * baked texel == runtime colour)', () => {
  const L = U.srgbToLinear;
  const texel = [200, 150, 100, 77];
  const prim = [1.5, 0.7, 0.3], sec = [0.2, 0.9, 1.4];
  const plan = U.planTint(prim, sec);
  for (const maskV of [0, 128, 255]) {
    const d = Uint8ClampedArray.from(texel);
    U.bakeTintPixels(d, plan, Uint8Array.of(maskV));
    assert.equal(d[3], 77, 'alpha kept');
    const m = maskV / 255;
    for (let c = 0; c < 3; c++) {
      const runtime = L(texel[c] / 255) * (prim[c] * (1 - m) + sec[c] * m);               // what the viewer shader does
      const glTF = L(d[c] / 255) * plan.factor[c];                                            // baseColorTexture * factor
      // 8-bit sRGB requantisation; values the runtime pushes over 1 clamp in both (display clamps anyway)
      near(Math.min(glTF, plan.factor[c]), Math.min(runtime, plan.factor[c]), 0.006, `mask ${maskV} ch ${c}: ${glTF} vs ${runtime}`);
    }
  }
  // no mask -> primary everywhere
  const d = Uint8ClampedArray.from([255, 255, 255, 255]);
  U.bakeTintPixels(d, U.planTint([1.25, 1, 0.5]));
  assert.deepEqual([...d], [255, 255, 255, 255], 'factor (1,1,0.5) * texel already gives the colour, 1.25 clamps');
});

// ---- credits ------------------------------------------------------------------------------------------

test('credits: built from asset_licenses.json + hair/clothing manifests, CC0 only', () => {
  const assetLicenses = readJson('asset_licenses.json'), hairManifest = readJson('hair.json'), catalog = readJson('clothing.json');
  const outfit = catalog.items.slice(0, 3).map(i => i.id);
  const hair = hairManifest.styles[0].id;
  const c = U.buildCredits({ assetLicenses, hairManifest, catalog, hair, outfit });
  assert.equal(c.summary, U.CREDITS_SUMMARY);
  assert.match(c.summary, /CC0/);
  const parts = c.sources.map(s => s.part);
  for (const p of ['base body', 'skins', 'eyes', 'eyebrows', 'eyelashes', 'teeth', 'tongue', 'hair', 'clothing', 'project output']) assert.ok(parts.includes(p), `credits miss ${p}`);
  assert.equal(c.sources.filter(s => s.part === 'clothing').length, outfit.length);
  assert.equal(c.sources.filter(s => s.part === 'hair').length, 1, 'only the worn hair style');
  // CC0 or the project's own work only (clothing.json licence strings: 'CC0', 'project-original', 'CC0 source + project-original extension')
  for (const s of c.sources) if (s.part !== 'project output') assert.match(s.license, /^(CC0-1\.0|project-original|CC0 source \+ project-original extension)$/, `${s.part}/${s.asset}: ${s.license}`);
  const all = U.buildCredits({ assetLicenses, hairManifest, catalog, hair, outfit: catalog.items.map(i => i.id) });
  for (const s of all.sources) if (s.part === 'clothing') assert.ok(s.license && s.source, `${s.asset}: licence + source`);
  // no machine paths in the metadata
  assert.doesNotMatch(JSON.stringify(c), /[A-Z]:\\|\/Users\/|\/home\//);
  // no hair, nothing worn
  const bare = U.buildCredits({ assetLicenses, hairManifest, catalog });
  assert.equal(bare.sources.filter(s => s.part === 'hair' || s.part === 'clothing').length, 0);
  assert.ok(U.buildCredits().sources.length >= 2, 'works without manifests');
});

// ---- bones / animation helpers -------------------------------------------------------------------------

test('bone table: one row per mapped joint, unique engine names', () => {
  const rows = U.humanoidBoneTable();
  assert.equal(rows.length, JOINT_NAMES.filter(j => MPFB_GAME_ENGINE[j]).length);
  const by = Object.fromEntries(rows.map(r => [r.vrm, r]));
  assert.deepEqual(by.hips, { vrm: 'hips', bone: MPFB_GAME_ENGINE.hips, unity: 'Hips', godot: 'Hips', mixamo: 'mixamorig:Hips' });
  assert.equal(by.leftUpperArm.mixamo, 'mixamorig:LeftArm');
  assert.equal(by.rightLowerLeg.unity, 'RightLowerLeg');
  if (by.leftThumbMetacarpal) assert.equal(by.leftThumbMetacarpal.unity, 'LeftThumbProximal');
  if (by.leftIndexProximal) assert.equal(by.leftIndexProximal.mixamo, 'mixamorig:LeftHandIndex1');
  for (const k of ['bone', 'unity', 'godot']) assert.equal(new Set(rows.map(r => r[k])).size, rows.length, `${k} names unique`);
  assert.equal(U.ROOT_BONE, 'Root');
});

test('animation helpers: keyTimes, alignQuaternionTrack, collapseConstantTrack, dynamicMorph', () => {
  const t = U.keyTimes(1.03, 60);
  assert.equal(t.length, 63); assert.equal(t[0], 0); near(t[t.length - 1], 1.03, 1e-6);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
  assert.equal(U.keyTimes(0.001, 30).length, 3, 'at least 2 intervals');
  for (const c of Object.values(CLIPS)) assert.ok(typeof c.sample === 'function' && typeof c.timing === 'function');

  const q = Float32Array.of(0, 0, 0, 1, 0, 0, 0, -1, 0, 0.1, 0, -0.995, 0, 0.2, 0, 0.98);
  U.alignQuaternionTrack(q);
  for (let i = 4; i < q.length; i += 4) {
    const d = q[i] * q[i - 4] + q[i + 1] * q[i - 3] + q[i + 2] * q[i - 2] + q[i + 3] * q[i - 1];
    assert.ok(d >= 0, `key ${i / 4} sign-continuous`);
  }
  assert.deepEqual([...q.slice(4, 8)], [-0, -0, -0, 1]);

  const times = Float32Array.of(0, 0.5, 1);
  const c = U.collapseConstantTrack(times, Float32Array.of(1, 2, 3, 1, 2, 3, 1, 2, 3), 3);
  assert.deepEqual([...c.times], [0, 1]); assert.deepEqual([...c.values], [1, 2, 3, 1, 2, 3]);
  const v = Float32Array.of(1, 2, 3, 1, 2, 3.1, 1, 2, 3);
  assert.equal(U.collapseConstantTrack(times, v, 3).values, v, 'varying track unchanged');

  assert.ok(U.dynamicMorph('blink_left')); assert.ok(U.dynamicMorph('look_up'));
  assert.ok(!U.dynamicMorph('dyn_breast_up')); assert.ok(U.dynamicMorph('dyn_breast_up', { breasts: true }));
  assert.ok(!U.dynamicMorph('height_up', { breasts: true }));
});

// ---- glbpack ------------------------------------------------------------------------------------------

/** Synthetic GLB: one mesh, 2 primitives sharing nothing, 4 targets (sparse, dense, zero, duplicate), 2 equal skins. */
function synthGlb(n = 200) {
  const chunks = [], views = [], accessors = [];
  let off = 0;
  const add = (arr, acc, view = {}) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, ...view });
    chunks.push(bytes); off += bytes.length;
    const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); off += pad; }
    accessors.push({ bufferView: views.length - 1, ...acc });
    return accessors.length - 1;
  };
  const pos = new Float32Array(n * 3).map((_, i) => (i % 7) * 0.1);
  const posAcc = add(pos, { componentType: 5126, count: n, type: 'VEC3', min: [0, 0, 0], max: [0.6, 0.6, 0.6] });
  const sparseT = new Float32Array(n * 3); sparseT[3 * 5] = 0.01; sparseT[3 * 9 + 2] = -0.02;
  const denseT = new Float32Array(n * 3).map((_, i) => Math.sin(i) * 0.05);
  const bigT = new Float32Array(n * 3).map((_, i) => (i === 0 ? 2.5 : 0.001 * (i % 3)));   // > 1 m: never quantised
  const zeroT = new Float32Array(n * 3);
  const tAcc = arr => add(arr, { componentType: 5126, count: n, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] });
  const t = [tAcc(sparseT), tAcc(denseT), tAcc(zeroT), tAcc(Float32Array.from(sparseT)), tAcc(bigT)];
  const ibm = new Float32Array(32); ibm[0] = ibm[5] = ibm[10] = ibm[15] = ibm[16] = ibm[21] = ibm[26] = ibm[31] = 1;
  const ibmA = add(ibm, { componentType: 5126, count: 2, type: 'MAT4' });
  const ibmB = add(Float32Array.from(ibm), { componentType: 5126, count: 2, type: 'MAT4' });
  const unused = add(new Float32Array(30), { componentType: 5126, count: 10, type: 'VEC3' });
  const bin = new Uint8Array(off); let o = 0; for (const c of chunks) { bin.set(c, o); o += c.length; }
  const targets = t.map(a => ({ POSITION: a }));
  const json = {
    asset: { version: '2.0', generator: 'THREE.GLTFExporter' },
    scene: 0, scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: 'Root', children: [] }, { name: 'Body', mesh: 0, skin: 0 }, { name: 'Hair', mesh: 1, skin: 1 }, { name: 'B2' }],
    meshes: [{ primitives: [{ attributes: { POSITION: posAcc }, targets }], extras: { targetNames: ['a', 'b', 'c', 'd', 'e'] } },
      { primitives: [{ attributes: { POSITION: posAcc }, targets: targets.slice(0, 2) }] }],
    skins: [{ joints: [0, 3], inverseBindMatrices: ibmA }, { joints: [0, 3], inverseBindMatrices: ibmB }],
    accessors, bufferViews: views, buffers: [{ byteLength: off }],
  };
  return { json, bin, unused, data: { sparseT, denseT, zeroT, bigT, pos } };
}

test('glbpack: buildGlb / parseGlb round trip (4-byte aligned chunks)', () => {
  const { json, bin } = synthGlb();
  const ab = buildGlb(json, bin);
  assert.equal(ab.byteLength % 4, 0);
  const back = parseGlb(ab);
  assert.deepEqual(back.json, json);
  assert.deepEqual([...back.bin.subarray(0, bin.length)], [...bin]);
  assert.throws(() => parseGlb(new ArrayBuffer(16)), /not a GLB/);
});

for (const quantize of [false, true]) {
  test(`glbpack: compactMorphTargets keeps every delta (quantize ${quantize})`, () => {
    const { json, bin, data } = synthGlb();
    const r = compactMorphTargets(json, bin, { quantize });
    assert.equal(r.stats.targets, 5); assert.equal(r.stats.shared, 1, 'duplicate target shared');
    assert.equal(r.stats.zero, 1); assert.ok(r.stats.sparse >= 1);
    assert.equal(r.json.skins.length, 1, 'equal skins merged');
    assert.equal(r.json.nodes[1].skin, 0); assert.equal(r.json.nodes[2].skin, 0);
    assert.equal(r.json.accessors.length < json.accessors.length, true, 'unused accessors dropped');
    assert.equal(r.json.buffers[0].byteLength, r.bin.length);
    for (const v of r.json.bufferViews) assert.equal(v.byteOffset % 4, 0, 'aligned views');
    // decode each target (dequantise normalized int16) and compare
    const p = r.json.meshes[0].primitives[0];
    assert.equal(p.targets[0].POSITION, p.targets[3].POSITION);
    const decode = ai => {
      const a = r.json.accessors[ai];
      if (a.componentType === 5126) return readFloatAccessor(r.json, r.bin, ai);
      assert.ok(a.normalized); assert.equal(a.componentType, 5122);
      const out = new Float32Array(a.count * 3);
      const rd = (bv, extraOff, k) => new DataView(r.bin.buffer, r.bin.byteOffset + (r.json.bufferViews[bv].byteOffset || 0) + (extraOff || 0)).getInt16(k * 2, true);
      if (a.bufferView !== undefined) {
        const stride = r.json.bufferViews[a.bufferView].byteStride || 6;
        for (let i = 0; i < a.count; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(-1, new DataView(r.bin.buffer, r.bin.byteOffset + r.json.bufferViews[a.bufferView].byteOffset).getInt16(i * stride + c * 2, true) / 32767);
      }
      if (a.sparse) {
        const s = a.sparse, iv = r.json.bufferViews[s.indices.bufferView];
        const idv = new DataView(r.bin.buffer, r.bin.byteOffset + iv.byteOffset);
        for (let k = 0; k < s.count; k++) {
          const i = s.indices.componentType === 5123 ? idv.getUint16(k * 2, true) : idv.getUint32(k * 4, true);
          for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(-1, rd(s.values.bufferView, 0, k * 3 + c) / 32767);
        }
      }
      return out;
    };
    const exp = [data.sparseT, data.denseT, data.zeroT, data.sparseT, data.bigT];
    p.targets.forEach((t, k) => {
      const got = decode(t.POSITION), a = r.json.accessors[t.POSITION];
      const tol = a.componentType === 5126 ? 0 : 0.5 / 32767 + 1e-9;
      for (let i = 0; i < got.length; i++) near(got[i], exp[k][i], tol, `target ${k} [${i}]`);
      if (k === 2) assert.equal(a.bufferView, undefined, 'all-zero target has no bufferView');
      if (k === 4) assert.equal(a.componentType, 5126, 'deltas > 1 m stay float');
      for (let c = 0; c < 3; c++) assert.ok(a.min[c] <= a.max[c]);
    });
    if (quantize) {
      assert.ok(r.stats.quantized >= 1);
      assert.ok(r.json.extensionsRequired.includes('KHR_mesh_quantization'));
      for (const ai of p.targets.map(t => t.POSITION)) {
        const a = r.json.accessors[ai];
        if (a.componentType === 5122) for (const v of [...a.min, ...a.max]) assert.ok(Number.isInteger(v), 'int16 min/max are integers');
      }
    } else {
      assert.equal(r.json.extensionsRequired, undefined);
      assert.equal(r.stats.quantized, 0);
    }
    assert.equal(r.json.meshes[1].primitives[0].targets[0].POSITION, p.targets[0].POSITION, 'shared across meshes');
  });
}

test('glbpack: dedupeSkins keeps skins with different joints or matrices apart', () => {
  const { json, bin } = synthGlb();
  json.skins[1].joints = [0];
  dedupeSkins(json, bin);
  assert.equal(json.skins.length, 2);
});

test('glbpack: applyMetadata + postProcessGlb', () => {
  const { json, bin } = synthGlb();
  json.animations = [{ name: 'walk', channels: [], samplers: [] }];
  const meta = {
    generator: 'CharacterCreator export v1', copyright: U.CREDITS_SUMMARY,
    extras: { characterCreator: { format: 'charactercreator.export', version: U.EXPORT_VERSION } },
    sceneExtras: { units: 'm' }, animationExtras: { walk: { loop: true } },
    nodeExtras: { Hair: { ccSlot: 'hair' } }, meshExtras: { Body: { ccJiggle: { a: 1 } } },
  };
  const { glb, stats, json: out } = postProcessGlb(buildGlb(json, bin), { quantize: false, metadata: meta });
  assert.equal(stats.targets, 5);
  const back = parseGlb(glb).json;
  assert.deepEqual(back, out);
  assert.equal(back.asset.version, '2.0');
  assert.equal(back.asset.generator, meta.generator);
  assert.equal(back.asset.copyright, U.CREDITS_SUMMARY);
  assert.equal(back.extras.characterCreator.version, U.EXPORT_VERSION);
  assert.equal(back.scenes[0].extras.units, 'm');
  assert.deepEqual(back.animations[0].extras, { loop: true });
  assert.equal(back.nodes[2].extras.ccSlot, 'hair');
  assert.deepEqual(back.meshes[0].extras.ccJiggle, { a: 1 });
  assert.deepEqual(back.meshes[0].extras.targetNames, ['a', 'b', 'c', 'd', 'e'], 'existing extras kept');
  assert.equal(back.meshes[0].name, 'Body', 'mesh named after its node');
  assert.equal(U.settingsFromAny(applyMetadata({}, meta).extras).format, 'charactercreator.export');
});
