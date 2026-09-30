// Eye life: idle blinking + look-at, as morph weights (no bones; the eyes are one rigid mesh on the head).
// Engine-agnostic, pure logic (unit tested in tests/eyelife.test.mjs); main.js turns the look target into
// head-relative yaw/pitch and writes the weights into every part's morphTargetInfluences.
//
// Morphs (blender/build_base.py): blink_left / blink_right (MakeHuman expression units eye-*-closure, upper +
// lower lid; the eyelash mesh carries them too), look_left / look_right (eyeballs rotated 30 deg about their
// sphere-fit centres; left = the character's left, +X in glTF), look_up / look_down (25 deg).
// Rotations of a sphere are linear only approximately; weights stay <= ~0.8 (clamps below), where the
// linear blend of the rotated vertex positions deviates < 0.3 mm from a true rotation.

export const BLINK = {
  minInterval: 2.0, maxInterval: 6.0,     // s between blinks (uniform random)
  minDur: 0.12, maxDur: 0.18,             // s, full close + open
  closeFrac: 0.4,                         // closing is faster than opening
  doubleChance: 0.15, doubleGap: [0.12, 0.25],
};
const DEG = Math.PI / 180;
export const LOOK = {
  morphYaw: 30 * DEG, morphPitch: 25 * DEG,  // angle at morph weight 1
  // maxUp is small on purpose: there is no lid-raise morph, so an upward gaze slides the pupil under the fixed
  // upper lid (14 deg hid the pupil in the close-up "eyes" view with look=camera)
  maxYaw: 24 * DEG, maxUp: 8 * DEG, maxDown: 18 * DEG,
  giveUp: 60 * DEG,                        // target further off-axis than this: eyes return to the front
  saccadeThreshold: 1.5 * DEG,             // smaller target moves are ignored (steady fixation, no jitter)
  saccadeTau: 0.035,                       // s, time constant of a saccade (fast, like real eyes)
  micro: 0.5 * DEG, microEvery: [0.6, 2.5],
  lidFollowDown: 0.3,                      // upper lid follows a downward gaze (blink weight per look_down)
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = x => x * x * (3 - 2 * x);

/** Lid closure 0..1 at normalised blink time u (0..1): fast close, slower open. */
export function blinkCurve(u, closeFrac = BLINK.closeFrac) {
  if (u <= 0 || u >= 1) return 0;
  return u < closeFrac ? smooth(u / closeFrac) : 1 - smooth((u - closeFrac) / (1 - closeFrac));
}

/** Clamped gaze angles for a head-relative target direction (yaw > 0 = character's left, pitch > 0 = up). */
export function clampGaze(yaw, pitch) {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || Math.hypot(yaw, pitch) > LOOK.giveUp) return { yaw: 0, pitch: 0 };
  return { yaw: clamp(yaw, -LOOK.maxYaw, LOOK.maxYaw), pitch: clamp(pitch, -LOOK.maxDown, LOOK.maxUp) };
}

/** Gaze angles -> look morph weights. */
export function gazeWeights(yaw, pitch) {
  return {
    look_left: Math.max(0, yaw) / LOOK.morphYaw, look_right: Math.max(0, -yaw) / LOOK.morphYaw,
    look_up: Math.max(0, pitch) / LOOK.morphPitch, look_down: Math.max(0, -pitch) / LOOK.morphPitch,
  };
}

