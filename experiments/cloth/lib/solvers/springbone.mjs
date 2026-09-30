// E) Spring bones: @pixiv/three-vrm-springbone (VRMC_springBone runtime). The skirt is `around` bone
// chains of `rows` joints hanging from the waistband (row 0 = chain roots, parented to a hips object);
// every garment vertex is one bone position, so the same metrics apply. No lateral constraints between
// chains (that is the nature of spring-bone skirts). Colliders: VRM capsule colliders on the same capsules.
import * as THREE from 'three';
import {
  VRMSpringBoneManager, VRMSpringBoneJoint, VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule,
} from '@pixiv/three-vrm-springbone';
import { capsuleTracker } from '../capsule.mjs';

export const name = 'springbone';

export function createSolver(g, body, frame0, pin0, P = {}) {
  const prm = { stiffness: 0.6, gravityPower: 1.0, dragForce: 0.4, hitRadius: 0.01, ...P };
  const scene = new THREE.Scene();
  const hips = new THREE.Object3D(); scene.add(hips);
  const H = body.heads.hips;
  const setHips = f => { hips.position.set(...f.hipsPos); hips.quaternion.set(...f.hipsQ); hips.updateMatrixWorld(true); };
  setHips(frame0);

  const trackers = frame0.capsules.map(capsuleTracker);
  const colliderObjs = frame0.capsules.map((c, k) => {
    const { half } = trackers[k](c);
    const shape = new VRMSpringBoneColliderShapeCapsule({ radius: c.r, offset: new THREE.Vector3(0, -half, 0), tail: new THREE.Vector3(0, half, 0) });
    const col = new VRMSpringBoneCollider(shape);
    const holder = new THREE.Object3D(); holder.add(col); scene.add(holder);
    return { holder, col };
  });
  const setColliders = f => f.capsules.forEach((c, k) => {
    const { t, q } = trackers[k](c);
    colliderObjs[k].holder.position.set(...t); colliderObjs[k].holder.quaternion.set(...q);
  });
  setColliders(frame0);
  scene.updateMatrixWorld(true);
  const group = { colliders: colliderObjs.map(o => o.col), name: 'body' };

  const { around, rows } = g;
  const bones = new Array(g.count);
  const settings = { hitRadius: prm.hitRadius, stiffness: prm.stiffness, gravityPower: prm.gravityPower,
    gravityDir: new THREE.Vector3(0, -1, 0), dragForce: prm.dragForce };
  for (let i = 0; i < around; i++) {
    let parent = hips, prevRest = H;
    for (let j = 0; j < rows; j++) {
      const v = j * around + i, r = [g.pos[3 * v], g.pos[3 * v + 1], g.pos[3 * v + 2]];
      const b = new THREE.Object3D();
      b.position.set(r[0] - prevRest[0], r[1] - prevRest[1], r[2] - prevRest[2]);
      parent.add(b); bones[v] = b; parent = b; prevRest = r;
    }
  }
  scene.updateMatrixWorld(true);
  const mgr = new VRMSpringBoneManager();
  for (let i = 0; i < around; i++) for (let j = 0; j + 1 < rows; j++) {
    mgr.addJoint(new VRMSpringBoneJoint(bones[j * around + i], bones[(j + 1) * around + i], { ...settings }, [group]));
  }
  mgr.setInitState();
  const out = new Float32Array(g.count * 3), w = new THREE.Vector3();

  function step(frame, pin, dt) {
    setHips(frame); setColliders(frame);
    scene.updateMatrixWorld(true);
    mgr.update(dt);
    for (let v = 0; v < g.count; v++) { bones[v].getWorldPosition(w); out[3 * v] = w.x; out[3 * v + 1] = w.y; out[3 * v + 2] = w.z; }
  }
  step(frame0, pin0, 0);
  return { step, positions: () => out, params: prm, info: { joints: mgr.joints.size }, dispose() {} };
}
