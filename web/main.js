import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SLIDERS, applySliders, applySkinColor, applySkeleton, validateMorphs } from './character.js';
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
    loading: 'Indlæser model…', glbError: 'Kunne ikke indlæse modellen (base_body.glb).',
    noBody: 'Modellen indeholder ingen skinned mesh.', missingMorphs: 'Manglende morphs:',
    anim: 'Animation', animNone: 'Ingen', clip_idle: 'Hvile', clip_walk: 'Gang', clip_run: 'Løb',
    play: 'Afspil', pause: 'Pause', speed: 'Hastighed', animError: 'Animation slået fra:',
  },
  en: {
    gender: 'Gender (F ↔ M)', age: 'Age (child ↔ old)', height: 'Height', weight: 'Weight',
    muscle: 'Muscle', proportions: 'Proportions', skin: 'Skin colour', reset: 'Reset',
    loading: 'Loading model…', glbError: 'Could not load the model (base_body.glb).',
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
let body = null, joints = null, animator = null, humanoid = null;
const bodyValues = () => Object.fromEntries(SLIDERS.map(s => [s.id, values[s.id]]));

// Order matters: applySkeleton moves bone positions for the new body, then the animator re-measures
// that skeleton (leg length, hip height, feet) so the clips adapt. The animator only writes rotations
// and the scene-root offset, so it never fights applySkeleton.
function update() {
  if (!body) return;
  applySliders(body, values);
  if (joints) applySkeleton(body, joints, values);
  animator?.bodyChanged();
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
  update();                                   // first applySkeleton at rest
  try {
    initAnimation();                          // createHumanoid snapshots the rest rotations
  } catch (e) {                               // a rig the animator cannot use must not break the sliders
    console.error('[viewer] animation disabled:', e);
    animator = null; humanoid = null;
    setStatus(`${statusEl.textContent ? statusEl.textContent + '\n' : ''}${t('animError')} ${e?.message || e}`, true);
  }
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
