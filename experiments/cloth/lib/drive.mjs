// Kinematic driver: the REAL web/animation animator (crossfades, phase matching, ground guard) on a
// fake bone hierarchy built from the rest joint heads, so it runs headless in node and identically in
// the browser. Output per 60 Hz frame: posed joint heads, hips rotation, forward travel, capsules.
import { createAnimator } from '../../../web/animation/animator.js';
import { createHumanoid } from '../../../web/humanoid.js';
import { JOINTS, fkPositions, poseToWorld } from '../../../web/animation/canonical.js';
import { MPFB_GAME_ENGINE } from '../../../web/animation/rig.js';
import { qRotate } from '../../../web/animation/qmath.js';
import { CAPSULES, capsuleEnds } from './bodies.mjs';

export const HZ = 60;
export const PREROLL = 1.0;      // s of idle before t = 0 (cloth settles; not measured)
export const DURATION = 10.0;    // measured seconds
// walk 0-3 s, run 3-5.5 s, idle 5.5-7.5 s, idle->run at 7.5 s, run to 10 s (0.3 s crossfades)
export const TIMELINE = [[-PREROLL, 'idle'], [0, 'walk'], [3, 'run'], [5.5, 'idle'], [7.5, 'run']];

function fakeObj(name) {
  const o = { name, parent: null, children: [], position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
  o.quaternion.set = (x, y, z, w) => { Object.assign(o.quaternion, { x, y, z, w }); };
  return o;
}

/** Fake rig: identity rest rotations, bone positions = head deltas -> restHeads() == heads exactly. */
export function fakeHumanoid(heads) {
  const root = fakeObj('scene'), objs = {};
  for (const [j, p] of JOINTS) {
    if (!heads[j]) continue;
    const o = fakeObj(MPFB_GAME_ENGINE[j]);
    const par = p ? objs[p] : null, ph = par ? heads[p] : [0, 0, 0];
    o.position = { x: heads[j][0] - ph[0], y: heads[j][1] - ph[1], z: heads[j][2] - ph[2] };
    o.parent = par || root; o.parent.children.push(o);
    objs[j] = o;
  }
  const mesh = { skeleton: { bones: Object.values(objs) } };
  return createHumanoid(mesh, { root });
}

export function clipAt(t) { let c = TIMELINE[0][1]; for (const [s, n] of TIMELINE) if (t >= s) c = n; return c; }

/**
 * Generator of frames. body = data/bodies.json entry. Each frame:
 *  { i, t, clip, P: {joint: [x,y,z]} (world, incl. travel), hipsQ: [x,y,z,w], hipsPos, travel, capsules: [{name,a,b,r}] }
 */
export function* frames(body, { hz = HZ, duration = DURATION, preroll = PREROLL } = {}) {
  const h = fakeHumanoid(body.heads);
  const anim = createAnimator(h, { getBody: () => body.values });
  const dt = 1 / hz;
  let travel = 0, cur = null;
  const n0 = Math.round(preroll * hz), n1 = Math.round(duration * hz);
  for (let i = -n0; i <= n1; i++) {
    const t = i * dt;
    const want = clipAt(t);
    if (want !== cur) { anim.play(want, { fade: cur ? 0.3 : 0 }); cur = want; }
    anim.update(i === -n0 ? 0 : dt);
    travel += anim.state().rootSpeed * (i === -n0 ? 0 : dt);
    const pose = anim.lastPose() || { joints: {}, root: [0, 0, 0] };
    const P0 = fkPositions(body.heads, pose);
    const P = {};
    for (const [k, v] of Object.entries(P0)) P[k] = [v[0], v[1], v[2] + travel];
    const D = poseToWorld(pose.joints);
    const capsules = CAPSULES.map(def => { const [a, b] = capsuleEnds(def, P); return { name: def[0], a, b, r: body.capsules[def[0]].r }; });
    yield { i, t, clip: want, pose, P, hipsQ: D.hips, hipsPos: P.hips, travel, capsules, measured: t >= 0 };
  }
}

/** Rest-space point (character frame at rest) rigidly attached to the hips -> world, for a frame. */
export function hipsAttach(frame, body, pRest) {
  const H = body.heads.hips;
  const r = qRotate(frame.hipsQ, [pRest[0] - H[0], pRest[1] - H[1], pRest[2] - H[2]]);
  return [frame.hipsPos[0] + r[0], frame.hipsPos[1] + r[1], frame.hipsPos[2] + r[2]];
}
