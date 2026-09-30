// Engine-agnostic slider model -> glTF morph target influences (works on any glTF loader).
// Bipolar sliders map -1..1 onto a pair of morph targets (neg/pos).
// `scale` caps the maximum influence of a side: a number (both sides) or { neg, pos } (default 1).
// Morphs are linear offsets baked at the macro extremes, so e.g. height_tall at 1.0 is ~+0.7 m;
// scaling the positive height side to 0.45 keeps the tallest setting around +0.3 m.
export const SLIDERS = [
  { id: 'gender',      label: 'Køn (K ↔ M)',           neg: 'gender_female',        pos: 'gender_male' },
  { id: 'age',         label: 'Alder (barn ↔ gammel)', neg: 'age_child',            pos: 'age_old' },
  { id: 'height',      label: 'Højde',                 neg: 'height_short',         pos: 'height_tall', scale: { pos: 0.45 } },
  { id: 'weight',      label: 'Vægt',                  neg: 'weight_min',           pos: 'weight_max' },
  { id: 'muscle',      label: 'Muskler',               neg: 'muscle_min',           pos: 'muscle_max' },
  { id: 'proportions', label: 'Proportioner',          neg: 'proportions_uncommon', pos: 'proportions_ideal' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function sideScale(s, side) {
  const sc = s.scale;
  if (sc == null) return 1;
  if (typeof sc === 'number') return sc;
  return sc[side] ?? 1;
}

/** Slider values -> { morphName: influence } for every morph owned by a slider (inactive side = 0). */
export function sliderInfluences(values) {
  const out = {};
  for (const s of SLIDERS) {
    const v = clamp(Number(values?.[s.id]) || 0, -1, 1);
    out[s.neg] = v < 0 ? -v * sideScale(s, 'neg') : 0;
    out[s.pos] = v > 0 ? v * sideScale(s, 'pos') : 0;
  }
  return out;
}

/** Returns (and warns once about) the slider morph names missing from the mesh. */
export function validateMorphs(mesh) {
  const dict = mesh?.morphTargetDictionary || {};
  const missing = [];
  for (const s of SLIDERS) for (const n of [s.neg, s.pos]) if (!(n in dict)) missing.push(n);
  if (missing.length) console.warn('[character] missing morph targets:', missing.join(', '));
  return missing;
}

const warnedMorphs = new Set();
/** Sets only the influences of morphs owned by SLIDERS; other morph targets are left untouched. */
export function applySliders(mesh, values) {
  const idx = mesh.morphTargetDictionary, inf = mesh.morphTargetInfluences;
  if (!idx || !inf) { console.warn('[character] mesh has no morph targets'); return; }
  for (const [name, w] of Object.entries(sliderInfluences(values))) {
    const i = idx[name];
    if (i === undefined) {
      if (!warnedMorphs.has(name)) { warnedMorphs.add(name); console.warn(`[character] unknown morph "${name}" ignored`); }
      continue;
    }
    inf[i] = w;
  }
}

export function applySkinColor(mesh, hex) {
  for (const m of [].concat(mesh.material)) m?.color?.set(hex);
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
