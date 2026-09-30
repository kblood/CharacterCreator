# Animation plan (idle / walk / run)

Goal: our own procedural humanoid clips that are **general** (canonical joint names, not MPFB names),
**body-adaptive** (stride, tempo, pelvis height and foot placement follow the current slider body),
and **exportable** (baked to glTF animation clips). Clip set is deliberately `idle`, `walk`, `run`;
the registry is open for more clips later.

Everything below was checked against `output/base_body.glb` (53-joint `game_engine` rig) with
`tests/canonical.test.mjs` (8 tests, all passing). Run all tests with `node --test "tests/*.test.mjs"`
(Node 24; the quotes matter, `node --test tests/` does not work).

## 1. Frames and the pose convention (the crux)

**Character frame** = the model root's space (`gltf.scene` / glTF scene space): **+X = character's left,
+Y = up, +Z = forward** (the character faces +Z), metres. The floor is y = 0 (`feet_on_ground`).

**Pose** (produced by clips, consumed by humanoid/animator/bakers):

```js
Pose = {
  joints: { <canonicalJoint>: [x, y, z, w] },   // parent-relative delta rotations, character frame
  root:   [x, y, z],                            // whole-character offset from rest placement (m)
}
```

* A joint's delta is a rotation **about axes of the character frame at rest**, applied parent-relative:
  world delta `D(j) = D(parent) * joints[j]`. So a knee delta is interpreted in the (already rotated)
  thigh's frame, like ordinary FK, but its axes never depend on bone roll.
* Absent joints = identity = rest orientation. Deltas are always relative to rest, never absolute.
* Bone-local value an engine writes (glTF node rotation / three.js `bone.quaternion`):

  `local = restLocal * restWorld^-1 * q * restWorld`  (`qToLocal` in `web/animation/qmath.js`)

  `restLocal` = the bone's rest local rotation, `restWorld` = product of rest locals from the character
  root down to the bone. Verified: heads-FK on canonical joints and bone-level FK with this formula agree
  to 1e-6 m for a random full-body pose.
* **Why not bone-local axes:** the rig's local axes are unusable as a convention. `thigh_l` local X is
  (0.89, 0.06, -0.45), i.e. rolled 27 deg; `upperarm_l` local X is (-0.75, -0.67, 0.04) because the
  rest pose is an A-pose. "Flex about local X" would swing the thigh 27 deg off the sagittal plane.
* **Mirroring:** author the left side, derive the right with `qMirrorX`: `(x, y, z, w) -> (x, -y, -z, w)`
  and swap `left*`/`right*` names (`mirrorPose`). Rotations about X keep their sign on both sides,
  Y/Z flip, so "flexion" and "abduction" mean the same on both sides. Verified: mirrored pose is an
  exact mirror (error < 1e-3 m, sidecar rounding).

### Axis/sign conventions (positive angle, right-hand rule, character frame)

| Axis | Effect of + rotation |
|---|---|
| +X | the bone's +Y end tips toward +Z (forward), its -Y end toward -Z (back) |
| +Y | turn toward the character's left (+Z end moves to +X) |
| +Z | +X end moves up; for a left-side bone pointing down this is abduction; for the spine it is lean to the character's right |

## 2. Joint map (canonical = VRM 1.0 humanoid names)

Rest numbers = neutral body, character frame. "dir" = unit vector head -> tip (tip = `TIP` in `canonical.js`).

