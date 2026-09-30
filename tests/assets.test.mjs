// Face assets (eyes, eyebrows, eyelashes, teeth, tongue) in output/base_body.glb and the hair GLBs listed in
// output/hair.json: structure, skinning, morph targets that really follow the body, materials/tints.
// Run: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, meshParts, jointNames } from '../tools/glb.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = f => path.join(root, 'output', f);
const G = readGlb(out('base_body.glb'));
const P = meshParts(G);
const BODY = P.Body;
const FACE = ['Eyes', 'Eyebrows', 'Eyelashes', 'Teeth', 'Tongue'];
const HAIR_BONES = new Set(['head', 'neck_01', 'spine_03', 'spine_02', 'clavicle_l', 'clavicle_r']);
const manifest = JSON.parse(fs.readFileSync(out('hair.json'), 'utf8'));

const add = (a, b, w = 1) => [a[0] + w * b[0], a[1] + w * b[1], a[2] + w * b[2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mean = ps => ps.reduce((s, p) => add(s, p, 1 / ps.length), [0, 0, 0]);
const allVerts = part => part.prims.flatMap(p => p.pos);
const allTargets = (part, t) => part.prims.flatMap(p => p.targets[t]);

// Morph targets (blender/build_base.py MORPH_KIND): 12 macro, 26 face detail, 2 blink, 4 look, 16 correctives.
const NT = 60;
const kind = n => (n.startsWith('face_') ? 'face' : n.startsWith('blink_') ? 'expr' : n.startsWith('look_') ? 'look'
  : n.startsWith('corr_') ? 'corr' : 'macro');
const own = kind2 => kind2 === 'look' || kind2 === 'expr';       // eyes / lids move on their own

test('base GLB: Body + 5 face parts, one skin (53 joints), identical 60 morph target names', () => {
  assert.ok(BODY, 'node Body');
  assert.equal(G.json.skins.length, 1);
  assert.equal(jointNames(G).length, 53);
  const names = BODY.targetNames;
  assert.equal(names.length, NT);
  const count = k => names.filter(n => kind(n) === k).length;
  assert.deepEqual([count('macro'), count('face'), count('expr'), count('look'), count('corr')], [12, 26, 2, 4, 16]);
  assert.ok(G.json.extensionsRequired?.includes('KHR_mesh_quantization'), 'quantized morph deltas');
  for (const n of FACE) {
    assert.ok(P[n], `node ${n}`);
    assert.equal(P[n].nodeDef.skin, 0, `${n} skinned with skin 0`);
    assert.deepEqual(P[n].targetNames, names, `${n} target names`);
    for (const p of P[n].prims) assert.equal(p.targets.length, NT, `${n} targets per primitive`);
  }
  // body stays the first mesh (older tools used meshes[0])
  assert.equal(G.json.nodes[G.json.nodes.findIndex(n => n.name === 'Body')].mesh, 0);
});

test('face parts are rigid on the head bone (no neck/jaw pull, no drift in animation)', () => {
  const head = jointNames(G).indexOf('head');
  for (const n of FACE) {
    for (const p of P[n].prims) {
      p.joints.forEach((j, i) => {
        const w = p.weights[i];
        const onHead = j.reduce((s, ji, k) => s + (ji === head ? w[k] : 0), 0);
        assert.ok(Math.abs(onHead - 1) < 1e-3, `${n} vertex ${i}: head weight ${onHead}`);
      });
    }
  }
});

// A part follows morph m if its centroid moves like the body skin around it: mean displacement of the
// body vertices within r of the part's neutral centroid. Tolerance: 12 % of the displacement + 4 mm.
function followCheck(part, r, label) {
  const bpos = BODY.prims[0].pos, c0 = mean(allVerts(part));
  const near = bpos.map((p, i) => [p, i]).filter(([p]) => dist(p, c0) < r).map(([, i]) => i);
  assert.ok(near.length > 20, `${label}: body vertices near the part (${near.length})`);
  const worst = [];
  BODY.targetNames.forEach((m, t) => {
    if (own(kind(m))) return;                                     // tested separately below
    const dPart = mean(allTargets(part, t));
    const dBody = mean(near.map(i => BODY.prims[0].targets[t][i]));
    const err = dist(dPart, dBody), mag = Math.hypot(...dBody);
    worst.push([m, err, mag]);
    assert.ok(err < 0.12 * mag + 0.004, `${label} ${m}: moves ${JSON.stringify(dPart.map(v => +v.toFixed(4)))} vs skin ${JSON.stringify(dBody.map(v => +v.toFixed(4)))}`);
  });
  return worst;
}

test('face parts follow every body morph (eyes, brows, lashes, teeth, tongue)', () => {
  for (const n of FACE) followCheck(P[n], n === 'Teeth' || n === 'Tongue' ? 0.05 : 0.04, n);
});

test('teeth/tongue stay behind the lips, eyes behind the brow ridge, at every morph extreme', () => {
  const bpos = BODY.prims[0].pos;
  const front = (verts) => Math.max(...verts.map(p => p[2]));
  const nearBody = (c, r) => bpos.map((p, i) => [p, i]).filter(([p]) => dist(p, c) < r).map(([, i]) => i);
  const mouth = nearBody(mean(allVerts(P.Teeth)), 0.045);
  const eyeC = mean(allVerts(P.Eyes)), brow = nearBody(eyeC, 0.06);
  for (let t = -1; t < NT; t++) {
    if (t >= 0 && own(kind(BODY.targetNames[t]))) continue;
    const at = (part) => part.prims.flatMap(p => p.pos.map((v, i) => (t < 0 ? v : add(v, p.targets[t][i]))));
    const bodyAt = idx => idx.map(i => (t < 0 ? bpos[i] : add(bpos[i], BODY.prims[0].targets[t][i])));
    const m = t < 0 ? 'neutral' : BODY.targetNames[t];
    assert.ok(front(at(P.Teeth)) < front(bodyAt(mouth)) - 0.002, `${m}: teeth in front of the lips`);
    assert.ok(front(at(P.Tongue)) < front(at(P.Teeth)), `${m}: tongue in front of the teeth`);
    assert.ok(front(at(P.Eyes)) < front(bodyAt(brow)), `${m}: eyes in front of the brow/nose region`);
  }
});

test('blink morphs close the lids of one side; look morphs rotate only the eyeballs', () => {
  const ti = n => BODY.targetNames.indexOf(n);
  const bodyD = t => BODY.prims[0].targets[t];
  const eyeC = mean(allVerts(P.Eyes));
  for (const [n, side] of [['blink_left', 1], ['blink_right', -1]]) {
    const d = bodyD(ti(n)), pos = BODY.prims[0].pos;
    let best = 0, at = null;
    d.forEach((v, i) => { const m = Math.hypot(...v); if (m > best) { best = m; at = pos[i]; } });
    assert.ok(best > 0.005 && best < 0.02, `${n}: lid moves ${(best * 1000).toFixed(1)} mm`);
    assert.ok(Math.sign(at[0] - eyeC[0]) === side, `${n}: moving lid on the character's ${side > 0 ? 'left (+X)' : 'right (-X)'}`);
    assert.ok(dist(at, eyeC) < 0.06, `${n}: near the eyes`);
    const lash = Math.max(...allTargets(P.Eyelashes, ti(n)).map(v => Math.hypot(...v)));
    assert.ok(lash > 0.003, `${n}: lashes follow the lid (${(lash * 1000).toFixed(1)} mm)`);
  }
  for (const [n, axis, sign] of [['look_left', 0, 1], ['look_right', 0, -1], ['look_up', 1, 1], ['look_down', 1, -1]]) {
    const t = ti(n);
    // the front of the eyes (cornea / iris, largest z = facing +Z) moves in the look direction
    const verts = allVerts(P.Eyes), zmax = Math.max(...verts.map(p => p[2]));
    const front = verts.map((p, i) => [p, i]).filter(([p]) => p[2] > zmax - 0.004).map(([, i]) => i);
    const dm = mean(front.map(i => allTargets(P.Eyes, t)[i]));
    assert.ok(sign * dm[axis] > 0.003, `${n}: eye front moves ${JSON.stringify(dm.map(v => +v.toFixed(4)))}`);
    for (const other of ['Body', 'Eyebrows', 'Eyelashes', 'Teeth']) {
      const m = Math.max(...allTargets(P[other], t).map(v => Math.hypot(...v)));
      assert.ok(m < 1e-4, `${n}: ${other} does not move (${m})`);
    }
  }
});

test('materials: tint extras on tintable materials, defaults equal the viewer defaults', () => {
  const mats = Object.fromEntries(G.json.materials.map(m => [m.name, m]));
  for (const n of ['Skin', 'Eye', 'Iris', 'Cornea', 'Eyebrow', 'Eyelash', 'Teeth', 'Tongue']) assert.ok(mats[n], `material ${n}`);
  const main = fs.readFileSync(path.join(root, 'web', 'main.js'), 'utf8');
  const def = JSON.parse(main.match(/DEFAULT_TINTS = (\{[^}]+\})/)[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'));
  const want = { Skin: def.skin, Iris: def.eyeColor, Eyebrow: def.browColor, Eyelash: def.lashes };
  for (const [n, hex] of Object.entries(want)) {
    const t = mats[n].extras?.tint;
    assert.ok(t && t.gain > 1 && t.gain < 4, `${n} tint gain`);
    assert.equal(t.default, hex, `${n} default tint == web/main.js DEFAULT_TINTS`);
    const f = mats[n].pbrMetallicRoughness.baseColorFactor;
    assert.ok(f.every(v => v >= 0 && v <= 1), `${n} baseColorFactor within glTF range`);
  }
  assert.ok(mats.Skin.pbrMetallicRoughness.baseColorTexture && mats.Skin.normalTexture, 'skin albedo + normal map');
  assert.equal(mats.Cornea.alphaMode, 'BLEND');
  assert.equal(mats.Eyebrow.alphaMode, 'MASK');
  assert.equal(manifest.defaultColor, def.hairColor, 'hair default colour');
});

test('size budget: base GLB < 9 MB, base + default hair < 12 MB', () => {
  const base = fs.statSync(out('base_body.glb')).size;
  const hair = fs.statSync(out(manifest.styles.find(s => s.id === manifest.default).file)).size;
  assert.ok(base < 9e6, `base ${base}`);
  assert.ok(base + hair < 12e6, `base + hair ${base + hair}`);
});

test('hair.json: >= 8 styles, each GLB skinned to the body joints, 60 morphs, follows the head', () => {
  assert.ok(manifest.styles.length >= 8);
  assert.ok(manifest.styles.some(s => s.id === manifest.default));
  const baseJoints = new Set(jointNames(G));
  const upper = BODY.prims[0].pos.map((p, i) => [p, i]).filter(([p]) => p[1] > 1.1).map(([, i]) => i);
  for (const s of manifest.styles) {
    assert.equal(s.license, 'CC0', s.id);
    const h = readGlb(out(s.file));
    assert.equal(h.size, s.bytes, `${s.file} size recorded`);
    const parts = Object.values(meshParts(h));
    assert.equal(parts.length, 1, `${s.id}: one mesh`);
    const hp = parts[0];
    assert.deepEqual(hp.targetNames, BODY.targetNames, `${s.id} morph names`);
    const names = jointNames(h);
    for (const n of names) assert.ok(baseJoints.has(n), `${s.id}: joint ${n} in base skeleton`);
    for (const p of hp.prims) p.joints.forEach((j, i) => j.forEach((ji, k) => {
      if (p.weights[i][k] > 1e-4) assert.ok(HAIR_BONES.has(names[ji]), `${s.id}: weight on ${names[ji]}`);
    }));
    assert.equal(h.json.materials[0].alphaMode, 'MASK');
    const mesh0 = h.json.meshes[hp.nodeDef.mesh];
    for (const at of ['_CCHAIR', '_CCEDGE']) {
      assert.ok(mesh0.primitives.every(p => p.attributes[at] !== undefined), `${s.id}: attribute ${at}`);
    }
    assert.ok(h.json.materials[0].extras?.tint?.gain > 0);
    // hair moves like the skin under it: each (sampled) hair vertex vs its nearest upper-body vertex,
    // mean error <= 10 % of the mean skin displacement + 12 mm, for every morph. MHCLO fitting scales the
    // offsets with reference-vertex distances instead of tracking the nearest skin, so long hair lying on
    // the shoulders deviates by up to ~16 mm (height_tall: 0.6 m of motion); hair that did not follow a
    // morph at all would fail by the full displacement.
    const hv = allVerts(hp), step = Math.max(1, Math.floor(hv.length / 400));
    const pairs = [];
    for (let k = 0; k < hv.length; k += step) {
      let best = -1, bd = Infinity;
      for (const i of upper) { const d = dist(hv[k], BODY.prims[0].pos[i]); if (d < bd) { bd = d; best = i; } }
      pairs.push([k, best]);
    }
    const ht = BODY.targetNames.map((_, t) => allTargets(hp, t));
    BODY.targetNames.forEach((m, t) => {
      let err = 0, mag = 0;
      for (const [k, i] of pairs) {
        const db = BODY.prims[0].targets[t][i];
        err += dist(ht[t][k], db) / pairs.length; mag += Math.hypot(...db) / pairs.length;
      }
      // correctives are differences of combined shapes, so the MHCLO fit error of two shapes adds up: 25 %
      const tol = (kind(m) === 'corr' ? 0.25 : 0.1) * mag + 0.012;
      assert.ok(err < tol,`${s.id} ${m}: mean error ${(err * 1000).toFixed(1)} mm vs skin motion ${(mag * 1000).toFixed(1)} mm`);
    });
  }
});

// ---- runtime helpers (web/character.js) with fake three.js objects ------------------------------------
const C = await import('../web/character.js');
const fakeColor = () => ({ v: null, s: 1, set(h) { this.v = h; this.s = 1; return this; }, multiplyScalar(k) { this.s *= k; return this; } });

test('materialRole maps glTF material names to tint roles', () => {
  const want = { Skin: 'skin', Hair_short02: 'hair', Eyebrow: 'brows', Eyelash: 'lashes', Iris: 'eyes', Eye: null, Cornea: null, Teeth: null, Tongue: null };
  for (const [n, r] of Object.entries(want)) assert.equal(C.materialRole(n), r, n);
  assert.equal(C.materialRole(undefined), null);
});

test('applyTint multiplies by userData.tint.gain; applyTints visits each material once', () => {
  const skin = { name: 'Skin', color: fakeColor(), userData: { tint: { gain: 1.6 } } };
  const plain = { name: 'Skin', color: fakeColor(), userData: {} };
  C.applyTint(skin, '#c99a80');
  C.applyTint(plain, '#c99a80');
  assert.deepEqual([skin.color.v, skin.color.s], ['#c99a80', 1.6]);
  assert.deepEqual([plain.color.v, plain.color.s], ['#c99a80', 1]);
  const hair = { name: 'Hair_bob02', color: fakeColor(), userData: { tint: { gain: 2 } } };
  const eye = { name: 'Eye', color: fakeColor(), userData: {} };
  const tree = { material: skin, children: [{ material: [eye, hair], children: [{ material: hair }] }] };
  C.applyTints(tree, { skin: '#111111', hair: '#222222' });
  assert.deepEqual([skin.color.v, skin.color.s, hair.color.v, hair.color.s, eye.color.v], ['#111111', 1.6, '#222222', 2, null]);
});

test('bindToSkeleton remaps skinIndex by bone name onto the body skeleton', () => {
  const bone = n => ({ name: n });
  const body = { bones: ['Root', 'pelvis', 'spine_01', 'head'].map(bone) };
  let bound = null;
  const mesh = {
    name: 'Hair', skeleton: { bones: ['head', 'spine_01'].map(bone) }, bindMatrix: 'own',
    geometry: { attributes: { skinIndex: { array: new Uint16Array([0, 1, 0, 0, 1, 0, 0, 0]), needsUpdate: false } } },
    bind(s, m) { bound = [s, m]; },
  };
  const r = C.bindToSkeleton(mesh, body, 'bodyBind');
  assert.deepEqual(r, { remapped: true, missing: [] });
  assert.deepEqual([...mesh.geometry.attributes.skinIndex.array], [3, 2, 3, 3, 2, 3, 3, 3]);
  assert.ok(mesh.geometry.attributes.skinIndex.needsUpdate);
  assert.deepEqual(bound, [body, 'bodyBind']);
  // unknown bone: left untouched
  const warn = console.warn; console.warn = () => {};
  const m2 = { ...mesh, skeleton: { bones: [bone('tail')] }, geometry: { attributes: { skinIndex: { array: new Uint16Array([0]) } } } };
  assert.deepEqual(C.bindToSkeleton(m2, body), { remapped: false, missing: ['tail'] });
  console.warn = warn;
});

test('characterMeshes finds every skinned mesh with morph targets', () => {
  const sm = n => ({ name: n, isSkinnedMesh: true, morphTargetInfluences: [], morphTargetDictionary: {} });
  const root = { children: [sm('Body'), { children: [sm('Eyes'), { name: 'plain', isMesh: true }] }] };
  assert.deepEqual(C.characterMeshes(root).map(m => m.name), ['Body', 'Eyes']);
});
