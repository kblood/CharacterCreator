# Cloth runtime (viewer)

Real-time cloth for every worn garment that carries cloth data (`_CLOTH_PIN` + `ccCloth`, see
[CLOTH_SPEC.md](CLOTH_SPEC.md)). Today that is the long coat and the skirt. Garments without the data stay
plain skinned meshes. Nothing here is garment-specific: a new garment only needs a pin mask and extras.

| file | role |
|---|---|
| `web/cloth/model.js` | weld GLB split vertices into particles, edges, skip-one bends (vertical chains flagged), mirror pairs, simulated subset (free particles + neighbours) |
| `web/cloth/solver.js` | XPBD solver: pure JS, no three.js, no per-step allocation; `advance(solver, job)` is shared by the worker and the sync path |
| `web/cloth/colliders.js` | cloth capsules from `body_colliders.json` → posed capsules each frame (slider radii) |
| `web/cloth/layers.js` | lower-layer collision points: the worn garments under a cloth garment, skinned each frame (see Lower layers) |
| `web/cloth/skin.js` | CPU morph + linear-blend skinning, normals |
| `web/cloth/wind.js` | deterministic gusting wind velocity |
| `web/cloth/worker.js` | module worker (browser) / `worker_threads` (node tests) |
| `web/cloth/runtime.js` | three.js glue: per-garment state, fixed step, proxy mesh, stats |
| `tools/cloth_sim.mjs` | headless harness: real animator + skeleton + the same solver; `node tools/cloth_sim.mjs trenchcoat skirt` prints the numbers below |
| `tests/cloth.test.mjs` | tests (see Tests) |

## Frame flow

1. The animator writes bone rotations (+ root position); `updateMatrixWorld`.
2. For each worn cloth garment (`runtime.update(dt, meshes)`):
   - **Rest shape.** When the garment's slider influences change, the bind positions are morphed again. The
     result gives new rest lengths (`setRest`), so the cloth follows every slider.
   - **Skinning.** All vertices are skinned on the CPU with the same matrices three.js uses (world =
     `matrixWorld · bindMatrixInverse · Σ w · boneWorld · boneInverse · bindMatrix · morphed`). The skinned
     position is the anchor of each particle: pinned particles sit exactly on it, and free particles are held
     within `(1 − pin) · maxDistance` of it.
   - **Colliders.** The capsules are posed from the live skeleton, with radii from the slider morphs.
   - **Lower layers.** The worn garments in a lower layer (`ccLayer`) are skinned at the selected vertices
     (position + normal) and sent with the job as `L0`/`L1`, like the capsules.
   - **Stepping.** The solver runs at a fixed 60 Hz with an accumulator. At most 4 steps run per frame, and
     the rest of a long frame is dropped, so a tab switch or hitch cannot cause a spiral. Anchors and
     capsules are interpolated linearly inside the frame's steps.
3. **Drawing.** Positions and normals go into a plain `THREE.Mesh` proxy in world space. The proxy shares the
   garment's index, UVs, groups and material, and gets per-frame bounds (so `frustumCulled` stays correct).
   The SkinnedMesh stays in the scene but is hidden from the camera through `layers`, so `visible` still means
   "worn" for the clothing code. Normals are the welded triangle normals of the simulated shape, blended by
   pin with the skinned normals, so there is no seam where pinned and free cloth meet.
4. **Lag compensation.** Free particles are drawn at `x_sim + (A_now − A_ref)`. This adds the skinned motion
   since the positions were computed, so neither the fixed-step remainder nor the worker's one-frame latency
   makes the cloth trail behind the body.

**Worker.** One job is in flight per garment and the result is one frame late. The worker is used when
`Worker` + module workers are available. It falls back to sync if the worker fails to start, errors, or does
not answer within 1.5 s. `?clothWorker=0` forces sync. The worker and sync paths run the same `advance()` and
are bit-identical (test).

**Resets.** The cloth snaps back to the skinned pose, plus 20 static settle steps, on:
- first wear;
- outfit change;
- the Reset button;
- animation to/from "None";
- enabling cloth;
- a teleport (any anchor jumps more than 0.3 m in one step).

A clip→clip crossfade (walk→run, idle→run) does **not** reset: the cloth carries its motion through the blend.

## Solver (per 1/60 s step, 8 substeps, one pass each: small-steps XPBD)

- **Predict.** Gravity, then air drag against the air velocity. The drag is split into tangential and normal
  parts (`drag`, `dragNormal`). Damping acts relative to the skinned motion, so running does not damp the coat
  toward standing still.
