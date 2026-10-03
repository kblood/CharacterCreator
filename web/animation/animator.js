// SPDX-License-Identifier: GPL-3.0-or-later
// Runtime player for the procedural canonical clips (docs/ANIMATION_PLAN.md, section 4C).
// Plain ES module, no three.js import: bones/root are used duck-typed, so it also runs in node.
//
// Ownership split with character.js:
//   applySkeleton() writes only bone.position (per-morph joint offsets),
//   the animator writes only bone.quaternion (via humanoid.applyPose) and root.position.
// Call order after a slider change: applySliders -> applySkeleton -> animator.bodyChanged().
// bodyChanged() re-measures the rest skeleton (legs, hips, feet) and rebuilds the clip context, so
// stride, tempo and pelvis height follow the new body on the next update(); the playing phase is kept.
//
// Blending: a stack of weighted layers (a clip or the rest pose). play()/stop() retarget the weights,
// update() moves every weight linearly toward its target (monotonic per layer), and the pose is the
// weighted slerp of all layers. Locomotion clips (timing().speed > 0) share one phase, so a walk <-> run
// fade stays foot-synchronous: the new clip starts at the old clip's phase (new time = phase * new
// duration) and the shared phase advances at the weight-blended rate while fading.
// Locomotion = a looping clip with a non-zero timing().velocity (walk, run, walk_back, strafe_*).
// One-shot clips (clip.loop === false, e.g. jump) start at time 0 on a fresh layer, hold their last frame
// and, `fadeOut` seconds before the end, crossfade to `then` (default clip.next, else idle). A looping clip
// played with { once: true } (the idle variants of the idle variation) does the same after one cycle.
// Root motion is in place: travel is only reported (state().rootSpeed = m/s along +Z, state().rootVelocity
// = [x, y, z] m/s); pose.root (pelvis bob / sway / the jump arc) is applied to `root` (gltf.scene), never
// to a bone.

import { CLIPS, makeContext } from './clips.js';
import { applyPose, resetPose, measure } from '../humanoid.js';
import { qSlerp, qIdentity, vLerp } from './qmath.js';
import { fkPositions } from './canonical.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap01 = p => p - Math.floor(p);
export const SPEED_MIN = 0.25, SPEED_MAX = 2, MAX_DT = 0.1;

/** Weighted blend of poses: [{ pose, w }] -> pose. Joints missing in a pose count as identity (rest). */
export function blendPoses(items) {
  let acc = null, W = 0;
  for (const { pose, w } of items) {
    if (!(w > 0)) continue;
    W += w;
    if (!acc) { acc = { joints: { ...(pose.joints || {}) }, root: [...(pose.root || [0, 0, 0])] }; continue; }
    const t = w / W, J = pose.joints || {};
    for (const k of new Set([...Object.keys(acc.joints), ...Object.keys(J)])) {
      acc.joints[k] = qSlerp(acc.joints[k] || qIdentity(), J[k] || qIdentity(), t);
    }
    acc.root = vLerp(acc.root, pose.root || [0, 0, 0], t);
  }
  return acc || { joints: {}, root: [0, 0, 0] };
}

/**
 * Amount (m, >= 0) the root must rise so no foot/toe joint dips below its rest height.
 * Clips already keep the feet on the floor; this only catches blends (e.g. walk -> run mid-fade).
 */
export function groundLift(heads, pose) {
  const P = fkPositions(heads, pose);
  let lift = 0;
  for (const j of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']) {
    if (P[j] && heads[j]) lift = Math.max(lift, heads[j][1] - P[j][1]);
  }
  return lift;
}