| Canonical joint | MPFB bone | Parent (canonical) | Rest head | Rest dir | Conventions (+ angle) |
|---|---|---|---|---|---|
| hips | pelvis | - (child of `Root`) | (0, .874, .013) | (0, .90, -.44) | +X pelvis/body pitches forward, +Y turn left, +Z roll to char right |
| spine | spine_01 | hips | (0, .953, -.025) | (0, .97, .23) | +X flex forward (15 deg: head +0.14 m Z), +Y twist left, +Z lean right |
| chest | spine_02 | spine | (0, 1.020, -.010) | (0, 1, .02) | as spine |
| upperChest | spine_03 | chest | (0, 1.095, -.008) | (.09, .98, .19)* | as spine |
| neck | neck_01 | upperChest | (0, 1.41, .01) | (0, .93, .36) | as spine |
| head | head | neck | (0, 1.515, .04) | none (leaf) | +X nod down, +Y look left, +Z tilt right |
| leftShoulder | clavicle_l | upperChest | (.023, 1.342, .022) | (.99, -.15, -.02) | +Z shrug up, -Y protract (shoulder forward), +Y retract |
| leftUpperArm | upperarm_l | leftShoulder | (.170, 1.320, .019) | (.67, -.75, 0) A-pose, 48 deg below horizontal | +Z raise sideways, -X swing forward, +X back. Arms at sides: about -42 deg Z (compute from `rig.dir`) |
| leftLowerArm | lowerarm_l | leftUpperArm | (.331, 1.140, .020) | (.51, -.52, .68) | about `rig.axes.leftLowerArm` = (-.745, -.665, .051): + flexes. Rest is already bent 43.1 deg, so target bend b -> angle b - `rig.restBend.leftLowerArm` |
| leftHand | hand_l | leftLowerArm | (.453, 1.016, .183) | (.33, -.49, .81) | small deltas only in v1 |
| leftUpperLeg | thigh_l | hips | (.102, .866, .010) | (.10, -.99, .08) | -X hip flexion (leg forward), +X extension, +Z abduction, +Y rotate knee outward |
| leftLowerLeg | calf_l | leftUpperLeg | (.14, .47, .04) | (.09, -.99, -.04) | +X knee flexion (40 deg: ankle -0.26 Z, +0.10 Y). Rest bend 6.8 deg (neutral) to 17 deg (child+short) |
| leftFoot | foot_l | leftLowerLeg | (.18, .069, .02) | (.04, -.46, .89) | +X plantarflex (toes down, heel up), -X dorsiflex |
| leftToes | ball_l | leftFoot | (.19, .009, .14) | none (leaf) | -X toes bend up relative to the foot |
| left fingers | thumb_01..03_l, index/middle/ring/pinky_01..03_l -> leftThumbMetacarpal/Proximal/Distal, left{Index,Middle,Ring,Little}{Proximal,Intermediate,Distal} | hand chain | | | mapped, **not animated in v1** (rest curl looks natural) |
| right* | *_r | mirrored | x -> -x | x -> -x | never authored directly: `mirrorPose` / `qMirrorX` |
| (root motion) | Root | - | (0, 0, 0) | - | not a canonical joint; carries `pose.root` in exported clips only |

\* `upperChest` points at the neck (1.41 m) as its tip; spine_03 is long (0.25 m).

Canonical joints the rig lacks would simply be skipped (`presentParent`), so other rigs with fewer spine
bones or no fingers work; this rig maps all 52 canonical joints + Root = 53 joints.

Body extremes (from the sidecar, via `restGeometry`): legLength 0.802 neutral, 0.987 tallest, 0.408
child+short; hipHeight 0.866 / 1.064 / 0.444; footLength 0.132 / 0.159 / 0.083. `weight`/`muscle`
sliders have **zero** joint offsets, so fat thighs are invisible to the skeleton: clips get the slider
values in `ctx.body` for that (step width / arm abduction).

## 3. Shared frozen files (written by the planner, nobody edits them)

* `web/animation/qmath.js` - quaternion/vector helpers on arrays: `qMul, qConj, qAxisAngle, qRotate,
  qFromTo, qSlerp, qAngle, qAlign, qMirrorX, qToLocal, qNormalize, qIdentity, DEG, v*`.
* `web/animation/canonical.js` - `JOINTS` ([joint, parent] parent-first), `JOINT_NAMES`, `PARENT`, `TIP`,
  `mirrorJointName`, `mirrorPose`, `presentParent`, `worldToPose(worldDeltas)`, `poseToWorld(joints)`,
  `fkPositions(heads, pose)` (posed joint heads incl. `pose.root`).
