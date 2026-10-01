# Clothing guide: how to make a new garment

This is the working guide for adding a garment to the character creator. It describes what the code does
**today** (`blender/cc_clothing.py`, `web/clothing*.js`, `web/cloth/`, the tools and tests). When this guide and
the code disagree, the code is right: fix the guide.

Reference documents:

- [CLOTH_SPEC.md](CLOTH_SPEC.md): the data contract (pin mask, `ccCloth`, colliders, underwear).
- [CLOTH_RUNTIME.md](CLOTH_RUNTIME.md): the viewer's solver, lower layers and the integrity harness.
- [BLENDER_WORKFLOW.md](BLENDER_WORKFLOW.md) "Clothing": the build steps in detail.
- [BREAST_PHYSICS.md](BREAST_PHYSICS.md): `dyn_breast_*` morphs and garment support.

The checker `node tools/check_garment.mjs <id>` tests most of the rules below automatically
(see [Checker](#the-checker-toolscheck_garmentmjs)).

---

## (a) Overview, routes and licences

Every garment is:

- one GLB, `output/clothing_<id>.glb`, with one skinned mesh `Cloth_<id>` on the same 53-bone rig and with the
  same 92 morph targets as `base_body.glb`;
- one entry in `output/clothing.json` (`items[]`).

Both are written by `blender/cc_clothing.py` (`Clothing.export_all`), which `blender/build_base.py` calls after the
hair. **Nothing in `output/` is edited by hand.** The viewer builds its clothing UI from the catalog, so a new
item needs no viewer code unless it covers the chest (`BREAST_SUPPORT`, section f) or adds a new slot.

### Which route?

```
Does a CC0 MakeHuman system asset (build/mh_assets/clothes/<pack>) contain the garment, or a part of it?
├─ yes ─> does it need geometry the asset does not have (longer, a collar, a hood, a belt)?
│         ├─ no  ─> ROUTE A: mhclo asset            (T-shirt, jeans, skirt, shoes)
│         └─ yes ─> ROUTE C: asset + generated extension (trench coat)
└─ no ──> does it lie on the skin (<= 3 mm, no folds: underwear, leggings, a bodysuit, tights)?
          ├─ yes ─> ROUTE B: generated from the body surface (briefs, panties, bra)
          └─ no  ─> not supported yet. It needs a new generator in cc_clothing.py, like coat_skirt
                    (rows x columns bound to body triangles with SynthFit). Do not import a mesh from
                    anywhere else.
```

| Route | Geometry | Binding to the 92 morphs | `license` in the catalog | Example |
|---|---|---|---|---|
| A: mhclo | the kept connected components of a MakeHuman suit (`keep` = their vertex counts) | MPFB mhclo fit, re-done by `MhcloFit` on every morph sample (`fit_keys`) | `CC0` | `tshirt`, `jeans`, `skirt`, `shoes` |
| B: generated | body faces inside a region field, clipped (`underwear_fields`, `clip_region`) and lifted 2–2.5 mm | `SurfaceFit` (a point on a body edge + offset along the re-computed body normal) | `project-original` | `briefs`, `panties`, `bra` |
| C: extension | route A plus generated rows/columns (`coat_skirt`, `coat_collar`) | the extension: `SynthFit` (nearest body triangle + scaled offset) | `CC0 source + project-original extension` | `trenchcoat` |

### Licence rules

- **Only CC0 third-party assets.** `build_base.py check_license(pack, file)` aborts the build unless
  - the pack index `packs/makehuman_system_assets.json` says `CC0`, and
  - the first 600 characters of **both** the `.mhclo` and the `.mhmat` contain `released as CC0`.
- The verified list goes to `asset_licenses.json` next to the .blend (`build/blend/`, not in git). The tracked copy
  `output/asset_licenses.json` has 2 rows per clothes pack (mhclo + mhmat, author `makehuman_system`).
- `LICENSE-NOTES.md` must list the item:
  - route A/C: the pack name in the asset table, plus what the project changed;
  - route B/C: the file `output/clothing_<id>.glb`, plus which code generated what.
- Catalog fields (written by `export_all`):
  - `license`;
  - `source`, which must contain `clothes/<pack>` for routes A/C;
  - `projectOriginal`, which is required for routes B/C, names the generator, and for route B matches `/add_generated/`.
- **Who checks what:**
  - the build checks CC0;
  - `tests/clothing.test.mjs` "licences" checks the catalog, LICENSE-NOTES and `build/blend/asset_licenses.json`
    when it exists;
  - `check_garment` does the same per item, falling back to `output/asset_licenses.json`.

---

## (b) End-to-end recipe

### 1. `blender/cc_clothing.py`

Add one `dict(...)` to `GARMENTS`. The keys `cc_clothing.py` reads today:

| key | routes | meaning |
|---|---|---|
| `id` | all | catalog id, file `clothing_<id>.glb`, mesh `Cloth_<id>`. Lower case, `[a-z0-9_]`. |
| `slot` | all | one of `SLOTS` (`underwear, bra, top, bottom, shoes, outerwear`). A new slot also needs `SLOTS` + `SLOT_LABELS` (da/en) and changes `tests/clothing.test.mjs` "catalog". |
| `layer` | all | integer fit and draw order, higher = outside. 0 = underwear only. Today: shoes 1, bottoms 2, top 3, outerwear 4 (section f). |
| `zone` | all | name of the body zone this item hides. Use a **new** name per garment: each zone gets the next bit (`1 << len(zone_bits)`), and re-using a name would overwrite the earlier bit. |
| `label` | all | `{"da": ..., "en": ...}`, the UI text. |
| `primary`, `secondary` | all | default tints `#rrggbb`. `secondary` only with a secondary region (below). |
| `roughness` | all | PBR roughness of the material. |
| `source_part` | all | text for the catalog `source`. |
| `pack`, `keep` | A, C | MakeHuman pack folder; vertex counts of the connected components to keep. The build asserts that each one exists and prints the available counts if not. |
| `closed` | A | closed footwear: keep the whole `delete_verts` list, `wrap` clearance. |
| `secondary_from` | A, C | `"small_components"` (shoes: the socks) or `"orange"` (T-shirt trim) marks the secondary-colour region. |
| `flare` | A | `{k, top, bottom}`: widen radially by up to ×k between two heights (skirt). |
| `coat`, `lining`, `hides_lower` | C | see the trench-coat example (i). |
| `cloth` | A, C | makes it a cloth garment (section e). |
| `gen`, `sex`, `offset`, `band` | B | generator kind (`trunks` / `bikini` / `bra`; a new kind needs code in `underwear_fields`), sex, lift over the skin (m), trim / waistband width (m). |

Next to `GARMENTS`:

- `OCCUPIES[id] = [slots]` for an item that fills several slots (a dress: `["top", "bottom"]`);
- `CONFLICTS[id] = [ids]` for items that cannot be worn together;
- `HIDES_EXTRA[id] = [zones]` for extra body zones it hides;
- `DEFAULT_UNDERWEAR` per sex.

Heights in `cloth`, `flare` and `coat` use `z_of`. The syntax is `<joint>[+-m]`, or `knee`, `hip`, `thigh_mid` or
`floor`, all measured on the neutral body (for example `"pelvis+0.03"` or `"spine_02-0.02"`).

### 2. The catalog entry (`output/clothing.json` `items[]`, written by `export_all`)

| field | from | rule (checked by) |
|---|---|---|
| `id`, `file`, `mesh` | `id` | `file == clothing_<id>.glb`; mesh and node name `Cloth_<id>` (`check_garment`) |
| `label {da, en}` | `label` | both present (test, checker) |
| `slot`, `occupies` | `slot`, `OCCUPIES` | slot in `slots`; `occupies` contains it |
| `conflicts` | `CONFLICTS` | existing ids only |
| `layer` | `layer` | integer; 0 for underwear slots, > 0 otherwise |
| `hidesBodyZones` | `zone` + `HIDES_EXTRA` | non-empty; every name in `bodyZones` |
| `colors {primary, secondary?}` | `primary`, `secondary` | `#rrggbb`; equal to the material's `tint.default` / `tint.secondaryDefault` |
| `bytes` | file size | equal to the file (test) |
| `vertices` | Blender vertex count | = unique positions; the GLB has more, because it splits at UV seams |
| `license`, `source`, `projectOriginal` | see (a) | |
| `sex`, `collidesAsLayer: false`, `coveredBy` | route B | the sex the item is for; never a cloth layer; vertices covered per outer garment |
| `hidesLowerVertices` | `hides_lower` | lower-garment vertices that this item's zone bit hides |
| `cloth` | `cloth` | identical to the GLB mesh extras `ccCloth` (section e) |

Top-level fields (`slots`, `slotLabels`, `bodyZones`, `defaultUnderwear`, `underwearSlots`, `rules`) also come from
`cc_clothing.py`.

### 3. UI strings

- The item name and the slot name come from the catalog (`label`, `slotLabels`), in **da** and **en**.
- Shared strings (`clothNone`, `clothPrimary`, `clothSecondary`, `clothLoading`, `clothError`) live in
  `web/main.js` `STRINGS.da` / `.en`; a garment does not touch them.
- An item with `sex` is hidden from the UI for the other sex.

### 4. Build, test, view

```powershell
# 1. build into a scratch folder (never straight into output/)
<blender> -b --python blender\build_base.py -- <scratch>\base_body.glb --blend <scratch>\base_body.blend
#    grep the log for "BUILD cloth <id>": vertices, faces, hidden body vertices, zone bit, pin counts
node tools\make_colliders.mjs <scratch>          # body_colliders.json next to it (cloth garments need it)
node tools\check_garment.mjs <scratch>\clothing_<id>.glb --bodies all
node tools\cloth_check.mjs <scratch>             # optional: penetration report of every garment
# 2. when it passes: build into output/, then
node tools\check_garment.mjs <id> --bodies all
node --test "tests/*.test.mjs"
node tools\cloth_integrity.mjs --outfits <new outfits>   # add outfits with the item to CONFIG.outfits (~1.5 min each)
```

- `<blender>` is the portable Blender of [BLENDER_WORKFLOW.md](BLENDER_WORKFLOW.md).
- **The body changes too:**
  - a new garment adds a zone bit to the body attribute `_CCZONE`, so `base_body.glb` must be rebuilt;
  - so must `base_body_anim.glb` (`blender/bake_clips.py`, see README "Tests and baking the animations");
  - check both with `python blender\tools\check_glb.py` and `node tools\check_anim_glb.mjs`.
- **Tests with per-garment tables:** `tests/clothing.test.mjs` keeps some tables keyed by garment id:
  - `MAX` holes in "body zones" fails for an id it does not know. Add the new id with its measured number (0 is the goal).
  - `UNDER`, the walk/run `LIM` and the size budget only cover the listed ids.
  - For a cloth garment, add runs to `tests/cloth.test.mjs`, and an outfit to `tests/integrity.test.mjs` `MATRIX`
    and `tools/cloth_integrity.mjs` `CONFIG.outfits`.
- **View it:** stage and serve (README "Run locally"), then open `?outfit=<id>,...`, or use
  `__set('wear', '<id>')` in the console.

---

## (c) Geometry guidelines

### Budgets (`check_garment` `CONFIG.budgets`, per slot)

| slot | GLB bytes | GLB vertices | triangles | texture side | today |
|---|---|---|---|---|---|
| underwear, bra | < 0.3 MB | ≤ 800 | ≤ 1 400 | ≤ 1024 px | briefs 0.23 MB / 538 v, panties 0.18 / 389, bra 0.29 / 510 |
| top, bottom, shoes | < 1.0 MB | ≤ 2 000 | ≤ 3 600 | ≤ 1024 px | tee 0.39 / 902, jeans 0.42 / 950, skirt 0.19 / 408, shoes 0.85 / 1 846 |
| outerwear | < 1.5 MB | ≤ 3 000 | ≤ 5 200 | ≤ 1024 px | trench coat 1.01 / 2 584 |

Notes on the numbers:

- The size is dominated by the 92 morph targets: about 120–350 bytes per vertex after `KHR_mesh_quantization`.
  Garments are exported with `export_morph_normal=False` to halve that. The cost is flat shading changes under
  morphs (accepted).
- The textures come next:
  - albedo JPEG ≤ 1024 px;
  - normal map 512 px;
  - `ccMask` 256 px;
  - route B: albedo and mask at ~1 mm per texel, mask as an 8-bit grey PNG.
- The viewer loads a garment when it is first worn. The default underwear loads right after the base.

### Clearance (mm over the skin)

**What the build does:**

- `PUSH` 1.5 mm outward;
- then, at neutral, at every macro extreme and every corrective corner (and on the female cup-max shape for breast
  keys), at least `EPS_BODY` 3 mm over the skin and `EPS_LAYER` 3 mm over every lower-layer garment;
- corrections are smoothed and written into the Basis and the deltas.

**Route B:**

- `offset` 2 mm (`briefs`, `panties`) or 2.5 mm (`bra`);
- the clearance floor is 0.6 × offset;
- `under_outer` keeps every underwear vertex at least 1 mm under any outer garment.

**The checker's rule:**

- a vertex counts as penetrating when it is more than 2 mm inside the visible skin or inside a drawn lower layer
  (`tools/cloth_check.mjs` `TOL`);
- at most 5 per body or shape, and 0 into lower layers, unless `CONFIG.clearance.garments` gives a documented limit.

**Measured gap to the skin at neutral** (`check_garment` "gap to skin", 5th percentile / median of the vertices
within 3 cm of the skin):

| garment | p05 | median | | garment | p05 | median |
|---|---|---|---|---|---|---|
| briefs | 1.0 | 2.0 | | jeans | 4.3 | 11.5 |
| panties | 0.4 | 2.0 | | skirt | 2.5 | 6.4 |
| bra | 2.1 | 2.5 | | shoes | 2.5 | 10.3 |
| tshirt | 5.9 | 12.2 | | trench coat | 10.6 | 21.6 |

### Thickness

- One surface, no modelled thickness.
- The viewer draws garments double-sided (`web/clothing.js upgradeCloth`). Back faces show the lining colour when
  `tint.lining` is set, so the inside of a coat needs no second shell.
- The coat's standing collar has a turned-in top edge: a real rim row, not a second shell.

### How tight or loose

- **Skinned (not simulated) garments must stay close to the body.**
  - `tests/clothing.test.mjs` "morph follow" needs more than 40 % of the sampled vertices within 3 cm of the skin.
  - The mean drift against the nearest skin vertex must stay below 30 % + 20 mm at every macro/corrective shape.
  - A part that hangs more than about 3–4 cm off the body, below the hips (a skirt, a coat tail), must be
    **cloth** (pinned top, free hem). Skinning alone makes it stretch between the legs: the skinned skirt's p99
    edge stretch is worse than the simulated one, which the sim check asserts.
- **Loose cuts need room for the poses.**
  - The flare of the skirt (×1.15) and the coat skirt (`clearance` 4.5 cm ramping in over the top 22 cm,
    `flare` 0.07) exist because a running knee came through the front of a pencil cut.
  - Check walk and run, not only the A pose.

### Openings, hems and body zones

- **The body zone is computed, not painted:**
  - start from the MakeHuman `delete_verts` (route A/C) or from the faces fully inside the region (route B);
  - a body vertex stays hidden only if a ray along the skin normal hits the garment within 20 cm and at least
    **3.5 cm away from the garment's open edges** (`covered`: reach 0.2, near 0.02, edge 0.035);
  - closed shoes keep the whole list.
- **So skin stays drawn for 3.5 cm inside every hem, cuff and neckline.** The garment must cover it there: the
  clearance pass guarantees that only at the sampled shapes, and the hem must not flap away in a pose.
- **Holes:** a hidden body triangle that no garment covers is a hole through the body (`cloth_check holes`).
  - Target: 0.
  - Accepted today: shoes 32 (foot soles facing the ground), T-shirt 2, jeans 2 (`check_garment CONFIG.holes`).
- **A lower garment that an outer one covers** (the T-shirt under the coat's pinned jacket):
  - carries the outer zone bit in its own `_CCZONE`;
  - those triangles are dropped while both are worn (`hide_lower`: reach 8 cm, ≥ 3 cm from the outer garment's
    open edges, only fully pinned outer faces, + one ring).
  - Never hide under a free (simulated) part: it moves away from what it covered.

### No thin double-sided shells

- Do not keep both sides of a garment as two coincident surfaces (inner + outer shell 1–2 mm apart).
  - They z-fight.
  - They double the morph data.
  - The clearance pass sees the inner shell as a "lower layer" of the outer one, and the integrity harness counts
    every vertex where the shells cross as a poke or a sink.
- Delete the inner shell (`keep` only the outer component), and use `lining` for the inside colour.
- A sock inside a shoe is fine: they are separate components.
  - The integrity harness splits them with `CONFIG.split.shoes`.
  - The build keeps them apart with `keep_inside`: the sock at least 3 mm inside the shoe.

### Normals, UVs and textures

- **Normals point away from the body** (`orient_outward` after every geometry step).
  - The integrity harness and the solver's layer test orient triangles by the exported normals; an inward normal
    turns pokes into sinks.
  - Smooth shading only: flat shading splits every corner (4× the GLB size, seen on the generated underwear).
- **One UV set (`TEXCOORD_0`) in [0, 1]:**
  - route A crops the used part of the MakeHuman atlas (`tex_cloth`);
  - route C maps generated parts to a rectangle of it filled with the median cloth colour and noise;
  - route B uses the body UVs.
- **Grey-normalised albedo** for the runtime tint: per region (primary / secondary) to a linear mean `k = 0.5`,
  giving material extras `tint {gain: 2, default, secondaryDefault, lining?}`.
  - The viewer renders `colour × gain × texture`.
  - `ccMask` (R = secondary weight) is required when the item has a secondary colour.
  - Never bake colour into the albedo.
- **Put UV seams where nobody looks:** under the arm, inside the leg, centre back, under a belt or collar.
  - Each seam splits vertices: the GLB count is above the Blender count, for example the T-shirt 902 vs 810.
  - The per-region normalisation and the JPEG blur bleed can show a faint line along a seam in the tint.

---

## (d) Skinning and morph rules

- **Morphs.** The GLB's `mesh.extras.targetNames` must equal the body's 92 names, **in the same order**: 16 macro,
  26 `face_*`, 2 `blink_*`, 4 `look_*`, 32 `corr_*`, 6 `bdet_breast_*`, 6 `dyn_breast_*`.
  - The viewer sets weights by index, in the same way on the body and on every part.
  - `fit_keys` produces exactly this list for every route; never add or drop a target.
  - Face, expression and look deltas must be zero (< 0.1 mm).
  - Breast detail and `dyn_breast_*` deltas are non-zero on anything over the chest: the T-shirt and coat carry up
    to 20 mm.
- **Bones.**
  - Use only the 53 joints of the `game_engine` rig, with the body's inverse bind matrices (same bind pose).
  - Garments add no bones. The rig is **rotation-only**: clips rotate bones and translate only the root, and the
    sliders move joint positions through the joints sidecar.
  - A garment that needs its own bones (a ponytail-like belt end, a hood string) is out of scope. Simulate it as
    cloth instead.
- **Weights come from the body:**
  - route A/C: MPFB's interpolated weights (`interpolate_weights=True`);
  - route B: the top-4 body weights of the bound edge, renormalised;
  - generated extensions: the nearest source vertex;
  - cloth garments blend their free part toward pelvis/thigh (section e).
  - At most 4 influences (`JOINTS_0` / `WEIGHTS_0` only), summing to 1 (±0.01).
- **Head and neck (from the coat collar):**
  - a collar takes the weights of the nearest jacket vertex **with the `head` bone dropped** (neck_01, spine and
    clavicles only), so a head turn does not tear it off the shoulders;
  - it is bound to body triangles **below the head** (SynthFit), kept 8 mm from the body, pinned (never
    simulated), and marked `_CCCOLLAR`.
  - Any new collar, hood or scarf follows the same rule; a hood that must turn with the head needs a separate
    design review.
- **Breast support.** A garment that hides `torso`, `coat` or `bra` skin needs an entry in `web/main.js`
  `BREAST_SUPPORT` (`{ tshirt: 0.2, trenchcoat: 0.3, bra: 0.5 }`, keyed by catalog id; 0..1). Otherwise the breast
  physics treats it as no support. The checker WARNs.

---

## (e) Cloth rules

A garment is simulated in the viewer when it has the `_CLOTH_PIN` attribute, an index buffer and `ccCloth` extras
(`web/cloth/runtime.js hasClothData`). All three come from the `cloth` dict in `GARMENTS`.

### Pin mask

- The pin mask is the custom vertex attribute **`_CLOTH_PIN`**, a float in [0, 1]: 1 = skinned, 0 = free.
- **It is not COLOR_0.** three.js multiplies COLOR_0 into the base colour (CLOTH_SPEC 1). An engine that wants a
  vertex-colour mask copies `_CLOTH_PIN` into one channel on import.
- three.js lowercases the name to `_cloth_pin`.
- The build writes `pin = smoothstep(z(pinBottom), z(pinTop), height)`; the coat forces jacket, sleeves, collar and
  belt to 1.
- Rules (test + checker):
  - the mean pin of the top 5 cm is above 0.99;
  - the mean of the bottom 5 cm is below 0.01;
  - more than 10 vertices lie in the 0.05–0.95 gradient.

| garment | pin = 1 above | pin = 0 below | free / pinned / GLB vertices |
|---|---|---|---|
| skirt | `pelvis+0.03` | `thigh_mid` | 109 / 152 / 408 |
| trench coat | `spine_02-0.02` | `hip-0.06` | 638 / 1 798 / 2 584 |

- **Weights of the free part** (no solver = no tearing):
  `w = pin·w_fitted + (1−pin)·[pelvis·(1−a) + (thigh_l·s + thigh_r·(1−s))·a]`
  - `a = legShare`, or `legShareFront` on the front panels;
  - `s` is a smoothstep across the centre line over ±`shareWidth`.
  - Skirt: 0.8 / 0.05. Coat: 0.5, front 0.8, 0.06.

### Parameters (`ccCloth`, also `items[].cloth`)

| key | default (`solver.js DEFAULTS`) | safe range (checker) | skirt | coat |
|---|---|---|---|---|
| `maxDistance` (m from the skinned target, × (1 − pin)) | 0.3 | 0.01–0.6 | 0.04 | 0.45 |
| `stiffness.stretch` | 0.95 | 0.8–1 | 0.95 | 0.95 |
| `stiffness.bend` | 0.35 | 0.1–0.8 | 0.3 | 0.35 |
| `bendVertical` | = bend | 0.1–0.9 | – | 0.7 |
| `damping` | 0.12 | 0.05–0.3 | 0.12 | 0.12 |
| `gravityScale` | 1 | 0.5–1.5 | 1 | 1 |
| `wind` (× the UI wind) | 0.3 | 0–1 | 0.3 | 0.6 |
| `friction` | 0.3 | 0–0.6 | – | 0.3 |
| `thickness` (m over capsules and floor) | 0.01 | 0.005–0.03 | – | 0.02 |
| `layerThickness` (m over lower layers) | 0.012 | 0.008–0.025 | – | 0.015 |
| `limit` (capsule groups `arms`, `hips`, `thighs`) | `arms,hips` | those names | `arms,hips,thighs` | `arms,hips` |
| `limitSlack` / `limitSlackPinned` | 0.02 / – | 0–0.05 / 0–0.02 | – / 0.006 | – |

- Missing or invalid values fall back to the defaults (`clothParams`).
- Compliance is `10^(-3-6s)`, so stretch 0.95 is nearly inextensible and 0.8 is visibly elastic.
- Start from the coat (long, free) or the skirt (short, mostly pinned) and change one value at a time.

### Particles and cost

- **The solver simulates the free particles plus their neighbours.** Welded at 1e-5 m, the coat has 860 simulated
  (823 free) and the skirt 317 (259 free).
- **Checker limit:** ≤ 1 200 simulated, ≥ 10 free.
- **Measured cost in node:** coat ≈ 1.7 ms per 60 Hz step and skirt ≈ 0.56 ms (the checker WARNs above 2.5 ms;
  timing depends on the machine).
- **Viewer budget** (CLOTH_RUNTIME): about 1 ms main-thread per frame with the worker, 2.5 ms on the sync path,
  for **all** worn cloth together.

### Shoes, floor and lower layers

- **Shoes are never cloth.** They are a closed skinned mesh. The floor is a collider at y = 0 for every free
  particle (`floorBelow` must stay 0).
- **Lower layers** (`web/cloth/layers.js`):
  - a cloth garment collides with the worn garments of a lower `layer` that collide as a layer, at most
    `LAYER_PARTS − 1` = 3, plus the body's drawn leg and hip skin;
  - it uses the vertices within `LAYER_SELECT` = 12 cm of a free particle, with `layerThickness`.
  - Underwear never collides (`collidesAsLayer` false); every other slot does.
  - A simulated lower garment (the skirt under the coat) is a layer in its **drawn** shape of the same frame.
- **Drawn-frame contacts** (`web/cloth/drawfix.js`, `DRAW_REACH` 8 cm, `DRAW_NEAR` 4 cm) fix what the one-frame
  worker latency would otherwise show. Nothing per garment is needed.

### Targets

**`check_garment` sim rows**, full 10 s timeline (walk, run, idle, idle→run) per body:

| metric | target (default = coat) | skirt (documented exception) |
|---|---|---|
| edge stretch p99, max over frames | ≤ 1.65 | ≤ 2.4 and below the skinned skirt's |
| stretch p99, mean | ≤ 1.3 | – |
| free particles > 2 mm inside the skin | ≤ 6, ≤ 25 mm, ≤ cloth off | ≤ 12 |
| particles below the floor | 0 | 0 |
| crossed mirror pairs (front/vent edges) | 0 | 0 |

**Integrity** (`tools/cloth_integrity.mjs`), as the viewer draws it:

- a pair of surfaces (outer:inner) fails when **more than 2 vertices AND more than 5 mm** poke out or sink in, in
  any clip;
- the checker reports only pairs that involve the garment.

---

## (f) Layering, underwear and sex

### Layer numbers

| layer | slots |
|---|---|
| 0 | `underwear`, `bra` |
| 1 | `shoes` |
| 2 | `bottom` |
| 3 | `top` |
| 4 | `outerwear` |

- Every garment is fitted over every lower-layer garment (3 mm), so the outer garment must really be outside.
  - A tucked-in shirt would need its own layer below the bottoms.
  - A dress is `slot top`, `occupies [top, bottom]`, layer 3 (`OCCUPIES`).
- Two items share a layer only if they can never be worn together (same slot, or `conflicts`); the checker WARNs
  otherwise.

### Outfit rules (`web/clothing_rules.js`)

- Putting an item on removes every worn item that occupies one of its slots, and the items in its `conflicts`
  (both ways).
- The body drops triangles whose 3 vertices carry a worn item's zone bit (`hiddenZoneMask`).
- A lower garment drops triangles carrying a worn higher item's bit (`coveringZoneMask`, rule `covered`). A mesh
  with nothing left is not drawn.

### Underwear

- Layer 0, slots `underwear` / `bra`.
- Worn by default: male `[briefs]`, female `[panties, bra]`.
  - `?outfit=none` or `[]` = naked.
  - `?underwear=0` turns the default off.
  - Switching sex swaps the default underwear (`swapUnderwearForSex`).
- Underwear is never a cloth layer and never a lower layer for another garment's clearance or `hide_lower`.
- Its `_CCZONE` holds the bits of every garment that covers it (`underwear_cover`, run in `finish_body` after all
  garments). So a **new outer garment automatically hides the underwear under it** at the next build.

### Sex

- `item.sex` (`male` / `female`) only exists on underwear today.
- Such an item is hidden in the UI for the other sex, and `check_garment` checks a female item on the female
  variant of every body (suffix `F`).
- Garments without `sex` must fit both: the clearance pass runs the breast keys on the female cup-max shape, and
  the checker runs all 9 bodies (8 slider bodies + male) and, with `--bodies all`, 20 female breast extremes.

---

## (g) Pitfalls already hit (and the fix that is in the code)

**Fitting and binding**

| problem | fix |
|---|---|
| MPFB's own fit snapshot (`from_mix`) is 3–4 cm off once our shape keys exist. | Own vectorised `MhcloFit` on every morph sample; MPFB's is only printed as "MPFB snapshot diff". |
| MPFB leaves a `Delete.*` vertex group and a MASK modifier on the basemesh after each asset. | Removed in `Clothing.add` right after `add_asset`. |
| A pin mask in COLOR_0 darkened the cloth in three.js. | Custom attribute `_CLOTH_PIN`. |

**Shoes and socks**

| problem | fix |
|---|---|
| The sock showed through the shoe sides on wide male bodies. | `keep_inside` (sock ≥ 3 mm inside the shoe, per shape) + `sock_weights` (the sock takes the shoe's weights near the shoe). |
| One nearest-surface query per lower garment let the sock hide the shoe tongue from the jeans hem. | Every connected part of a lower garment is its own clearance collider. |

**Skirt and coat**

| problem | fix |
|---|---|
| A running knee came out through the pencil skirt. | `flare` ×1.15 below the hips; the integrity harness tests the skirt in its simulated shape. |
| The coat's vent and front edges crossed by up to 39 mm on child/female shapes. | Generated deltas mirror-symmetrised; the x delta fades to 0 within 3 cm of the centre line. |
| Coat `maxDistance` 0.6 over-swung in run (female front panel p99 1.687). | 0.45 (max p99 1.544 over 8 bodies). |
| Coat over socks, shoes, jeans or skirt: 16 failing integrity pair cases. | `layerThickness` 0.015 → 11 (0.018 gave new toe pokes). |
| Blue T-shirt specks at the coat shoulders (linear blend skinning differs between the two meshes). | `hide_lower`: tee triangles under the fully pinned jacket are dropped while the coat is worn. |
| A skirt waist band on the hip capsules pushed out past the T-shirt hem. | `limitSlackPinned` 0.006. |

**Generated underwear**

| problem | fix |
|---|---|
| Flat shading split every vertex (4× the GLB). | Smooth shading. |
| 0.72 mm/texel broke the 0.3 MB bra budget; a JPEG mask rang around the trim. | `min_mpt` 1 mm; grey PNG mask. |
| Clipping whole quads made square skin dots (the body ridge came through). | `clip_region` per body triangle with the exported diagonal. |
| Dropping an underwear triangle over skin hidden only by the underwear's own zone made a hole through the body under the T-shirt hem. | `underwear_cover` rule (a): only where the covering garment hides that skin too or lies within 6 mm. |
| Panties came through the skirt. | `under_outer`: ≥ 1 mm under every outer garment at every shape. |
| A bra loaded later kept all `dyn_* = 1`. | Garments loaded later get `dyn_*` zeroed (web/main.js). |

**Measurement and catalog**

| problem | fix |
|---|---|
| `cloth_check` flagged points 2 mm outside the skin at concave creases. | The nearest-ring triangle test in `countInside`. |
| The catalog's `vertices` is not the GLB vertex count. | It is Blender's count (unique positions); the checker compares it that way. |

**Still open**

| problem | status |
|---|---|
| Long hair / a braid lying on the upper back goes into a hood or a tall collar (static hair). | Partly fixed in the viewer (see "Hair over a hood or collar" below); a strand that starts right at the nape can still meet the top of the hood roll. |
| `tests/cloth.test.mjs` "long coat over T-shirt + jeans, female" is chaotic: moving the T-shirt's vertices by ±1e-7 m (float noise of a rebuild) flips it. 5 of 8 such perturbations pass, on the old output and on the 2026-10-01 rebuild alike. Seen when it fails: the tee at the front hip through the coat in run, 1–4 vertices, 8–33 mm. | Open. Do not "fix" it by choosing a lucky build. The coat's run near the hip needs a robust margin. |

(The coat lapel sliver that was listed here no longer occurs since the 2026-10-01 hoodie / shirt / shorts build;
its exception was removed from `CONFIG.knownExceptions`.)

**Hoodie, long-sleeve shirt, shorts (2026-10-01)**

| problem | fix |
|---|---|
| Holes: hidden skin showed through between garment triangles (shorts 4, shirt 1, hoodie 4) although every quad was covered. | `covered(..., tris=True)` tests the exported loop triangles, not the quads (`zone_tris=True` on the spec). |
| A new top in the coat's skirt envelope widened the coat skirt (run: 23.7 → 26.6 mm into the legs, `tests/clothing.test.mjs` limit 25). | `coat_envelope=False` on the shirt: it is not part of `coat_skirt`'s envelope; the clearance pass still fits the coat over it. |
| The simulated skirt came out through the shirt / hoodie hem (shirt+skirt 21 of 220 integrity cases). | `hides_lower=True` on both tops plus `sim_layer_gap` 0.018 m: over a lower garment with cloth data the clearance pass keeps `EPS_LAYER + sim_layer_gap` instead of 3 mm (0.012 still left 4 of 100). |
| Fitting the coat's standing collar over the shirt collar pushed single vertices of its top edge out by up to 19 mm, into short hair (`tests/collar.test.mjs`: short04 426 crossing edges). | `coat_collar`: a lower garment with its own collar (`tex.collar_islands`) is no clearance collider for the back of the collar (`own_collar_deg` 75° from the back centre). `hide_lower` hides that part of the shirt collar instead: `edge_collar` 8 mm instead of 30 mm, only there. At 100° the hidden shirt triangles showed as small holes at the sides. |
| The loose shirt / hoodie waist sits > 2 cm off the skin, so `covered` left a ring of skin drawn under it. That skin came through in run (female hip: 3 vertices / 25 mm). | `zone_near=0.045` on the spec (`covered`'s `near`, default 0.02). |
| The flared shorts hem widened the coat skirt envelope by 2.6 mm. | `coat_envelope=False` on the shorts too. |
| Two layer-4 items (hoodie, coat) were reported as a layering ambiguity. | The checker's "layer unique" row ignores pairs in `conflicts` (they are never worn together). |
| Screenshots at 520 px width used the mobile layout, the panel covered the character. | Use a viewport ≥ 1000 px wide. |

**Hair over a hood or collar.** Hair is static in its rest pose; `web/materials.js createHairCollider` pushes
strands out of 3 capsules (shoulders, upper back). `calibrate(garments)` now grows the upper-back capsule to the
worn garments' back (+ 6 mm, `HAIR_CLEAR`) and then also moves strands from the root, so long hair, the braid and
the ponytail lie on the hood, the coat collar and the shirt collar. Short styles are unchanged (they have no
strands that far out).

---

## (h) Definition of done

- [ ] Route chosen (a); `LICENSE-NOTES.md` row added; catalog `license` / `source` / `projectOriginal` correct.
- [ ] `GARMENTS` entry (+ `OCCUPIES` / `CONFLICTS` / `HIDES_EXTRA` if needed); built into a scratch folder first.
- [ ] `node tools/check_garment.mjs <id> --bodies all` ends with `=> OK`, with no new KNOWN entry (an exception
      needs a reason and is a TODO, never a hidden regression). On a scratch build the licence row FAILs until
      the documented build has written `build/blend/asset_licenses.json` (copy it to `output/asset_licenses.json`).
- [ ] Any skinned garment that is worn over a garment with cloth data (a top over the skirt): an outfit in
      `CONFIG.outfits` + the integrity numbers (the skinned checks do not see the simulated skirt).
- [ ] `node --test "tests/*.test.mjs"` green, after adding the id to the per-garment tables (b.4). The new
      `tests/check_garment.test.mjs` row runs automatically.
- [ ] Cloth garment: runs in `tests/cloth.test.mjs`, an outfit in `tools/cloth_integrity.mjs CONFIG.outfits` and
      `tests/integrity.test.mjs MATRIX`; the full integrity matrix shows no new failing pair.
- [ ] Chest garment: `BREAST_SUPPORT` entry.
- [ ] `base_body.glb` and `base_body_anim.glb` rebuilt (new zone bit); `check_glb.py` and `check_anim_glb.mjs` CHECK OK.
- [ ] README sizes line and STATUS updated with the measured numbers.
- [ ] Screenshots, made with the local viewer:
  - URL: `?shot&outfit=<ids>&view=<v>&sex=<s>&anim=<clip>&animT=<t>`;
  - with cloth, call `__cloth.advance(1)` before the capture;
  - store them in `build/shots/clothing/`, which is git-ignored;
  - use a viewport at least 1000 px wide (narrower windows get the mobile layout and the panel covers the
    character).

  1. front / side / back, male and female, alone and with the default underwear;
  2. the 6 slider extremes (tall, short, heavy, child, old, muscular), plus female cup max (`breastSize` 1);
  3. walk and run, front and side, at `animT` 0.1 / 0.3 / 0.5 / 0.7 / 0.9;
  4. close-ups (`view=` face34, shoulderBack, …): neckline / collar, armpit, waist / hem, cuffs, and the hem over
     the shoes;
  5. layered with every garment it can be worn with (under and over), including partly drawn underwear;
  6. tint: primary and secondary at white and near-black (`__set('clothColor', {id, primary, secondary})`).

---

## (i) Worked examples

### Trench coat (route C: CC0 jacket + generated skirt, belt, collar and lapels; cloth)

```python
dict(id="trenchcoat", slot="outerwear", layer=4, pack="male_casualsuit05", keep=[1659], zone="coat",
     label={"da": "Trenchcoat", "en": "Trench coat"}, primary="#2b2b30", secondary="#1f1b1a",
     roughness=0.78, lining=1.0, hides_lower=True, source_part="jacket of male_casualsuit05, cut at the waist; ...",
     coat=dict(cut="spine_02", hem="floor+0.08", row=0.045, columns=36, clearance=0.045, clearance_ramp=0.22,
               flare=0.07, open_deg=7.0, vent="knee+0.04", belt=0.055, uv=(0.01, 0.58, 0.01, 0.385), ...,
               collar=dict(height_back=0.072, height_front=0.045, lapel_width=0.075, body_gap=0.008, ...)),
     cloth=dict(pinTop="spine_02-0.02", pinBottom="hip-0.06", legShare=0.5, legShareFront=0.8, shareWidth=0.06,
                maxDistance=0.45, stretch=0.95, bend=0.35, bendVertical=0.7, damping=0.12, gravityScale=1.0,
                wind=0.6, friction=0.3, thickness=0.02, layerThickness=0.015, limit="arms,hips"))
```

1. **Source.** `keep=[1659]` keeps only the jacket of `male_casualsuit05` (not its trousers, shirt or CC0 collar).
   `coat_drop_pockets` removes the four chest pocket pieces and fills the holes.
2. **Extension.** `coat_skirt`:
   - cut at `spine_02`;
   - a generated skirt down to 8 cm above the floor, 23 rows × 37 columns with the belt, 971 vertices: A-line,
     flare 0.07, front opening 7°, back vent from knee + 4 cm, clearance 4.5 cm ramping in over the top 22 cm;
   - a 3-row belt over the cut.

   The new vertices are bound to body triangles (SynthFit), so they get all 92 morphs. The deltas are mirror-
   symmetrised.
3. **Collar.** `coat_collar` adds the standing collar and peaked lapels (285 vertices) after the clearance pass:
   pinned, head weight dropped, 8 mm from the body, `_CCCOLLAR`.
4. **Layering.** `hide_lower` writes the coat bit into the T-shirt's `_CCZONE` (catalog `hidesLowerVertices`
   `{tshirt: 470}`). `lining` 1 tints the back faces with the secondary colour.
5. **Cloth.** It is pinned down to just under the belt; only the generated skirt is free (638 of 2 584 vertices;
   860 simulated particles). The parameters were tuned against the integrity matrix (section g).
6. **Licence.** `CC0 source + project-original extension`; `projectOriginal` lists both generators;
   LICENSE-NOTES has the row.
7. **Result.** See the appendix. All checks pass on 9 bodies. (Until the 2026-10-01 hoodie / shirt / shorts
   build there were two KNOWN rows, a lapel sliver triangle and `trenchcoat:jeans` on the child body in run; both
   pass now.)

### Briefs (route B: generated from the body surface)

```python
dict(id="briefs", slot="underwear", layer=0, gen="trunks", sex="male", zone="underwear_m",
     label={"da": "Underbukser", "en": "Briefs"}, primary="#2b2b30", secondary="#c9c9cc", roughness=0.85,
     offset=0.002, band=0.032, source_part="short-leg briefs generated from the body surface by ...")
```

1. **Region.** `underwear_fields` builds a smooth field on the body vertices: a waist line under `spine_01` and a
   leg line from the crotch. `trunks` also gives `tb`, the distance below the top edge, for a 3.2 cm waistband.
2. **Geometry.** `clip_region` cuts the body triangles along the zero line (crossings within 20 % of an edge snap
   to the vertex) and copies the faces inside, with interpolated body UVs and smooth shading. The result is 538
   GLB vertices (513 in Blender) and 892 triangles.
3. **Binding.** `SurfaceFit` puts each vertex on a body edge point + 2 mm along the re-computed body normal at
   every shape. `fit_keys` bakes all 92 morphs, including breast detail and `dyn_*` where they apply. Weights: the
   top-4 body weights, renormalised.
4. **Clearance and zone.** Clearance is against the body only (floor 0.6 × offset). The zone `underwear_m` holds
   the body vertices whose faces are all inside.
5. **Texture.** `tex_generated` makes a procedural knit, plus the waistband in the secondary colour, per texel at
   about 1 mm (albedo JPEG + mask PNG, 0.23 MB in total).
6. **After all garments.** `under_outer` (≥ 1 mm under the jeans, skirt and coat), then `underwear_cover` writes
   `coveredBy {jeans: 488, skirt: 399, tshirt: 13, trenchcoat: 3}`.
7. **Catalog.** `sex: male`, `collidesAsLayer: false`, `license: project-original`; LICENSE-NOTES lists
   `output/clothing_briefs.glb`.

---

## The checker (`tools/check_garment.mjs`)

```
node tools/check_garment.mjs <garment-id|path.glb> [more ...] [--bodies quick|all] [--json] [--no-sim] [--dir output]
```

- **Target.**
  - An id is looked up in `output/clothing.json`, or in `--dir`.
  - A `.glb` whose folder holds a `clothing.json` that lists it (a scratch build) is checked as that item, against
    that folder's base body.
  - Any other `.glb` gets the GLB-level checks only; the catalog and sim rows are SKIP.
- **Rows:**
  1. GLB loads;
  2. one mesh / primitive and its attributes;
  3. the 92 morph names in order, and zero face/look deltas;
  4. `dyn_*` on chest garments;
  5. joints ⊂ the 53-bone rig, the bind pose equal to the body's, ≤ 4 influences, weights summing to 1;
  6. no NaN, no degenerate triangles, unit normals, UVs in [0, 1];
  7. budgets (bytes, vertices, triangles, texture size);
  8. tint extras;
  9. the catalog entry (fields, slot/layer, labels da+en, colours, zones, conflicts, bytes, vertices);
  10. licence;
  11. `BREAST_SUPPORT`;
  12. `_CCZONE`, holes;
  13. cloth data (pin mask, extras, safe ranges, particles);
  14. clearance (skin + lower layers) on 9 bodies, plus every morph extreme with `--bodies all`;
  15. cloth garments: the solver numbers and integrity per body.
- **Bodies:**
  - `quick` (default) runs the sim and integrity on neutral + female, with a shortened integrity timeline
    (about 7 s for the skirt, 13 s for the coat);
  - `all` runs them on all 9 bodies with the full timelines (about 1.5 min for the skirt, 4 min for the coat).
- **Statuses:**
  - OK, INFO and SKIP;
  - WARN (non-blocking: UV range, a shared layer, `BREAST_SUPPORT`, solver ms);
  - FAIL (exit code 1);
  - KNOWN: a failure matched by `CONFIG.knownExceptions`. Each entry has a reason. If the defect is fixed, the
    entry itself becomes a FAIL ("remove the exception").
- **Limits that differ per garment** (`CONFIG.clearance.garments`, `CONFIG.holes`, `CONFIG.sim.garments`) are
  listed with their reason and printed next to the row.
- **What it does not cover:**
  - integrity of skinned garments: the T-shirt sinking into the belly on old/child is only measured by
    `cloth_integrity` and is in `tests/integrity.test.mjs KNOWN_FAILING`;
  - walk/run penetration of skinned garments (`tests/clothing.test.mjs`);
  - anything visual (screenshots).
- **Test.** `tests/check_garment.test.mjs` runs `--bodies quick` on every catalog item. It also tests a broken id
  and a lone GLB.

---

## Appendix: checker results for the 8 garments (2026-10-01)

Command: `node tools/check_garment.mjs briefs panties bra tshirt jeans skirt shoes trenchcoat --bodies all`
(exit 0; about 6 min, most of it the coat and skirt sims). Bodies: 9 for unisex items, 8 for the briefs (no
female), 7 female variants for panties and bra (suffix `F`). Clearance numbers are counts of vertices more than
2 mm inside the skin or a lower layer; sim numbers are the worst body.

| garment | result | ok / fail / known / skip | bytes | GLB verts / tris | skin: bodies / extremes (max verts) | lower layers: bodies / extremes | hidden tris uncovered | cloth sim: max p99, max pen verts | integrity |
|---|---|---|---|---|---|---|---|---|---|
| briefs | OK | 32 / 0 / 0 / 1 | 227 604 | 538 / 892 | 0 / 2 | – | 0 of 535 | – | – |
| panties | OK | 32 / 0 / 0 / 1 | 184 344 | 389 / 588 | 0 / 1 | – | 0 of 196 | – | – |
| bra | OK | 34 / 0 / 0 / 1 | 294 332 | 510 / 860 | 2 / 23 | – | 0 of 528 | – | – |
| tshirt | OK | 36 / 0 / 0 / 1 | 388 104 | 902 / 1528 | 0 / 0 | 0 / 0 | 2 of 2763 | – | – |
| jeans | OK | 31 / 0 / 0 / 1 | 420 056 | 950 / 1712 | 1 / 2 | 0 / 0 | 2 of 2195 | – | – |
| skirt | OK | 61 / 0 / 0 / 0 | 194 980 | 408 / 728 | 0 / 0 | – | 0 of 904 | 1.721 (child), 7 | 9 of 9 OK |
| shoes | OK | 30 / 0 / 0 / 1 | 847 684 | 1846 / 3320 | 0 / 0 | – | 32 of 4528 | – | – |
| trenchcoat | OK | 64 / 0 / 2 / 0 | 1 006 216 | 2584 / 4480 | 0 / 0 | 2 / 4 | 0 of 3019 | 1.587 (female), 4 | 8 of 9 OK, child KNOWN |

The SKIP row is "sim / integrity: not a cloth garment". No WARN rows.

**Deviations in the shipped garments** (all within the configured limits or listed as exceptions, with a reason, in
`CONFIG` in `tools/check_garment.mjs`):

- **trenchcoat, geometry (KNOWN):** 1 degenerate triangle, a collinear sliver (5e-11 m², 1.5 cm long) on the
  front edge of the left lapel from `coat_collar` in `blender/cc_clothing.py`. It is pinned and not visible.
  Fix it in the generator.
- **trenchcoat, integrity (KNOWN):** tee + jeans + shoes + coat, child body, run: `trenchcoat:jeans` pokes
  3 vertices / 8.7 mm (a shin through the coat panel). This is the same single case the full matrix reports in
  CLOTH_RUNTIME.md.
  - The coat's other known matrix failures are not in the outfit this checker runs: `trenchcoat:body` (child /
    female / tall), `trenchcoat:shoes` and `trenchcoat:socks` (coat + shoes, old / male run).
  - The `trenchcoat:socks` / old case in `tests/integrity.test.mjs` `KNOWN_FAILING` passed in this outfit, so
    it is not an exception here.
- **skirt, stretch:** child p99 1.721 is above the coat target (1.65) but inside the skirt's own limit (2.4)
  and below the skinned skirt.
- **Holes (allowed per garment):**
  - shoes 32 of 4528 hidden triangles uncovered (limit 40, at the ankle collar);
  - tshirt 2 (limit 4);
  - jeans 2 (limit 4).
- **Clearance exceptions (allowed per garment):**
  - bra: up to 23 vertices on the breast fold extremes (limits 35 / 22 per shape);
  - jeans over the shoes: layer limit 5;
  - coat over tee + jeans: 2 on the bodies and 4 on the extremes (limit 35, the open front edges).
- **Not covered by this checker:** the skinned tee sinks into the belly on old / child (`tshirt:body`, 14
  cases in the full matrix, `KNOWN_FAILING` tee + jeans + shoes / old). The checker only runs integrity for
  cloth garments.

## Appendix: hoodie, long-sleeve shirt, shorts (2026-10-01)

Command: `node tools/check_garment.mjs shorts shirt hoodie trenchcoat --bodies all` (exit 0 after removing the two
coat exceptions that pass now). All three are skinned (no cloth data): the shirt and hoodie hems are short, the hood
is pinned to the shoulders.

| garment | route / source | result | ok / fail / known / skip | bytes | GLB verts / tris | skin: bodies / extremes (max verts) | lower layers: bodies / extremes | hidden tris uncovered |
|---|---|---|---|---|---|---|---|---|
| shorts | A: jeans of `male_casualsuit04`, legs cut above the knee (`cut_legs`, `flare_legs`) | OK | 31 / 0 / 0 / 1 | 242 008 | 503 / 862 | 1 (female) / 1 | – | 0 of 1180 |
| shirt | A: shirt of `male_casualsuit03` (`drop_inner_cuffs`), procedural texture (collar, placket, buttons, cuffs) | OK | 36 / 0 / 0 / 1 | 605 956 | 1603 / 2688 | 2 (short) / 2 | 0 / 0 | 0 of 4328 |
| hoodie | C: sweater of `male_casualsuit02` loosened 6 mm + generated hood lying down (`hood_down`, 429 verts) | OK | 34 / 0 / 0 / 1 | 684 848 | 1793 / 3176 | 0 / 0 | 0 / 0 | 0 of 4427 |
| trenchcoat (rebuilt) | – | OK | 66 / 0 / 0 / 0 | 1 006 564 | 2584 / 4480 | 0 / 0 | 3 / 3 | 0 of 3021 |

- Layers: shorts 2 (slot bottom, replaces the jeans / skirt), shirt 3 (replaces the T-shirt), hoodie 4
  (`CONFLICTS hoodie: [trenchcoat]`). Zone bits: shorts 256, shirt 512, hoodie 1024.
- Spec flags used: `zone_tris` (all three), `coat_envelope=False` (shirt, shorts), `hides_lower` + `sim_layer_gap`
  0.018 + `zone_near` 0.045 (shirt, hoodie); coat collar `own_collar_deg` 75.
- Integrity (full matrix, 9 bodies, idle / walk / run / idle>run): hoodie+jeans+shoes 0 of 292, shirt+shorts+shoes
  0 of 224, shirt+skirt 0 of 184, hoodie+skirt 0 of 180, shirt+jeans+coat 0 of 264; whole matrix 21 of 3368 (the
  8 old outfits 26 -> 21).
- `BREAST_SUPPORT`: shirt 0.25, hoodie 0.3; `dyn_breast` carried 20.5 / 20.1 mm.
- Walk / run (`tests/clothing.test.mjs` limits): see STATUS.md for the measured numbers and the integrity matrix.

