// glTF / GLB export of the configured character (docs/EXPORT.md) + settings JSON save / load / share.
// Builds a fresh three.js scene from the viewer's parts (one skeleton, rest pose with the applySkeleton joint
// positions, baked or morph-target geometry, plain PBR materials with the runtime tints baked in), samples the
// procedural clips for the CURRENT body (the animator's own rig measurement + ground guard), writes it with
// three.js' GLTFExporter and post-processes the GLB (web/export/glbpack.js: sparse / quantised morph targets,
// metadata). The viewer's scene is never modified.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SLIDERS, sliderInfluences, materialRole, sexOf, breastGate } from '../character.js';
import { applyPose, measure } from '../humanoid.js';
import { CLIPS, makeContext } from '../animation/clips.js';
import { groundLift } from '../animation/animator.js';
import { MPFB_GAME_ENGINE } from '../animation/rig.js';
import { BREAST_PHYSICS, DYN_MORPHS } from '../breastphysics.js';
import {
  makeSettings, normalizeSettings, decodeSettingsParam, encodeSettingsParam, settingsFromAny, normalizeExportOptions,
  exportFileName, uniqueNamer, planTint, bakeTintPixels, buildCredits, humanoidBoneTable, alignQuaternionTrack,
  keyTimes, collapseConstantTrack, dynamicMorph, CREDITS_SUMMARY, EXPORT_VERSION, ROOT_BONE,
} from './util.js';
import { postProcessGlb } from './glbpack.js';

const SLIDER_IDS = SLIDERS.map(s => s.id);
const I18N = {
  da: {
    secExport: 'Eksport', exShape: 'Form', exBaked: 'Bagt (aktuelle skydere, lille fil)', exMorphs: 'Med morph targets (shape keys)',
    exPose: 'Positur', exRest: 'Hvilestilling', exCurrent: 'Aktuelt animationsbillede',
    exAnim: 'Animationer', exFps: 'Billeder pr. sekund (animation)', exAnimNone: 'Ingen', exAnimAll: 'Alle klip (tilpasset kroppen)',
    exTex: 'Teksturstørrelse', exTexOrig: 'Original', exClothing: 'Tøj', exHair: 'Hår', exEyes: 'Øjne', exTeeth: 'Tænder',
    exTongue: 'Tunge', exBrows: 'Øjenbryn', exLashes: 'Øjenvipper', exRemoveHidden: 'Fjern skjult hud under tøj',
    exMerge: 'Saml i ét mesh', exButton: 'Eksporter glTF (.glb)',
    exNote: 'Hudens SSS-shader eksporteres ikke (almindelig PBR). Stof og hår simuleres ikke; stofdata følger med som extras.',
    exSaveJson: 'Gem indstillinger (JSON)', exLoadJson: 'Indlæs indstillinger…', exShare: 'Kopiér delingslink',
    exBusy: 'Eksporterer…', exDone: 'Eksporteret', exError: 'Eksport fejlede:', exLoaded: 'Indstillinger indlæst',
    exLoadError: 'Kunne ikke indlæse indstillinger:', exCopied: 'Link kopieret', exLink: 'Delingslink',
    stPrepare: 'Forbereder geometri…', stMaterials: 'Materialer og farver…', stAnim: 'Animationer…', stWrite: 'Skriver glTF…', stPack: 'Pakker…',
  },
  en: {
    secExport: 'Export', exShape: 'Shape', exBaked: 'Baked (current sliders, small file)', exMorphs: 'With morph targets (shape keys)',
    exPose: 'Pose', exRest: 'Rest pose', exCurrent: 'Current animation frame',
    exAnim: 'Animations', exFps: 'Frames per second (animation)', exAnimNone: 'None', exAnimAll: 'All clips (fitted to this body)',
    exTex: 'Texture size', exTexOrig: 'Original', exClothing: 'Clothes', exHair: 'Hair', exEyes: 'Eyes', exTeeth: 'Teeth',
    exTongue: 'Tongue', exBrows: 'Eyebrows', exLashes: 'Eyelashes', exRemoveHidden: 'Remove skin hidden under clothes',
    exMerge: 'Merge into one mesh', exButton: 'Export glTF (.glb)',
    exNote: 'The skin SSS shader is not exported (plain PBR). Cloth and hair are not simulated; cloth data is included as extras.',
    exSaveJson: 'Save settings (JSON)', exLoadJson: 'Load settings…', exShare: 'Copy share link',
    exBusy: 'Exporting…', exDone: 'Exported', exError: 'Export failed:', exLoaded: 'Settings loaded',
    exLoadError: 'Could not load settings:', exCopied: 'Link copied', exLink: 'Share link',
    stPrepare: 'Preparing geometry…', stMaterials: 'Materials and colours…', stAnim: 'Animations…', stWrite: 'Writing glTF…', stPack: 'Packing…',
  },
};

