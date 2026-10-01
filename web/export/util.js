// Pure helpers of the glTF export (docs/EXPORT.md): settings JSON (save / share / restore), export options,
// tint baking math, glTF name sanitising, credits / licence metadata and the humanoid bone-name table.
// No three.js and no DOM: runs in the browser and in node (tests/export.test.mjs).
import { MPFB_GAME_ENGINE, MPFB_ROOT_BONE } from '../animation/rig.js';
import { JOINT_NAMES } from '../animation/canonical.js';

export const SETTINGS_FORMAT = 'charactercreator.character';
export const SETTINGS_VERSION = 1;
export const EXPORT_VERSION = 1;
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_KEYS = ['skin', 'eyeColor', 'hairColor', 'browColor'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- settings JSON ------------------------------------------------------------------------------------

/**
 * Character settings (what the viewer needs to re-create a character) from the viewer state.
 * state = { sex, values: { sliderId: number }, colors: { skin, eyeColor, hairColor, browColor }, hair, outfit: [ids],
 *   clothColors: { id: { primary, secondary } } }. Only worn items keep their colours.
 */
export function makeSettings(state, sliderIds) {
  const values = {};
  for (const id of sliderIds) if (id !== 'gender' && Number.isFinite(Number(state.values?.[id]))) values[id] = round4(Number(state.values[id]));
  const outfit = [...(state.outfit || [])];
  const clothColors = {};
  for (const id of outfit) {
    const c = state.clothColors?.[id];
    if (c) clothColors[id] = { primary: c.primary, ...(c.secondary ? { secondary: c.secondary } : {}) };
  }
  return normalizeSettings({
    format: SETTINGS_FORMAT, version: SETTINGS_VERSION, sex: state.sex,
    values, colors: Object.fromEntries(COLOR_KEYS.filter(k => state.colors?.[k]).map(k => [k, state.colors[k]])),
    hair: state.hair ?? null, outfit, clothColors,
  }, sliderIds);
}
const round4 = v => { const x = Math.round(v * 1e4) / 1e4; return x === 0 ? 0 : x; };

/**
 * Validates / cleans a settings object (from a file, a URL or a GLB's extras.characterCreator). Unknown keys are
 * dropped, sliders clamped to -1..1, colours must be #rrggbb, ids [A-Za-z0-9_-]. Throws on a wrong format/version.
 */
export function normalizeSettings(s, sliderIds) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('settings: not an object');
  if (s.format !== undefined && s.format !== SETTINGS_FORMAT) throw new Error(`settings: unknown format ${s.format}`);
  if (s.version !== undefined && !(Number(s.version) >= 1 && Number(s.version) <= SETTINGS_VERSION)) throw new Error(`settings: unsupported version ${s.version}`);
  const known = new Set(sliderIds || []);
  const sex = s.sex === 'female' || s.sex === 'male' ? s.sex : (Number(s.values?.gender) < 0 ? 'female' : 'male');
  const values = {};
  for (const [k, v] of Object.entries(s.values || {})) {
    if (k === 'gender' || (known.size && !known.has(k))) continue;
    const n = Number(v);
    if (Number.isFinite(n)) values[k] = clamp(n, -1, 1);
  }
  const colors = {};
  for (const k of COLOR_KEYS) if (HEX.test(String(s.colors?.[k] ?? ''))) colors[k] = s.colors[k].toLowerCase();
  const hair = s.hair == null || s.hair === '' || s.hair === 'none' ? null : (ID.test(String(s.hair)) ? String(s.hair) : null);
  const outfit = (Array.isArray(s.outfit) ? s.outfit : typeof s.outfit === 'string' ? s.outfit.split(',') : [])
    .map(x => String(x).trim()).filter(x => ID.test(x) && x !== 'none');
  const clothColors = {};
  for (const [id, c] of Object.entries(s.clothColors || {})) {
    if (!ID.test(id) || !c) continue;
    const o = {};
    if (HEX.test(String(c.primary ?? ''))) o.primary = c.primary.toLowerCase();
    if (HEX.test(String(c.secondary ?? ''))) o.secondary = c.secondary.toLowerCase();
    if (Object.keys(o).length) clothColors[id] = o;
  }
  return { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, sex, values, colors, hair, outfit: [...new Set(outfit)], clothColors };
}

