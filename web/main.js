import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  SLIDERS, applySliders, applySkeleton, validateMorphs, applyTints, characterMeshes, bindToSkeleton, materialRole,
} from './character.js';
import { createHumanoid } from './humanoid.js';
import { createAnimator, SPEED_MIN, SPEED_MAX } from './animation/animator.js';
import { CLIPS } from './animation/clips.js';

window.__booted = true;
const params = new URLSearchParams(location.search);

// ---- i18n (da default, en via ?lang=en) ----
const I18N = {
  da: {
    gender: 'Køn (K ↔ M)', age: 'Alder (barn ↔ gammel)', height: 'Højde', weight: 'Vægt',
    muscle: 'Muskler', proportions: 'Proportioner', skin: 'Hudfarve', reset: 'Nulstil',
    hair: 'Frisure', hairNone: 'Skaldet', hairColor: 'Hårfarve', browColor: 'Øjenbrynsfarve', eyeColor: 'Øjenfarve',
    loading: 'Indlæser model…', glbError: 'Kunne ikke indlæse modellen (base_body.glb).',
    hairError: 'Kunne ikke indlæse frisuren', hairLoading: 'Indlæser frisure…',
    noBody: 'Modellen indeholder ingen skinned mesh.', missingMorphs: 'Manglende morphs:',
    anim: 'Animation', animNone: 'Ingen', clip_idle: 'Hvile', clip_walk: 'Gang', clip_run: 'Løb',
    play: 'Afspil', pause: 'Pause', speed: 'Hastighed', animError: 'Animation slået fra:',
  },
  en: {
    gender: 'Gender (F ↔ M)', age: 'Age (child ↔ old)', height: 'Height', weight: 'Weight',
    muscle: 'Muscle', proportions: 'Proportions', skin: 'Skin colour', reset: 'Reset',
    hair: 'Hair style', hairNone: 'Bald', hairColor: 'Hair colour', browColor: 'Eyebrow colour', eyeColor: 'Eye colour',
    loading: 'Loading model…', glbError: 'Could not load the model (base_body.glb).',
    hairError: 'Could not load the hair style', hairLoading: 'Loading hair…',
    noBody: 'The model contains no skinned mesh.', missingMorphs: 'Missing morphs:',
    anim: 'Animation', animNone: 'None', clip_idle: 'Idle', clip_walk: 'Walk', clip_run: 'Run',
    play: 'Play', pause: 'Pause', speed: 'Speed', animError: 'Animation disabled:',
  },
};
const lang = I18N[params.get('lang')] ? params.get('lang') : 'da';
document.documentElement.lang = lang;
const t = k => I18N[lang][k] ?? I18N.da[k] ?? k;

const statusEl = document.getElementById('status');
function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.className = isError ? 'error' : '';
}

// ---- renderer, lighting ----
// Neutral tone mapping keeps picked colours close to what the colour inputs show; the RoomEnvironment
// (generated, no download) gives image-based light + reflections for skin, eyes and hair; one soft shadow.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: params.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2a2d34);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}
const cam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 50); cam.position.set(0, 1.1, 4);
const ctl = new OrbitControls(cam, renderer.domElement); ctl.target.set(0, 0.9, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.9));
const key = new THREE.DirectionalLight(0xfff4e8, 2.2); key.position.set(2, 3.2, 3);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 2.6, bottom: -0.2, near: 0.5, far: 10 });
key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
scene.add(key);
const rim = new THREE.DirectionalLight(0xdde6ff, 0.8); rim.position.set(-2.5, 2.5, -2.5); scene.add(rim);
scene.add(new THREE.GridHelper(4, 16, 0x555555, 0x333333));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.28 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = 0.001; ground.receiveShadow = true; scene.add(ground);

// ---- state ----
// Default tints == DEFAULTS in blender/build_base.py (also stored as glTF material extras tint.default).
const DEFAULT_TINTS = { skin: '#c99a80', hairColor: '#3b2a1e', browColor: '#3b2a1e', eyeColor: '#4a2f19', lashes: '#1c1510' };
const values = { ...DEFAULT_TINTS, hair: null };
for (const s of SLIDERS) values[s.id] = 0;
let body = null, joints = null, animator = null, humanoid = null, parts = [];
const bodyValues = () => Object.fromEntries(SLIDERS.map(s => [s.id, values[s.id]]));
const tints = () => ({ skin: values.skin, hair: values.hairColor, brows: values.browColor, eyes: values.eyeColor, lashes: values.lashes });

// Order matters: applySkeleton moves bone positions for the new body, then the animator re-measures
// that skeleton (leg length, hip height, feet) so the clips adapt. The animator only writes rotations
// and the scene-root offset, so it never fights applySkeleton. Every part (eyes, brows, teeth, hair ...)
// shares the body's skeleton and carries the same morph targets, so it follows sliders and animation.
function update() {
  if (!body) return;
  for (const m of parts) applySliders(m, values);
  if (joints) applySkeleton(body, joints, values);
  animator?.bodyChanged();
  applyTints(body.parent || body, tints());
}

