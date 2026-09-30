// Capsule (segment a-b, radius r) -> rigid transform of an engine capsule whose axis is local +Y.
// The rotation must be CONTINUOUS over time: a naive "shortest arc from +Y" is singular for segments that
// point down (thighs, shins), which flips the rotation between frames and gives a kinematic body huge
// angular velocities (Jolt exploded, Rapier over-stretched before this). So: fixed rest orientation per
// capsule + shortest arc from the rest direction to the current one (well conditioned for < ~150 deg).
import { qMul, qFromTo, qNormalize } from '../../../web/animation/qmath.js';

const norm = d => { const L = Math.hypot(d[0], d[1], d[2]); return [d[0] / L, d[1] / L, d[2] / L]; };

export function capsuleTracker(c0) {
  const rest = norm([c0.b[0] - c0.a[0], c0.b[1] - c0.a[1], c0.b[2] - c0.a[2]]);
  // rest orientation: +Y -> rest direction, built via an intermediate axis that is never opposite
  const mid = Math.abs(rest[1]) > 0.5 ? [1, 0, 0] : [0, 1, 0];
  const q0 = qNormalize(qMul(qFromTo(mid, rest), qFromTo([0, 1, 0], mid)));
  return c => {
    const d = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]], L = Math.hypot(...d);
    const q = qNormalize(qMul(qFromTo(rest, norm(d)), q0));
    return { t: [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2, (c.a[2] + c.b[2]) / 2], q, half: L / 2 };
  };
}
