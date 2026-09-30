import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SLIDERS, applySliders, applySkinColor, applySkeleton, validateMorphs } from './character.js';

window.__booted = true;
const params = new URLSearchParams(location.search);

// ---- i18n (da default, en via ?lang=en) ----
const I18N = {
  da: {
    gender: 'Køn (K ↔ M)', age: 'Alder (barn ↔ gammel)', height: 'Højde', weight: 'Vægt',
    muscle: 'Muskler', proportions: 'Proportioner', skin: 'Hudfarve', reset: 'Nulstil',
    loading: 'Indlæser model…', glbError: 'Kunne ikke indlæse modellen (base_body.glb).',
    noBody: 'Modellen indeholder ingen skinned mesh.', missingMorphs: 'Manglende morphs:',
  },
  en: {
    gender: 'Gender (F ↔ M)', age: 'Age (child ↔ old)', height: 'Height', weight: 'Weight',
    muscle: 'Muscle', proportions: 'Proportions', skin: 'Skin colour', reset: 'Reset',
    loading: 'Loading model…', glbError: 'Could not load the model (base_body.glb).',
    noBody: 'The model contains no skinned mesh.', missingMorphs: 'Missing morphs:',
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

// ---- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: params.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2a2d34);
const cam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 50); cam.position.set(0, 1.1, 4);
const ctl = new OrbitControls(cam, renderer.domElement); ctl.target.set(0, 0.9, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(2, 3, 3); scene.add(key);
scene.add(new THREE.GridHelper(4, 16, 0x555555, 0x333333));

// ---- state ----
const DEFAULT_SKIN = '#c99a80';
const values = { skin: DEFAULT_SKIN };
for (const s of SLIDERS) values[s.id] = 0;
let body = null, joints = null;

function update() {
  if (!body) return;
  applySliders(body, values);
  if (joints) applySkeleton(body, joints, values);
  applySkinColor(body, values.skin);
}

// Joint sidecar is optional: without it the skeleton simply stays in bind pose.
const jointsReady = fetch('./base_body.joints.json')
  .then(r => (r.ok ? r.json() : null))
  .then(j => { if (j && j.morphs) joints = j; else console.info('[viewer] no joints sidecar, skeleton not adjusted'); })
  .catch(e => console.info('[viewer] joints sidecar unavailable:', e.message));

setStatus(t('loading'));
new GLTFLoader().load('./base_body.glb', async g => {
  scene.add(g.scene);
  g.scene.traverse(o => { if (o.isSkinnedMesh && !body) body = o; });
  if (!body) { setStatus(t('noBody'), true); return; }
  body.frustumCulled = false;
  const missing = validateMorphs(body);
  setStatus(missing.length ? `${t('missingMorphs')} ${missing.join(', ')}` : '', missing.length > 0);
  await jointsReady;
  window.__body = body;
  window.__joints = joints;
  update();
  window.__ready = true;
}, xhr => {
  if (xhr.lengthComputable) setStatus(`${t('loading')} ${Math.round(100 * xhr.loaded / xhr.total)}%`);
}, err => {
  console.error('[viewer] GLB load failed', err);
  setStatus(`${t('glbError')}\n${err?.message || err?.target?.statusText || ''}`.trim(), true);
});

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
const cl = document.createElement('label'); cl.textContent = t('skin');
const c = Object.assign(document.createElement('input'), { type: 'color', value: values.skin });
c.setAttribute('aria-label', t('skin'));
c.oninput = () => { values.skin = c.value; update(); };
inputs.skin = { input: c, show: x => { c.value = x; } };
ui.append(cl, c);

const resetBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: t('reset') });
resetBtn.onclick = () => {
  for (const s of SLIDERS) { values[s.id] = 0; inputs[s.id].show(0); }
  values.skin = DEFAULT_SKIN; inputs.skin.show(DEFAULT_SKIN);
  update();
};
ui.append(resetBtn);

// Test hook: window.__set('height', 1) / window.__set('skin', '#ff0000')
window.__set = (k, v) => { values[k] = v; inputs[k]?.show(v); update(); };

addEventListener('resize', () => {
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix();
});
renderer.setAnimationLoop(() => { ctl.update(); renderer.render(scene, cam); });
