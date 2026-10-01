// Engine-agnostic slider model -> glTF morph target influences (works on any glTF loader).
// Bipolar sliders map -1..1 onto a pair of morph targets (neg/pos).
// `scale` caps the maximum influence of a side: a number (both sides) or { neg, pos } (default 1).
// Morphs are linear offsets baked at the macro extremes, so e.g. height_tall at 1.0 is ~+0.7 m;
// scaling the positive height side to 0.45 keeps the tallest setting around +0.3 m.
// group 'body': MakeHuman macro morphs; group 'face': MakeHuman detail targets (face_<stem>_decr / _incr,
// blender/build_base.py FACE_TARGETS). Face morphs are carried by every part (eyes, brows, lashes, teeth,
// hair), so e.g. the hair follows a longer forehead or larger ears. They move no joints.
//
// Sex is binary: the 'gender' entry (binary: true) is not a slider in the UI but a male / female switch that sets
// gender = +1 (male, SEXES.male) or -1 (female). Both ends are exact MakeHuman macro samples (gender 1.0 / 0.0), so
// every morph, corrective, garment fit, collider and joint offset is exact there. Scripts may still pass values in
// between (old calls keep working, they are clamped like any slider). sexOf(values) reads it back.
// group 'breast': female-only sliders (MakeHuman breast macros breast_cup_* / breast_firm_* and detail targets
// bdet_*), gated by breastGate(values) = female weight x adult: 0 for a male or a child, so they never show there.
// `default` = the value the viewer starts with and Reset returns to (defaultValues()); missing values in
// sliderInfluences() still mean 0.
export const SLIDERS = [
  { id: 'gender',      group: 'body', label: 'Køn',                   neg: 'gender_female',        pos: 'gender_male', binary: true, default: 1 },
  { id: 'age',         group: 'body', label: 'Alder (barn ↔ gammel)', neg: 'age_child',            pos: 'age_old' },
  { id: 'height',      group: 'body', label: 'Højde',                 neg: 'height_short',         pos: 'height_tall', scale: { pos: 0.45 } },
  { id: 'weight',      group: 'body', label: 'Vægt',                  neg: 'weight_min',           pos: 'weight_max' },
  { id: 'muscle',      group: 'body', label: 'Muskler',               neg: 'muscle_min',           pos: 'muscle_max' },
  { id: 'proportions', group: 'body', label: 'Proportioner',          neg: 'proportions_uncommon', pos: 'proportions_ideal' },
  ...[
    ['noseWidth', 'nose_width', 'Næsebredde'], ['noseLength', 'nose_length', 'Næselængde'],
    ['noseHeight', 'nose_height', 'Næsehøjde'], ['jawWidth', 'jaw_width', 'Kæbebredde'],
    ['chin', 'chin', 'Hage'], ['cheekbones', 'cheekbones', 'Kindben'],
    ['eyeSize', 'eye_size', 'Øjenstørrelse', 0.7], ['eyeSpacing', 'eye_spacing', 'Øjenafstand'],
    ['eyeTilt', 'eye_tilt', 'Øjenhældning'], ['lips', 'lips', 'Læber'],
    ['mouthWidth', 'mouth_width', 'Mundbredde'], ['earSize', 'ear_size', 'Ørestørrelse'],
    ['forehead', 'forehead', 'Pande', 0.6],
  ].map(([id, stem, label, scale]) => ({ id, group: 'face', label, neg: `face_${stem}_decr`, pos: `face_${stem}_incr`, ...(scale ? { scale } : {}) })),
  { id: 'breastSize',       group: 'breast', label: 'Størrelse', neg: 'breast_cup_min',  pos: 'breast_cup_max',  default: 0.35 },
  { id: 'breastFirmness',   group: 'breast', label: 'Fasthed',   neg: 'breast_firm_min', pos: 'breast_firm_max', default: 0.45 },
  { id: 'breastHeight',     group: 'breast', label: 'Højde',     neg: 'bdet_breast_height_decr', pos: 'bdet_breast_height_incr', default: 0 },
  { id: 'breastSpacing',    group: 'breast', label: 'Afstand',   neg: 'bdet_breast_dist_decr',   pos: 'bdet_breast_dist_incr',   default: 0 },
  { id: 'breastProjection', group: 'breast', label: 'Form',      neg: 'bdet_breast_point_decr',  pos: 'bdet_breast_point_incr',  default: 0 },
];
export const FACE_SLIDERS = SLIDERS.filter(s => s.group === 'face');
export const BREAST_SLIDERS = SLIDERS.filter(s => s.group === 'breast');