* `web/animation/rig.js` - `MPFB_GAME_ENGINE` (canonical -> bone), `MPFB_ROOT_BONE = 'Root'`,
  `headsFromSidecar(sidecar, influences)` (rest heads for a slider body, node-safe),
  `restGeometry(heads)` -> **Rig**:
  `{ heads, dir, len, axes:{left/rightLowerArm, left/rightLowerLeg}, restBend, legLength, armLength,
  hipHeight, height (head JOINT y), ankleHeight, toesHeight, footLength, hipWidth, shoulderWidth }`.
* `tests/canonical.test.mjs` - locks the convention against the GLB.

If an agent needs a change here it reports it; the orchestrator changes it. Adding a new export is
allowed only via the orchestrator.

## 4. Module contracts

All web modules are plain ES modules with **no three.js import** except `main.js` (three objects are used
duck-typed: `bone.quaternion.set(x,y,z,w)`, `bone.position.{x,y,z}`, `obj.position`), so they also load
in node for tests and baking.

### A) `web/humanoid.js` - binds a three.js skinned mesh to the canonical skeleton

```js
export function createHumanoid(skinnedMesh, { map = MPFB_GAME_ENGINE, root } = {}) -> Humanoid
// MUST be called at rest (before any pose). root defaults to the topmost ancestor below the THREE.Scene
// (same rule as character.js sceneRoot, i.e. gltf.scene). Bone lookup by exact name, then by the
// three.js-sanitised name. Missing joints -> humanoid.missing (warn once), never throw.
Humanoid = { mesh, root, map, bones: {joint: Bone}, missing: [joint],
             restLocal: {joint: [x,y,z,w]}, restWorld: {joint: [x,y,z,w]} /* relative to root */ }

export function applyPose(h, pose)        // writes ONLY bone.quaternion = qToLocal(restLocal, restWorld, q)
                                          // for every mapped joint (absent in pose -> restLocal). Never
                                          // touches bone.position (applySkeleton owns it) or pose.root.
export function resetPose(h)              // restores rest quaternions exactly
export function restHeads(h) -> {joint: [x,y,z]}
      // rest-pose joint heads in the character frame for the CURRENT bone.position values (i.e. after
      // applySkeleton): FK with restLocal rotations + current positions. Independent of the current pose.
export function measure(h) -> Rig         // restGeometry(restHeads(h))
```

Unit test `tests/humanoid.test.mjs`: fake bones built from the GLB nodes (objects with `name, parent,
position{x,y,z}, quaternion{x,y,z,w,set()}`): map resolves 52/52; applyPose then bone-level FK equals
`fkPositions` (< 1e-4 m); resetPose restores exactly; restHeads equals `headsFromSidecar` for neutral and
for sidecar-offset positions (< 1e-3 m); applyPose never changes any position.

### B) `web/animation/clips.js` - procedural clips (pure, deterministic)

```js
export const CLIPS = { idle, walk, run };          // registry; new clips = new entries
export function makeContext(rig, { speedScale = 1, body = {} } = {}) -> ctx
ctx = { rig, body /* slider values -1..1, may be {} */, speedScale /* 0.25..2 */,
        legLength, armLength, height, hipHeight /* copied from rig */ }
Clip = {
  name, loop: true,
  duration,                                 // seconds for the NEUTRAL body at speedScale 1 (metadata)
  timing(ctx) -> { duration, speed, stride }// body-adapted cycle length (s), root-motion speed (m/s along
                                            // +Z, 0 for idle), stride = distance per cycle (m)
  sample(t, ctx) -> Pose                    // t in seconds, wrapped by timing(ctx).duration;
                                            // sample(0) == sample(duration)
  contacts(t, ctx) -> { left: 0|1, right: 0|1 }  // 1 = foot planted
}
```

Note vs. the original brief: `stride` is per clip (from `timing`), not a ctx field.