- **Distance constraints.** These are stiff in stretch (`stretch`) and softer in compression (`compress`), so
  folds can form.
- **Skip-one bends.** Horizontal and vertical chains have separate stiffness (`bend`, `bendVertical`: long
  panels keep their shape). Bends are **unilateral**: they only resist compression, so they never pull
  against stretch.
  - They are solved before the edges.
  - Their compliance is floored at `bendFloor · h²`. Without the floor, the stiff bends made the long coat
    unstable (stretch p99 1.52 → 1.03 in the sway test).
- **Mirror separation.** Left/right front panels and the vent edges are kept apart along the pelvis' lateral
  axis, with gap `max(0, min(rest gap, mirrorGap))`. It runs before and after collisions, so the front panels
  never cross.
- **Long-range attachments.** Each free particle stays within its rest geodesic distance (`+ tetherSlack`) of
  the nearest pinned particle, so long panels do not sag with few iterations.
- **maxDistance** to the skinned position.
- **Collisions.** These run last, spread over the substeps.
  - **Capsules** have `thickness` and friction.
  - **Anchor-limited capsules** (`limit`): for the capsule groups a garment lists in `ccCloth.limit`, the
    push-out radius is `min(R, dA + limitSlack)`, where `dA` is the skinned target's own distance from the
    capsule axis. Where the garment's cut already lies inside a capsule (the coat's sides under the hands, a
    tight skirt over the hips), the cloth does not fight its pins. The other capsules (lower legs, feet,
    thighs for the skirt... see table) stay hard.
  - **Lower layers** (see below): after the capsules, before the floor.
  - **Floor:** y ≥ `thickness`, with floor friction. The hem never sinks.
- **Velocities.** Velocities are taken from positions, then contact velocities are clamped to the collider
  surface's velocity, so the cloth is not launched off a moving leg.

Everything is deterministic: fixed iteration order, and float64 math on Float32Array storage. The same inputs
give the same hash.

## Colliders (`body_colliders.json` → `cloth.capsules`, 20 capsules)

These are thicker than the spring-bone capsules: the radius is a quantile of the skin distances, close to the
surface. Limbs are split into sub-segments, so each radius fits its own part of the limb.

| capsule | radius quantile | limit group |
|---|---|---|
| torso (spine_01 → spine_03) | 0.35 | hips |
| hips (thigh_r → thigh_l) | 0.55 | hips |
| thighUp_l/r, thighLo_l/r | 0.75 | thighUp: thighs; thighLo: none |
| calfUp_l/r, calfLo_l/r | 0.85 | none |
| foot_l/r (heel t −0.3 to toe t 1.5) | 0.75 | none |
| upperarm, lowerarm l/r | 0.7 | arms |
| hand_l/r (wrist to past the knuckles, t 0..1.9) | 0.8 | arms |

- Coat: `limit = "arms,hips"`. The thighs stay hard, so the knee cannot poke through a front panel in run.
- Skirt: `limit = "arms,hips,thighs"`. The skirt's cut sits on the hips and thighs.

## Lower layers (cloth vs the garments underneath)

**Why.** The capsules are fitted to the skin. The jeans lie up to 37–49 mm outside the thigh/calf capsules
and the T-shirt hem ~59 mm (q90) outside the hip capsule, far more than the coat's 20 mm `thickness`. So a
coat panel pressed against a knee or swinging back onto a leg sat on the capsule, *inside* the jeans, and the
jeans showed through as blue holes (knee in walk, back hem in run). Thin capsules alone (the shin/knee
capsules exist and are hard), panel flips (0 crossed pairs) and morphs (all bodies were affected) do not
explain it: the garments are simply thicker than the body.

**How** (`web/cloth/layers.js`, `solver.js`, `runtime.js` `syncLayers`):
- The lower garments are the worn, visible skinned clothing meshes with a lower `ccLayer` than the cloth
  garment, except footwear (`collidesAsLayer` in `clothing_rules.js`: items that hide only `feet`). At most
  `LAYER_PARTS` = 4 garments.
- Only garment vertices within `LAYER_SELECT` = 12 cm of the cloth garment's free particles (bind pose) are
  used. They are skinned on the CPU each frame with their normals: `[x, y, z, nx, ny, nz, part]` per point.
- Once per step, each free particle gets the nearest point of **each garment** (part) within `layerReach`
  (hash grid). The search is per part, so the shoes cannot hide the jeans.
