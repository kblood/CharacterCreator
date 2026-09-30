import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SLIDERS, applySliders, applySkinColor } from './character.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(devicePixelRatio);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2a2d34);
const cam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 50); cam.position.set(0, 1.1, 4);
const ctl = new OrbitControls(cam, renderer.domElement); ctl.target.set(0, 0.9, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(2, 3, 3); scene.add(key);
scene.add(new THREE.GridHelper(4, 16, 0x555555, 0x333333));

const values = { skin: '#c99a80' }; let body;
new GLTFLoader().load('./base_body.glb', g => {
  scene.add(g.scene);
  g.scene.traverse(o => { if (o.isSkinnedMesh) body = o; });
  body.frustumCulled = false; window.__body = body; window.__ready = true;
  update();
});
function update() { if (!body) return; applySliders(body, values); applySkinColor(body, values.skin); }

const ui = document.getElementById('ui');
for (const s of SLIDERS) {
  values[s.id] = 0;
  const l = document.createElement('label'); l.innerHTML = `${s.label}<span class="v">0</span>`;
  const r = Object.assign(document.createElement('input'), { type: 'range', min: -1, max: 1, step: 0.01, value: 0 });
  r.oninput = () => { values[s.id] = +r.value; l.querySelector('.v').textContent = (+r.value).toFixed(2); update(); };
  ui.append(l, r);
}
const cl = document.createElement('label'); cl.textContent = 'Hudfarve';
const c = Object.assign(document.createElement('input'), { type: 'color', value: values.skin });
c.oninput = () => { values.skin = c.value; update(); }; ui.append(cl, c);
window.__set = (k, v) => { values[k] = v; update(); };
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); });
renderer.setAnimationLoop(() => { ctl.update(); renderer.render(scene, cam); });