Animated joints in v1: hips, spine, chest, upperChest, neck, head, both shoulders, upperArm, lowerArm,
hand, upperLeg, lowerLeg, foot, toes (22). Fingers stay at rest. Author left, mirror right with a phase
offset of half a cycle for locomotion.

**Foot-plant approach: analytic two-bone leg IK inside the clip** (chosen over a stride-scaled FK cycle).
Reason: FK angle cycles make foot height depend on the thigh/shin ratio, which the linearised morphs
distort badly (neutral 0.395/0.407, short 0.220/0.360), so feet would float or sink and a sinusoidal hip
angle gives a non-constant stance velocity (slides). Defining the **foot trajectory** in units of the
body's own geometry and solving the angles makes no-slide/no-penetration hold by construction for every
body, costs ~30 lines, and stays pure (bakeable). Per leg per frame:

1. Foot targets (in-place frame). Phase offset 0.5 for the right leg, duty factor beta (walk ~0.62,
   run ~0.38). Stance (s = phase/beta): toes (ball) at `rig.heads.<side>Toes` height, x = rest x +
   step-width offset, z moving back linearly `zc + beta*stride*(0.5 - s)` (exact speed = `speed`, so the
   foot is planted when the root moves at `speed`). Late stance: heel lift = foot rotation about the
   ball (+X plantarflex), so the ankle rises and the ball stays planted. Swing: smooth z from lift-off
   to next strike, y = clearance * sin(pi u) (walk ~0.08 legLength, run ~0.2), pitch back to 0 at strike.
2. Pelvis: `root.y = min(bob(t), min over legs(reachY))`, `reachY` = the highest hip that keeps
   |ankle - hip| <= 0.985 (thigh + shin). Include the hips delta when computing the hip joint position.
3. Two-bone IK: hip H, ankle target A, a = len.upperLeg, b = len.lowerLeg, d = clamp(|A-H|,
   |a-b| + 1e-4, 0.999(a+b)); knee K by law of cosines in the plane of (A-H) and the pole (forward +Z
   rotated by the hips yaw). World deltas: `Dthigh = qFromTo(dir.upperLeg, K-H)`,
   `Dshin = qMul(qFromTo(qRotate(Dthigh, dir.lowerLeg), A-K), Dthigh)`, foot/toes world deltas from
   the pitch; convert everything with `worldToPose`.
4. Upper body: hips yaw with the swinging leg (walk ~4 deg, run ~8 deg), roll ~3 deg; spine/chest
   counter-yaw; head keeps world yaw ~0; arms: world `Rx(swing) * Rz(down)` with `down` from `rig.dir`
   so the arm hangs ~6 deg off the body (+ more with `body.weight` > 0), swing opposite the same-side
   leg (walk ~18 deg, run ~35 deg), elbow bend walk ~20 deg, run ~85 deg (about `rig.axes`).

Tempo/stride (starting values, B tunes): walk v = speedScale * sqrt(0.2 g hipHeight) (1.30 m/s
neutral), stride = 1.55 hipHeight * sqrt(speedScale); run v = speedScale * sqrt(1.0 g hipHeight)
(2.9 m/s), stride = 2.4 hipHeight * sqrt(speedScale); duration = stride / v. Idle: 8 s loop, 2 breaths
(chest/upperChest +X ~1.5 deg), one weight shift (root.x ~ 0.015 legLength, hips roll ~2 deg), feet
IK-pinned to rest, arms at sides with slight sway.

**Root motion policy:** clips are **in-place**. Forward travel is `timing(ctx).speed` (m/s along +Z),
exposed as metadata (animator state, JSON `rootMotion`). `pose.root` carries only pelvis height/bob (y)
and lateral sway (x); `root.z = 0` for locomotion. No bone translation from clips.

