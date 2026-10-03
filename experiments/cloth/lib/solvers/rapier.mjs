// SPDX-License-Identifier: GPL-3.0-or-later
// A) Rapier 0.21 soft body (@dimforge/rapier3d-compat, WASM). Cloth = SoftBodyDesc over raw particle
// positions with structural + shear edges, bend edges, dihedrals and a non-oriented surface (shell).
// Pins are binary (setPinnedParticles) and driven with setParticleKinematicTarget; capsules are
// kinematic position-based rigid bodies. Rapier has no per-particle maxDistance: mask > 0 && < 1 is lost.
export const name = 'rapier';
let RAPIER = null;

export async function init() {
  if (RAPIER) return RAPIER;
  const m = await import('@dimforge/rapier3d-compat');
  RAPIER = m.default ?? m;
  await RAPIER.init();
  return RAPIER;
}

import { capsuleTracker } from '../capsule.mjs';
const V = a => ({ x: a[0], y: a[1], z: a[2] }), Q = q => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

export async function createSolver(g, body, frame0, pin0, P = {}) {
  const R = await init();
  const prm = { frequency: 240, dampingRatio: 1, bendFrequency: 10, damping: 0.4, thickness: 0.008, iterations: 8, substeps: 1, particleMass: 0.002, ...P };  // tuned; first run used 30 / 2 / 4 iterations (stretch 2.4, penetrations)
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  world.numSolverIterations = prm.iterations;
  const trackers = frame0.capsules.map(capsuleTracker);
  const caps = frame0.capsules.map((c, k) => {
    const { t, q, half } = trackers[k](c);
    const rb = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(t[0], t[1], t[2]).setRotation(Q(q)));
    world.createCollider(R.ColliderDesc.capsule(half, c.r), rb);
    return rb;
  });
  const pinned = [];
  for (let v = 0; v < g.count; v++) if (g.mask[v] >= 1) pinned.push(v);
  const mat = new R.SoftBodyMaterial();
  mat.edgeSoftness = { naturalFrequency: prm.frequency, dampingRatio: prm.dampingRatio };
  mat.bendSoftness = { naturalFrequency: prm.bendFrequency, dampingRatio: prm.dampingRatio };
  const desc = new R.SoftBodyDesc(Float32Array.from(pin0))
    .setEdges(Uint32Array.from([...g.edges, ...g.shear]))
    .setBendEdges(g.bends)
    .setDihedrals(g.dihedrals)
    .setSurface(g.tris)
    .setOriented(false)
    .setMaterial(mat)
    .setParticleMass(prm.particleMass)
    .setParticleRadius(prm.thickness)
    .setPinnedParticles(Uint32Array.from(pinned))
    .setLinearDamping(prm.damping)
    .setAdditionalSolverIterations(prm.substeps - 1)
    .setSurfaceCollider(R.ColliderDesc.ball(prm.thickness).setFriction(0.3))
    .setCanSleep(false);
  const sb = world.createSoftBody(desc);
  let out = new Float32Array(g.count * 3);

  function step(frame, pin) {
    frame.capsules.forEach((c, k) => {
      const { t, q } = trackers[k](c);
      caps[k].setNextKinematicTranslation(V(t)); caps[k].setNextKinematicRotation(Q(q));
    });
    for (const v of pinned) sb.setParticleKinematicTarget(v, { x: pin[3 * v], y: pin[3 * v + 1], z: pin[3 * v + 2] });
    world.step();
    out = sb.particlePositions();
  }
  return {
    step, positions: () => out, params: prm,
    info: { particles: sb.numParticles(), edges: sb.numEdges(), dihedrals: sb.numDihedrals() },
    dispose() { world.free(); },
  };
}
