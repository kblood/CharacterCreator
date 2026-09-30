# Cloth runtime (viewer)

Real-time cloth for every worn garment that carries cloth data (`_CLOTH_PIN` + `ccCloth`, see
[CLOTH_SPEC.md](CLOTH_SPEC.md)). Today that is the long coat and the skirt. Garments without the data stay
plain skinned meshes. Nothing here is garment-specific: a new garment only needs a pin mask and extras.

| file | role |
|---|---|
| `web/cloth/model.js` | weld GLB split vertices into particles, edges, skip-one bends (vertical chains flagged), mirror pairs, simulated subset (free particles + neighbours) |
| `web/cloth/solver.js` | XPBD solver: pure JS, no three.js, no per-step allocation; `advance(solver, job)` is shared by the worker and the sync path |
| `web/cloth/colliders.js` | cloth capsules from `body_colliders.json` → posed capsules each frame (slider radii) |
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
| worker vs sync | 40 frames with a varying step count and reset: `worker_threads` hash = main-thread hash |

## Not verified

- Mobile GPUs and CPUs, and browsers other than headless Chrome.
- Stability over hours (only 10 s timelines and short browser runs were tested).
- Coat vs T-shirt / jeans layer collision: the cloth collides with the body capsules only. The pinned part is
  cut 3 mm over the lower layers, but free coat panels can pass through the jeans where the capsules are
  thinner than the jeans.
- Hair vs coat collar.
