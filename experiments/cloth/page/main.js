// Browser view of one experiment run: the real body GLB (sliders + skeleton offsets + the same pose as the
// headless driver) with the simulated skirt. URL params:
//   solver=xpbd|rapier|jolt|springbone  n=500|2000  body=neutral|tall|short|heavy|child|old
//   shots=1.5,4.2,8.4   (pause at these times for screenshots; window.__shotReady / __continue())
//   view=front34|side|back  caps=1 (draw the capsule colliders)  play=1 (real-time playback loop)
// When the run ends: window.__result (metrics + ms per frame measured in this browser), window.__done.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { applySliders, applySkeleton, characterMeshes, bindToSkeleton } from '../../../web/character.js';
import { createHumanoid, applyPose } from '../../../web/humanoid.js';
import { runOne } from '../lib/run.mjs';

const q = new URLSearchParams(location.search);
const SOLVER = q.get('solver') || 'xpbd', N = Number(q.get('n') || 500), BODY = q.get('body') || 'neutral';
const SHOTS = (q.get('shots') || '').split(',').filter(Boolean).map(Number);
const VIEW = q.get('view') || 'front34', PLAY = q.get('play') === '1';
const hud = document.getElementById('hud');
const say = s => { hud.textContent = s; };

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2a2d34);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(2, 4, 3); scene.add(sun);
const grid = new THREE.GridHelper(80, 160, 0x777777, 0x444444); grid.position.z = 30; scene.add(grid);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100);
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

const [data, joints, gltf] = await Promise.all([
  fetch('../data/bodies.json').then(r => r.json()),
  fetch('../../../output/base_body.joints.json').then(r => r.json()),
  new GLTFLoader().loadAsync('../../../output/base_body.glb'),
]);
const body = data.bodies[BODY];
scene.add(gltf.scene);
const meshes = characterMeshes(gltf.scene);
const bodyMesh = meshes.find(m => m.name === 'Body') || meshes[0];
for (const m of meshes) { if (m !== bodyMesh) bindToSkeleton(m, bodyMesh.skeleton, bodyMesh.bindMatrix); applySliders(m, body.values); m.frustumCulled = false; }
gltf.scene.updateMatrixWorld(true);
applySkeleton(bodyMesh, joints, body.values);
const human = createHumanoid(bodyMesh);

const mod = await import(`../lib/solvers/${SOLVER}.mjs`);
await mod.init?.();

// skirt mesh (geometry filled on the first frame)
const skirtGeo = new THREE.BufferGeometry();
const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.8, side: THREE.DoubleSide }));
skirt.frustumCulled = false; scene.add(skirt);
const capMeshes = [];

function place(f, P, g) {
  if (!skirtGeo.index) {
    skirtGeo.setIndex(new THREE.BufferAttribute(Uint32Array.from(g.tris), 1));
    skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(g.count * 3), 3));
  }
  skirtGeo.attributes.position.array.set(P); skirtGeo.attributes.position.needsUpdate = true;
  skirtGeo.computeVertexNormals();
  applyPose(human, f.pose);
  gltf.scene.position.set(f.pose.root[0], f.pose.root[1], f.pose.root[2] + f.travel);
  if (q.get('caps') === '1') f.capsules.forEach((c, k) => {
    if (!capMeshes[k]) { capMeshes[k] = new THREE.Mesh(new THREE.CapsuleGeometry(c.r, 1, 4, 12), new THREE.MeshBasicMaterial({ color: 0xff4040, wireframe: true })); scene.add(capMeshes[k]); }
    const a = new THREE.Vector3(...c.a), b = new THREE.Vector3(...c.b), d = b.clone().sub(a), L = d.length();
    capMeshes[k].geometry.dispose(); capMeshes[k].geometry = new THREE.CapsuleGeometry(c.r, L, 4, 12);
    capMeshes[k].position.copy(a).addScaledVector(d, 0.5);
    capMeshes[k].quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  });
  const h = f.hipsPos;
  const off = { front34: [1.5, 0.15, 1.9], side: [2.4, 0.1, 0.0], back: [0.6, 0.2, -2.3] }[VIEW] || [1.5, 0.15, 1.9];
  const s = body.heads.head[1] / 1.515;             // frame smaller bodies closer
  camera.position.set(h[0] + off[0] * s, h[1] + off[1] * s, h[2] + off[2] * s);
  camera.lookAt(h[0], h[1] - 0.18 * s, h[2]);
  renderer.render(scene, camera);
}

let wall = performance.now();
const result = await runOne(mod, body, N, {
  async onFrame(f, P, g) {
    const shot = SHOTS.find(t => Math.abs(f.t - t) < 0.5 / 60);
    if (shot !== undefined || PLAY) {
      place(f, P, g);
      say(`${SOLVER}  n=${g.count}  body=${BODY}  t=${f.t.toFixed(2)} s  clip=${f.clip}`);
    }
    if (shot !== undefined) {
      window.__shotReady = `${f.t.toFixed(2)}_${f.clip}`;
      await new Promise(res => { window.__continue = () => { window.__shotReady = null; res(); }; });
    } else if (PLAY) {
      const due = wall + 1000 / 60; wall = Math.max(due, performance.now() - 50);
      await new Promise(res => setTimeout(res, Math.max(0, due - performance.now())));
    }
  },
});
delete result.trace;
window.__result = { solver: SOLVER, n: N, body: BODY, ua: navigator.userAgent, ...result };
window.__done = true;
say(`${SOLVER} n=${N} ${BODY}: done  ${result.msMean} ms/frame (browser), pen ${result.penEvents}`);