// Render settings glTF cannot express. Alpha-masked cards (hair, brows, lashes) use alpha-to-coverage
// (smooth edges with MSAA, no sorting); the cornea is a thin clear shell.
function setupMaterials(root) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    for (const m of [].concat(o.material)) {
      if (!m) continue;
      const role = materialRole(m.name);
      if (role === 'hair' || role === 'brows' || role === 'lashes') {
        m.alphaToCoverage = true; m.transparent = false; m.depthWrite = true; m.side = THREE.DoubleSide;
        if (role !== 'hair') o.castShadow = false;
        else m.envMapIntensity = 0.6;             // soft sheen instead of a plastic highlight
      }
      if (m.name === 'Cornea') { m.envMapIntensity = 0.7; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 2; }
      if (m.name === 'Eye' || m.name === 'Iris') o.castShadow = false;
      m.needsUpdate = true;
    }
  });
}

function attachPart(m) {
  if (m !== body) bindToSkeleton(m, body.skeleton, body.bindMatrix);
  m.frustumCulled = false;
  if (!parts.includes(m)) parts.push(m);
}

// Joint sidecar is optional: without it the skeleton simply stays in bind pose.
const jointsReady = fetch('./base_body.joints.json')
  .then(r => (r.ok ? r.json() : null))
  .then(j => { if (j && j.morphs) joints = j; else console.info('[viewer] no joints sidecar, skeleton not adjusted'); })
  .catch(e => console.info('[viewer] joints sidecar unavailable:', e.message));
// Hair manifest is optional too: without it the hair controls stay hidden.
const hairReady = fetch('./hair.json')
  .then(r => (r.ok ? r.json() : null))
  .catch(() => null);

const loader = new GLTFLoader();
setStatus(t('loading'));
loader.load('./base_body.glb', async g => {
  scene.add(g.scene);
  const meshes = characterMeshes(g.scene);
  body = meshes.find(m => m.name === 'Body') ?? null;
  if (!body) g.scene.traverse(o => { if (o.isSkinnedMesh && !body) body = o; });   // old GLBs
  if (!body) { setStatus(t('noBody'), true); return; }
  body.frustumCulled = false;
  parts = [body];
  for (const m of meshes) attachPart(m);
  setupMaterials(g.scene);
  const missing = validateMorphs(body);
  setStatus(missing.length ? `${t('missingMorphs')} ${missing.join(', ')}` : '', missing.length > 0);
  await jointsReady;
  window.__body = body;
  window.__joints = joints;
  window.__parts = parts;
  update();                                   // first applySkeleton at rest
  try {
    initAnimation();                          // createHumanoid snapshots the rest rotations
  } catch (e) {                               // a rig the animator cannot use must not break the sliders
    console.error('[viewer] animation disabled:', e);
    animator = null; humanoid = null;
    setStatus(`${statusEl.textContent ? statusEl.textContent + '\n' : ''}${t('animError')} ${e?.message || e}`, true);
  }
  await initHair();
  if (params.has('view')) setView(params.get('view'));
  window.__ready = true;
}, xhr => {
  if (xhr.lengthComputable) setStatus(`${t('loading')} ${Math.round(100 * xhr.loaded / xhr.total)}%`);
}, err => {
  console.error('[viewer] GLB load failed', err);
  setStatus(`${t('glbError')}\n${err?.message || err?.target?.statusText || ''}`.trim(), true);
});

// ---- hair: one small GLB per style (hair.json), loaded on demand and cached ----
let hairManifest = null, hairToken = 0, hairPending = null;
const hairCache = new Map();                   // id -> [meshes] (bound to the body skeleton)

function showHair(id) {
  for (const [k, ms] of hairCache) for (const m of ms) m.visible = k === id;
}

async function loadHair(id) {
  if (hairCache.has(id)) return hairCache.get(id);
  const style = hairManifest.styles.find(s => s.id === id);
  if (!style) throw new Error(`unknown hair style ${id}`);
  const g = await loader.loadAsync(`./${style.file}`);
  const ms = characterMeshes(g.scene);
  if (!ms.length) throw new Error(`${style.file}: no skinned mesh`);
  const holder = body.parent;
  for (const m of ms) {
    // same space as the body in the source .blend: put it next to the body with the body's local transform
    m.removeFromParent();
    m.position.copy(body.position); m.quaternion.copy(body.quaternion); m.scale.copy(body.scale);
    holder.add(m);
    const r = bindToSkeleton(m, body.skeleton, body.bindMatrix);
    if (r.missing.length) throw new Error(`${style.file}: bones missing in the body skeleton`);
    m.frustumCulled = false;
  }
  setupMaterials({ traverse: f => ms.forEach(m => m.traverse(f)) });
  hairCache.set(id, ms);
  return ms;
}