/** UTF-8 safe base64url (no padding). */
export function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64Url(s) {
  const b = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

/** Settings -> value for ?character= (base64url of the compact JSON). */
export function encodeSettingsParam(settings) { return toBase64Url(JSON.stringify(settings)); }

/**
 * ?character= value -> { settings } (inline JSON or base64url JSON) or { url } (a JSON file to fetch: http(s)://,
 * ./ or / relative, or a name ending in .json). Throws on garbage.
 */
export function decodeSettingsParam(value) {
  const v = String(value ?? '').trim();
  if (!v) throw new Error('character: empty');
  if (v.startsWith('{')) return { settings: JSON.parse(v) };
  if (/^(https?:\/\/|\.{0,2}\/)/i.test(v) || /\.json(\?.*)?$/i.test(v)) return { url: v };
  let text;
  try { text = fromBase64Url(v); } catch { throw new Error('character: neither JSON, base64url JSON nor a .json URL'); }
  return { settings: JSON.parse(text) };
}

/** Accepts a settings object, an exported GLB's json.extras ({ characterCreator }) or the characterCreator block. */
export function settingsFromAny(obj) {
  if (obj?.characterCreator) obj = obj.characterCreator;
  if (obj?.settings && obj.format !== SETTINGS_FORMAT) obj = obj.settings;
  return obj;
}

// ---- export options -----------------------------------------------------------------------------------

export const EXPORT_DEFAULTS = Object.freeze({
  shape: 'baked',            // 'baked' | 'morphs'
  pose: 'rest',              // 'rest' | 'current' (the viewer's current animation frame as the node pose)
  animations: 'none',        // 'none' | 'all' | [clip names]
  fps: 60,                   // like tools/sample_clips.mjs: at 30 fps linear keys stray up to ~15 mm between keys (walk)
  textureSize: 0,            // 0 = original, else max edge in px (1024, 512 ...)
  clothing: true, hair: true, eyes: true, teeth: true, tongue: true, brows: true, lashes: true,
  removeHiddenSkin: true,    // drop body / garment triangles hidden under worn clothing (else keep + _CCZONE marks)
  merge: false,              // one mesh "Character" with one primitive per part / material
  dynamicMorphs: true,       // baked mode: keep blink_*, look_* and (female) dyn_breast_* as shape keys
  quantize: null,            // null = auto (morph mode: KHR_mesh_quantization int16 morph deltas), true / false
  pinAsColor: false,         // also write the cloth pin mask as COLOR_0 (tints the garment in engines that use it)
});

export function normalizeExportOptions(o = {}) {
  const r = { ...EXPORT_DEFAULTS };
  for (const k of Object.keys(EXPORT_DEFAULTS)) if (o[k] !== undefined) r[k] = o[k];
  r.shape = r.shape === 'morphs' || r.shape === 'morph' || r.shape === 'morphTargets' ? 'morphs' : 'baked';
  r.pose = r.pose === 'current' ? 'current' : 'rest';
  if (Array.isArray(r.animations)) r.animations = r.animations.map(String);
  else r.animations = r.animations === 'all' || r.animations === true ? 'all' : 'none';
  r.fps = clamp(Math.round(Number(r.fps) || 60), 5, 120);
  r.textureSize = Number(r.textureSize) > 0 ? clamp(Math.round(Number(r.textureSize)), 16, 8192) : 0;
  for (const k of ['clothing', 'hair', 'eyes', 'teeth', 'tongue', 'brows', 'lashes', 'removeHiddenSkin', 'merge', 'dynamicMorphs', 'pinAsColor']) r[k] = !!r[k];
  r.quantize = r.quantize == null ? r.shape === 'morphs' : !!r.quantize;
  return r;
}

/** Default download name: character_<sex>_<shape>[_anim].glb */
export function exportFileName(settings, opts) {
  const parts = ['character', settings?.sex || 'x', opts.shape === 'morphs' ? 'morphs' : 'baked'];
  if (opts.animations !== 'none') parts.push('anim');
  return sanitizeName(parts.join('_')) + '.glb';
}

// ---- names --------------------------------------------------------------------------------------------

/** Engine-safe node / mesh / material name: [A-Za-z0-9_.-], no leading digit-only, never empty. */
export function sanitizeName(name, fallback = 'node') {
  const TR = { Ø: 'O', ø: 'o', Æ: 'AE', æ: 'ae', ß: 'ss', Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Þ: 'Th', þ: 'th' };
  let s = String(name ?? '').replace(/[ØøÆæßŁłĐđÞþ]/g, c => TR[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = fallback;
  if (/^[0-9.-]/.test(s)) s = `_${s}`;
  return s.slice(0, 63);
}
/** Returns a function that makes names unique (Name, Name_1, Name_2 ...). */
export function uniqueNamer() {
  const used = new Set();
  return (name, fallback) => {
    const base = sanitizeName(name, fallback);
    let n = base, i = 1;
    while (used.has(n)) n = `${base}_${i++}`;
    used.add(n);
    return n;
  };
}

// ---- colour / tint baking -----------------------------------------------------------------------------

export const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** '#rrggbb' -> linear [r, g, b] (what three.js Color.set does in a linear working space). */
export function hexToLinear(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => srgbToLinear(v / 255));
}

/**
 * How a runtime tint (linear colour, may exceed 1 because of the grey-normalisation gain) becomes glTF:
 * baseColorFactor = min(1, c) per channel and, where c > 1, the rest (c / factor) is baked into a texture copy.
 * With a secondary colour (mask texture) the texture always has to be baked: factor = min(1, max(primary,
 * secondary)) per channel, texel multiplier = mix(primary, secondary, mask) / factor.
 * Returns { factor: [r,g,b], bake: bool, primaryMul: [r,g,b], secondaryMul: [r,g,b] | null }.
 */
export function planTint(primary, secondary = null) {
  const factor = [0, 1, 2].map(i => Math.min(1, Math.max(primary[i], secondary ? secondary[i] : 0)));
  const mul = c => [0, 1, 2].map(i => (factor[i] > 1e-6 ? c[i] / factor[i] : 0));
  const primaryMul = mul(primary), secondaryMul = secondary ? mul(secondary) : null;
  const bake = !!secondary || primaryMul.some((v, i) => factor[i] > 1e-6 && Math.abs(v - 1) > 1e-4);
  return { factor, bake, primaryMul, secondaryMul };
}

let LUT = null;
const lut = () => (LUT ??= Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255)));

