# Cloth-ready data (no solver)

The garments are skinned meshes that already follow sliders and animation without simulation. For the loose
parts (skirt, trench coat skirt) the build also writes the data a cloth solver needs. **This project ships no
solver.** The data is engine-agnostic: plain glTF attributes and extras, plus one JSON sidecar. The choice of
solver is covered in `docs/CLOTH_SOLVER_REPORT.md` and `experiments/cloth/`, which are separate work.

Producers: `blender/cc_clothing.py` (`cloth_weights_and_pin`, `cloth_extras`) and `tools/make_colliders.mjs`.
Checks: `tests/clothing.test.mjs` (pin mask, extras, colliders).

Units are metres, in the glTF Y-up bind pose of `output/base_body.glb`. The garment GLBs use the same frame
and the same 53 joints.

## 1. Pin mask: vertex attribute `_CLOTH_PIN`

- Per-vertex float in [0, 1]. **1 = the vertex follows the skinned mesh** (kinematic, skinning only).
  **0 = the vertex is free** (driven by the solver).
- The build writes a smoothstep in height between two anchors. The anchors are joint heads of the fitted
  rig plus an offset, so the gradient is smooth:

  | garment | pin = 1 above | pin = 0 below | free / pinned / total verts |
  |---|---|---|---|
  | skirt | pelvis + 3 cm | mid thigh | 109 / 143 / 395 |
  | trenchcoat | spine_01, the waist (shoulders, sleeves and collar are always 1) | hip joint − 14 cm (about the jacket hem) | 349 / 1690 / 2380 |

- **Deviation from a COLOR_0 mask.** Many engines read pin masks from vertex colours. The mask is stored as a
  custom attribute instead, because three.js multiplies COLOR_0 into the base colour when vertex colours are
  enabled, which would darken the cloth. If an engine needs COLOR_0, copy `_CLOTH_PIN` into one channel on
  import.
- three.js `GLTFLoader` lowercases custom attribute names, so the attribute arrives as
  `geometry.attributes._cloth_pin`.
- Skinning of the free part: the build replaces the fitted weights of free vertices with a pelvis/thigh blend,
  so that without a solver the skirt does not tear between the legs:

  ```
  w = pin * w_fitted + (1 - pin) * [ pelvis * (1 - legShare) + (thigh_l * s + thigh_r * (1 - s)) * legShare ]
  ```

  Here `s` is a smoothstep across the centre line (±`shareWidth`). legShare is 0.8 for the skirt; for the coat it is 0.7 at the back and 1.0 on the front panels (`legShareFront`), blended over ±5 cm in depth, so a lifted knee does not pierce the front panels.
  With a solver, the skinned position is the anchor that `maxDistance` refers to.

## 2. Mesh extras `ccCloth` (also in `output/clothing.json` → `items[].cloth`)

```json
{ "version": 1, "pinAttribute": "_CLOTH_PIN", "pinMeaning": "1 = follows the skinned mesh, 0 = free",
  "maxDistance": 0.25, "stiffness": { "stretch": 0.9, "bend": 0.15 }, "damping": 0.08,
  "gravityScale": 1.0, "wind": 0.6, "colliders": "body_colliders.json", "units": "metres, glTF Y-up" }
```

| field | meaning | skirt | coat |
|---|---|---|---|
| maxDistance | largest distance (m) a free vertex may move away from its skinned position. Scale it by (1 − pin) per vertex. | 0.04 | 0.25 |
| stiffness.stretch | edge-length constraint stiffness, 0..1 | 0.95 | 0.9 |
| stiffness.bend | bending (dihedral/skip-edge) stiffness, 0..1 | 0.3 | 0.15 |
| damping | velocity damping per step, 0..1 | 0.12 | 0.08 |
| gravityScale | multiplier on the engine gravity | 1 | 1 |
| wind | how much the garment reacts to global wind, 0..1 | 0.3 | 0.6 |

The values are starting points, not tuned against a solver. Rest lengths are the bind-pose edge lengths
after morphs: rebuild them when sliders change.

## 3. Body colliders: `output/body_colliders.json`

Written by `node tools/make_colliders.mjs [output-dir]`. There are 16 shapes: 15 capsules and a head sphere.

```json
{ "version": 1, "units": "...", "capsules": [
  { "name": "thigh_l", "bone": "thigh_l", "from": "thigh_l", "to": "calf_l", "sphere": false,
    "radius": 0.0615, "radiusMorphs": { "weight_max": 0.0056, "muscle_max": -0.0029, "corr_weight_max__muscle_max": 0.01, "...": 0 } },
  { "name": "head", "bone": "head", "from": "head", "to": "head", "sphere": true, "radius": 0.0751,
    "center": [0, 1.549, 0.0556], "radiusMorphs": { "height_tall": 0.0216, "...": 0 } } ] }
```

- **Ends.** A capsule runs from joint head `from` to joint head `to` of `base_body.joints.json`.
  - With sliders, the ends move like the skeleton: `head + Σ weight_m · morphs[m][bone]`, which is the same
    formula `applySkeleton` uses.
  - In a pose, the ends are the world positions of the `from` / `to` bones.
  - The head sphere is centred on `center`, the bounding-box centre of the head vertices; it follows the head bone.
- **Radius.** The radius is the 25th percentile of the distances from the capsule axis to the body vertices
  skinned mainly (> 0.5) to `bone`, measured on the middle 80 % of the segment. This keeps the capsule
  inside the skin, not around it.
  - Slider model: `radius + Σ weight_m · radiusMorphs[m]`.
  - Correctives use the product of their two macro weights, as the viewer does.
  - Face morphs are ignored.
- **Collision margin.** The garments were built with 3 mm clearance over the skin. A solver should use a
  collision margin of about 5–10 mm on top of the capsules.

Capsules are a coarse proxy (15 capsules + 1 sphere). The torso is three capsules, so breasts/belly at high
weight are underestimated. Use the skinned body mesh (SDF or triangle collision) for tight garments.

## 4. VRM / VRMC_springBone notes

VRM 1.0 `VRMC_springBone` simulates **bone chains**, not vertices. To bring the skirt/coat to VRM:

1. Add bone chains to the skirt/coat part: for example 6–8 chains around the hips, each 3–4 joints from the
   pin line (the `_CLOTH_PIN` = 1 boundary) down to the hem.
2. Skin the free vertices to those chains, using `1 − pin` as the chain share.
3. Map the parameters:
   - `stiffness` ≈ bend,
   - `dragForce` ≈ damping,
   - `gravityPower` = gravityScale,
   - `hitRadius` ≈ 0.02.
4. Map the colliders:
   - capsules become `VRMC_springBone` colliders with `shape.capsule {offset, radius, tail}`, placed in the
     `from` bone's local space;
   - the head becomes `shape.sphere`.
   - VRM colliders do not scale with morphs: bake them at the chosen slider values when exporting a
     character.
5. `maxDistance` has no VRM equivalent. Use chain length and stiffness instead.

Hair can use the same route (chains from the scalp). Hair has no pin data yet.

## 5. What is not done

- No solver runs in the viewer. The garments are pure skinning plus morphs.
- The values in section 2 are not validated in a simulation.
- Per-vertex stiffness maps are not written; only per-garment values are.
