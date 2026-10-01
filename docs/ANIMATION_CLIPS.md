# Animation clips

All clips live in `web/animation/clips.js` (`CLIPS`), are procedural, deterministic and body-adaptive, and follow
the rules of [ANIMATION_PLAN.md](ANIMATION_PLAN.md): canonical VRM joint names, parent-relative rest deltas,
rotations only on bones (the only translation is `pose.root`, applied to the scene root / baked as the `Root` bone
translation), feet planted by leg IK, loops seamless (`sample(0) == sample(T)`), quaternion signs continuous in the
baked keys. The run clip has its own notes in [RUN_ANIMATION.md](RUN_ANIMATION.md).

## Clip list

Durations and speeds are for the neutral body at speed 1 (`timing(ctx)` scales them with the body and the speed
slider). Velocity is in the character frame (+X = the character's left, +Z = forward).

| clip | loop | T (s) | travel | what |
|---|---|---|---|---|
| `idle` | yes | 8.0 | 0 | breathing, small sway |
| `walk` | yes | 1.00 | 1.30 m/s fwd | |
| `run` | yes | 0.71 | 2.91 m/s fwd | |
| `idle_look` | yes | 10.0 | 0 | weight onto the right leg + glance left (38 deg), back, weight onto the left leg + glance right (32 deg); 3 breaths |
| `idle_breathe` | yes | 8.0 | 0 | two slow deep breaths (15 / min): chest 3.2 deg, shoulders up 3.5 deg, arm sway 3.5 deg |
| `idle_fidget` | yes | 9.0 | 0 | shoulder roll (0.6-2.8 s), then a look at the left wrist (forearm up, 3.2-7.4 s) |
| `walk_back` | yes | 1.05 | 0.87 m/s back | walking backward, toe-first contact |
| `strafe_left` | yes | 0.90 | 0.45 m/s left | sidestep, facing forward, feet never cross |
| `strafe_right` | yes | 0.90 | 0.45 m/s right | `strafe_left` mirrored (and shifted half a cycle) |
| `jump` | **one-shot** | 2.09 | 0 | standing countermovement jump in place, then back to `idle` |
| `fall` | yes | 1.2 | 0 | airborne loop at the jump apex (root at apex height, small arm/leg drift) |
| `land` | **one-shot** | 1.06 | 0 | the jump from its apex on: fall, touch-down, absorb, stand up; then `idle` |

`timing(ctx)` returns `{ duration, speed, stride, velocity: [x, y, z] }`; `speed` is the signed forward speed
(walk_back negative, strafe 0), `velocity` the full travel. One-shots also return `events` (s of clip time):
jump `{ takeoff, apex, touchdown, settled }`, land `{ touchdown, settled }`, and the jump `height` (m).

## Parameters and references

Measured with the clip code over 9 slider bodies (neutral, female, child, short child, tall, heavy, old, ...),
see `tests/clips.test.mjs` and `tests/moves.test.mjs`:

### Jump (standing countermovement jump)

| phase | time (neutral) | reference |
|---|---|---|
| quiet stance | 0.10 s | |
| countermovement (unweighting + braking) | 0.45 s | ~0.4-0.6 s in force-plate CMJs (Linthorne 2001, Am. J. Phys. 69) |
| propulsion | 0.25 s | ~0.2-0.3 s (same) |
| flight | 0.45 s | ballistic, root `y'' = -9.81` exactly; ~0.45-0.55 s for 0.25-0.35 m jumps |
| landing absorb | 0.20 s | ~0.15-0.25 s (soft landing) |
| recover + settle | 0.55 + 0.12 s | |

- Ground phases scale with `sqrt(legLength / 0.802)` (dynamic similarity), old bodies +15 %.
- Countermovement depth 0.28 L (L = leg length): knee 86 deg at the bottom (CMJ self-selected depth ~80-95 deg);
  hips back 0.35 m per m of drop; trunk lean 40 deg; arms swing back 50 deg then forward-up to 85 deg at take-off
  with 20-25 deg abduction (a straight-forward 100 deg swing pushed the T-shirt armpit through the body, 10 vertices
  10 mm on the female body; this amplitude keeps every poke at <= 2 vertices or < 5 mm).
- Take-off: legs straight (at the rest-knee limit, never hyperextended), plantarflexion 44 deg (peak ~40-45 deg in
  CMJs). Pelvis rise above take-off = 0.30 L x (0.75 + 0.25 speed) x (1 - 0.35 old) x (1 - 0.2 heavy): neutral
  0.24 m, tall 0.30 m, short child 0.13 m (recreational adults: ~0.25-0.40 m centre-of-mass rise).
- Touch-down on the balls (22 deg plantarflexion, heel down within 0.07 s), knees 72 deg in the absorb.
- Root = `[0, y, z]`: y = the pelvis arc (piecewise: smoothstep crouch, Hermite push ending at the take-off velocity,
  parabola, constant-deceleration absorb, smoothstep recovery), z = hips back in the crouch / absorb.
- Pelvis peak speed 2.2 m/s (37 mm per 60 fps frame) at take-off / touch-down.

### walk_back

Backward walking is close to time-reversed forward walking (Thorstensson 1986, Exp. Brain Res. 61; Grasso et al.
1998, J. Neurophysiol. 80) with shorter strides and ~60-75 % of the forward speed (Laufer 2005, Phys. Ther. 85).
The clip is a forward-gait generator with backward-walking parameters (Froude 0.089, stride 1.05 L, stance share
0.64) played in reverse, so contact starts on the ball of the foot and ends with the heel. Neutral: 0.87 m/s
(0.67 x walk), stride 0.91 m, cadence 115 steps/min, knee max 49 deg, pelvis bob 42 mm; arms swing 12 deg.

### strafe_left / strafe_right

Sidestep (no crossing): the leading leg abducts and lands, the trailing leg closes to a narrowed stance (min. gap
0.7 hip widths). Neutral: 0.45 m/s, 133 steps/min, step 0.40 m (0.5 L); gap between the feet 0.15-0.56 m; pelvis
follows the low-passed feet midpoint (no sideways jerk), bob 12 mm, high in single support; knee max 44 deg;
arms abduct slightly with their leg. The pelvis faces forward (< 6 deg yaw).
Speed slider: cadence ~ s^0.5, step length the rest, capped so the feet never cross.

### Idle variants

Feet pinned by IK at rest (both contacts on), pelvis as high as the planted legs allow. Weight shift <= 0.035 L
(28 mm neutral) with a 4 deg hip roll; head turns <= 38 deg; breathing 15-18 / min. `idle_fidget` raises the left
forearm across the body in front of the chest (upper-arm internal rotation 75 deg via the arm `twist` parameter, so
the forearm points inward rather than forward; the head pitches down 32 deg to the hand).

## Root-motion policy

- Travel is never baked and never written by the animator: the viewer stands still. `state().rootVelocity` (m/s,
  [x, y, z]) / `rootSpeed` (+Z) report it; the cloth uses it as air velocity (strafe: sideways, walk_back:
  backwards). The baked JSON stores `rootMotion: { mode: 'in-place', speed, axis, stride }` (walk_back axis
  `[0,0,-1]`, strafe_left `[1,0,0]`) so an engine can move the character controller.
- `pose.root` = pelvis bob / sway / the jump arc, baked as the `Root` bone translation. The jump arc is part of the
  clip (it is not travel): a controller that also simulates gravity should drive the `fall` loop and play `land`
  instead of `jump`'s flight.

## Animator: one-shots, blends, idle variation

- `play(name, { fade, then, once, fadeOut })`. A one-shot (`loop: false`) starts at 0 on a fresh layer, holds its
  last frame and, `fadeOut` (default min(0.3 s, T/4)) before the end, crossfades to `then` (default `clip.next`,
  else idle). Retriggering a running one-shot is ignored. `once: true` plays a loop for one cycle, then `then`.
- Locomotion = looping clip with non-zero velocity. Clips of the same travel direction share one phase (walk <-> run
  stay foot-synchronous). A clip of another direction (walk -> walk_back, strafe -> walk) joins at the phase whose
  feet are closest to the current pose (48-phase search), so the blend never mixes a swinging leg with a planted
  one.
- Ground guard (unchanged): the root rises if a blend dips a foot below the floor. A temporally smoothed release
  was tried and reverted: it changed the walk/run blends and pushed four coat cloth tests over their thresholds.
- Crossfade test (`tests/animator.test.mjs`): every ordered pair of the 12 clips, fade 0.3 s, neutral and short
  child: pelvis, toes and head never move more per 60 fps frame than 1.5 x the clips' own motion + the A-B distance
  closed linearly + 8 mm. Worst pelvis frame step in a fade 20.7 mm (land -> run, pelvis rising from the absorb);
  run -> walk_back lifts the pelvis smoothly by up to ~5 cm during the fade, and interrupting the jump crouch with
  idle lifts the feet ~6.5 mm per frame for a few frames (ground guard, no snap).
- `web/animation/idlevary.js`: while the animator rests in idle, after 6 s and then every 8-14 s (seeded PRNG) it
  plays one variant once (fade 0.6 s), never the same twice in a row. Viewer: "Idle variation" checkbox, on by
  default; off under `?shot` unless `?idleVary=1` (seed `?idleSeed=`, default 1).
- Viewer: the clip selector lists every clip (da/en labels `clip_<name>`); "Jump!" plays `jump` and returns to the
  loop that played before (or idle). `?anim=jump&animT=0.9` seeks a one-shot (clamped, paused).

## Adding a clip

1. Write it in `clips.js` (reuse `locomotion()` / `reversed()` / `mirrored()` / `sidestep()` / `idleVariant()`, or
   a custom `{ name, loop, duration, timing, sample, contacts }`; one-shots add `loop: false, next`), register it
   in `CLIPS`. Set `duration` to the neutral `timing().duration` (the registry test allows 2 %).
2. Add `clip_<name>` labels (da + en) in `web/main.js`.
3. Tests: the generic contract runs automatically (`tests/clips.test.mjs`: finite/unit, seamless loop,
   determinism, planted feet without sliding, no hyperextension, feet never cross, crossfades with every other
   clip in `tests/animator.test.mjs`); add clip-specific numbers to `tests/moves.test.mjs`.
4. `node tools/sample_clips.mjs`, bake (build a fresh scratch `.blend` with `blender/build_base.py`, then
   `blender/bake_clips.py -- --blend <it>`), `node tools/check_anim_glb.mjs` -> CHECK OK.
5. Cloth: `node tools/cloth_integrity.mjs --timeline moves --outfits coat,tee+skirt+shoes` (or add a timeline in
   `TIMELINES`).