/**
 * Bakes a tint into sRGB RGBA pixels in place: linear texel * mix(primaryMul, secondaryMul, mask) -> sRGB, clamped.
 * mask: per-pixel 0..255 values (R of the mask texture, same size) or null. Alpha is kept.
 */
export function bakeTintPixels(data, plan, mask = null) {
  const L = lut(), p = plan.primaryMul, s = plan.secondaryMul;
  for (let i = 0, k = 0; i < data.length; i += 4, k++) {
    const m = mask && s ? mask[k] / 255 : 0;
    for (let c = 0; c < 3; c++) {
      const mul = m ? p[c] * (1 - m) + s[c] * m : p[c];
      const v = linearToSrgb(Math.min(1, L[data[i + c]] * mul));
      data[i + c] = Math.round(v * 255);
    }
  }
  return data;
}

// ---- credits / licence --------------------------------------------------------------------------------

export const CREDITS_SUMMARY = 'CharacterCreator export. Contains CC0 1.0 assets (MakeHuman system assets: base mesh, '
  + 'macro/detail morph targets, game_engine rig and weights, skin/eye/brow/lash/teeth/tongue/hair/clothing assets, '
  + 'https://www.makehumancommunity.org) and geometry/textures generated by the CharacterCreator project code. '
  + 'Free to use, also commercially; no attribution required. Details: extras.characterCreator.credits and the '
  + 'project LICENSE-NOTES.md.';

/**
 * Credits for the parts in an export: always the base body assets (asset_licenses.json types skins, eyes,
 * eyebrows, eyelashes, teeth, tongue), the worn hair style and garments (hair.json / clothing.json fields).
 */
