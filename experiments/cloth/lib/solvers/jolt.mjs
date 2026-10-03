// SPDX-License-Identifier: GPL-3.0-or-later
// B) Jolt Physics soft body (jolt-physics npm = JoltPhysics.js, WASM, single-threaded build).
// Kinematic (invMass 0) vertices are integrated with their velocity, so each frame they are put at the
// previous target with velocity (target - previous) / dt and end the step exactly on the target.
// Cloth = SoftBodySharedSettings from the garment triangles; CreateConstraints() builds edge / shear /
// dihedral bend constraints (XPBD inside Jolt). Pinned vertices: invMass 0, positions written into the
// vertex array every frame. Capsules: kinematic CapsuleShape bodies moved with MoveKinematic.
// Param skinned:true uses Jolt's skinned constraints instead (one joint = hips, per-vertex MaxDistance =
// (1 - mask) * maxDistance, i.e. the portable mask 1:1; SkinVertices() each frame hard-skins invMass-0 vertices).
// Default off so all candidates get the same binary pin.
export const name = 'jolt';
let Jolt = null;

export async function init() {
  if (Jolt) return Jolt;
  const m = await import('jolt-physics/wasm-compat');
  Jolt = await (m.default ?? m)();
  return Jolt;
}

import { capsuleTracker } from '../capsule.mjs';

