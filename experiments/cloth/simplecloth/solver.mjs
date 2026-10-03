// SPDX-License-Identifier: GPL-3.0-or-later
// C) three-simplecloth (WebGPU compute, three r182) wrapped in the same solver interface as lib/solvers/*.
// Browser only. The skirt is a SkinnedMesh with one bone (hips); mask -> vertex colour GREEN channel
// (the library reads G: 1 = skinned, 0 = cloth). Param noColliders:true for diagnostics. The library only has SPHERE colliders, so every capsule
// is approximated by spheres along its axis (radius = capsule radius + thickness).
// step() runs cloth.update(dt, stepsPerSecond) and reads the particle buffer back (for the metrics).
import * as THREE from 'three';
import { SimpleCloth } from './patched/index.js';

export const name = 'simplecloth';
let renderer = null, scene = null;
export function setContext(r, s) { renderer = r; scene = s; }
export const handles = {};

export async function createSolver(g, body, frame0, pin0, P = {}) {
  const prm = { stiffness: 0.2, dampening: 0.96, stepsPerSecond: 360, thickness: 0.008, readback: true, ...P };
  const N = g.count;
  // skinned skirt: rest positions in the character frame, one bone at the rest hips head
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(g.pos), 3));
  const col = new Float32Array(N * 3);
  for (let v = 0; v < N; v++) { col[3 * v] = 1; col[3 * v + 1] = g.mask[v]; col[3 * v + 2] = g.mask[v]; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(N * 4), 4));
  const sw = new Float32Array(N * 4); for (let v = 0; v < N; v++) sw[4 * v] = 1;
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(g.tris), 1));
  const bone = new THREE.Bone(); bone.name = 'hips';
  const H = body.heads.hips;
  bone.position.set(H[0], H[1], H[2]);
  const rig = new THREE.Group(); rig.add(bone); scene.add(rig);
  rig.updateMatrixWorld(true);
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.8, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  rig.add(mesh);
  mesh.bind(new THREE.Skeleton([bone]), new THREE.Matrix4());
  const setBone = f => {
    bone.position.set(f.hipsPos[0], f.hipsPos[1], f.hipsPos[2]);
    bone.quaternion.set(f.hipsQ[0], f.hipsQ[1], f.hipsQ[2], f.hipsQ[3]);
    rig.updateMatrixWorld(true); mesh.skeleton.update();
  };
  setBone(frame0);

  // sphere colliders along each capsule (count fixed from the rest length)
  const colRoot = new THREE.Group(); scene.add(colRoot);
  const spheres = frame0.capsules.map(c => {
    const L = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
    const k = Math.max(2, Math.ceil(L / (0.5 * c.r)) + 1);
    return Array.from({ length: k }, () => {
      const o = new THREE.Object3D(); o.userData.clothCollider = true; o.scale.setScalar(c.r + prm.thickness);
      colRoot.add(o); return o;
    });
  });
  const placeSpheres = f => f.capsules.forEach((c, i) => spheres[i].forEach((o, j, arr) => {
    const s = j / (arr.length - 1);
    o.position.set(c.a[0] + (c.b[0] - c.a[0]) * s, c.a[1] + (c.b[1] - c.a[1]) * s, c.a[2] + (c.b[2] - c.a[2]) * s);
    o.updateMatrixWorld(true);
  }));
  placeSpheres(frame0);

  const cloth = SimpleCloth.onSkinnedMesh(mesh, renderer, {
    collidersRoot: prm.noColliders ? undefined : colRoot, stiffness: prm.stiffness, dampening: prm.dampening,
    gravityPerSecond: new THREE.Vector3(0, -9.81, 0), windPerSecond: new THREE.Vector3(0, 0, 0),
  });
  handles.mesh = mesh; handles.cloth = cloth; handles.sphereCount = spheres.flat().length;
  if (cloth.uniqueCount !== N) throw new Error(`unique vertex count ${cloth.uniqueCount} != ${N} (order mapping would break)`);
  // the library initialises inside requestAnimationFrame -> wait for it
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const pos = Float32Array.from(pin0);
  const readback = async () => {
    const buf = new Float32Array(await renderer.getArrayBufferAsync(cloth.positions.value));
    for (let v = 0; v < N; v++) { pos[3 * v] = buf[4 * v]; pos[3 * v + 1] = buf[4 * v + 1]; pos[3 * v + 2] = buf[4 * v + 2]; }
  };
  return {
    params: prm,
    async step(f, pin, dt) {
      setBone(f); placeSpheres(f);
      cloth.update(dt, prm.stepsPerSecond);
      if (prm.readback) await readback();
    },
    readback,
    positions: () => pos,
    dispose() { scene.remove(rig); scene.remove(colRoot); geo.dispose(); },
  };
}