export function buildCredits({ assetLicenses = [], hairManifest = null, catalog = null, hair = null, outfit = [] } = {}) {
  const sources = [{ part: 'base body', asset: 'MakeHuman base mesh, macro/detail targets, game_engine rig + weights', license: 'CC0-1.0',
    author: 'makehuman_system', source: 'https://www.makehumancommunity.org' }];
  const base = new Set(['skins', 'eyes', 'eyebrows', 'eyelashes', 'teeth', 'tongue']);
  const seen = new Set();
  for (const a of Array.isArray(assetLicenses) ? assetLicenses : []) {
    if (!base.has(a.type) && !(a.type === 'hair' && a.asset === hair)) continue;
    const key = `${a.type}:${a.asset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ part: a.type, asset: a.asset, license: a.license === 'CC0' ? 'CC0-1.0' : a.license, author: a.author, source: a.source });
  }
  if (hair && !seen.has(`hair:${hair}`)) {
    const st = hairManifest?.styles?.find(s => s.id === hair);
    if (st) sources.push({ part: 'hair', asset: hair, license: st.license === 'CC0' ? 'CC0-1.0' : st.license, source: st.source });
  }
  for (const id of outfit) {
    const it = catalog?.items?.find(i => i.id === id);
    if (it) sources.push({ part: 'clothing', asset: id, license: it.license === 'CC0' ? 'CC0-1.0' : it.license, source: it.source });
  }
  sources.push({ part: 'project output', asset: 'joint offsets, corrective/eye/breast-motion morphs, generated garment parts and textures, animation clips',
    license: 'project output (free to use)', source: 'CharacterCreator' });
  return { summary: CREDITS_SUMMARY, licenseNotes: 'LICENSE-NOTES.md (project root)', sources };
}

// ---- humanoid bone-name table -------------------------------------------------------------------------

const cap = s => s[0].toUpperCase() + s.slice(1);
const MIXAMO_CORE = { hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head' };
const MIXAMO_LIMB = { Shoulder: 'Shoulder', UpperArm: 'Arm', LowerArm: 'ForeArm', Hand: 'Hand', UpperLeg: 'UpLeg', LowerLeg: 'Leg', Foot: 'Foot', Toes: 'ToeBase' };
const MIXAMO_FINGER = { Thumb: 'Thumb', Index: 'Index', Middle: 'Middle', Ring: 'Ring', Little: 'Pinky' };
const UNITY_SEG = { Metacarpal: 'Proximal', Proximal: 'Intermediate', Distal: 'Distal' };   // thumb only (VRM 1.0 -> Unity)

/**
 * One row per canonical joint present in the rig: { vrm, bone (glTF node in the export = MPFB game_engine = UE4
 * mannequin naming), unity (HumanBodyBones), godot (SkeletonProfileHumanoid), mixamo }.
 */
export function humanoidBoneTable(map = MPFB_GAME_ENGINE) {
  const rows = [];
  for (const j of JOINT_NAMES) {
    const bone = map[j];
    if (!bone) continue;
    let unity = cap(j), mixamo = MIXAMO_CORE[j] ? `mixamorig:${MIXAMO_CORE[j]}` : null;
    const m = /^(left|right)(.+)$/.exec(j);
    if (m) {
      const side = cap(m[1]), rest = m[2];
      if (MIXAMO_LIMB[rest]) mixamo = `mixamorig:${side}${MIXAMO_LIMB[rest]}`;
      const f = /^(Thumb|Index|Middle|Ring|Little)(Metacarpal|Proximal|Intermediate|Distal)$/.exec(rest);
      if (f) {
        const n = f[1] === 'Thumb' ? { Metacarpal: 1, Proximal: 2, Distal: 3 }[f[2]] : { Proximal: 1, Intermediate: 2, Distal: 3 }[f[2]];
        mixamo = `mixamorig:${side}Hand${MIXAMO_FINGER[f[1]]}${n}`;
        unity = `${side}${f[1]}${f[1] === 'Thumb' ? UNITY_SEG[f[2]] : f[2]}`;
      } else unity = `${side}${rest}`;
    }
    rows.push({ vrm: j, bone, unity, godot: cap(j), mixamo });
  }
  return rows;
}
export const ROOT_BONE = MPFB_ROOT_BONE;

// ---- animation helpers --------------------------------------------------------------------------------

/** Makes a flat [x,y,z,w,...] quaternion track sign-continuous (q and -q are the same rotation). In place. */
export function alignQuaternionTrack(values) {
  for (let i = 4; i < values.length; i += 4) {
    const d = values[i] * values[i - 4] + values[i + 1] * values[i - 3] + values[i + 2] * values[i - 2] + values[i + 3] * values[i - 1];
    if (d < 0) for (let c = 0; c < 4; c++) values[i + c] = -values[i + c];
  }
  return values;
}

/** Key times of a clip of duration T at `fps`: n + 1 keys, n = max(2, round(T * fps)), last key exactly at T. */
export function keyTimes(T, fps) {
  const n = Math.max(2, Math.round(T * fps));
  return Float32Array.from({ length: n + 1 }, (_, i) => (i === n ? T : i * T / n));
}

/** A track whose keys all equal the first (|diff| <= eps) -> its first and last key only; else unchanged. */
export function collapseConstantTrack(times, values, itemSize, eps = 1e-7) {
  for (let i = itemSize; i < values.length; i++) if (Math.abs(values[i] - values[i % itemSize]) > eps) return { times, values };
  const v = values.slice(0, itemSize);
  return { times: Float32Array.of(times[0], times[times.length - 1]), values: Float32Array.from([...v, ...v]) };
}

/** Morph names kept as shape keys in baked mode (dynamic, not slider-owned). */
export function dynamicMorph(name, { breasts = false } = {}) {
  return /^(blink_|look_)/.test(name) || (breasts && /^dyn_breast_/.test(name));
}
