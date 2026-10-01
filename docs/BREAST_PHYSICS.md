# Sex, breast shape and breast physics

## Sex (binary)

The body is male **or** female. There is no in-between slider any more.

- **Viewer:** a two-way switch (Mand / Kvinde, Male / Female). The default is **male**.
- **URL:** `?sex=female|male` (also `0|1`).
- **Hooks:** `__set('sex', 'male'|'female'|1|0)` (0 = female, 1 = male, as MakeHuman's gender macro; -1 is accepted too).
- **State:** `__values().sex`.

### Contract (`web/character.js`)

- Internally the slider value `gender` is `+1` (male, `SEXES.male`) or `-1` (female, `SEXES.female`).
- `gender` influences are `gender_male = 1`, or `gender_female = 1`.
- Both are exact MakeHuman macro samples, so every morph, corrective, garment fit, collider and joint offset is exact for both sexes.
- `sexOf(values)` returns `'male'|'female'`, and `genderOfSex(x)` parses the forms listed above.
- Scripts may still set `gender` directly. Values in between still work (tools use `gender: 0` as "neutral"), but the UI never produces them.
- `defaultValues()` gives the defaults the viewer starts with and that Reset returns to.

## Breast shape (female only)

Section **Bryster / Chest**. It is hidden for a male body.

| Slider id | Morphs (neg / pos) | Default |
|---|---|---|
| `breastSize` | `breast_cup_min` / `breast_cup_max` (MakeHuman `cupsize` macro 0 / 1) | 0.35 |
| `breastFirmness` | `breast_firm_min` / `breast_firm_max` (`firmness` 0 / 1) | 0.45 |
| `breastHeight` | `bdet_breast_height_decr` / `_incr` (`breast-trans-down` / `-up`) | 0 |
| `breastSpacing` | `bdet_breast_dist_decr` / `_incr` (`breast-dist-*`) | 0 |
| `breastProjection` | `bdet_breast_point_decr` / `_incr` (`breast-point-*`) | 0 |

### Macros and the gate

- The two macros are sampled like the body macros (linearised, `blender/build_base.py` `MACRO_MORPHS`).
- MPFB applies the MakeHuman breast targets to any body with a female component and does **not** scale them by gender.
  - MakeHuman's own default female (cup 0.5, firmness 0.5) gets **no** breast target at all. That is why the old female looked flat and conical.
- So the runtime gates every breast morph with `breastGate(values) = female weight x clamp(1 + age, 0, 1)`:
  - 0 for a male;
  - fading out towards the child end of the age slider;
  - 1 for an adult female.

### Correctives

Four corrective pairs (`corr_A__B`, the MakeHuman sample of A+B minus the linear sum) make these combinations exact at the extremes: size x firmness, size x age, size x muscle, firmness x age.

### Garments

- `blender/cc_clothing.py` `clearance` fixes every breast key on top of the body it shows on: female, and the largest cup unless the key is a cup key itself.
- It checks against the body and against the lower layers.
- `tools/cloth_check.mjs` `BREAST_SHAPES` checks 20 female breast extremes. These cover size x firmness / weight / muscle / age / proportions, the detail targets, and the physics morphs at full deflection.
- **T-shirt and coat:**
  - 0 skin penetrations;
  - coat vs T-shirt at most 4 vertices, the same as the plain female body (the armpit).
  - The exceptions are `+weight_max` (20) and `+weight_min` (12), which equal the pre-existing `corr_gender_female__weight_max/min` without breasts.

## Breast physics

Limited secondary motion, on by default for a female body.

- **Controls:** checkbox **Brystfysik / Breast physics**, `?breast=0` to turn it off, `__set('breastPhysics', bool)`.
- **State:** `__breast()` returns `{ enabled, sex, scale, weights, msPerFrame, morphs, ... }` plus the spring state (`x`, ...). `__breast.reset()` resets it.

### Morphs (the data contract)

Six generated, project-original morphs:

- `dyn_breast_up`, `dyn_breast_down`
- `dyn_breast_left`, `dyn_breast_right` (left = the character's left, +X)
- `dyn_breast_fwd`, `dyn_breast_back`

How they are built:

- Each translates the breast tissue by `amplitude` = **2 cm** along its axis at weight 1.
- Tissue weight W per basemesh vertex = `|delta(breast_cup_max)|` normalised (60 % of its maximum saturates), smoothstepped.
  - It covers 334 body vertices and 206 helper vertices.
  - W is 0 on the chest wall and the arms.
- Because W covers the helper geometry, every fitted mesh (body, T-shirt, coat, long hair) carries the same morphs and moves along. No bone is moved, and the joints sidecar has no offsets for them.

Weights are non-negative. Each axis uses one morph of its pair; the other stays 0.

### Glb mesh extras on `Body`

`base_body.glb` and `base_body_anim.glb` both carry `ccJiggle`, for other engines:

```json
{"version": 1, "doc": "docs/BREAST_PHYSICS.md", "driverBone": "spine_03", "amplitude": 0.02,
 "morphs": {"up": "dyn_breast_up", "down": "dyn_breast_down", "left": "dyn_breast_left", "right": "dyn_breast_right",
            "forward": "dyn_breast_fwd", "back": "dyn_breast_back"},
 "frequencyHz": 2.6, "dampingRatio": 0.4, "maxDisplacement": 0.012, "gain": 0.75,
 "maxWeight": 0.75, "upMaxWeight": 0.6, "backMaxWeight": 0.35,
 "supportStiffness": 2, "supportDamping": 0.5, "supportTravel": 0.5,
 "gate": "female weight x clamp(1 + age, 0, 1) (web/character.js breastGate)"}
```

The values equal `BREAST_PHYSICS` in `web/breastphysics.js` (`tests/breast.test.mjs` checks this).

### Model (`web/breastphysics.js`, pure JS)

A damped spring per axis, in the character's rest frame (glTF: +x left, +y up, +z forward):

```
x'' = -w^2 x - 2 zeta w x' + f,   w = 2 pi 2.6 Hz x sqrt(1 + 2 s), zeta = 0.4 + 0.5 s
f   = (g_local - g_rest) - a_local            clamped to +-60 m/s^2 per axis
|x| <= lim = 12 mm x (1 - 0.5 s) per axis      soft stop: past lim / 2 the stiffness grows (x 1 + 8 u^2), at lim the
                                               outward velocity is dropped
```

`s` = support of the worn garments (below), 0 when nothing holds the chest.

- **a_local:** the second difference of the `spine_03` world position, divided by the frame times.
  - It is rotated into the rest frame by the inverse of (current world rotation x rest world rotation^-1).
  - So a character that walks at constant speed gives 0.
- **g_local:** gravity in that frame. A leaning chest sags a little and settles there.
- **Integration:** semi-implicit Euler in steps of at most 1/120 s.
- **Resets instead of integrating:**
  - dt > 0.1 s;
  - the driver moves more than 0.25 m in one frame (teleport);
  - NaN input, or scale 0;
  - clip changes to or from "none";
  - Reset.
- **Output:** `weight = soft(gain x scale x x / amplitude)`, with `gain = 0.75`, soft = tanh limit at `maxWeight`
  0.75 (up: 0.6, back: 0.35). So no weight exceeds 0.75 = 15 mm of tissue motion, whatever the input.
- **Scale:** `breastMotionScale = gate x (0.25 + 0.9 x size01) x (1.2 - 0.7 x firm01) x (1 - support)`.
- **Support** (`web/main.js` `BREAST_SUPPORT`, by catalog id): bra 0.5, T-shirt 0.2, coat 0.3. Every WORN item
  counts (worn, not drawn: the bra under a T-shirt still holds), combined as `1 - prod(1 - s)` (`combineSupport`):
  bra + T-shirt 0.6, bra + T-shirt + coat 0.72. Support scales the motion down and makes the spring stiffer, more
  damped and shorter (above). `__breast().support` shows the value.
- **Garments loaded later** (outfit change, default underwear) start with the GLB's default morph weights (1 for every
  target); with physics off or on a male the six `dyn_*` weights are zeroed once per mesh part when it first shows up
  (review 2026-10-01: before, a later-loaded bra kept all six `dyn_* = 1`; they mostly cancel, but the bra
  still moved up to 7.7 mm off the body's breast shape).

### Viewer order per frame

1. animator
2. matrices
3. eyes and hair capsules
4. **breast physics** (`applyMorphWeights` on every part)
5. cloth

### Cloth runtime (`web/cloth/runtime.js`)

- `dyn_*` targets are kept out of a garment's rest shape.
  - Otherwise they would re-morph the whole garment and reset the solver's rest lengths every frame.
  - Instead they are added per frame to the skinned base over their few vertices only (`buildDyn` / `dynBase`).
- `web/cloth/layers.js` drops the targets that do not touch its picked lower-layer vertices, so their weights cause no re-morph.
- The colliders ignore `dyn_*` (`tools/make_colliders.mjs`).

### Measured

Measured in headless Chrome with swiftshader, `node film.mjs` in the session scratchpad, 2 s after a 1 s warm-up. Peak tissue motion = peak weight x 2 cm:

| Case | Peak tissue motion |
|---|---|
| Idle, default female | 0.2 mm |
| Walk, T-shirt | 5.8 mm |
| Run, T-shirt | 9.9 mm |
| Run, coat | 8.1 mm |
| Run, nude, size 1 / firmness -1 | 18.6 mm |
| Male | 0 |

Those rows are from before the travel limit and support (review 2026-10-01). Re-measured after it, run clip, size 1 /
firmness -0.5, 5 s, spring vertical travel (x) and peak weights (`jb.json` probe in the session scratchpad):

| Case | Support | Vertical travel x | Peak weight up / down / fwd | Peak tissue motion |
|---|---|---|---|---|
| Nude, no underwear | 0 | -12.0 .. +12.0 mm (at the limit) | 0.43 / 0.46 / 0.35 | 9.1 mm |
| Default underwear (bra) | 0.5 | -7.4 .. +8.0 mm (limit 9 mm) | 0.17 / 0.16 / 0.10 | 3.4 mm |
| T-shirt + jeans + coat over the bra | 0.72 | -6.0 .. +6.5 mm (limit 7.7 mm) | 0.08 / 0.07 / 0.05 | 1.6 mm |

Cost:

- the driver takes 0.01–0.05 ms per frame;
- cloth frame time with the coat running went from 2.67 to 2.78 ms, which is within noise.

Unit tests: `tests/breast.test.mjs`.