// ---- sex -----------------------------------------------------------------------------------------------
export const SEXES = { male: 1, female: -1 };
/** 'male' | 'female' from slider values (gender >= 0 is male; a missing gender is the default, male). */
export const sexOf = values => ((Number(values?.gender ?? 1) || 0) < 0 ? 'female' : 'male');
/** Parses a sex given as 'male' | 'female' | 'm' | 'f' | 1 (male) | 0 (female) | -1 (female) -> gender value
 *  (+1 / -1), or null when it cannot be read. 0/1 follows MakeHuman's gender macro (0 = female, 1 = male). */
export function genderOfSex(sex) {
  if (typeof sex === 'string') {
    const s = sex.trim().toLowerCase();
    if (s === 'male' || s === 'm' || s === '1') return SEXES.male;
    if (s === 'female' || s === 'f' || s === '0' || s === '-1') return SEXES.female;
    return null;
  }
  if (sex === true) return SEXES.male;
  if (sex === false) return SEXES.female;
  if (typeof sex !== 'number') return null;
  const n = sex;
  if (n === 1) return SEXES.male;
  if (n === 0 || n === -1) return SEXES.female;
  return null;
}
/** The values the viewer starts with / resets to (every slider's default, male). */
export function defaultValues() {
  return Object.fromEntries(SLIDERS.map(s => [s.id, s.default ?? 0]));
}
/** Breast morph gate 0..1: female weight (gender -1 -> 1, >= 0 -> 0) x adult (age -1 child -> 0, >= 0 -> 1). */
export function breastGate(values) {
  const g = clamp(Number(values?.gender) || 0, -1, 1), a = clamp(Number(values?.age) || 0, -1, 1);
  return Math.max(0, -g) * clamp(1 + a, 0, 1);
}

// Corrective morphs (blender/build_base.py CORRECTIVE_PAIRS): corr_<A>__<B> = what the real MakeHuman
// combination A+B adds on top of the linear sum of A and B. Runtime weight = influence(A) * influence(B),
// which is exact at the corners and bilinear in between (MakeHuman itself blends its macro targets
// multi-linearly, so this is the same model). Pairs: gender x age, weight x muscle, gender x muscle,
// gender x weight (height and proportions interact little and are left linear), and the breast pairs
// size x firmness, size x age, size x muscle, firmness x age (their parts are gated, so the products are too).
const CORR_AXES = [['gender', 'age'], ['weight', 'muscle'], ['gender', 'muscle'], ['gender', 'weight'],
  ['breastSize', 'breastFirmness'], ['breastSize', 'age'], ['breastSize', 'muscle'], ['breastFirmness', 'age']];
