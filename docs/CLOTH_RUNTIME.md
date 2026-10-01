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
| `web/cloth/drawfix.js` | drawn-frame contacts: the drawn (lag-compensated) positions are pushed out of THIS frame's capsules / layers (see Frame flow 4) |
| `web/cloth/skin.js` | CPU morph + linear-blend skinning, normals |
| `web/cloth/wind.js` | deterministic gusting wind velocity |
| `web/cloth/worker.js` | module worker (browser) / `worker_threads` (node tests) |
| `web/cloth/runtime.js` | three.js glue: per-garment state, fixed step, proxy mesh, stats |
| `tools/cloth_sim.mjs` | headless harness: real animator + skeleton + the same solver; `node tools/cloth_sim.mjs trenchcoat skirt` prints the numbers below |
| `tools/cloth_integrity.mjs` | visible layer penetrations per outfit × body × clip × pair (see "Integrity harness") |
| `tests/cloth.test.mjs` | tests (see Tests) |

## Frame flow

1. The animator writes bone rotations (+ root position); `updateMatrixWorld`.
2. For each worn cloth garment (`runtime.update(dt, meshes)`):
   - **Rest shape.** When the garment's slider influences change, the bind positions are morphed again. The
     result gives new rest lengths (`setRest`), so the cloth follows every slider. The breast-motion morphs
     (`dyn_*`, set every frame by the breast physics) are not part of the rest shape: `buildDyn`/`dynBase` add
     them to the morphed base per frame over their few vertices only, so they move the anchors without a
     re-morph or new rest lengths. `layers.js` likewise ignores targets that do not touch its picked vertices.
     See [BREAST_PHYSICS.md](BREAST_PHYSICS.md).
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
5. **One-frame prediction (worker).** A worker job is solved against its inputs (anchors, capsules, layer
   points) extrapolated one frame ahead (`extrapolate`: `2·now − previous`), the frame its result is drawn in.
   The next job interpolates from those predicted inputs, so the solver sees a continuous input stream.
6. **Drawn-frame contacts** (`drawfix.js`). The rigid lag shift does not move the cloth away from a leg that
   moved further than its anchor: a running shin moves 5–8 cm per frame, and the drawn coat panel lay inside the
   jeans (`trenchcoat:jeans` failed on 9/9 bodies with the worker, 0/9 in sync). After the shift, every drawn
   free particle is pushed out of the capsules and lower-layer tangent planes of the frame that is drawn:
   - capsules as in the solver (radius + thickness, anchor-limited groups); a particle that the motion carried
     past the capsule axis goes back out on the side it was on in the solved frame;
   - layers: each particle keeps the layer points it was in front of in the solved frame (per part, within
     `DRAW_REACH` = 8 cm) and is pushed out of their current planes; plus the nearest point per part now
     (within `DRAW_NEAR` = 4 cm) if it was in front of that point in the solved frame (a shoe toe that swung
     into the coat hem since);
   - the solver state is not touched, so the worker and sync paths stay bit-identical.

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
  garment, except the underwear (`collidesAsLayer` in `clothing_rules.js`: slots `underwear` / `bra`,
  `collidesAsLayer: false`; 2 mm over the skin, so the capsules already stand for it, and fully covered
  underwear is not drawn at all, CLOTH_SPEC.md "Underwear"). Footwear IS a layer (since 2026-10-01): in run
  the shoe swings forward through the ankle-length coat hem, which the foot capsule alone did not stop
  (`trenchcoat:shoes` 30 failing cases → 3, together with the drawn-frame contacts).
- **Body layer.** The body's drawn leg / hip skin is the last part (`bodyLayerMask`: vertices of drawn,
  zone-filtered triangles whose dominant bone is pelvis / thigh / calf / foot / ball). A flat foot or a knee
  is wider than its capsule, so bare legs came out through the coat hem / front panels in run. Arms are left
  to the anchor-limited arm capsules.
- **Simulated skirt under the coat.** Garments are updated inner first; a lower garment that is itself
  simulated (the skirt) is a layer in its DRAWN shape of this frame (`createLayerSet` `drawnOf`), not its
  skinned one (`trenchcoat:skirt` 34 → 0 failing cases in the matrix of review 2026-10-01; the "1" first written here
  was not from a recorded run).