- Per substep (points interpolated like the capsules): if the particle is less than `layerThickness` in front
  of that point's tangent plane and not more than `layerDepth` behind it, it is pushed out to
  `layerThickness`. The contact velocity is the point's velocity (same clamp as the capsules).
- `layerSided`: a particle that was already behind the plane at the substep start is left alone. It went
  past a thin edge (the jeans' outer seam, the tee hem) and is not inside. Yanking it across stretched the
  coat (heavy p99 1.21 → 1.34 without this, 1.26 with it).
- Footwear is excluded because on short bodies the hem reaches the shoes. Pushing the hem out over the shoe
  fights the floor, and the shoe then kicks through the hem (through-count 5 on short, worse than without).

| parameter (`DEFAULTS`) | value |
|---|---|
| layerThickness (m) | 0.012 (`ccCloth.layerThickness` overrides) |
| layerDepth (m) | 0.04 |
| layerReach (m) | 0.05 |
| layerSided | true |

**Metric** (`node tools/cloth_sim.mjs trenchcoat --under tshirt,jeans`, `pokeThrough`).
- A covered layer vertex (one that the skinned coat covers in the first idle frame) that projects into a
  coat triangle within 4 cm and lies more than 2 mm on its outer side counts as `n`.
- It counts as `through` if one of that triangle's particles is itself inside the layers, i.e. the layer
  really comes through the fabric.
- The rest of `n` is a panel that lies *behind* a leg that came out through the front opening (seen as leg,
  not as a hole).
- "body" = bare skin through the coat.
- Values are the max over the sampled frames; the skinned coat (cloth off) is the reference.

| coat over tee + jeans, through (tee / jeans / body) | before | after | cloth off (total) |
|---|---|---|---|
| neutral | 5 / 9 / 0 | 0 / 0 / 0 | 17 |
| tall | 8 / 9 / 0 | 0 / 0 / 0 | 11 |
| short | 6 / 7 / 0 | 0 / 0 / 0 | 80 |
| heavy | 6 / 9 / 0 | 0 / 0 / 0 | 19 |
| child | 4 / 9 / 5 | 0 / 0 / 0 | 22 |
| old | 8 / 8 / 0 | 0 / 0 / 0 | 19 |
| muscular | 4 / 11 / 0 | 0 / 0 / 0 | 18 |
| female | 6 / 14 / 6 | 0 / 0 / 0 | 21 |

- The holes before were up to 39–40 mm deep.
- `n` after: child 7 / 5 / 6, female 2 / 2 / 2, short jeans 3, tall jeans 1. All of these are "panel behind a
  leg". Before, `n` was 159 in total.

Other outfits (through, sum over the 8 bodies, before → after):
- tee + jeans + shoes: 122 → 0.
- tee + skirt + shoes: 102 → 8. Female only: tee 4 and skirt 4, 7–12 mm, at the front opening at hip height
  in run. The skirt is collided with in its skinned pose, not its simulated one.
- tee only: 64 → 4 (female tee 4, 9 mm).

**Stretch and body penetration with the layers** (tee + jeans, same 10 s timeline):

| body | p99 without → with layers | pen without → with |
|---|---|---|
| neutral | 1.287 → 1.279 | 3 → 3 |
| tall | 1.346 → 1.365 | 3 → 3 |
| short | 1.504 → 1.516 | 3 → 3 |
| heavy | 1.215 → 1.264 | 0 → 1 |
| child | 1.552 → 1.497 | 2 → 4 |
| old | 1.331 → 1.362 | 3 → 4 |
| muscular | 1.299 → 1.272 | 3 → 4 |
| female | 1.607 → 1.645 | 3 → 6 |

- p99 is chaotic. Perturbing the damping between 0.119 and 0.121 moves female between 1.58 and 1.645 (with
  layers). It moves the pen count between 5 and 8, with and without layers.
- Heavy is the one systematic change (+0.03–0.05).
- With tee + skirt + shoes, female p99 is 1.685 at the default damping. The band is 1.598–1.685 with layers
  and 1.579–1.63 without; mean p99 is 1.202 vs 1.203.
- Pen counts coat particles inside the capsules. With layers the coat sits further out, so a few more
  particles touch a capsule edge on the way.

**Cost.**
- Solver: ~0.25 ms/step more (node: neutral 1.43 → 1.70, female 1.54 → 1.78 ms/step).
- Main thread: ~0.1–0.2 ms/frame more (CPU skinning of the layer points).
- Headless Chrome, coat over tee + jeans:

| mode | main thread (ms/frame), before → after | solver (ms/step), before → after |
|---|---|---|
| worker, run | 0.55 → 0.76 | 1.46 → 1.73 |
| worker, walk | 0.59 → 0.71 | |
| sync | 2.01 → 2.34 | |

## Parameters (`ccCloth` extras, defaults in `solver.js` `DEFAULTS`)

| field | coat | skirt | default |
|---|---|---|---|
| maxDistance (m) | 0.6 | 0.04 | 0.3 |
| stiffness.stretch / bend | 0.95 / 0.35 | 0.95 / 0.3 | 0.95 / 0.35 |
| bendVertical | 0.7 | (= bend) | 0.6 |
| damping | 0.12 | 0.12 | 0.12 |
| wind | 0.6 | 0.3 | 0.3 |
| friction | 0.3 | – | 0.3 |
| thickness (m) | 0.02 | – | 0.01 |
| limit | arms,hips | arms,hips,thighs | arms,hips |

Missing or invalid values fall back to the defaults.

**Air.** `air = windVelocity(ui wind × garment wind, t) − rootSpeed · forward`. When running, the coat
therefore meets the headwind and trails without any wind.

## Viewer

- "Cloth physics" / "Stoffysik" checkbox (default on) and a "Wind" / "Vind" slider (0–1) in the clothes section.
  Both are shown only when a catalog garment has cloth data.
- URL: `?cloth=0|1`, `?wind=0..1`, `?clothWorker=0`.
- If there are no colliders, no worker or any error: the garment stays skinned (graceful). If the cloth is off,
  the proxy is hidden and the SkinnedMesh is drawn.
- Hooks:
  - `window.__cloth()` returns stats: `{ enabled, wind, mode (worker|sync|idle), worker, msPerFrame (main
    thread), solverMsPerStep, stepsPerFrame, frames, time, garments: [{ id, particles, free, steps, resets,
    stretchP99, stretchMax, penetrations, penetrationMm, belowFloor }] }`;
  - `__cloth.reset()`;
  - `__cloth.manual(bool)`: sync, frozen real time;
  - `__cloth.advance(seconds)`: fixed 1/60 s ticks + one render, deterministic screenshots;
  - `__camTo([x,y,z],[tx,ty,tz])`: test camera.

## Numbers

**Harness setup.** `node tools/cloth_sim.mjs trenchcoat skirt`, 10 s timeline: walk 0–3 s, run 3–5.5 s,
idle 5.5–7.5 s, idle→run 7.5–10 s, preceded by 1 s of idle.

**Metrics.**
- *Stretch* = edge length / rest length. "p99" is the worst per-frame 99th percentile; "mean" is the mean of
  the per-frame p99.
- *Pen* = particles more than 2 mm inside a hard capsule. For limited capsules, it counts particles inside the
  anchor-limited radius.
- *Cloth off* = the same garment skinned only (what the viewer showed before). Its penetration grid is capped
  at ~29 mm, so "≥ 29 mm" means at least that.

| long coat | stretch p99 / mean | cloth off p99 | pen (particles / worst mm) | cloth off pen | floor below | panels crossed | hem trail in run (m) |
|---|---|---|---|---|---|---|---|
| neutral | 1.22–1.29 / 1.13 | 3.10 | 3 / 16 | 20 / ≥ 29 | 0 | 0 | 0.31 |
| tall | 1.35 / 1.21 | 3.17 | 3 / 8–13 | 19–21 / ≥ 29 | 0 | 0 | 0.35 |
| short | 1.50 / 1.24 | 2.72 | 3 / 12 | 21 / ≥ 29 | 0 | 0 | 0.23 |
| heavy | 1.19–1.22 / 1.09 | 3.21 | 0 | 20 / ≥ 29 | 0 | 0 | 0.33 |
| child | 1.51–1.55 / 1.23 | 3.91 | 2 / 8–10 | 20–21 / ≥ 29 | 0 | 0 | 0.30 |
| old | 1.33 / 1.11 | 3.07 | 3 / 9–12 | 22 / ≥ 29 | 0 | 0 | 0.35 |
| muscular | 1.26–1.30 / 1.14 | 3.10 | 3 / 17 | 20 / ≥ 29 | 0 | 0 | 0.32 |
| female | 1.61 / 1.20 | 3.40 | 3 / 13–14 | 20 / ≥ 29 | 0 | 0 | 0.32 |

Coat details:
- **Hem at rest:** 6.4–9.1 cm above the floor, following body height (neutral 8.0 cm, child 6.4 cm, tall 9.1 cm).
- **Hem in run:** the lowest hem point is at the floor + thickness (2 cm) and never below it. The hem rises
  0.10–0.23 m and trails 0.23–0.35 m behind its skinned position.
- **Front panels:** they never cross (0 on all bodies).
- **Where the worst stretch is:** p99 above 1.5 appears only on short, child and female bodies, at the
  sides/underarm in run. The mean p99 is ≤ 1.24 everywhere.

| skirt | stretch p99 | cloth off p99 | pen (particles / worst mm) | cloth off pen |
|---|---|---|---|---|
| neutral | 1.72 | 3.00 | 8 / 18 | 15 / ≥ 29 |
| short | 2.20 | 2.80 | 4 / 12 | 24 / ≥ 29 |
| child | 2.07 | 3.00 | 5 / 10–12 | 14 / ≥ 29 |
| female | 1.87–1.92 | 3.48 | 8 / 19 | 18 / ≥ 29 |

**Skirt limitation.** The skirt improves on skinning, but it does not reach p99 ≤ 1.5. It is a tight
knee-length cut: in run the thighs spread further than the fabric's rest width allows, so the fabric must
stretch or be penetrated.

**Cost.** In node, one step takes about 1.4–1.6 ms for the coat (823 free / 860 simulated particles) and
about 0.55 ms for the skirt. At 60 fps the solver runs one step per frame on average.

In the browser (headless Chrome, run, coat worn):

| mode | main thread (ms/frame) | solver (ms/step) |
|---|---|---|
| worker | 0.62 (skinning + proxy write) | 1.50, on the worker |
| sync | 2.05 | 1.45 |
| skirt, worker | 0.23 | 0.57 |

The frame time was vsync-bound (16.65 ms) with cloth on and off.

Re-measured after the standing collar, lapels and pocket removal (2026-09-30): the collar and lapels are
pinned, so the coat still has 860 simulated / 823 free particles and the table above is unchanged (node
1.42–1.56 ms/step; stretch p99 1.215–1.607; pen 0–3). Headless Chrome, run: worker 0.54 ms/frame main thread +
1.44 ms/step, sync 1.98 ms/frame + 1.43 ms/step (before the collar: 0.55 + 1.46, 1.98 + 1.42).

## Tests (`tests/cloth.test.mjs`, part of `node --test "tests/*.test.mjs"`)

Every test prints its numbers and tolerances.

| test | checks |
|---|---|
| determinism | the same coat run twice gives the same position hash |
| pins | pinned particles match their skinned targets (max error 0 < 1e-6) |
| collision | a sheet dropped over a capsule ends outside it; a dropped triangle rests at floor + thickness |
| dt spikes / teleport | jittered dt + 0.25 s hitches: coat p99 1.48 < 1.8; a 1 m teleport resets once with stretch max 1.004 |
| long coat, 8 bodies | p99 ≤ 1.65; mean ≤ 1.3; pen ≤ 6 particles, ≤ 25 mm and ≤ cloth off; floor 0; crossed 0; hem ≥ floor; trail ≥ 0.15 m; rise ≤ 0.3 m |
| skirt, 4 bodies | p99 ≤ 2.4 and < cloth off; pen ≤ 12 and ≤ cloth off; crossed 0 |
| coat over tee + jeans, 8 bodies | per layer (tee, jeans, body) `through` ≤ 1 in walk and in run and ≤ 15 mm; total < cloth off; p99 ≤ 1.65; pen ≤ 6; crossed 0 (today all 0) |
| footwear | `collidesAsLayer`: shoes no, tee / jeans / skirt yes |
| worker vs sync | 40 frames with a varying step count and reset: `worker_threads` hash = main-thread hash, without and with lower layers |

## Not verified

- Mobile GPUs and CPUs, and browsers other than headless Chrome.
- Stability over hours (only 10 s timelines and short browser runs were tested).
- Lower layers:
  - A simulated skirt under the coat is collided with in its skinned pose, not its simulated one (female: 4
    skirt vertices through at the front opening in run).
  - Bare skin and feet are not a layer (only the capsules). In one close-up frame, a small heel speck showed
    through the female back hem in run.
  - Fingertips through the coat sides in idle were already there before (hands vs the limited arm capsules).
- Stacks of more than 4 lower garments (`LAYER_PARTS`), and a cloth garment under another cloth garment.
- Hair vs coat collar.