const sliderById = Object.fromEntries(SLIDERS.map(s => [s.id, s]));
export const CORRECTIVES = CORR_AXES.flatMap(([a, b]) => {
  const A = sliderById[a], B = sliderById[b];
  return [A.neg, A.pos].flatMap(ma => [B.neg, B.pos].map(mb => ({ name: `corr_${ma}__${mb}`, a: ma, b: mb })));
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function sideScale(s, side) {
  const sc = s.scale;
  if (sc == null) return 1;
  if (typeof sc === 'number') return sc;
  return sc[side] ?? 1;
}

/** Slider values -> { morphName: influence } for every morph owned by a slider (inactive side = 0),
 *  plus the corrective morphs (product of their two parts). */
export function sliderInfluences(values) {
  const out = {};
  const gate = breastGate(values);
  for (const s of SLIDERS) {
    const v = clamp(Number(values?.[s.id]) || 0, -1, 1);
    const g = s.group === 'breast' ? gate : 1;
    out[s.neg] = v < 0 ? -v * sideScale(s, 'neg') * g : 0;
    out[s.pos] = v > 0 ? v * sideScale(s, 'pos') * g : 0;
  }
  for (const c of CORRECTIVES) out[c.name] = out[c.a] * out[c.b];
  return out;
}

/** Returns (and warns once about) the slider morph names missing from the mesh (correctives are optional). */
export function validateMorphs(mesh) {
  const dict = mesh?.morphTargetDictionary || {};
  const missing = [];
  for (const s of SLIDERS) for (const n of [s.neg, s.pos]) if (!(n in dict)) missing.push(n);
  if (missing.length) console.warn('[character] missing morph targets:', missing.join(', '));
  return missing;
}

const warnedMorphs = new Set();
// correctives and the breast morphs are optional (a GLB built before them still works, the breast UI just does nothing)
const optionalMorph = n => /^(corr_|breast_|bdet_|dyn_)/.test(n);
/** Sets only the influences of morphs owned by SLIDERS (and the correctives); other morph targets
 *  (blink, look) are left untouched. */
export function applySliders(mesh, values) {
  const idx = mesh.morphTargetDictionary, inf = mesh.morphTargetInfluences;
  if (!idx || !inf) { console.warn('[character] mesh has no morph targets'); return; }
  for (const [name, w] of Object.entries(sliderInfluences(values))) {
    const i = idx[name];
    if (i === undefined) {
      if (!optionalMorph(name) && !warnedMorphs.has(name)) {
        warnedMorphs.add(name); console.warn(`[character] unknown morph "${name}" ignored`);
      }
      continue;
    }
    inf[i] = w;
  }
}

// ---- runtime tints --------------------------------------------------------------------------------
// Tintable materials carry glTF extras { tint: { gain, default } } (three.js: material.userData.tint).
// Their textures are normalised to a neutral grey of mean k (linear), gain = 1 / k, so
//   rendered = texel * color,  color = tint (linear) * gain   ->  the mean rendered colour == the picked tint,
// while the texture keeps its detail (skin: pores/lips/redness; hair/brows/lashes: strands; iris: fibres).
// Materials without extras (old GLBs, flat colour) get the plain tint (gain 1).

/** Tint role of a material by its glTF name: 'skin' | 'hair' | 'brows' | 'lashes' | 'eyes' | null. */
export function materialRole(name) {
  const n = String(name || '');
  if (n === 'Skin') return 'skin';
  if (n.startsWith('Hair')) return 'hair';
  if (n === 'Eyebrow') return 'brows';
  if (n === 'Eyelash') return 'lashes';
  if (n === 'Iris') return 'eyes';
  return null;
}

/** material.color = hex (converted by Color.set, i.e. sRGB -> working space) * userData.tint.gain. */
export function applyTint(material, hex) {
  if (!material?.color) return;
  material.color.set(hex);
  const g = Number(material.userData?.tint?.gain);
  if (g > 0 && g !== 1) material.color.multiplyScalar(g);
}

export function applySkinColor(mesh, hex) {
  for (const m of [].concat(mesh.material)) applyTint(m, hex);
}

/** Applies tints = { role: hex } to every material below root (see materialRole). */
export function applyTints(root, tints) {
  const seen = new Set();
  const visit = o => {
    for (const m of [].concat(o.material || [])) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const r = materialRole(m.name);
      if (r && tints[r]) applyTint(m, tints[r]);
    }
    (o.children || []).forEach(visit);
  };
  visit(root);
}

// ---- several meshes, one skeleton -------------------------------------------------------------------

/** Skinned meshes below root that carry morph targets (body, eyes, brows, lashes, teeth, tongue, hair). */
export function characterMeshes(root) {
  const out = [];
  const visit = o => {
    if (o.isSkinnedMesh && o.morphTargetInfluences && o.morphTargetDictionary) out.push(o);
    (o.children || []).forEach(visit);
  };
  if (root) visit(root);
  return out;
}

/**
 * Makes `mesh` use `skeleton` (the body's): its skinIndex attribute is remapped by bone NAME from the mesh's
 * own skeleton to `skeleton`, then mesh.bind(skeleton, bindMatrix). A shared skeleton means applySkeleton(),
 * which rebases skeleton.boneInverses, moves every part of the character at once (a GLTFLoader gives each
 * skinned mesh its own Skeleton / boneInverses copy, which applySkeleton would not touch).
 * Returns { remapped, missing } (missing: bone names of the mesh not found in `skeleton`; mesh left as is).
 */
export function bindToSkeleton(mesh, skeleton, bindMatrix) {
  const own = mesh?.skeleton;
  if (!own || !skeleton) return { remapped: false, missing: ['<no skeleton>'] };
  if (own === skeleton) return { remapped: false, missing: [] };
  const idx = new Map();
  skeleton.bones.forEach((b, i) => { idx.set(b.name, i); if (!idx.has(sanitize(b.name))) idx.set(sanitize(b.name), i); });
  const map = own.bones.map(b => idx.get(b.name) ?? idx.get(sanitize(b.name)));
  const missing = own.bones.filter((b, i) => map[i] === undefined).map(b => b.name);
  if (missing.length) {
    console.warn(`[character] ${mesh.name}: bones not in the body skeleton:`, missing.join(', '));
    return { remapped: false, missing };
  }
  const remapped = map.some((v, i) => v !== i);
  if (remapped) {
    const a = mesh.geometry.attributes.skinIndex;
    for (let i = 0; i < a.array.length; i++) a.array[i] = map[a.array[i]];
    a.needsUpdate = true;
  }
  mesh.bind(skeleton, bindMatrix ?? mesh.bindMatrix);
  return { remapped, missing };
}

// ---- skeleton follows morphs ----------------------------------------------------------------
// The sidecar (base_body.joints.json) gives, per morph, the offset of each bone head at weight 1.0
// in glTF scene space (Y-up, metres). Offsets are summed with the same influences as the morphs,
// converted into each bone's parent-local space, and the bind matrices are rebased so the rest
// pose still matches the morphed mesh exactly while animations pivot around the moved joints.
// The FIRST call must happen at rest (it snapshots the rest pose); later calls may run while an
// animation plays (note: a mixer track on bone.position would override the offset).

// Same sanitising three.js GLTFLoader applies to node names (PropertyBinding.sanitizeNodeName).
const sanitize = n => String(n).replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');
const skelState = new WeakMap();

function sceneRoot(obj) {           // topmost ancestor below a THREE.Scene == the glTF scene root
  let r = obj;
  while (r.parent && !r.parent.isScene) r = r.parent;
  return r;
}

function restState(mesh) {
  let st = skelState.get(mesh);
  if (st) return st;
  const sk = mesh.skeleton, bones = sk.bones;
  const root = sceneRoot(mesh);
  root.updateMatrixWorld(true);
  const Matrix4 = root.matrixWorld.constructor;
  const rootInv = new Matrix4().copy(root.matrixWorld).invert();
  const byName = new Map();
  bones.forEach((b, i) => { byName.set(b.name, i); byName.set(sanitize(b.name), i); });
  st = {
    root, byName, warned: false,
    pos: bones.map(b => b.position.clone()),
    // rest bone matrices relative to the scene root, so moving/rotating the character later
    // does not leave the skinned mesh behind at its old place
    world: bones.map(b => new Matrix4().multiplyMatrices(rootInv, b.matrixWorld)),
    inv: sk.boneInverses.map(m => m.clone()),
    // scene-root-space vector -> parent-local vector (linear part only)
    toParent: bones.map(b => {
      if (!b.parent) return new Matrix4();
      const rel = new Matrix4().multiplyMatrices(rootInv, b.parent.matrixWorld);
      rel.setPosition(0, 0, 0);
      return rel.invert();
    }),
  };
  skelState.set(mesh, st);
  return st;
}

/**
 * Offsets skeleton bones by sum(influence * offset) from the joints sidecar.
 * Returns { moved, missingBones } (missingBones: sidecar names with no matching bone).
 */
export function applySkeleton(mesh, joints, values) {
  const sk = mesh?.skeleton;
  if (!sk || !joints?.morphs) return { moved: 0, missingBones: [] };
  const st = restState(mesh);
  const bones = sk.bones;
  const V = bones[0].position.constructor;
  const delta = bones.map(() => new V());
  const missing = new Set();

  for (const [morph, w] of Object.entries(sliderInfluences(values))) {
    if (!w) continue;
    const offs = joints.morphs[morph];
    if (!offs) continue;
    for (const [name, d] of Object.entries(offs)) {
      const i = st.byName.get(name) ?? st.byName.get(sanitize(name));
      if (i === undefined) { missing.add(name); continue; }
      delta[i].x += w * d[0]; delta[i].y += w * d[1]; delta[i].z += w * d[2];
    }
  }

  const boneIndex = new Map(bones.map((b, i) => [b, i]));
  const tmp = new V();
  bones.forEach((b, i) => {
    const pi = boneIndex.get(b.parent);
    tmp.copy(delta[i]);
    if (pi !== undefined) tmp.sub(delta[pi]);        // parent's own move is inherited already
    tmp.applyMatrix4(st.toParent[i]);
    b.position.copy(st.pos[i]).add(tmp);
  });

  st.root.updateMatrixWorld(true);
  // Rebase (root-relative): newInv = inv(rootInv * newWorld) * restRel * origInv
  //   => rest pose skinning stays identical wherever the root is.
  // newRest (root space) = T(delta) * restRel (only the head moves, linear part unchanged), so
  // newInv = inv(restRel) * T(-delta) * restRel * origInv. Built from stored rest data, not from the
  // live b.matrixWorld, so a running animation pose is never baked into the bind matrices.
  const Matrix4 = st.root.matrixWorld.constructor, m = new Matrix4(), tr = new Matrix4();
  st.worldInv ??= st.world.map(w => w.clone().invert());
  bones.forEach((b, i) => {
    const d = delta[i];
    tr.makeTranslation(-d.x, -d.y, -d.z);
    m.copy(st.worldInv[i]).multiply(tr).multiply(st.world[i]).multiply(st.inv[i]);
    sk.boneInverses[i].copy(m);
  });

  const missingBones = [...missing];
  if (missingBones.length && !st.warned) {
    st.warned = true;
    console.warn('[character] joints sidecar bones not in skeleton:', missingBones.join(', '));
  }
  return { moved: bones.length, missingBones };
}
