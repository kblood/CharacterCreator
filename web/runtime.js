// Prototype: MakeHuman macro targets applied at runtime in three.js (no Blender, no baked morphs).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Human, browserLoader, DEFAULT_MACROS } from './mh/human.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(devicePixelRatio);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2a2d34);
const cam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 50); cam.position.set(0, 1.0, 4.2);
const ctl = new OrbitControls(cam, renderer.domElement); ctl.target.set(0, 0.85, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(2, 3, 3); scene.add(key);
scene.add(new THREE.GridHelper(4, 16, 0x555555, 0x333333));

const human = await new Human(browserLoader('./data/')).init();
const geo = new THREE.BufferGeometry();
const posAttr = new THREE.BufferAttribute(human.positions, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', posAttr);
geo.setAttribute('uv', new THREE.BufferAttribute(human.uv, 2));
geo.setIndex(new THREE.BufferAttribute(human.index, 1));
const mat = new THREE.MeshStandardMaterial({ color: '#c99a80', roughness: 0.6 });
const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; scene.add(mesh);

const m = structuredClone(DEFAULT_MACROS); let busy = false, dirty = true, lastMs = 0;
async function refresh() {
  if (busy || !dirty) return; busy = true; dirty = false;
  const t0 = performance.now();
  const total = Object.values(m.race).reduce((a, b) => a + b, 0) || 1;
  const race = Object.fromEntries(Object.entries(m.race).map(([k, v]) => [k, v / total]));
  await human.apply({ ...m, race });
  posAttr.needsUpdate = true; geo.computeVertexNormals();
  // keep feet on the ground
  geo.computeBoundingBox(); mesh.position.y = -geo.boundingBox.min.y;
  lastMs = performance.now() - t0; busy = false;
  document.getElementById('info').textContent = `${human.lastStack.length} targets, ${lastMs.toFixed(0)} ms, height ${(geo.boundingBox.max.y - geo.boundingBox.min.y).toFixed(2)} m`;
  if (dirty) refresh();
}
const ui = document.getElementById('ui');
function slider(label, get, set) {
  const l = document.createElement('label'); l.innerHTML = `${label}<span class="v"></span>`;
  const r = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 1, step: 0.01, value: get() });
  const show = () => l.querySelector('.v').textContent = (+r.value).toFixed(2); show();
  r.oninput = () => { set(+r.value); show(); dirty = true; refresh(); };
  ui.append(l, r); return r;
}
const h = t => { const e = document.createElement('h3'); e.textContent = t; ui.append(e); };
h('MakeHuman makro');
for (const [k, lab] of [['gender', 'Køn (K=0 · M=1)'], ['age', 'Alder (baby 0 · ung 0.5 · gammel 1)'], ['muscle', 'Muskler'], ['weight', 'Vægt'], ['height', 'Højde'], ['proportions', 'Proportioner']])
  slider(lab, () => m[k], v => m[k] = v);
h('Race (normaliseres)');
for (const k of ['asian', 'caucasian', 'african']) slider(k, () => m.race[k], v => m.race[k] = v);
h('Hud');
const c = Object.assign(document.createElement('input'), { type: 'color', value: '#c99a80' });
c.oninput = () => mat.color.set(c.value); ui.append(c);
window.__set = (k, v) => { if (k in m.race) m.race[k] = v; else m[k] = v; dirty = true; return refresh(); };
window.__ready = true;
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); });
renderer.setAnimationLoop(() => { ctl.update(); renderer.render(scene, cam); });
refresh();