function setHair(id) {
  id = id || null;
  values.hair = id;
  inputs.hair?.show(id ?? '');
  const token = ++hairToken;
  if (!id || !hairManifest || !body) { showHair(null); hairPending = null; return Promise.resolve(); }
  if (!hairCache.has(id)) setStatus(t('hairLoading'));
  hairPending = loadHair(id).then(ms => {
    if (token !== hairToken) return;           // a newer choice won
    for (const m of ms) if (!parts.includes(m)) parts.push(m);
    showHair(id);
    update();
    if (statusEl.textContent === t('hairLoading')) setStatus('');
  }).catch(e => {
    console.error('[viewer] hair load failed', e);
    if (token === hairToken) { showHair(null); setStatus(`${t('hairError')} (${id}): ${e?.message || e}`, true); }
  }).finally(() => { if (token === hairToken) hairPending = null; });
  return hairPending;
}

async function initHair() {
  hairManifest = await hairReady;
  if (!hairManifest?.styles?.length) { hairUI.forEach(el => { el.hidden = true; }); return; }
  for (const s of hairManifest.styles) hairSel.append(new Option(s.label?.[lang] ?? s.label?.da ?? s.id, s.id));
  const want = params.has('hair') ? params.get('hair') : hairManifest.default;
  await setHair(want && want !== 'none' ? want : null);
}

// ---- camera presets (?view=face|side|front|back and window.__view) ----
function setView(name) {
  const hb = body?.skeleton?.bones.find(b => b.name === 'head');
  const head = hb ? hb.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.55, 0);
  const faceY = head.y + 0.06;
  const V = {
    front: [[0, 1.1, 4], [0, 0.9, 0]],
    side: [[4, 1.1, 0], [0, 0.9, 0]],
    back: [[0, 1.1, -4], [0, 0.9, 0]],
    face: [[head.x, faceY + 0.02, head.z + 0.75], [head.x, faceY, head.z]],
    eyes: [[head.x + 0.05, faceY + 0.03, head.z + 0.34], [head.x + 0.02, faceY + 0.02, head.z + 0.08]],
    mouth: [[head.x + 0.06, faceY - 0.06, head.z + 0.3], [head.x, faceY - 0.08, head.z + 0.08]],
    face34: [[head.x + 0.45, faceY + 0.05, head.z + 0.6], [head.x, faceY, head.z]],
    faceSide: [[head.x + 0.75, faceY, head.z + 0.02], [head.x, faceY, head.z]],
    headBack: [[head.x - 0.35, faceY + 0.15, head.z - 0.7], [head.x, faceY - 0.05, head.z]],
  }[name];
  if (!V) return false;
  cam.position.set(...V[0]); ctl.target.set(...V[1]); ctl.update();
  return true;
}
window.__view = setView;

// ---- UI ----
const ui = document.getElementById('ui');
const inputs = {};
for (const s of SLIDERS) {
  const l = document.createElement('label');
  l.textContent = t(s.id) === s.id ? s.label : t(s.id);
  const v = Object.assign(document.createElement('span'), { className: 'v', textContent: '0.00' });
  l.append(v);
  const r = Object.assign(document.createElement('input'), { type: 'range', min: -1, max: 1, step: 0.01, value: 0 });
  r.setAttribute('aria-label', l.firstChild.textContent);
  r.oninput = () => { values[s.id] = +r.value; v.textContent = (+r.value).toFixed(2); update(); };
  inputs[s.id] = { input: r, show: x => { r.value = x; v.textContent = (+x).toFixed(2); } };
  ui.append(l, r);
}
function colorInput(id, label) {
  const cl = document.createElement('label'); cl.textContent = label;
  const c = Object.assign(document.createElement('input'), { type: 'color', value: values[id] });
  c.setAttribute('aria-label', label);
  c.oninput = () => { values[id] = c.value; update(); };
  inputs[id] = { input: c, show: x => { c.value = x; } };
  ui.append(cl, c);
  return [cl, c];
}
colorInput('skin', t('skin'));
colorInput('eyeColor', t('eyeColor'));

const hl = document.createElement('label'); hl.textContent = t('hair');
const hairSel = document.createElement('select');
hairSel.setAttribute('aria-label', t('hair'));
hairSel.append(new Option(t('hairNone'), ''));
hairSel.onchange = () => { setHair(hairSel.value || null); };
inputs.hair = { input: hairSel, show: x => { hairSel.value = x ?? ''; } };
ui.append(hl, hairSel);
const hairUI = [hl, hairSel, ...colorInput('hairColor', t('hairColor'))];
colorInput('browColor', t('browColor'));

const resetBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: t('reset') });
resetBtn.onclick = () => {
  for (const s of SLIDERS) { values[s.id] = 0; inputs[s.id].show(0); }
  for (const [k, v] of Object.entries(DEFAULT_TINTS)) { values[k] = v; inputs[k]?.show(v); }
  update();
  if (hairManifest) setHair(hairManifest.default);
};
ui.append(resetBtn);

// Test hooks: window.__set('height', 1) / __set('skin', '#ff0000') / __set('hair', 'long01' | null) /
// __set('hairColor' | 'browColor' | 'eyeColor', '#rrggbb'). __set('hair', ...) returns a promise.
window.__set = (k, v) => {
  if (k === 'hair') return setHair(v);
  values[k] = v; inputs[k]?.show(v); update();
  return undefined;
};
window.__hairState = () => ({ style: values.hair, pending: !!hairPending, loaded: [...hairCache.keys()],
  styles: hairManifest?.styles.map(s => s.id) ?? [] });

// ---- animation UI (clips from the registry; new clips appear automatically) ----
const clipLabel = n => (t(`clip_${n}`) === `clip_${n}` ? n : t(`clip_${n}`));
const al = document.createElement('label'); al.textContent = t('anim');
const animSel = document.createElement('select');
animSel.setAttribute('aria-label', t('anim'));
animSel.append(new Option(t('animNone'), ''));
for (const n of Object.keys(CLIPS)) animSel.append(new Option(clipLabel(n), n));
const playBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: t('pause'), disabled: true });
const sl = document.createElement('label'); sl.textContent = t('speed');
const sv = Object.assign(document.createElement('span'), { className: 'v', textContent: '1.00' });
sl.append(sv);
const speedIn = Object.assign(document.createElement('input'), { type: 'range', min: SPEED_MIN, max: SPEED_MAX, step: 0.05, value: 1 });
speedIn.setAttribute('aria-label', t('speed'));
ui.append(al, animSel, playBtn, sl, speedIn);

function syncAnimUI() {
  const st = animator?.state();
  animSel.value = st?.clip ?? '';
  playBtn.disabled = !st?.clip;
  playBtn.textContent = st?.paused ? t('play') : t('pause');
  speedIn.value = st?.speedScale ?? 1; sv.textContent = (+speedIn.value).toFixed(2);
}
animSel.onchange = () => {
  if (!animator) return;
  if (animSel.value) animator.play(animSel.value); else animator.stop();
  syncAnimUI();
};
playBtn.onclick = () => {
  if (!animator) return;
  if (animator.state().paused) animator.resume(); else animator.pause();
  syncAnimUI();
};
speedIn.oninput = () => { animator?.setSpeed(+speedIn.value); sv.textContent = (+speedIn.value).toFixed(2); };

function initAnimation() {
  humanoid = createHumanoid(body);
  animator = createAnimator(humanoid, { getBody: bodyValues });
  // URL params for tests/screenshots: ?anim=walk&animT=0.3 (seek + pause)&animSpeed=1.5
  if (params.has('animSpeed')) animator.setSpeed(+params.get('animSpeed'));
  const a = params.get('anim');
  if (a && CLIPS[a]) {
    animator.play(a, { fade: 0 });
    if (params.has('animT')) { animator.seek(+params.get('animT')); animator.pause(); }
    animator.update(0);
  }
  syncAnimUI();

  // Test hooks: window.__anim = the animator (+ t, boneWorldPos), window.__animProbe()
  const worldPos = j => {
    const b = humanoid.bones[j];
    if (!b) return null;
    humanoid.root.updateMatrixWorld(true);
    const v = b.getWorldPosition(new THREE.Vector3());
    return [v.x, v.y, v.z];
  };
  Object.defineProperty(animator, 't', { get: () => animator.state().time });
  animator.boneWorldPos = worldPos;
  animator.humanoid = humanoid;
  window.__anim = animator;
  window.__animProbe = () => {
    const st = animator.state(), lt = worldPos('leftToes'), rt = worldPos('rightToes');
    const lf = worldPos('leftFoot'), rf = worldPos('rightFoot');
    return { clip: st.clip, phase: st.phase, minToesY: Math.min(lt[1], rt[1]), minFootY: Math.min(lf[1], rf[1]),
      leftToes: lt, rightToes: rt };
  };
}

addEventListener('resize', () => {
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix();
});
const clock = new THREE.Clock();
let uiKey = '';
renderer.setAnimationLoop(() => {
  ctl.update();
  animator?.update(clock.getDelta());
  // Keep the controls in sync when the animator is driven from code (window.__anim, URL params).
  if (animator) {
    const st = animator.state(), k = `${st.clip}|${st.paused}|${st.speedScale}`;
    if (k !== uiKey) { uiKey = k; syncAnimUI(); }
  }
  renderer.render(scene, cam);
});