Unit test `tests/clips.test.mjs` (bodies: neutral, tall `height=1`, short `height=-1`, child `age=-1`,
child+short, old `age=1`, male+tall, heavy `weight=1`, via `headsFromSidecar(sidecar,
sliderInfluences(values))` + `restGeometry`; speedScale 0.5/1/2; 120 samples per cycle):
* all quats finite and unit (1e-6); loop closure sample(0) vs sample(duration) < 1e-4 rad / 1e-6 m;
* using `fkPositions`: toes y >= rest toesHeight - 0.005 and foot y >= rest ankleHeight - 0.01 always
  (no penetration);
* while `contacts` = 1: toes y <= rest + 0.005 (no float) and toes z + speed * t constant within
  0.01 m (no slide);
* knee never hyperextends (flexion >= rest bend - 1 deg), knee in front of the hip-ankle line;
* feet don't cross: left toes x - right toes x >= 0.5 hipWidth;
* idle: toes/foot within 0.005 m of rest the whole loop;
* neutral walk speed 1.1-1.6 m/s, run 2.4-3.6 m/s, cadence walk 90-130, run 150-190 steps/min.

### C) `web/animation/animator.js` + `web/main.js` + `web/index.html`

```js
export function createAnimator(humanoid, { clips = CLIPS, root = humanoid.root, getBody = () => ({}) } = {})
-> {
  play(name, { fade = 0.3 } = {}),   // crossfade from whatever plays; walk<->run: new time = old phase *
                                     // new duration (phase-matched, no foot pop)
  stop({ fade = 0.3 } = {}),         // fade to rest, then resetPose + root offset 0
  pause(), resume(),                 // update() keeps applying the frozen pose while paused
  setSpeed(s),                       // speedScale, clamped 0.25..2
  seek(t),                           // deterministic time for tests/screenshots
  bodyChanged(),                     // re-measure(humanoid) + makeContext; call after EVERY applySkeleton
  update(dt),                        // dt clamped to 0.1 s; sample active (+ fading) clip, blend
                                     // (qSlerp per joint, lerp root), ground guard, applyPose, root offset
  state() -> { clip, time, phase, speedScale, paused, fading, rootSpeed, stride, duration },
  dispose(),
}
```

* **applySkeleton integration:** applySkeleton only writes `bone.position`, the animator only writes
  `bone.quaternion` and `root.position`. Order in `main.js update()`: `applySliders -> applySkeleton ->
  animator?.bodyChanged()`. The first `applySkeleton` and `createHumanoid` both happen at rest (today's
  load path already calls `update()` before anything animates).
* **Root offset at runtime** goes on `root` (= `gltf.scene`), never on a bone: `root.position = rootRest
  + pose.root`, `rootRest` captured at creation. applySkeleton explicitly supports moving the scene root.
* **Ground guard** (only needed during crossfades, clips are already correct): after blending, compute
  `fkPositions(rig.heads, pose)`; if min(toes y - toesHeight, foot y - ankleHeight) < 0, raise root.y by
  that amount. Never lowers.
* **UI** (append after the reset button): section label, `<select>` (none / idle / walk / run, built
  from `CLIPS`), play/pause button, speed range 0.25..2 step 0.05 with value display. Reset keeps the
  animation. URL params for tests: `?anim=walk`, `&animT=0.3` (seek + pause), `&animSpeed=1.5`.
  Loop: `const clock = new THREE.Clock()`; in `setAnimationLoop`: `animator?.update(clock.getDelta())`
  before render.
* **i18n keys** (da / en): `anim` Animation / Animation, `animNone` Ingen / None, `clip_idle` Hvile / Idle,
  `clip_walk` Gang / Walk, `clip_run` Løb / Run, `play` Afspil / Play, `pause` Pause / Pause,
  `speed` Hastighed / Speed. New clips add `clip_<name>`, fallback = the clip name.
* **Test hooks:** `window.__anim` = the animator, `window.__animProbe()` -> `{ clip, phase, minToesY,
  minFootY, leftToes:[x,y,z], rightToes:[x,y,z] }` from `bone.getWorldPosition` (world metres).
