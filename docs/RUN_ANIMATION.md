# Run animation (rework 2026-09-30)

The run clip in `web/animation/clips.js` was reworked because it looked like "sitting". Walk and idle
are unchanged (bit-identical output). The public clip contract (`docs/ANIMATION_PLAN.md` 4B) is unchanged:
`timing(ctx)` still returns `{ duration, speed, stride, beta }`, `sample`, `contacts`, in-place root motion.

## What was wrong (neutral body, speedScale 1, measured with FK over 240 samples)

| Measure | Before | Real running (jog ~3 m/s) | After |
|---|---|---|---|
| Hip (thigh) angle range | +8.6 .. +51.6 deg: the thigh **never went behind vertical** | ~ -15..-25 (toe-off) .. +45..+55 | -21.6 .. +52.8 |
| Pelvis offset (root.y) | -7.6 .. -4.4 cm, never rises in flight | low at mid-stance, near standing in flight | -7.5 .. -1.9 cm |
| Knee at strike / mid-stance / stance max | 16 / 50 / 60 deg | ~15-25 / ~40-45 / ~45 | 25 / 44 / 47 |
| Swing knee max (heel recovery) | 97 deg, heel 0.37 hip height | 100-120 at a jog, more when sprinting | 113, heel 0.48 hip height |
| Strike: ball / ankle ahead of hip | 40 / 29 cm (0.36 L) | foot lands ~0.2-0.3 L ahead | 30 / 18 cm (0.23 L) |
| Cadence at speedScale 2 | 256 spm (stride capped at 3.4 L) | ~190-210 spm | 204 spm, stride 4.3 L |
| Arms | hands always in front of the hip | hand reaches the hip at the back swing | upper arm -51..+13 deg, hand to the hip |

The root cause was geometric: the stance window of the ball sat ~9 cm in front of the hip joint and
the pelvis was fitted "as high as the planted foot allows". The leg therefore worked entirely in front
of the body, with a bent knee at toe-off and a pelvis that never rose.

## What the run does now

* **Tempo** (`timing`): speed unchanged (`speedScale * sqrt(g * hipHeight)`, 2.9 m/s neutral).
  Step frequency = `0.832 * speedScale^0.28 * sqrt(g / hipHeight)` (168 spm neutral jog, 204 at 2x;
  dynamic similarity, so a child runs at a higher cadence). Stride = 2 speed / step frequency, so most
  of the speed gain is stride. The contact share `beta` falls with speed (0.42 / 0.32 / 0.27 at
  0.25 / 1 / 2), +0.03 heavy, +0.04 old, capped so the stance length is at most 0.85 legLength.
* **Speed presets** (jog-to-sprint blend): `speedPresets` at speedScale 0.25 (shuffle jog), 1 (jog) and
  2 (fast run), smoothstep-blended in between: stance centre, toe-off pitch, bob, swing heights, trunk
  lean (6 -> 9 -> 14 deg authored, ~7 / ~11.5 deg measured trunk), pelvis yaw/roll, arm swing/elbow.
* **Stance**: the ball is planted (IK, exactly: slide < 1 mm, height error < 0.5 mm), centred
  `zCenter * legLength` relative to the **hip joint** (-0.04 L at a jog, -0.06 L fast) instead of the
  rest toes, so the leg reaches behind at toe-off (thigh -22 deg, knee ~16 deg: push-off). The heel lifts
  over the second part of the stance (foot rolls over the ball, 50-62 deg toe-off pitch).
* **Swing**: authored as an **ankle path** (not a ball path) with Hermite keys: from toe-off it drifts
  back while rising toward the glutes (heel recovery), passes forward under the knee, reaches ~6 % past
  the strike point and pulls back onto it (paw-back). z keys are fractions of the toe-off -> strike
  distance, heights are in leg lengths (scaled down for short-thighed bodies). The strike tangent
  equals the stance velocity (no pop at touchdown). The foot pitch follows the solved shin (+ some
  plantarflexion), blends to flat for the strike and is clamped so the ball never goes below the floor.
* **Pelvis**: stance dip + ballistic flight parabola (`ballisticBob`, C1 at both contacts for any beta),
  lowest at mid-stance, highest mid-flight (5.6 cm peak-to-peak neutral jog). The fit keeps planted
  feet and the late-swing foot (second half of the swing) reachable, so the leg reaches the floor
  before contact instead of snapping.
* **Flight**: contacts give 36 % flight at 1x and 60 % at 2x (neutral). Both feet are > 1 cm off the
  floor for 28 % / 53 % of the cycle. The swing foot is never pulled back by the foot-plant logic,
  because only planted and late-swing legs constrain the pelvis.
* **Upper body**: forward lean, pelvis yaw +-8 deg with opposite thorax yaw, head stabilised in world
  space, arms with ~82-100 deg elbow flexion, opposite-leg phase, a 10-12 deg backward bias so the hand
  reaches the hip at the back swing, and a slight inward swing in front.

## Checks

* `node --test "tests/*.test.mjs"`: 4 run tests in `tests/clips.test.mjs` for 9 bodies (neutral, tall,
  short, child, child+short, old, male+tall, heavy, muscle) at 1x and 2x: flight share 20-65 %, both
  feet > 0.02 L up mid-flight; stance slide < 1 mm, no floor penetration (> -1 mm); strike knee <= 35,
  stance knee 25-56, swing knee 95-150, hip extension -12..-35, hip flexion 40-90, trunk lean 3-17,
  elbow 60-120 deg; pelvis lowest near mid-stance, rises in flight, no crouch; cadence and stride rise
  with speed. The existing tests (seamless loop, L/R half-cycle mirror, no hyperextension, etc.) still
  cover the run. The "not sitting" and tempo tests fail on the old clip.
* `node tools/sample_clips.mjs` -> `output/animations/run.json` (43 frames at 60 fps, 0.717 s). Between
  keys (linear interpolation) the feet dip at most 1.7 mm, same as before.
* Crossfades (animator unchanged, emulated at 60 fps, 0.3 s fade, every start phase): worst per-frame
  jumps are about as before. Neutral 1x walk -> run: toes 47.5 mm/frame (before 48.9), pelvis 12.0
  (before 20.3). At 2x the pelvis jump is 25 mm/frame (before 17), because walk and run strides differ
  more now. The ground guard lifts the root for a few frames.

## Known limits

* Fingers are not animated (v1 contract), so the hands stay open instead of a loose fist, and there is
  no forearm pronation (no twist bones in the rig).
* Child+short (thigh 38 % of the leg) still has a fairly high knee lift in the swing (hip flexion 66 deg
  at 1x, 82 deg at 2x).
* The speed 0.25 preset is a shuffle jog. Below ~0.5x the run is not really a run.
* The run is a mid/forefoot strike (the ball is planted, the foot is flat at contact). A heel strike
  would need the heel as the contact point.