- At most `LAYER_PARTS` = 4 parts (garments + body).
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
- Footwear was excluded until 2026-10-01 (on short bodies, pushing the hem out over the shoe fought the floor
  and the shoe kicked through the hem). With the drawn-frame contacts that no longer happens: short fails no
  shoe case in the integrity matrix.

| parameter (`DEFAULTS`) | value |
|---|---|
| layerThickness (m) | 0.012 (`ccCloth.layerThickness` overrides; the trenchcoat uses 0.015 since 2026-10-01) |
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
| maxDistance (m) | 0.45 | 0.04 | 0.3 |
| stiffness.stretch / bend | 0.95 / 0.35 | 0.95 / 0.3 | 0.95 / 0.35 |
| bendVertical | 0.7 | (= bend) | 0.6 |
| damping | 0.12 | 0.12 | 0.12 |
| wind | 0.6 | 0.3 | 0.3 |
| friction | 0.3 | – | 0.3 |
| thickness (m) | 0.02 | – | 0.01 |
| limit | arms,hips | arms,hips,thighs | arms,hips |
| limitSlack (m) | – | – | 0.02 |
| limitSlackPinned (m) | – | 0.006 | – (= limitSlack) |

`limitSlackPinned` (`solver.js` `limitSlackOf`): the anchor-limited slack blends from `limitSlack` toward this
value as the pin weight rises, so the skirt's nearly pinned waist band stays on its skinned shape instead of
bulging out over the hip / thigh capsules through the T-shirt hem (`tshirt:skirt` 36 failing cases → 0).

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
| coat over tee + jeans, 8 bodies | per layer (tee, jeans, body) `through` ≤ 1 in walk and in run and ≤ 15 mm; total < cloth off; p99 ≤ 1.65; pen ≤ 6; crossed 0 (passes: through all 0; female p99 1.587, was 1.687 before the coat's layerThickness 0.015) |
| layers | `collidesAsLayer`: briefs / panties / bra no; shoes / tee / jeans / skirt yes |
| integrity (`tests/integrity.test.mjs`) | visible poke / sink per layer pair, 11 outfit × body cases (5 added 2026-10-01 from the full matrix's failures: coat / female, coat+shoes / neutral and old, tee+skirt+coat / female, tee+jeans+shoes / old); `KNOWN_FAILING` 2 entries (coat+shoes trenchcoat:socks, tee+jeans+shoes tshirt:body, both on old); hidden zones are not tested |
| shoes, more bodies (`integrity.test.mjs`) | tee + jeans + shoes on child, heavy, tall, old and male heavy / child: no shoes:socks, jeans:shoes |
| socks inside the shoe (`integrity.test.mjs`, static) | every CONFIG body and its male variant, bind pose: no sock TRIANGLE centroid lies outside the shoe (the shoe is behind it within 3 cm and nothing in front); catches the patches between vertices that the vertex-based harness misses |
| worker vs sync | 40 frames with a varying step count and reset: `worker_threads` hash = main-thread hash, without and with lower layers |

## Integrity harness (`tools/cloth_integrity.mjs`, `tests/integrity.test.mjs`)

Counts VISIBLE layer penetrations of worn outfits while the character animates. Cloth runs as in the viewer:
60 Hz steps from a frame accumulator (max 4 per frame), `advance()` with interpolated anchors / capsules /
layers, and by default the worker path (the result is drawn one frame late, lag-compensated `x + A_now − A_ref`).
Deterministic.

```powershell
node tools\cloth_integrity.mjs                                   # full matrix, ~12 min, table; exit 1 above thresholds
node tools\cloth_integrity.mjs --outfits jeans+coat --bodies neutral,female --clips run
node tools\cloth_integrity.mjs --worker 0                        # sync path (?clothWorker=0)
node tools\cloth_integrity.mjs --fps 15 --json report.json       # low frame rate; JSON report (+ table)
```

- **Matrix** (`CONFIG` at the top of the file):
  - outfits: tee+jeans+shoes, tee+jeans+coat+shoes, tee+skirt+shoes, tee+skirt+coat, jeans+coat, coat,
    coat+shoes (coat over the underwear only, added 2026-10-01) and `underwear` (nothing else); every outfit is worn over the body sex's default underwear like in the viewer
    (`CONFIG.underwear`, `wornOutfit`: briefs, or panties + bra for gender < 0), so only its drawn part is tested;
  - bodies: the 8 `cloth_sim.mjs` shapes + male (gender slider +1);
  - one 10 s run per outfit × body (1 s idle preroll): idle, walk, run, idle, idle→run crossfade (0.3 s);
  - measured every 3rd frame.
- **Surfaces.** Every drawn surface: body (layer −1), garments by catalog layer. The socks are split off the
  shoe mesh (components ≤ 400 vertices, layer − 0.5). Simulated garments are tested in their simulated shape.
  Body triangles hidden by the outfit's zones and garment triangles covered by a higher layer (`_CCZONE`) are
  left out, as in the viewer.
- **poke (outer:inner)**: an inner vertex came out through the outer surface. The ray along its normal no longer
  hits the outer surface, but the ray backwards does within 30 mm. Depth = that distance, so 30 mm = "≥ 30 mm".
- **sink**: an outer vertex lies behind the inner surface (the ray along its normal hits it within 30 mm).
- **Only visible hits count**:
  - the pair must be layered at that vertex in the bind pose (ray coverage within 0.15 m);
  - the triangle normals must agree (dot ≥ 0.3);
  - the ray outward from the hit must escape: no drawn surface within 0.6 m. Without this, the T-shirt armpit
    behind the arm and the coat sleeve counted. In screenshots those armpit hits were not visible.
- **Thresholds.** `CONFIG.thresholds`, first matching rule {outfit, body, clip, pair} wins. The default fails a
  case when the max per-frame count > 2 vertices AND the deepest > 5 mm.
- **Test.** `tests/integrity.test.mjs` runs 11 outfit × body cases on a 4.6 s timeline (~30 s). It asserts the
  thresholds, except for pairs in `KNOWN_FAILING`. A known entry that starts passing fails the test, so remove
  entries as they are fixed. Until review 2026-10-01 the MATRIX had 6 cases that all passed and none of the
  failing ones; it now includes the reported cases (coat over underwear only, socks / shoes through the coat,
  skirt + coat on female) and two that still fail, listed in `KNOWN_FAILING` with their numbers.

**Baseline 2026-10-01** (full matrix, worker path, 60 fps): 461 of 1188 outfit × body × clip × pair cases above
threshold. Max per-frame vertex count / deepest mm over bodies and clips:

| outfit | pair | bodies failing | poke | sink | seen |
|---|---|---|---|---|---|
| all with shoes | shoes:socks | 9/9 | 10–21 / ≥ 30 | 10–26 / 29 | sock out over the shoe heel / collar in walk and run |
| jeans + shoes | jeans:shoes | 8/9 (not male) | 16–22 / 18 | 5 / 30 | shoe tongue / laces through the jeans hem, already in idle |
| coat + jeans | trenchcoat:jeans | 9/9 | 28–30 / ≥ 30 | 12 / 30 | shins / knees through the coat panels in run, coat hem flap out through the shin |
| coat + jeans + shoes | trenchcoat:shoes | 9/9 | 31 / ≥ 30 | 3 / 30 | shoe through the coat hem (footwear is not a coat layer) |
| coat, no jeans | trenchcoat:body | 9/9 | 33–81 / ≥ 30 | 4–7 / 30 | legs through the coat |
| skirt + coat | trenchcoat:skirt | 9/9 | 20 / 25 | 9 / 29 | simulated skirt out through the back of the coat |
| skirt | skirt:body | 9/9 | 15 / 26 | 5–7 / 26 | thighs through the front of the skirt in run |
| tee + skirt | tshirt:skirt | 9/9 | 7 / 16 | 18 / 30 | skirt waist band vs the T-shirt hem |
| tee | tshirt:body | 3/9 (heavy, child, old) | 1 / 11 | 4 / 30 | not checked in a screenshot |

**With the default underwear (2026-10-01, full matrix, 6 outfits)**: 470 of 1584 cases above threshold. The
pairs above are unchanged (459 of their cases, was 461; skirt:body slightly fewer because the skin under the
briefs is hidden). New underwear pairs, 9 failing cases:

| outfit | pair | failing | max poke | max sink | note |
|---|---|---|---|---|---|
| tee + skirt (+ coat) | skirt:briefs | 6 cases (neutral, tall, male; idle / walk / run) | 5 / 9 mm | – | briefs front through the simulated skirt where it lies on the thighs (same cause as skirt:body); tee+skirt+coat: 0 failing |
| tee + skirt | skirt:panties | 0 | 6 / 3 mm | – | |
| underwear | briefs:body | 1 (child, walk) | – | 3 / 29 mm | thigh skin over the leg opening when the hip bends |
| underwear | panties:body | 2 (female, run / idle>run) | – | 5 / 30 mm | the same at the leg line |
| all others with jeans / tee / coat | *:briefs, *:panties, *:bra | 0 pairs | | | fully covered underwear is not drawn, so not tested |

Sync path (`--worker 0`), coat outfits: 134 of 756 cases instead of 278. trenchcoat:jeans passes on 9/9
bodies, and trenchcoat:body fails on 3/9 with ≤ 5 vertices. **The coat problems are mostly the worker's
one-frame latency.** Fast legs (run) move 5–8 cm per frame, the drawn cloth is solved against the previous
frame's capsules / layers, and the lag compensation shifts it rigidly with its anchors, not away from the legs.
A real-time headless-Chrome run (worker, ~15 fps) shows the same: jeans shins through the coat and a coat hem
flap out through the shin. The pairs without a coat (socks, jeans:shoes, skirt:body, tshirt:skirt) are the same
in both paths.

**After the fixes (2026-10-01, full matrix, worker, 60 fps, default underwear): 35 of 1584 cases above
threshold (was 470).** Correction (review 2026-10-01): this section first said 34; the run had 35, and the
trenchcoat:skirt row below was not from that run. The tables are kept as written; the current numbers are in
"After review 2026-10-01" below. What changed:
- shoes / socks (`cc_clothing.py`): the socks take the shoe's skin weights near the shoe (`sock_weights`); the
  build pushes the sock inside the shoe (`keep_inside`: a sock vertex outside, or closer than `EPS_LAYER` under
  it, moves in; a shoe vertex that a sock face bulges past pushes that face in);
- jeans hem over the shoe (`cc_clothing.py` clearance): every connected part of a lower garment is its own
  collider (the sock no longer hides the shoe tongue), and `wrap`: a shoe vertex that comes out through the
  middle of a large jeans face moves that face out;
- skirt: lower part flared by up to ×1.15 (`flare`), waist band `limitSlackPinned` 0.006;
- coat: drawn-frame contacts, one-frame prediction, body and shoes as layers, the skirt as a layer in its drawn
  shape (see Frame flow / Lower layers).

| pair | failing cases before | after |
|---|---|---|
| shoes:socks | 94 | 0 |
| trenchcoat:jeans | 70 | 2 (child run 4 / 18 mm, old run 3 / 11 mm) |
| skirt:body | 66 | 0 |
| jeans:shoes | 61 | 0 |
| trenchcoat:body | 52 | 5 (child run, old run, short, female) |
| tshirt:skirt | 36 | 0 |
| trenchcoat:skirt | 34 | 1 as first written (tall idle>run, 7 / 25 mm; not from the recorded run, see the correction above); 0 after review 2026-10-01 |
| trenchcoat:shoes | 30 | 3 (old idle 8 / 21 mm, muscular run 8 / 7 mm, female idle>run 16 / 13 mm) |
| tshirt:body | 18 | 18 (unchanged: heavy / child / old, the tee sinks into the belly, ≥ 30 mm) |
| skirt:briefs | 6 | 2 (tall) |
| panties:body | 2 | 2 (unchanged) |
| briefs:body | 1 | 1 (unchanged) |

| outfit | failing cases before | after |
|---|---|---|
| tee + jeans + shoes | 72 | 9 |
| tee + jeans + coat + shoes | 126 | 3 |
| tee + skirt + shoes | 117 | 11 |
| tee + skirt + coat | 96 | 3 |
| jeans + coat | 56 | 5 |
| underwear | 3 | 3 |

**After review 2026-10-01** (full matrix, 8 outfits incl. coat / coat+shoes over the underwear only, worker,
60 fps, trenchcoat `layerThickness` 0.015, `under_outer`): **26 of 2224 cases above threshold.**

| pair | failing | bodies / clips | max |
|---|---|---|---|
| tshirt:body | 14 | child, old (tee+jeans+shoes and tee+skirt+shoes, all clips) | sink 3–4 / 22–30 mm (the skinned tee sinks into the belly; not addressed) |
| trenchcoat:body | 7 | child run / idle>run, female run, tall walk | poke 16 / 28 mm (child run, the foot through the hem), sink 3–4 / 30 mm (spine_02, thigh, lower arm) |
| trenchcoat:shoes | 2 | male run, old run (coat+shoes) | 8–10 / 8–9 mm (the shoe at the calf through the hem) |
| trenchcoat:socks | 1 | old run (coat+shoes) | 5 / 7 mm |
| trenchcoat:jeans | 1 | child run | 3 / 9 mm |
| briefs:body | 1 | child walk (underwear) | sink 3 / 27 mm (thigh over the leg opening) |

| outfit | cases | failing |
|---|---|---|
| tee + jeans + shoes | 360 | 7 |
| tee + jeans + coat + shoes | 576 | 1 |
| tee + skirt + shoes | 288 | 7 |
| tee + skirt + coat | 360 | 2 |
| jeans + coat | 224 | 1 |
| coat | 116 | 2 |
| coat + shoes | 260 | 5 |
| underwear | 40 | 1 |

No skirt:panties / skirt:briefs / *:bra case fails any more. Coat stretch p99 in the matrix (no threshold
there): max 1.666 (jeans+coat female), 1.656 (tee+skirt+coat female), all others ≤ 1.645; `cloth.test.mjs`
(shorter timeline, threshold 1.65): female 1.565, coat-over-layers female 1.587.

Screenshots (headless Chrome, bone-tracked close-ups of the shoes on 6 bodies in idle / walk / run, coat over
jeans in walk / run, skirt in run front / side / back on 8 bodies + female) show no sock patches through the
shoe and no legs through the skirt. Seen but not fixed: a small dark notch at the back of the jeans hem (old,
run), a small dark triangle in the skirt front (tall, run), and a pointed skirt hem in front (child, run).

## Not verified

- Mobile GPUs and CPUs, and browsers other than headless Chrome.
- Stability over hours (only 10 s timelines and short browser runs were tested).
- Lower layers:
  - Fingertips through the coat sides in idle were already there before (hands vs the limited arm capsules;
    arms are not part of the body layer).
  - The integrity harness tests vertices only; the static sock test covers triangle centres of the socks only.
- **Coat stretch, female.** Fixed in `cloth.test.mjs` (1.687 → 1.587) by the coat's `layerThickness` 0.015
  (16 → 11 failing coat cases in the matrix; 0.018 let the shoe toes through). The full 10 s matrix still has
  two female coat cases at p99 1.656 / 1.666 (no stretch threshold there). p99 stays chaotic here (mm-level input
  changes move it ±0.1).
- **Fingertips through the coat in walk** (review 2026-10-01, issue 9): still seen in a screenshot (the left
  hand's fingers behind the coat side, male, walk); the hands are limited capsules and not a cloth layer. Not fixed.
- **Cost of the drawn-frame contacts / prediction / body + shoe layers.** Measured on 2026-10-01 in headless
  Chrome on a heavily loaded machine. The old code measured 3.5 ms/frame there instead of its documented
  0.76, so only the ratio holds: worker main thread ×1.5 (coat over tee + jeans + shoes, run: 3.5 → 5.2 ms
  loaded), skirt + coat ×1.9, skirt alone ×2.6, sync ×1.18. Scaled to the earlier unloaded numbers, that is
  ~1.1 ms/frame on the worker main thread (target ~1 ms) and ~2.8 ms in sync (target 2.5 ms). This must be
  measured again on an idle machine.
- The integrity CONFIG bodies are gender 0 (between the sexes) apart from `male` / `female`, while the viewer
  default is male (+1).
- Stacks of more than 4 lower parts (`LAYER_PARTS`, the body included), and a cloth garment under another cloth garment.
- Hair vs coat collar.