* `index.html`: CSS for `select` (full width, same look as buttons); nothing else.
* Unit test `tests/animator.test.mjs` with fake humanoid/bones: crossfade weights monotonic, stop ends in
  exact rest, pause freezes time, phase matching walk->run.
* Headless Chrome (webxr-test skill `check.js`, local `build/site` served over HTTP): no console errors
  for `?anim=walk`, `?anim=run`, `?anim=idle`; probe `__animProbe()` at several `animT` for neutral and
  after `__set('height',1)`, `__set('age',-1); __set('height',-1)`: minToesY >= -0.01; screenshots
  of walk/run at 2 phases for a visual check.

### D) Baking: `tools/sample_clips.mjs`, `blender/bake_clips.py`, `tools/check_anim_glb.mjs`

**Output decision:** `output/animations/<clip>.json` (+ `index.json`) and a separate
`output/base_body_anim.glb` = the same body (mesh, 12 morphs, skin) + clips `idle`, `walk`, `run`.
`output/base_body.glb` stays untouched; the viewer keeps loading it and animates procedurally (so the
baked neutral-body clips never fight the slider skeleton).

`node tools/sample_clips.mjs [--fps 60] [--out output/animations]` (60 by default since integration: at
30 fps linear key interpolation in three.js let run's toes dip 5.05 mm below rest between keys): neutral body
(`restGeometry(headsFromSidecar(sidecar, {}))`, `makeContext(rig)`), for each clip: `T =
timing(ctx).duration`, `n = max(2, round(T * fps))`, key i (0..n) sampled at clip time `i*T/n`, stored
at time `i/fps` (so `duration = n/fps`, `timeScale = T/duration`; last key == first key). Quaternions
normalised, hemisphere-aligned to the previous key (`qAlign`), rounded to 6 decimals. JSON:

```json
{ "format": "charactercreator.humanoid-clip", "version": 1, "name": "walk", "loop": true,
  "fps": 60, "frames": 60, "duration": 1.0, "timeScale": 0.996,
  "frame": "character: +X left, +Y up, +Z forward, metres; quaternions [x,y,z,w]",
  "convention": "parent-relative rest deltas, docs/ANIMATION_PLAN.md section 1",
  "body": { "sliders": {}, "legLength": 0.802, "hipHeight": 0.866, "height": 1.515 },
  "rootMotion": { "mode": "in-place", "speed": 1.30, "stride": 1.34, "axis": [0, 0, 1] },
  "rig": "mpfb-game_engine", "boneMap": { "hips": "pelvis", "...": "..." }, "rootBone": "Root",
  "root": [[0, -0.01, 0], "... frames entries"],
  "contacts": { "left": [1, "..."], "right": [0, "..."] },
  "joints": { "hips": [[0, 0, 0, 1], "... frames entries"], "...": [] } }
```

Only joints the clip outputs are stored. `index.json` = `{ clips: [names], boneMap, rootBone }`.

`blender -b --python blender/bake_clips.py -- --blend <scratch>/base_body.blend [--anim-dir
output/animations] [--out output/base_body_anim.glb]`:
* **The .blend must be fresh** (an old scratch .blend from before the skeleton fix gives wrong rest
  poses). Rebuild first into a scratch folder:
  `blender -b --python blender/build_base.py -- <scratch>/base_body.glb --blend <scratch>/base_body.blend`
  (never overwrite `output/`), and check that the rebuilt glb has the same joint rest TRS as
  `output/base_body.glb` (check_anim_glb does it).
* Per clip: new Action `<name>` on the armature; every pose bone `rotation_mode = 'QUATERNION'`.
  Axis conversion glTF -> Blender: vector `(x, y, z) -> (x, -z, y)`, quaternion `[x,y,z,w] ->
  Quaternion((w, x, -z, y))`. `Rrest = (arm.matrix_world @ pbone.bone.matrix_local).to_quaternion()`,
  `pbone.rotation_quaternion = Rrest.inverted() @ qB @ Rrest` (same formula as section 1; no scale in the
  rig). `Root` location = `Rrest_root.inverted() @ vB(pose.root)` (the only translation track; Root's
  morph offsets are <= 3.5 mm, so a Root translation track is harmless). Keys at frame `i` (as built:
  frame `1 + i` would shift glTF time, the exporter does not slide actions to 0),
  scene fps = JSON fps, LINEAR interpolation; push each action to its own NLA track (stash), clear the
  active action. Blender 5.x actions are slotted: assign the action to the armature first and use
  `keyframe_insert` so slots/channelbags are created for you.
* Export like `build_base.py` plus `export_animations=True, export_animation_mode='ACTIONS',
  export_force_sampling=False` (as built: forced sampling would add translation/scale tracks for all 53 bones), export_optimize_animation_size=False, export_reset_pose_bones=True` (check
  the exact option names in 5.2 via `bpy.ops.export_scene.gltf.get_rna_type().properties`). Do not save
  the .blend.

`node tools/check_anim_glb.mjs [output/base_body_anim.glb]` (exit 1 on failure): 53 joints with rest
TRS equal to `output/base_body.glb` (<= 1e-5, keeps the joints sidecar valid); 12 morph targets;
animations idle/walk/run with durations matching the JSON; rotation channels only, except one
translation channel on Root; each baked rotation key equals `qToLocal(restLocal, restWorld, q_json)`
(<= 0.5 deg) and Root translation = rest + root (<= 1 mm); foot FK check on the baked data for walk
(toes y >= -0.005 m).

## 5. File ownership (disjoint)

| Agent | Owns (create/edit) |
|---|---|
| A | `web/humanoid.js`, `tests/humanoid.test.mjs` |
| B | `web/animation/clips.js`, `tests/clips.test.mjs` |
| C | `web/animation/animator.js`, `web/main.js`, `web/index.html`, `tests/animator.test.mjs` |
| D | `tools/sample_clips.mjs`, `tools/check_anim_glb.mjs`, `blender/bake_clips.py`, `output/animations/*`, `output/base_body_anim.glb` |
| planner / orchestrator only | `web/animation/qmath.js`, `web/animation/canonical.js`, `web/animation/rig.js`, `tests/canonical.test.mjs`, `docs/ANIMATION_PLAN.md`, `README.md`, `docs/STATUS.md`, `docs/BLENDER_WORKFLOW.md`, `LICENSE-NOTES.md` |
| nobody | `web/character.js`, `blender/build_base.py`, `blender/tools/*`, `output/base_body.glb`, `output/base_body.joints.json`, `.gitignore`, `deploy.ps1`, `deploy.htaccess`, `AGENTS.md` |

Dependencies: C and D import A's and B's modules by the contracts above; until those land they may stub
them in scratch, not in the repo. Temp files go in the scratchpad. No commits, no deploy (only
`deploy.ps1 -StageOnly` for the local site). Never put machine paths, IPs, usernames or key paths into
tracked files.

## 6. Known risks

* Blender round trip (axis conversion, slotted actions, exporter option names in 5.2) is **unverified**;
  `check_anim_glb.mjs` is the gate. Fallback if the Blender route fails: write the animation channels
  straight into a copy of `base_body.glb` from node (same math, no Blender).
* The existing .blend is stale; a rebuild must reproduce the committed GLB's rest pose (not verified that
  the build is deterministic).
* Minimal-arc (`qFromTo`) thigh rotation can add slight thigh twist at large abduction; the clip test's
  knee-in-front check catches gross errors.
* `weight`/`muscle` do not move joints, so thigh collision at weight = 1 is handled only by clip
  heuristics (`ctx.body.weight`), not by geometry.
* Linearised morphs give odd leg ratios at extremes (short: thigh 0.22 m vs shin 0.36 m; child+short
  rest knee bend 17 deg); IK handles it, but the look is only as good as the morphs.
* `deploy.ps1` stages every `output/*.glb`, so `base_body_anim.glb` (4.67 MB at 60 fps) would be uploaded too;
  decide before the next deploy.