export async function createSolver(g, body, frame0, pin0, P = {}) {
  const J = await init();
  const prm = { iterations: 8, collisionSteps: 2, compliance: 0, shearCompliance: 1e-5, bendCompliance: 2e-3,
    damping: 0.4, thickness: 0.008, particleMass: 0.002, friction: 0.3, updatePosition: true, bendType: 'Distance', skinned: false, maxDistance: 0.6, ...P };  // Dihedral exploded on capsule contact (see report)
  const LAYER_STATIC = 0, LAYER_MOVING = 1;
  const settings = new J.JoltSettings();
  settings.mMaxWorkerThreads = 0;
  const objFilter = new J.ObjectLayerPairFilterTable(2);
  objFilter.EnableCollision(LAYER_STATIC, LAYER_MOVING); objFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);
  const bpi = new J.BroadPhaseLayerInterfaceTable(2, 2);
  bpi.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(0));
  bpi.MapObjectToBroadPhaseLayer(LAYER_MOVING, new J.BroadPhaseLayer(1));
  settings.mObjectLayerPairFilter = objFilter;
  settings.mBroadPhaseLayerInterface = bpi;
  settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bpi, 2, objFilter, 2);
  const jolt = new J.JoltInterface(settings);
  J.destroy(settings);
  const system = jolt.GetPhysicsSystem(), bi = system.GetBodyInterface();
  system.SetGravity(new J.Vec3(0, -9.81, 0));

  const trackers = frame0.capsules.map(capsuleTracker);
  const capIds = (prm.noColliders ? [] : frame0.capsules).map((c, k) => {
    const { t, q, half } = trackers[k](c);
    const shape = new J.CapsuleShape(half, c.r);
    const bcs = new J.BodyCreationSettings(shape, new J.RVec3(t[0], t[1], t[2]),
      new J.Quat(q[0], q[1], q[2], q[3]), J.EMotionType_Kinematic, LAYER_MOVING);
    const b = bi.CreateBody(bcs); J.destroy(bcs);
    bi.AddBody(b.GetID(), J.EActivation_Activate);
    return b.GetID();
  });

  const ss = new J.SoftBodySharedSettings();
  const vtx = new J.SoftBodySharedSettingsVertex();
  for (let v = 0; v < g.count; v++) {
    vtx.mPosition = new J.Float3(pin0[3 * v], pin0[3 * v + 1], pin0[3 * v + 2]);
    vtx.mInvMass = g.mask[v] >= 1 ? 0 : 1 / prm.particleMass;
    ss.mVertices.push_back(vtx);
  }
  for (let t = 0; t < g.tris.length; t += 3) {
    const f = new J.SoftBodySharedSettingsFace(g.tris[t], g.tris[t + 1], g.tris[t + 2], 0);
    ss.AddFace(f); J.destroy(f);
  }
  const attr = new J.SoftBodySharedSettingsVertexAttributes();
  attr.mCompliance = prm.compliance; attr.mShearCompliance = prm.shearCompliance; attr.mBendCompliance = prm.bendCompliance;
  ss.CreateConstraints(attr, 1, J[`SoftBodySharedSettings_EBendType_${prm.bendType}`]);
  const hipsM = f => J.Mat44.prototype.sRotationTranslation(new J.Quat(...f.hipsQ), new J.Vec3(...f.hipsPos));
  if (prm.skinned) {
    // bind pose = frame0 (the settings' vertices are pin0), so invBind = inverse(hips matrix at frame0)
    ss.mInvBindMatrices.resize(1);
    const ib = ss.mInvBindMatrices.at(0); ib.mJointIndex = 0; ib.mInvBind = hipsM(frame0).Inversed();
    ss.mSkinnedConstraints.resize(g.count);
    for (let v = 0; v < g.count; v++) {
      const sk = ss.mSkinnedConstraints.at(v);
      sk.mVertex = v;
      const w0 = sk.get_mWeights(0); w0.mInvBindIndex = 0; w0.mWeight = 1;
      for (let k = 1; k < 4; k++) { const w = sk.get_mWeights(k); w.mInvBindIndex = 0; w.mWeight = 0; }
      sk.mBackStopDistance = 1e6; sk.mBackStopRadius = 0.4;
      sk.mMaxDistance = Math.max(1e-3, (1 - g.mask[v]) * prm.maxDistance);   // exactly 0 gave NaN in Step (jolt-physics 1.1.0)
    }
    ss.CalculateSkinnedConstraintNormals();
  }
  ss.Optimize();
  const cs = new J.SoftBodyCreationSettings(ss, new J.RVec3(0, 0, 0), new J.Quat(0, 0, 0, 1), LAYER_MOVING);
  cs.mUpdatePosition = prm.updatePosition; cs.mAllowSleeping = false; cs.mFacesDoubleSided = true;
  cs.mNumIterations = prm.iterations; cs.mLinearDamping = prm.damping; cs.mVertexRadius = prm.thickness;
  cs.mFriction = prm.friction; cs.mGravityFactor = 1;
  const sb = bi.CreateSoftBody(cs); J.destroy(cs);
  bi.AddBody(sb.GetID(), J.EActivation_Activate);
  const mp = J.castObject(sb.GetMotionProperties(), J.SoftBodyMotionProperties);

  // direct heap access to the vertex array (byte offsets of the members inside SoftBodyVertex, checked)
  const v0 = mp.GetVertex(0);
  const base = J.getPointer(v0), stride = J.getPointer(mp.GetVertex(1)) - base;
  const offPos = J.getPointer(v0.get_mPosition()) - base, offPrev = J.getPointer(v0.get_mPreviousPosition()) - base, offVel = J.getPointer(v0.get_mVelocity()) - base;
  { const q = v0.get_mPosition(); if (Math.abs(q.GetX() - J.HEAPF32[(base + offPos) >> 2]) > 1e-7) throw new Error('jolt vertex layout check failed'); }
  const pinned = []; for (let v = 0; v < g.count; v++) if (g.mask[v] >= 1) pinned.push(v);
  const out = new Float32Array(g.count * 3);
  let pinPrev = Float32Array.from(pin0);
  const tmpV = new J.RVec3(0, 0, 0), sbId = sb.GetID(), jointArr = new J.ArrayMat44();
  // vertex positions are relative to the body position (identity rotation: mMakeRotationIdentity)
  const origin = () => { const p = bi.GetPosition(sbId); return [p.GetX(), p.GetY(), p.GetZ()]; };

  function step(frame, pin, dt) {
    if (capIds.length) frame.capsules.forEach((c, k) => {
      const { t, q: qa } = trackers[k](c);
      tmpV.Set(t[0], t[1], t[2]);
      const q = new J.Quat(qa[0], qa[1], qa[2], qa[3]);
      bi.MoveKinematic(capIds[k], tmpV, q, dt); J.destroy(q);
    });
    const F = J.HEAPF32, o0 = origin();
    if (prm.skinned) {
      // joint matrix relative to the soft body root transform (identity rotation, position = origin)
      const h = frame.hipsPos, M = J.Mat44.prototype.sRotationTranslation(new J.Quat(...frame.hipsQ), new J.Vec3(h[0] - o0[0], h[1] - o0[1], h[2] - o0[2]));
      jointArr.clear(); jointArr.push_back(M);
      mp.SkinVertices(sb.GetWorldTransform(), jointArr.data(), 1, false, jolt.GetTempAllocator());
    } else for (const v of pinned) {
      const p = (base + v * stride + offPos) >> 2, pv = (base + v * stride + offVel) >> 2;
      for (let c = 0; c < 3; c++) { F[p + c] = pinPrev[3 * v + c] - o0[c]; F[pv + c] = (pin[3 * v + c] - pinPrev[3 * v + c]) / dt; }
    }
    jolt.Step(dt, prm.collisionSteps);
    const F2 = J.HEAPF32, o1 = origin();   // heap may have grown; body origin may have moved
    for (let v = 0; v < g.count; v++) {
      const p = (base + v * stride + offPos) >> 2;
      out[3 * v] = F2[p] + o1[0]; out[3 * v + 1] = F2[p + 1] + o1[1]; out[3 * v + 2] = F2[p + 2] + o1[2];
    }
    pinPrev = Float32Array.from(pin);
  }
  return {
    step, positions: () => out, params: prm,
    info: { stride, offPos, offPrev, offVel, edges: ss.mEdgeConstraints.size(), dihedrals: ss.mDihedralBendConstraints.size() },
    dispose() { J.destroy(jolt); },
  };
}