export function createAnimator(humanoid, { clips = CLIPS, root = humanoid.root, getBody = () => ({}) } = {}) {
  const rootRest = root ? [root.position.x, root.position.y, root.position.z] : [0, 0, 0];
  let rig = null, ctx = null, speedScale = 1, paused = false, disposed = false;
  let timings = {};                 // clip name -> timing(ctx)
  let layers = [];                  // { name|null (rest), phase, w, target, rate, elapsed, then, once, fadeOut }
  let locoPhase = 0;                // shared phase of all locomotion layers
  let lastPose = null;

  const isLoop = name => name != null && clips[name]?.loop !== false;
  const velocity = name => timings[name]?.velocity || [0, 0, timings[name]?.speed || 0];
  const isLoco = name => isLoop(name) && Math.hypot(...velocity(name)) > 0;
  const duration = name => Math.max(1e-3, timings[name]?.duration || clips[name]?.duration || 1);
  const phaseOf = l => (isLoco(l.name) ? wrap01(locoPhase + (l.offset || 0)) : l.phase);
  const cosDir = (a, b) => {
    const u = velocity(a), v = velocity(b), n = Math.hypot(...u) * Math.hypot(...v);
    return n > 0 ? (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / n : 1;
  };
  const FEET = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'];
  /**
   * Phase offset for a locomotion clip that joins visible locomotion of another travel direction (walk ->
   * walk_back, strafe -> walk): the phase whose feet are closest to the current pose, so the crossfade does not
   * blend a forward-swinging leg with a planted one (that dips the blend through the floor and the ground guard
   * lifts the pelvis). Clips of the same direction (walk <-> run) keep the shared phase exactly.
   */
  function matchOffset(name) {
    const vis = layers.filter(x => isLoco(x.name) && x.w > 0).sort((a, b) => b.w - a.w);
    if (!vis.length) return 0;
    const same = vis.find(x => cosDir(x.name, name) > 0.9);
    if (same) return same.offset || 0;
    const ref = fkPositions(rig.heads, currentPose()), n = 48, T = duration(name);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const P = fkPositions(rig.heads, clips[name].sample(wrap01(locoPhase + i / n) * T, ctx));
      let d = 0;
      for (const j of FEET) d += (P[j][0] - ref[j][0]) ** 2 + (P[j][1] - ref[j][1]) ** 2 + (P[j][2] - ref[j][2]) ** 2;
      if (d < bestD - 1e-12) { bestD = d; best = i / n; }
    }
    return best;
  }
  const main = () => layers.find(l => l.target === 1) || null;
  /** Seconds until a one-shot (or a once-played loop) layer ends. */
  const left = l => (isLoop(l.name) ? duration(l.name) - l.elapsed : (1 - l.phase) * duration(l.name));

  function rebuild() {
    rig = measure(humanoid);
    ctx = makeContext(rig, { speedScale, body: getBody() || {} });
    timings = {};
    for (const [n, c] of Object.entries(clips)) timings[n] = c.timing(ctx);
  }

  function writeRoot(off) {
    if (!root) return;
    root.position.x = rootRest[0] + off[0];
    root.position.y = rootRest[1] + off[1];
    root.position.z = rootRest[2] + off[2];
  }

  function toRestNow() {
    layers = []; lastPose = null;
    resetPose(humanoid);
    writeRoot([0, 0, 0]);
  }

  function setTargets(name, fade, { then = null, once = false, fadeOut = null } = {}) {
    const rate = fade > 0 ? 1 / fade : Infinity;
    for (const l of layers) { l.target = 0; l.rate = rate; }
    const oneShot = name != null && !isLoop(name);
    once = !!once && !oneShot && name != null;
    // one-shots and once-played loops always start on a fresh layer (a retrigger never rewinds a copy that
    // is still fading out); a plain loop re-uses its layer and keeps its phase
    let l = oneShot || once ? null : layers.find(x => x.name === name);
    if (!l) {
      l = { name, phase: 0, w: 0, target: 1, rate, elapsed: 0, offset: 0 };
      // Nothing playing: fade in from the rest pose.
      if (!layers.length) layers.push({ name: null, phase: 0, w: 1, target: 0, rate, elapsed: 0 });
      // Phase matching: a locomotion clip joining without another visible locomotion layer restarts
      // the shared phase; otherwise it inherits it (walk <-> run keep the same foot phase).
      if (isLoco(name) && !layers.some(x => isLoco(x.name) && x.w > 0)) locoPhase = 0;
      else if (isLoco(name) && rig) l.offset = matchOffset(name);
      layers.push(l);
    }
    l.target = 1; l.rate = rate; l.once = once;
    l.then = oneShot ? (then ?? clips[name].next ?? (clips.idle ? 'idle' : null)) : once ? (then ?? (clips.idle ? 'idle' : null)) : null;
    if (l.then === name && !oneShot) l.then = null;
    l.fadeOut = fadeOut ?? (name != null ? Math.min(0.3, 0.25 * duration(name)) : 0);
    if (!(fade > 0) || paused) settle();
  }

  /** One-shot / once layer near its end: crossfade to its `then` clip (or hold the last frame without one). */
  function autoNext() {
    const m = main();
    if (!m || m.name == null || !m.then || left(m) > m.fadeOut + 1e-9) return;
    const next = m.then;
    m.then = null;
    if (clips[next]) setTargets(next, m.fadeOut);
  }

  function settle() {                     // finish all fades now
    for (const l of layers) l.w = l.target;
    layers = layers.filter(l => l.w > 0);
  }

  function advance(dt) {
    // weights
    for (const l of layers) {
      if (l.w === l.target) continue;
      const step = dt * l.rate;
      l.w = l.w < l.target ? Math.min(l.target, l.w + step) : Math.max(l.target, l.w - step);
    }
    layers = layers.filter(l => l.w > 0 || l.target > 0);
    // time: locomotion layers share a phase advancing at the weight-blended rate
    let wr = 0, ww = 0;
    for (const l of layers) {
      if (l.name == null) continue;
      l.elapsed += dt;
      if (isLoco(l.name)) { wr += l.w / duration(l.name); ww += l.w; }
      else if (isLoop(l.name)) l.phase = wrap01(l.phase + dt / duration(l.name));
      else l.phase = Math.min(1, l.phase + dt / duration(l.name));       // one-shot: holds its last frame
    }
    if (ww > 0) locoPhase = wrap01(locoPhase + dt * wr / ww);
    else {
      const m = main();
      if (m && isLoco(m.name)) locoPhase = wrap01(locoPhase + dt / duration(m.name));
    }
  }

  function currentPose() {
    const items = layers.map(l => ({
      w: l.w,
      pose: l.name == null ? { joints: {}, root: [0, 0, 0] } : clips[l.name].sample(phaseOf(l) * duration(l.name), ctx),
    }));
    const pose = blendPoses(items);
    const lift = groundLift(rig.heads, pose);
    if (lift > 0) pose.root = [pose.root[0], pose.root[1] + lift, pose.root[2]];
    return pose;
  }

  const api = {
    /**
     * Crossfade to a clip. Options: fade (s); one-shot clips: then = clip to return to (default clip.next /
     * idle), fadeOut = crossfade length back (default min(0.3 s, a quarter of the clip)); once: true plays a
     * looping clip for one cycle, then returns to `then` (default idle). A one-shot that is still running is
     * not restarted (no double jump).
     */
    play(name, { fade = 0.3, then = null, once = false, fadeOut = null } = {}) {
      if (disposed) return;
      if (!clips[name]) { console.warn(`[animator] unknown clip "${name}"`); return; }
      const m = main();
      if (m && m.name === name && !isLoop(name) && m.phase < 1) return;
      if (m && m.name === name && isLoop(name) && !once && layers.length === 1) { m.then = null; m.once = false; return; }
      setTargets(name, fade, { then, once, fadeOut });
    },
    stop({ fade = 0.3 } = {}) {
      if (disposed || !layers.length) return;
      if (!(fade > 0) || paused) { toRestNow(); return; }
      setTargets(null, fade);
    },
    pause() { paused = true; },
    resume() { paused = false; },
    setSpeed(s) {
      speedScale = clamp(Number(s) || 1, SPEED_MIN, SPEED_MAX);
      if (rig) { ctx = makeContext(rig, { speedScale, body: getBody() || {} }); for (const [n, c] of Object.entries(clips)) timings[n] = c.timing(ctx); }
    },
    seek(t) {
      const m = main();
      if (!m || m.name == null) return;
      settle();
      const T = duration(m.name), x = (Number(t) || 0) / T;
      const p = isLoop(m.name) ? wrap01(x) : clamp(x, 0, 1);
      if (isLoco(m.name)) locoPhase = wrap01(p - (m.offset || 0)); else m.phase = p;
      m.elapsed = p * T;
    },
    bodyChanged() { if (!disposed) rebuild(); },
    update(dt) {
      if (disposed || !layers.length) return;
      dt = clamp(Number(dt) || 0, 0, MAX_DT);
      if (!paused) { advance(dt); autoNext(); }
      // Stop finished: only the rest layer is left.
      if (layers.length === 1 && layers[0].name == null && layers[0].w >= 1) { toRestNow(); return; }
      const pose = currentPose();
      applyPose(humanoid, pose);
      writeRoot(pose.root);
      lastPose = pose;
    },
    state() {
      const m = main(), name = m?.name ?? null;
      let rootSpeed = 0, W = 0;
      const rv = [0, 0, 0];
      for (const l of layers) {
        W += l.w;
        if (l.name == null) continue;
        rootSpeed += l.w * (timings[l.name]?.speed || 0);
        velocity(l.name).forEach((v, k) => { rv[k] += l.w * v; });
      }
      const phase = m && name != null ? phaseOf(m) : 0;
      return {
        clip: name, time: name != null ? phase * duration(name) : 0, phase, speedScale, paused,
        fading: layers.length > 1 || layers.some(l => l.w !== l.target),
        oneShot: name != null && !isLoop(name), next: m?.then ?? null,
        rootSpeed: W > 0 ? rootSpeed / W : 0,
        rootVelocity: W > 0 ? rv.map(v => v / W) : [0, 0, 0],
        stride: name != null ? timings[name]?.stride || 0 : 0,
        duration: name != null ? duration(name) : 0,
      };
    },
    /** True if the clip registry has `name`. */
    has: name => !!clips[name],
    /** Last applied pose (canonical deltas incl. ground guard), or null at rest. For tests/debug. */
    lastPose: () => lastPose,
    /** Current weights, for tests/debug: [{ clip, weight, target }]. */
    weights: () => layers.map(l => ({ clip: l.name, weight: l.w, target: l.target })),
    get rig() { return rig; },
    get ctx() { return ctx; },
    dispose() { if (disposed) return; toRestNow(); disposed = true; },
  };
  rebuild();
  return api;
}