export function createEyeLife({ rng = Math.random, blink = true } = {}) {
  const rand = (a, b) => a + (b - a) * rng();
  const st = {
    blinkEnabled: blink,
    nextBlink: rand(BLINK.minInterval, BLINK.maxInterval),
    blinkT: -1, blinkDur: 0, pendingDouble: -1, blinks: 0,
    fix: { yaw: 0, pitch: 0 }, cur: { yaw: 0, pitch: 0 }, micro: { yaw: 0, pitch: 0 },
    nextMicro: rand(...LOOK.microEvery), saccades: 0,
  };

  function startBlink(isDouble = false) {
    st.isDouble = isDouble;
    st.blinkT = 0;
    st.blinkDur = rand(BLINK.minDur, BLINK.maxDur);
    st.blinks++;
  }

  /**
   * Advance by dt seconds. target = { yaw, pitch } (radians, head-relative, unclamped) or null (look ahead).
   * Returns the morph weights { blink_left, blink_right, look_left, look_right, look_up, look_down }.
   */
  function update(dt, target = null) {
    dt = clamp(Number(dt) || 0, 0, 0.1);            // a long frame (tab in background) must not skip a whole blink
    // ---- blink timer (independent of the body animation) ----
    let lid = 0;
    if (st.blinkT >= 0) {
      st.blinkT += dt;
      const u = st.blinkT / st.blinkDur;
      if (u >= 1) {
        st.blinkT = -1;
        if (!st.isDouble && rng() < BLINK.doubleChance) st.pendingDouble = rand(...BLINK.doubleGap);
      } else lid = blinkCurve(u);
    } else if (st.blinkEnabled) {
      if (st.pendingDouble >= 0) {                  // second blink of a double blink (never a triple)
        st.pendingDouble -= dt;
        if (st.pendingDouble < 0) { st.pendingDouble = -1; startBlink(true); }
      } else {
        st.nextBlink -= dt;
        if (st.nextBlink <= 0) { st.nextBlink = rand(BLINK.minInterval, BLINK.maxInterval); startBlink(false); }
      }
    }
    // ---- gaze: fixations + fast saccades + micro-saccades ----
    const want = target ? clampGaze(target.yaw, target.pitch) : { yaw: 0, pitch: 0 };
    if (Math.hypot(want.yaw - st.fix.yaw, want.pitch - st.fix.pitch) > LOOK.saccadeThreshold) {
      st.fix = want; st.saccades++;
    }
    st.nextMicro -= dt;
    if (st.nextMicro <= 0) {
      st.nextMicro = rand(...LOOK.microEvery);
      st.micro = target ? { yaw: rand(-1, 1) * LOOK.micro, pitch: rand(-1, 1) * LOOK.micro } : { yaw: 0, pitch: 0 };
    }
    const k = 1 - Math.exp(-dt / LOOK.saccadeTau);
    st.cur.yaw += (st.fix.yaw + st.micro.yaw - st.cur.yaw) * k;
    st.cur.pitch += (st.fix.pitch + st.micro.pitch - st.cur.pitch) * k;
    const g = gazeWeights(st.cur.yaw, st.cur.pitch);
    const b = clamp(Math.max(lid, g.look_down * LOOK.lidFollowDown), 0, 1);
    return { blink_left: b, blink_right: b, ...g };
  }

  return {
    update,
    blinkNow: () => startBlink(true),
    setBlinkEnabled(on) { st.blinkEnabled = !!on; if (!on) { st.blinkT = -1; st.pendingDouble = -1; } },
    /** Jump the gaze to the (clamped) target without a saccade (screenshots/tests). */
    snapGaze(target) { const w = target ? clampGaze(target.yaw, target.pitch) : { yaw: 0, pitch: 0 }; st.fix = { ...w }; st.cur = { ...w }; st.micro = { yaw: 0, pitch: 0 }; },
    state: () => ({ blinkEnabled: st.blinkEnabled, blinking: st.blinkT >= 0, blinks: st.blinks, nextBlink: st.nextBlink,
      blinkDur: st.blinkDur, gaze: { ...st.cur }, fixation: { ...st.fix }, saccades: st.saccades }),
  };
}

/** Writes morph weights into a mesh (only the names it has). */
export function applyMorphWeights(mesh, weights) {
  const idx = mesh?.morphTargetDictionary, inf = mesh?.morphTargetInfluences;
  if (!idx || !inf) return;
  for (const [n, w] of Object.entries(weights)) { const i = idx[n]; if (i !== undefined) inf[i] = w; }
}
