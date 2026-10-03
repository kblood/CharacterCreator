// SPDX-License-Identifier: GPL-3.0-or-later
// three-simplecloth (candidate C) on the same skirt / bodies / animation timeline as the other solvers.
// URL params: n=500|2000 body=neutral|... shots=1.5,4.2 view=front34|side|back params=<json solver params>
// Two passes: (1) metrics pass with a GPU->CPU readback every frame (ms includes the readback),
// (2) throughput pass without readback (queue all frames, one readback at the end, wall time / frames).
// Result: window.__result, window.__done (same protocol as ../page/main.js; driven by ../shoot.mjs --page=simplecloth).
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { runOne } from '../lib/run.mjs';
import { buildSkirt } from '../lib/garment.mjs';
import { frames, HZ } from '../lib/drive.mjs';
import { pinTargets } from '../lib/run.mjs';
import * as mod from './solver.mjs';

const q = new URLSearchParams(location.search);
const N = Number(q.get('n') || 500), BODY = q.get('body') || 'neutral', VIEW = q.get('view') || 'front34';
const PARAMS = JSON.parse(q.get('params') || '{}');
const SHOTS = (q.get('shots') || '').split(',').filter(Boolean).map(Number);
const hud = document.getElementById('hud');
const say = s => { hud.textContent = s; };
const fail = e => { window.__result = { solver: 'simplecloth', n: N, body: BODY, error: String(e?.stack || e) }; window.__done = true; say('ERROR ' + e); };

try {
  if (!navigator.gpu) throw new Error('navigator.gpu missing (WebGPU not available in this browser/context)');
  const renderer = new WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'fallback (WebGL2)';
  const adapterInfo = await navigator.gpu.requestAdapter().then(a => a ? { ...(a.info ? { vendor: a.info.vendor, architecture: a.info.architecture } : {}), fallback: a.isFallbackAdapter ?? a.info?.isFallbackAdapter } : null);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2a2d34);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(2, 4, 3); scene.add(sun);
  const grid = new THREE.GridHelper(80, 160, 0x777777, 0x444444); grid.position.z = 30; scene.add(grid);
  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100);
  mod.setContext(renderer, scene);

  const data = await fetch('../data/bodies.json').then(r => r.json());
  const body = data.bodies[BODY];
  const capMeshes = [];
  const place = f => {
    f.capsules.forEach((c, k) => {
      const a = new THREE.Vector3(...c.a), b = new THREE.Vector3(...c.b), d = b.clone().sub(a), L = d.length();
      if (!capMeshes[k]) { capMeshes[k] = new THREE.Mesh(new THREE.CapsuleGeometry(c.r, L, 4, 12), new THREE.MeshStandardMaterial({ color: 0xc89a80, roughness: 0.9 })); scene.add(capMeshes[k]); }
      capMeshes[k].position.copy(a).addScaledVector(d, 0.5);
      capMeshes[k].quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    });
    const h = f.hipsPos, s = body.heads.head[1] / 1.515;
    const off = { front34: [1.5, 0.15, 1.9], side: [2.4, 0.1, 0.0], back: [0.6, 0.2, -2.3] }[VIEW] || [1.5, 0.15, 1.9];
    camera.position.set(h[0] + off[0] * s, h[1] + off[1] * s, h[2] + off[2] * s);
    camera.lookAt(h[0], h[1] - 0.18 * s, h[2]);
    renderer.render(scene, camera);
  };

  // pass 1: metrics (+ screenshots)
  const result = await runOne(mod, body, N, {
    params: PARAMS,
    async onFrame(f, P, g) {
      const shot = SHOTS.find(t => Math.abs(f.t - t) < 0.5 / 60);
      if (shot === undefined) return;
      place(f);
      say(`simplecloth  n=${g.count}  body=${BODY}  t=${f.t.toFixed(2)} s  clip=${f.clip}  (capsules drawn as bodies)`);
      await new Promise(r => requestAnimationFrame(r));
      window.__shotReady = `${f.t.toFixed(2)}_${f.clip}`;
      await new Promise(res => { window.__continue = () => { window.__shotReady = null; res(); }; });
    },
  });
  delete result.trace;
  const spheres = mod.handles.sphereCount;

  // pass 2: throughput without per-frame readback
  const g = buildSkirt(body, N);
  let solver = null, count = 0, t0 = 0;
  for (const f of frames(body)) {
    const pin = pinTargets(g, body, f);
    if (!solver) { solver = await mod.createSolver(g, body, f, pin, { ...PARAMS, readback: false }); continue; }
    if (f.measured && !t0) t0 = performance.now();
    await solver.step(f, pin, 1 / HZ);
    if (t0) count++;
  }
  await solver.readback();
  const throughputMs = +((performance.now() - t0) / count).toFixed(3);
  solver.dispose();

  window.__result = { solver: 'simplecloth', n: N, body: BODY, params: PARAMS, backend, adapter: adapterInfo, spheres, ...result, msMeanNote: 'pass 1 incl. per-frame readback', throughputMs };
  window.__done = true;
  say(`simplecloth n=${N} ${BODY}: ${backend} readback ${result.msMean} ms/f, no-readback ${throughputMs} ms/f, pen ${result.penEvents}`);
} catch (e) { fail(e); }