const yieldUI = () => new Promise(r => setTimeout(r, 0));
const fmtBytes = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`);

/** Reads any (interleaved / normalised) BufferAttribute into a dense Float32Array. */
function readAttr(a) {
  const n = a.count, k = a.itemSize, out = new Float32Array(n * k);
  const get = [a.getX, a.getY, a.getZ, a.getW];
  for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) out[i * k + c] = get[c].call(a, i);
  return out;
}

/** Tint / visibility role of a viewer part. */
function classify(m, body) {
  if (m === body) return 'body';
  if (m.userData?.ccClothing != null) return 'clothing';
  const n = m.name || '', mats = [].concat(m.material).map(x => x?.name || '');
  if (/^Hair/i.test(n) || mats.some(x => materialRole(x) === 'hair')) return 'hair';
  if (/^Eyebrows/.test(n) || mats.includes('Eyebrow')) return 'brows';
  if (/^Eyelashes/.test(n) || mats.includes('Eyelash')) return 'lashes';
  if (/^Teeth/.test(n) || mats.includes('Teeth')) return 'teeth';
  if (/^Tongue/.test(n) || mats.includes('Tongue')) return 'tongue';
  if (/^Eyes/.test(n) || mats.some(x => /^(Eye|Iris|Cornea|Sclera)$/.test(x))) return 'eyes';
  return 'other';
}

/**
 * deps: { lang, ui, before, setStatus, getBody, getParts, values, bodyValues, getHumanoid, getAnimator, clothing,
 *   getHairManifest, set(k, v) } (web/main.js). Must be created before the clothing hides body zones (it snapshots
 * the full body index for the 'keep hidden skin' option).
 */
export function createExporter(deps) {
  const lang = I18N[deps.lang] ? deps.lang : 'da';
  const t = k => I18N[lang][k] ?? I18N.da[k] ?? k;
  const body0 = deps.getBody();
  const fullBodyIndex = body0?.geometry?.index ? body0.geometry.index.array.slice() : null;
  let sceneRoot = body0;
  while (sceneRoot?.parent && !sceneRoot.parent.isScene) sceneRoot = sceneRoot.parent;
  const sceneRest = sceneRoot ? sceneRoot.position.clone() : new THREE.Vector3();
  let licensesPromise = null;
  const assetLicenses = () => (licensesPromise ??= fetch('./asset_licenses.json').then(r => (r.ok ? r.json() : [])).catch(() => []));
  let busy = null;

  // ---- viewer state -> settings ----
  function settings() {
    const v = deps.values;
    const cs = deps.clothing?.state?.() ?? { outfit: [], colors: {} };
    return makeSettings({
      sex: sexOf(v), values: deps.bodyValues(),
      colors: { skin: v.skin, eyeColor: v.eyeColor, hairColor: v.hairColor, browColor: v.browColor },
      hair: v.hair ?? null, outfit: cs.outfit, clothColors: cs.colors,
    }, SLIDER_IDS);
  }

  async function applySettings(raw) {
    const s = normalizeSettings(settingsFromAny(raw), SLIDER_IDS);
    await deps.set('sex', s.sex);
    for (const id of SLIDER_IDS) if (id !== 'gender' && s.values[id] !== undefined) deps.set(id, s.values[id]);
    for (const [k, v] of Object.entries(s.colors)) deps.set(k, v);
    await deps.set('hair', s.hair);
    const cat = deps.clothing?.catalog;
    if (cat) {
      const known = s.outfit.filter(id => cat.items.some(i => i.id === id));
      const uw = new Set(cat.underwearSlots ?? ['underwear']);
      const hasUnderwear = known.some(id => uw.has(cat.items.find(i => i.id === id)?.slot));
      if (!known.length) await deps.set('outfit', 'none');
      else {
        if (!hasUnderwear) await deps.set('underwear', false);
        await deps.set('outfit', known);
      }
      for (const [id, c] of Object.entries(s.clothColors)) if (known.includes(id)) await deps.set('clothColor', { id, ...c });
    }
    return s;
  }

  async function restoreFromUrl(value) {
    if (value == null || value === '') return null;
    try {
      const d = decodeSettingsParam(value);
      let obj = d.settings;
      if (d.url) {
        const r = await fetch(d.url);
        if (!r.ok) throw new Error(`${d.url}: HTTP ${r.status}`);
        obj = await r.json();
      }
      const s = await applySettings(obj);
      return s;
    } catch (e) {
      console.error('[export] ?character= failed', e);
      deps.setStatus?.(`${t('exLoadError')} ${e?.message || e}`, true);
      return null;
    }
  }

  function shareLink() {
    const u = new URL(location.href);
    u.search = '';
    const p = new URLSearchParams(location.search);
    if (p.get('lang')) u.searchParams.set('lang', p.get('lang'));
    u.searchParams.set('character', encodeSettingsParam(settings()));
    return u.toString();
  }

  // ---- skeleton ----
  function buildSkeleton(o) {
    const body = deps.getBody(), h = deps.getHumanoid?.();
    const src = body.skeleton.bones;
    const restQ = h?._restQ;
    const srcArm = src[0].parent;
    const armature = new THREE.Object3D();
    armature.name = srcArm && !srcArm.isScene ? srcArm.name || 'Armature' : 'Armature';
    if (srcArm && !srcArm.isScene) { armature.position.copy(srcArm.position); armature.quaternion.copy(srcArm.quaternion); armature.scale.copy(srcArm.scale); }
    const map = new Map();
    const bones = src.map(b => {
      const c = new THREE.Bone();
      c.name = b.name;
      c.position.copy(b.position);                                  // applySkeleton joint positions (current body)
      const q = restQ?.get(b);
      if (q) c.quaternion.set(q[0], q[1], q[2], q[3]); else c.quaternion.copy(b.quaternion);
      c.scale.copy(b.scale);
      map.set(b, c);
      return c;
    });
    src.forEach((b, i) => { (map.get(b.parent) ?? armature).add(bones[i]); });
    armature.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);                      // inverses = inverse(rest world): baked bind pose
    const restRoot = bones.find(b => b.name === ROOT_BONE)?.position.clone() ?? null;
    if (o.pose === 'current') {
      src.forEach((b, i) => bones[i].quaternion.copy(b.quaternion));
      const rootBone = bones.find(b => b.name === ROOT_BONE);
      if (rootBone && sceneRoot) rootBone.position.add(sceneRoot.position.clone().sub(sceneRest));
      armature.updateMatrixWorld(true);
    }
    return { armature, skeleton, bones, restRoot };
  }

  // ---- geometry ----
  function prepGeometry(m, kind, o, infl, breasts) {
    const body = deps.getBody();
    const g = m.geometry, n = g.attributes.position.count;
    const pos = readAttr(g.attributes.position);
    const nrm = g.attributes.normal ? readAttr(g.attributes.normal) : null;
    const names = Object.entries(m.morphTargetDictionary || {}).sort((a, b) => a[1] - b[1]).map(e => e[0]);
    const tp = g.morphAttributes.position || [], tn = g.morphAttributes.normal || [];
    const delta = (list, i, base) => {
      const d = readAttr(list[i]);
      if (!g.morphTargetsRelative) for (let k = 0; k < d.length; k++) d[k] -= base[k];
      return d;
    };
    const basePos = g.morphTargetsRelative ? null : pos.slice(), baseNrm = g.morphTargetsRelative || !nrm ? null : nrm.slice();
    const keep = [];
    names.forEach((name, i) => {
      if (i >= tp.length) return;
      const w = infl[name] || 0;
      if (o.shape === 'baked') {
        if (w) {
          const d = delta(tp, i, basePos);
          for (let k = 0; k < pos.length; k++) pos[k] += w * d[k];
          if (nrm && tn[i]) { const dn = delta(tn, i, baseNrm); for (let k = 0; k < nrm.length; k++) nrm[k] += w * dn[k]; }
        }
        if (o.dynamicMorphs && dynamicMorph(name, { breasts })) keep.push({ name, i, w: 0 });
      } else keep.push({ name, i, w: dynamicMorph(name, { breasts: true }) ? 0 : w });
    });
    if (nrm) for (let k = 0; k < nrm.length; k += 3) {
      const l = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) || 1;
      nrm[k] /= l; nrm[k + 1] /= l; nrm[k + 2] /= l;
    }
    const targets = keep.map(({ name, i, w }) => ({
      name, w, pos: delta(tp, i, basePos ?? pos), nrm: tn[i] ? delta(tn, i, baseNrm ?? nrm) : null,
    }));

    // triangles: as drawn (hidden skin removed) or the full index (+ _CCZONE kept as the mark)
    const src = !o.removeHiddenSkin
      ? (kind === 'body' ? fullBodyIndex : m.userData.ccIndex) ?? g.index?.array
      : g.index?.array;
    const index = src ? Uint32Array.from(src) : Uint32Array.from({ length: n }, (_, i) => i);

    const attrs = { position: [pos, 3] };
    if (nrm) attrs.normal = [nrm, 3];
    if (g.attributes.uv) attrs.uv = [readAttr(g.attributes.uv), 2];
    if (g.attributes.skinIndex) attrs.skinIndex = [Uint16Array.from(readAttr(g.attributes.skinIndex)), 4];
    if (g.attributes.skinWeight) {
      const w = readAttr(g.attributes.skinWeight);
      for (let k = 0; k < w.length; k += 4) {                 // exact unit sum (validator ACCESSOR_WEIGHTS_NON_NORMALIZED)
        const s = w[k] + w[k + 1] + w[k + 2] + w[k + 3];
        if (s > 0 && Math.abs(s - 1) > 1e-7) for (let c = 0; c < 4; c++) w[k + c] /= s;
      }
      attrs.skinWeight = [w, 4];
    }
    const zone = g.attributes._cczone;
    if (zone && !o.removeHiddenSkin) attrs.cczone = [readAttr(zone), 1];          // written as _CCZONE
    const pin = g.attributes._cloth_pin;
    const cloth = kind === 'clothing' && pin ? (m.userData.ccCloth ?? deps.clothing?.catalog?.items.find(i => i.id === m.userData.ccClothing)?.cloth ?? null) : null;
    if (pin && cloth) {
      const p = readAttr(pin);
      attrs.cloth_pin = [p, 1];                                         // written as _CLOTH_PIN (GLTFExporter adds the _)
      if (o.pinAsColor) attrs.color = [Float32Array.from({ length: n * 3 }, (_, k) => p[Math.floor(k / 3)]), 3];
    }

    // drop vertices no triangle uses (hidden skin, covered garment parts)
    const used = new Int32Array(n).fill(-1);
    let cnt = 0;
    for (const v of index) if (used[v] < 0) used[v] = cnt++;
    if (cnt < n) {
      const order = new Uint32Array(cnt);
      for (let v = 0; v < n; v++) if (used[v] >= 0) order[used[v]] = v;
      const pick = (arr, k) => { const out = new arr.constructor(cnt * k); for (let j = 0; j < cnt; j++) for (let c = 0; c < k; c++) out[j * k + c] = arr[order[j] * k + c]; return out; };
      for (const key of Object.keys(attrs)) attrs[key] = [pick(attrs[key][0], attrs[key][1]), attrs[key][1]];
      for (const tg of targets) { tg.pos = pick(tg.pos, 3); if (tg.nrm) tg.nrm = pick(tg.nrm, 3); }
      for (let k = 0; k < index.length; k++) index[k] = used[index[k]];
    }
    // the parts live in the armature's space (Body etc. are identity children of the Armature node)
    if (m.parent !== body.parent || !m.position.equals(new THREE.Vector3()) || m.quaternion.w < 1 - 1e-9 || !m.scale.equals(new THREE.Vector3(1, 1, 1))) {
      console.warn(`[export] ${m.name}: not an identity child of the armature; exported in its local space`);
    }
    return { attrs, targets, index, vertexCount: cnt, cloth };
  }

  function toGeometry(list) {
    // list: prepared geometries of ONE node (several = one primitive each); aligned attribute + morph sets
    const names = [];
    for (const p of list) for (const tg of p.targets) if (!names.includes(tg.name)) names.push(tg.name);
    const keys = [...new Set(list.flatMap(p => Object.keys(p.attrs)))];
    const withNrm = list.some(p => p.targets.some(tg => tg.nrm)) && list.every(p => p.attrs.normal);
    const DEF = { cloth_pin: 1 };
    const geos = list.map(p => {
      const geo = new THREE.BufferGeometry();
      const n = p.vertexCount;
      for (const k of keys) {
        let a = p.attrs[k];
        if (!a) {
          const size = list.find(q => q.attrs[k]).attrs[k][1];
          const proto = list.find(q => q.attrs[k]).attrs[k][0];
          a = [new proto.constructor(n * size).fill(k === 'color' || k === 'cloth_pin' ? DEF.cloth_pin : 0), size];
        }
        geo.setAttribute(k, new THREE.BufferAttribute(a[0], a[1]));
      }
      geo.setIndex(new THREE.BufferAttribute(p.index, 1));
      const by = Object.fromEntries(p.targets.map(tg => [tg.name, tg]));
      if (names.length) {
        geo.morphAttributes.position = names.map(nm => Object.assign(new THREE.BufferAttribute(by[nm]?.pos ?? new Float32Array(n * 3), 3), { name: nm }));
        if (withNrm) geo.morphAttributes.normal = names.map(nm => Object.assign(new THREE.BufferAttribute(by[nm]?.nrm ?? new Float32Array(n * 3), 3), { name: nm }));
        geo.morphTargetsRelative = true;
      }
      return geo;
    });
    const weights = names.map(nm => list.map(p => p.targets.find(tg => tg.name === nm)?.w).find(w => w !== undefined) ?? 0);
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, true);
    if (!geo) throw new Error('merging the parts failed (attribute sets differ)');
    geo.morphTargetsRelative = names.length > 0;               // mergeGeometries() does not carry the flag over
    return { geo, names, weights };
  }

  // ---- materials ----
  const imageCanvas = (img, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { c, ctx };
  };
  async function convertMaterial(src, o) {
    const role = materialRole(src.name);
    const u = src.userData?.ccUniforms;
    const maskTex = u?.ccMask?.value ?? null;
    const primary = src.color ? [src.color.r, src.color.g, src.color.b] : [1, 1, 1];
    const secondary = maskTex ? [u.ccSecondary.value.r, u.ccSecondary.value.g, u.ccSecondary.value.b] : null;
    const plan = planTint(primary, secondary);
    let map = src.map ?? null;
    if (plan.bake && map?.image) {
      const img = map.image, lim = o.textureSize || Infinity;
      const s = Math.min(1, lim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
      const { c, ctx } = imageCanvas(img, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      let mask = null;
      if (secondary && maskTex?.image) {
        const md = imageCanvas(maskTex.image, w, h).ctx.getImageData(0, 0, w, h).data;
        mask = new Uint8Array(w * h);
        for (let k = 0; k < mask.length; k++) mask[k] = md[k * 4];
      }
      bakeTintPixels(data.data, plan, mask);
      ctx.putImageData(data, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.name = `${map.name || src.name}_tinted`;
      tex.flipY = map.flipY; tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = map.wrapS; tex.wrapT = map.wrapT; tex.magFilter = map.magFilter; tex.minFilter = map.minFilter;
      tex.channel = map.channel;
      const alpha = src.alphaTest > 0 || src.transparent;
      tex.userData.mimeType = alpha ? 'image/png' : 'image/jpeg';
      map = tex;
      await yieldUI();
    }
    const m = new THREE.MeshStandardMaterial({
      name: src.name, map, roughness: src.roughness ?? 1, metalness: src.metalness ?? 0,
      normalMap: src.normalMap ?? null, side: src.side, alphaTest: src.alphaTest || 0,
      transparent: !!src.transparent && (src.opacity ?? 1) < 1, opacity: src.opacity ?? 1,
      roughnessMap: src.roughnessMap ?? null, metalnessMap: src.metalnessMap ?? null, aoMap: src.aoMap ?? null,
      emissive: src.emissive ?? new THREE.Color(0), emissiveMap: src.emissiveMap ?? null,
    });
    m.color.setRGB(plan.bake && !src.map ? Math.min(1, primary[0]) : plan.factor[0], plan.bake && !src.map ? Math.min(1, primary[1]) : plan.factor[1],
      plan.bake && !src.map ? Math.min(1, primary[2]) : plan.factor[2]);
    if (src.normalMap && src.normalScale) m.normalScale.copy(src.normalScale);
    m.userData = role ? { ccTintRole: role } : {};
    return m;
  }

  // ---- animation ----
  function sampleClips(o, restRoot, boneNames) {
    const h = deps.getHumanoid?.();
    if (!h || o.animations === 'none') return { clips: [], extras: {} };
    const rig = measure(h);                                   // == the animator's rig for the current body
    const ctx = makeContext(rig, { speedScale: 1, body: deps.bodyValues() });
    const names = o.animations === 'all' ? Object.keys(CLIPS) : o.animations.filter(n => CLIPS[n]);
    const joints = Object.keys(h.bones).filter(j => boneNames.has(h.bones[j].name));
    const rec = {};
    const fake = { ...h, bones: Object.fromEntries(joints.map(j => [j, { quaternion: { set: (x, y, z, w) => { rec[j] = [x, y, z, w]; } } }])) };
    const clips = [], extras = {};
    for (const name of names) {
      const clip = CLIPS[name], tm = clip.timing(ctx), T = tm.duration;
      const times = keyTimes(T, o.fps), n = times.length - 1;
      const q = Object.fromEntries(joints.map(j => [j, new Float32Array(times.length * 4)]));
      const root = new Float32Array(times.length * 3);
      for (let i = 0; i <= n; i++) {
        const pose = clip.sample(i * T / n, ctx);
        const lift = groundLift(rig.heads, pose);
        applyPose(fake, pose);
        for (const j of joints) q[j].set(rec[j], i * 4);
        const r = pose.root || [0, 0, 0];
        root.set([restRoot.x + r[0], restRoot.y + r[1] + Math.max(0, lift), restRoot.z + r[2]], i * 3);
      }
      // every clip animates the same channels (all mapped bones + Root); constant ones keep only their 2 end keys
      const tracks = joints.map(j => {
        const c = collapseConstantTrack(times, alignQuaternionTrack(q[j]), 4);
        return new THREE.QuaternionKeyframeTrack(`${h.bones[j].name}.quaternion`, c.times, c.values);
      });
      const cr = collapseConstantTrack(times, root, 3);
      tracks.push(new THREE.VectorKeyframeTrack(`${ROOT_BONE}.position`, cr.times, cr.values));
      clips.push(new THREE.AnimationClip(name, T, tracks));
      const v = tm.velocity || [0, 0, tm.speed || 0], vl = Math.hypot(...v);
      extras[name] = {
        loop: clip.loop !== false, ...(clip.loop === false && clip.next ? { next: clip.next } : {}),
        ...(tm.events ? { events: tm.events } : {}),
        rootMotion: { mode: 'in-place', speed: +vl.toFixed(4), axis: vl > 0 ? v.map(x => +(x / vl).toFixed(6)) : [0, 0, 1], stride: +(tm.stride || 0).toFixed(4) },
        fps: o.fps, fittedTo: { legLength: +rig.legLength.toFixed(4), hipHeight: +rig.hipHeight.toFixed(4) },
      };
    }
    return { clips, extras };
  }

  // ---- export ----
  async function exportGlb(options = {}, onProgress = () => {}) {
    const o = normalizeExportOptions(options);
    const body = deps.getBody();
    if (!body) throw new Error('no body loaded');
    const st = settings();
    const step = async (f, key) => { onProgress(f, t(key)); await yieldUI(); };
    await step(0.05, 'stPrepare');
    const worn = new Set(deps.clothing?.worn?.() ?? []);
    const values = deps.bodyValues();
    const infl = sliderInfluences(values);
    const breastState = window.__breast?.() ?? null;
    const breasts = breastGate(values) > 0;                   // female adult: the dyn_breast_* morphs can move
    const picked = [];
    for (const m of deps.getParts()) {
      const kind = classify(m, body);
      if (kind === 'clothing') {
        if (!o.clothing || !worn.has(m.userData.ccClothing)) continue;
        if (o.removeHiddenSkin && (m.userData.ccCovered || !m.visible)) continue;
      } else if (kind === 'hair') { if (!o.hair || !m.visible) continue; }
      else if (kind !== 'body' && kind !== 'other' && !o[kind]) continue;
      else if (kind === 'other' && !m.visible) continue;
      picked.push({ m, kind });
    }
    const { armature, skeleton, bones, restRoot } = buildSkeleton(o);
    const scene = new THREE.Scene();
    scene.name = 'Character';
    scene.add(armature);
    const name = uniqueNamer();
    bones.forEach(b => { b.name = name(b.name); });          // already engine-safe (MPFB game_engine names)
    const boneNames = new Set(bones.map(b => b.name));

    // nodes: one per part; the three eye primitives become one mesh "Eyes"; merge = everything in "Character"
    const groups = new Map();
    for (const p of picked) {
      const key = o.merge ? 'Character' : p.kind === 'eyes' ? 'Eyes' : p.kind === 'body' ? 'Body' : p.m.name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const matCache = new Map();
    const nodeExtras = {}, meshExtras = {};
    let gi = 0;
    for (const [key, list] of groups) {
      const prepared = list.map(p => ({ ...prepGeometry(p.m, p.kind, o, infl, breasts), part: p }));
      await step(0.05 + 0.3 * (++gi / groups.size), 'stPrepare');
      const { geo, names, weights } = toGeometry(prepared);
      const mats = [];
      for (const p of prepared) {
        const src = [].concat(p.part.m.material)[0];
        if (!matCache.has(src)) { await step(0.35, 'stMaterials'); matCache.set(src, await convertMaterial(src, o)); }
        mats.push(matCache.get(src));
      }
      const mesh = new THREE.SkinnedMesh(geo, mats.length === 1 ? mats[0] : mats);
      mesh.name = name(key);
      if (names.length) {
        mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
        mesh.morphTargetInfluences = weights.slice();
      }
      // skinned meshes at the scene root (glTF ignores their parents' transforms; validator NODE_SKINNED_MESH_NON_ROOT);
      // their vertices are in the armature's local space, so a non-identity armature node carries its transform along
      scene.add(mesh);
      mesh.position.copy(armature.position); mesh.quaternion.copy(armature.quaternion); mesh.scale.copy(armature.scale);
      mesh.updateMatrixWorld(true);
      mesh.bind(skeleton, mesh.matrixWorld.clone());          // explicit: bind() alone would re-measure a posed skeleton
      // extras (node + glTF mesh, the latter is where the viewer's GLBs carry ccCloth / ccJiggle)
      const ex = {};
      const parts = prepared.map(p => {
        const it = p.part.kind === 'clothing' ? deps.clothing?.catalog?.items.find(i => i.id === p.part.m.userData.ccClothing) : null;
        return { name: p.part.m.name, kind: p.part.kind, material: [].concat(p.part.m.material)[0]?.name,
          ...(it ? { clothing: it.id, slot: it.slot, layer: it.layer ?? 0 } : {}), ...(p.cloth ? { ccCloth: p.cloth } : {}) };
      });
      if (prepared.length === 1) {
        const p = parts[0];
        if (p.clothing) Object.assign(ex, { ccClothing: p.clothing, ccSlot: p.slot, ccLayer: p.layer });
        if (p.ccCloth) ex.ccCloth = p.ccCloth;
      } else ex.ccParts = parts;
      if (list.some(p => p.kind === 'body')) {
        const cat = deps.clothing?.catalog;
        if (body.userData?.ccJiggle && breasts) {
          ex.ccJiggle = { ...body.userData.ccJiggle, driverBone: 'spine_03', morphs: DYN_MORPHS, params: BREAST_PHYSICS,
            runtime: breastState ? { scale: breastState.scale, support: breastState.support } : undefined,
            note: o.shape === 'baked' && !o.dynamicMorphs ? 'dyn_breast_* morphs not exported (dynamicMorphs off)' : undefined };
        }
        if (cat?.bodyZones) {
          ex.ccBodyZones = cat.bodyZones;
          ex.ccHiddenZones = deps.clothing.state().hiddenZones;
          ex.ccHiddenSkin = o.removeHiddenSkin ? 'removed' : 'kept; _CCZONE marks the zones (drop triangles whose 3 vertices are in ccHiddenZones)';
        }
      }
      if (Object.keys(ex).length) { nodeExtras[mesh.name] = JSON.parse(JSON.stringify(ex)); meshExtras[mesh.name] = nodeExtras[mesh.name]; }
    }
    // pose of the node hierarchy (rest or the current frame) is already set; skins use the rest bind pose
    await step(0.45, 'stAnim');
    const anim = sampleClips(o, restRoot, boneNames);

    await step(0.6, 'stWrite');
    const exporter = new GLTFExporter();
    const raw = await exporter.parseAsync(scene, {
      binary: true, trs: true, onlyVisible: false, animations: anim.clips,
      maxTextureSize: o.textureSize || Infinity,
    });

    await step(0.9, 'stPack');
    const credits = buildCredits({ assetLicenses: await assetLicenses(), hairManifest: deps.getHairManifest?.(), catalog: deps.clothing?.catalog,
      hair: o.hair ? st.hair : null, outfit: o.clothing ? st.outfit : [] });
    const cc = {
      format: 'charactercreator.export', version: EXPORT_VERSION,
      settings: st, sex: st.sex, values: st.values, outfit: o.clothing ? st.outfit : [], hair: o.hair ? st.hair : null,
      colors: { ...st.colors, clothing: st.clothColors },
      export: { ...o, animations: o.animations === 'none' ? 'none' : anim.clips.map(c => c.name) },
      units: 'metres, glTF Y-up, character faces +Z', rig: 'mpfb-game_engine', rootBone: ROOT_BONE,
      humanoid: humanoidBoneTable(MPFB_GAME_ENGINE),
      notInExport: ['skin SSS / pore / region shader (plain PBR)', 'hair gradient / hairline shader', 'garment lining colour on back faces',
        'cloth and breast simulation (data in extras only)', 'eye catchlight'],
      credits,
    };
    const { glb, stats } = postProcessGlb(raw, {
      quantize: o.quantize,
      metadata: {
        generator: `CharacterCreator glTF export v${EXPORT_VERSION} (three.js GLTFExporter r${THREE.REVISION})`,
        copyright: CREDITS_SUMMARY,
        extras: { characterCreator: cc },
        sceneExtras: { characterCreator: { settings: st } },
        animationExtras: anim.extras, nodeExtras, meshExtras,
      },
    });
    // free GPU-less temporaries (canvas textures / geometries)
    scene.traverse(x => { if (x.isMesh) { x.geometry.dispose(); [].concat(x.material).forEach(mm => { mm.map?.isCanvasTexture && mm.map.dispose(); mm.dispose(); }); } });
    onProgress(1, t('exDone'));
    lastStats = { bytes: glb.byteLength, morphs: stats, options: o };
    return glb;
  }
  let lastStats = null;

  /** Queued: one export at a time. */
  function exportQueued(options, onProgress) {
    const run = () => exportGlb(options, onProgress);
    busy = (busy ?? Promise.resolve()).catch(() => {}).then(run);
    return busy;
  }

  // ---- UI ----
  function download(data, filename, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function buildUI() {
    if (!deps.ui) return;
    const d = Object.assign(document.createElement('details'), { open: false });
    d.dataset.section = 'secExport';
    d.append(Object.assign(document.createElement('summary'), { textContent: t('secExport') }));
    const sel = (label, key, opts) => {
      const l = Object.assign(document.createElement('label'), { textContent: label });
      const s = document.createElement('select');
      s.setAttribute('aria-label', label); s.dataset.export = key;
      for (const [v, txt] of opts) s.append(new Option(txt, v));
      d.append(l, s);
      return s;
    };
    const ui = {
      shape: sel(t('exShape'), 'shape', [['baked', t('exBaked')], ['morphs', t('exMorphs')]]),
      pose: sel(t('exPose'), 'pose', [['rest', t('exRest')], ['current', t('exCurrent')]]),
      animations: sel(t('exAnim'), 'animations', [['none', t('exAnimNone')], ['all', t('exAnimAll')]]),
      fps: sel(t('exFps'), 'fps', [['60', '60 fps'], ['30', '30 fps']]),
      textureSize: sel(t('exTex'), 'textureSize', [['0', t('exTexOrig')], ['1024', '1024 px'], ['512', '512 px']]),
    };
    const checks = {};
    for (const [k, key, def] of [['clothing', 'exClothing', true], ['hair', 'exHair', true], ['eyes', 'exEyes', true], ['teeth', 'exTeeth', true],
      ['tongue', 'exTongue', true], ['brows', 'exBrows', true], ['lashes', 'exLashes', true], ['removeHiddenSkin', 'exRemoveHidden', true], ['merge', 'exMerge', false]]) {
      const l = Object.assign(document.createElement('label'), { className: 'check' });
      const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: def });
      c.dataset.export = k;
      l.append(c, document.createTextNode(` ${t(key)}`));
      checks[k] = c;
      d.append(l);
    }
    const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: t('exButton') });
    btn.dataset.export = 'run';
    const prog = Object.assign(document.createElement('progress'), { max: 1, value: 0, hidden: true });
    prog.style.cssText = 'width:100%;margin-top:6px';
    const msg = Object.assign(document.createElement('div'), { role: 'status' });
    msg.style.cssText = 'margin-top:4px;opacity:.85;font-size:12px;overflow-wrap:anywhere';
    const note = Object.assign(document.createElement('div'), { textContent: t('exNote') });
    note.style.cssText = 'margin-top:8px;opacity:.6;font-size:11px';
    const opts = () => ({ shape: ui.shape.value, pose: ui.pose.value, animations: ui.animations.value, fps: +ui.fps.value, textureSize: +ui.textureSize.value,
      ...Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.checked])) });
    btn.onclick = async () => {
      btn.disabled = true; prog.hidden = false; prog.value = 0; msg.textContent = t('exBusy');
      try {
        const o = normalizeExportOptions(opts());
        const glb = await exportQueued(o, (f, s) => { prog.value = f; msg.textContent = s; });
        const fn = exportFileName(settings(), o);
        download(glb, fn, 'model/gltf-binary');
        msg.textContent = `${t('exDone')}: ${fn} (${fmtBytes(glb.byteLength)})`;
      } catch (e) {
        console.error('[export] failed', e);
        msg.textContent = `${t('exError')} ${e?.message || e}`;
      } finally { btn.disabled = false; prog.hidden = true; }
    };
    const save = Object.assign(document.createElement('button'), { type: 'button', textContent: t('exSaveJson') });
    save.onclick = () => download(JSON.stringify(settings(), null, 1), `character_${settings().sex}.json`, 'application/json');
    const file = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json,.glb,model/gltf-binary', hidden: true });
    const load = Object.assign(document.createElement('button'), { type: 'button', textContent: t('exLoadJson') });
    load.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        let obj;
        if (/\.glb$/i.test(f.name)) {
          const { parseGlb } = await import('./glbpack.js');
          obj = parseGlb(await f.arrayBuffer()).json.extras;
        } else obj = JSON.parse(await f.text());
        await applySettings(obj);
        msg.textContent = t('exLoaded');
      } catch (e) { msg.textContent = `${t('exLoadError')} ${e?.message || e}`; }
    };
    const share = Object.assign(document.createElement('button'), { type: 'button', textContent: t('exShare') });
    const linkOut = Object.assign(document.createElement('input'), { type: 'text', readOnly: true, hidden: true });
    linkOut.setAttribute('aria-label', t('exLink'));
    linkOut.style.cssText = 'width:100%;box-sizing:border-box;margin-top:6px;background:#2b2f37;color:#ddd;border:1px solid #555;padding:4px';
    share.onclick = async () => {
      const link = shareLink();
      linkOut.value = link; linkOut.hidden = false; linkOut.select();
      try { await navigator.clipboard.writeText(link); msg.textContent = t('exCopied'); } catch { msg.textContent = t('exLink'); }
    };
    d.append(btn, prog, msg, note, save, load, file, share, linkOut);
    deps.ui.insertBefore(d, deps.before && deps.before.parentNode === deps.ui ? deps.before : null);
  }
  buildUI();

  const api = { exportGlb: exportQueued, settings, applySettings, restoreFromUrl, shareLink, lastStats: () => lastStats };
  // Test hooks: __export(options) -> Promise<ArrayBuffer> (GLB); __exportSettings() -> settings object;
  // __loadSettings(obj | GLB extras) -> Promise; __shareLink() -> URL string; __exportStats() -> last export stats.
  window.__export = (options = {}) => exportQueued(options);
  window.__exportSettings = () => settings();
  window.__loadSettings = obj => applySettings(obj);
  window.__shareLink = () => shareLink();
  window.__exportStats = () => lastStats;
  return api;
}
