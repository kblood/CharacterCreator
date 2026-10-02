# Avoiding clipping (cloth through cloth, body through cloth)

What was learned while building the garments, the hoodie / shirt / shorts and dress / jacket / boots batches
(2026-10-01). It is practical, not complete: some root causes are still open (section 4). The build is in
`blender/cc_clothing.py`, the runtime cloth in `web/cloth/`, the checks in `tools/`. Recipe and pitfalls table:
[CLOTHING_GUIDE.md](CLOTHING_GUIDE.md).

## 1. Symptom -> likely cause -> what to try

| symptom | likely cause | what to try |
|---|---|---|
| Lower garment (T-shirt, skirt) shows through an outer garment in walk / run | Outer fitted too close; skinning differs between the two meshes | `clearance()` fits each garment over every earlier one (`lower`); raise `EPS_LAYER` gap for that pair via `sim_layer_gap` (over a simulated skirt) or `hide_lower` (drop tee triangles under a fully pinned outer). |
| A garment ignores another one completely (dress skirt 22-30 mm through the coat) | `GARMENTS` order: a garment built earlier never sees a later one (clearance uses `self.done`) | Declare `CONFLICTS` unless the order can change (zone bits are the `GARMENTS` index, so it usually cannot). |
| Skin "sinks" through a loose waist / hem when the hands hang at the hips | Skin under a loose garment stays drawn (garment > 2 cm off the skin) | `zone_near` (0.045 shirt / hoodie, 0.05 dress, 0.07 jacket). |
| Thigh through the pinned top of a cloth skirt in jump | Pinned vertices get no thigh share; the skin there is the zone boundary | `zone_near_pinned=(0.2, 0.10)`. `legShareFront` 1.0 alone was not enough and cost stretch. |
| Red shards / bodice through a belt | Belt placed by rays at its 36 columns only | `belt_clamp` (closed `coat_skirt`), never above the belt's top edge (pulls the bodice under the skin). |
| T-shirt armpit through the jacket side in jump | Ray along the normal misses the outer garment in the armpit | `hide_grow=2`. |
| Hidden skin visible between garment triangles ("holes") | Zone computed on quads, GLB draws triangles | `zone_tris=True`. |
| A tiny island of skin stays drawn inside a shoe / boot (20-30 mm "through the boot") | Not in MakeHuman's delete list | `zone_fill=True` (islands of <= 8 vertices enclosed by the zone join it). |
| Toe 2-3 mm through the middle of a large toe-cap face | Every boot vertex clears the skin, the face does not | `wrap_body=True` (skin points wrapped like a closed lower layer), reach `WRAP_BODY_REACH` 0.01 m. |
| A spike of one boot toe through the floor at one body corner only | `wrap_body` with the full `FIX_RANGE` reach: toe sides against the squashed sole met far sole faces, repeated wrap rounds added up to 75 mm | Short wrap reach (above). Check: per-target max delta should be left/right symmetric. |
| Sock / boot shaft triangle outside the shoe while all its vertices are inside | Exporter triangulated an n-gon differently from the fit's fan (a sliver folded over) | `dissolve_flat` triangulates the inner part's (`cc_sec`) n-gons itself. Not the outer boot: that changed the jeans fit. |
| Shoe through the jeans hem | One collider per lower garment let the sock hide the tongue | Every connected part is its own clearance collider; `wrap()` for closed lower garments. |
| Hole under the jaw showing the mouth interior (red) | Zone ray from the jaw underside met the collar within `reach` -> skin above the garment hidden | Zone limited to the garment's highest vertex + 5 mm (open garments). |
| Long hair / braid into a hood or tall collar | Hair is static | `web/materials.js` `createHairCollider` + `calibrate(garments)`; a strand starting at the nape can still touch. |
| Step / bump at the hip sides of a cloth skirt (dress), cloth on only | UNVERIFIED, see section 4 | - |

## 2. Design-time rules for a new garment

**Layer order and conflicts**
- Layers: 1 shoes / boots, 2 bottoms, 3 tops (and the dress), 4 outerwear. A garment is fitted over everything
  built before it in `GARMENTS` with a lower layer. Something built later is invisible to it.
- If two items cannot be fitted in a fixed order for every outfit, declare `CONFLICTS` in `cc_clothing.py`
  (mirrored by `web/clothing_rules.js resolveOutfit`). A conflict is cheaper than a fragile fit. Current:
  hoodie x coat, jacket x coat / hoodie / dress, dress x coat.
- `coat_envelope=False` on garments that must not widen the coat's generated skirt (shirt, shorts, dress).

**Clearance and thickness**
- `EPS_LAYER` 3 mm minimum over a lower garment; `FIX_RANGE` 3 cm: anything deeper is treated as mis-associated
  and not moved. Do not raise `FIX_RANGE` to "fix" a poke; find the wrong association.
- Over a simulated lower garment (skirt): `hides_lower=True` + `sim_layer_gap` 0.018.
- Coat `layerThickness` 0.015 (0.018 gave new toe pokes). Change it only with the full matrix.
- Loose tops: `inflate` (jacket 8 mm, hoodie 6 mm) before clearance, same offset in every shape key.

**What to pin (cloth garments)**
- Pin (`pinTop` / `pinBottom`) everything the body holds: waist band, bodice. Only the skirt below the hips is free.
- `legShare` / `legShareFront`: thigh skinning share of the skirt. Dress: 0.6 / 0.8 (1.0 cost stretch p99).
- `limit="arms,hips"` capsules push particles out; `limitSlack` 0.008 on the dress (hands at the sides).
- Keep `check_garment` stretch rows green: p99 <= 1.65, mean <= 1.3, body pen <= cloth off.

**Zones (hidden skin)**
- Zone bit = index in `GARMENTS` (dress 2048, jacket 4096, boots 8192). Adding a garment in the middle of the
  list renumbers all later ones.
- Zone rules in `covered()`: `zone_tris`, `zone_near`, `zone_near_pinned`, `zone_fill`; plus the top limit.
  A hidden vertex must have garment over it in every pose, or it is a hole; a drawn vertex near the zone
  boundary is what pokes through.

**Shoes, boots, hems**
- Shoe soles: `sole=dict(top, floor)` squashes everything below `top` onto the floor band.
- Socks / shafts (`cc_sec`, `secondary_from="small_components"`): `sock_weights` + `keep_inside` keep them >= 3 mm
  inside the shoe at every shape.
- Jeans over the boot shaft (boots layer 1, jeans fitted over them) passes the harness. Tucking in would need the
  boot fitted over every jeans shape; not tried.
- Hem / tuck: a top over a skirt keeps `sim_layer_gap`; a flared skirt uses `flare` (no new vertices).

## 3. The checks: what they do, how long they take

| check | what | time (this PC) | when |
|---|---|---|---|
| `node tools/check_garment.mjs <id> --bodies all` | budgets, licence, skinning, 92 morphs, clearance to skin / lower layers on 9 bodies + 69 morph extremes, holes, cloth sim rows (cloth garments), integrity per body | ~1-2 min skinned, ~5-10 min a cloth garment | every garment change; must end `=> OK` |
| `node --test` | whole suite incl. reduced integrity matrix, sock-inside, hole tests, walk / run limits | ~4 min | before handing over |
| `node tools/cloth_integrity.mjs` (default timeline) | full matrix: every outfit x 9 bodies x idle / walk / run / idle>run, worker path | ~30-40 min | on demand only |
| `... --timeline moves` / `--timeline land` | strafe, walk_back, jump, idle variants / fall + land | ~1 h / ~30 min | on demand only |
| headless screenshots of a staged copy | what no metric sees (spikes at one morph corner, jaw hole, hip step) | ~10 min for ~40 strips | after a visual-affecting change |

The long matrix is a measuring tool, not a ship gate: it has a known nonzero baseline (20 / 5108 default) and
several cases are chaotic (section 4). Compare before / after on the same machine and timeline; report the delta.
A case fails at > 2 vertices AND > 5 mm.

Fast loops used while tuning: build into a scratch folder (`build_base.py -- <dir>/base_body.glb`), run
`check_garment <dir>/clothing_<id>.glb`, then `cloth_integrity` on just the outfits / bodies involved
(`runCase(D, outfit, body, {cfg})` with `loadData(dir)`). Note: cloth params come from the GLB extras
(`ccCloth`), so editing `clothing.json` does not change the sim; override `D.garments[id].extras` in a script.

## 4. Known unsolved problems (UNVERIFIED hypotheses)

**Coat over T-shirt + jeans, female (`tests/cloth.test.mjs`)** - chaotic. Moving the T-shirt by +-1e-7 m flips
pass / fail; 4 of 8 perturbations pass on the dress / jacket / boots build (1 of 8 before). Seen: tee / jeans at
the front hip through the coat in run, 2-4 vertices, 24-36 mm.
- Since ROADMAP M2 the test runs a FIXED set of 8 seeded perturbations (`tools/perturb.mjs`, the T-shirt's bind
  positions +-1e-7 m) and asserts how many pass (`COAT_CHAOTIC` in `tests/cloth.test.mjs`; threshold >= 6 of 8 is
  PROVISIONAL until the owner decides ROADMAP decision 3). Same seeds -> same count on every run. Measured on
  87bd0d7: 5 of 8 (seeds 3, 4, 6, 7, 8 pass), so the test is red; the solver is not tuned to make it green.
- Hypothesis: the coat's free panel at the hip sits within one solver iteration of the layer; a small phase
  difference decides which side it settles on.
- Next: measure the margin (closest coat particle to the tee at the hip over the run) instead of pass / fail;
  try a hip-only `layerThickness` or a pinned band 2-3 cm lower at the hip. Do not pick a lucky build.

**Dress hip step (cloth on, clearest on male bodies)** - a step / bump in the skirt at the hip sides below the
belt; cloth off is smooth.
- Not the `hips` limit capsule: `limit="arms"` changed nothing measurable.
- Hypothesis: the pinned -> free transition (`pinBottom="hip-0.12"`, `clearance_ramp` 0.15): the pinned top holds
  the 3 cm clearance, the free part below drops inward under gravity, and the smoothstep is narrow.
- Next: screenshot strips with `pinBottom` -0.08 / -0.16 and a wider ramp; compare stretch p99 and the jump case
  (`zone_near_pinned` depends on `pinTop`).

**Jeans / shorts at the pelvis, old body, jump / land (briefs and body, 3-4 vertices, 5-7 mm)** - also without
boots. Hypothesis: the old body's pelvis corrective plus the deep crouch; jeans are skinned only.

**Bra under dress / jacket, female `idle_fidget` (3 vertices, 29.9 mm sink)** - `under_outer` now keeps the bra
under the dress and jacket at every shape, which moved it slightly. Hypothesis: the hand in fidget is not a cloth
layer, the 29.9 mm is the hand reaching the chest.

**Coat:jeans neutral jump (5 vertices, 7.4 mm)** - new since jeans are fitted over the boots (the jeans changed
slightly everywhere). Hypothesis: same hip region as the chaotic coat case.

**Hair at collars** - static hair; `calibrate()` grows the upper-back capsule to the worn garments. A strand rooted
at the nape can still meet a hood roll or jacket collar.

## 5. Adding a regression case

- Static, every body (bind pose): add a test in `tests/integrity.test.mjs` like "sock triangles stay inside":
  build surfaces with `outfitSurfaces(D, createCharacter(D, sliders), [item], CFG)` and assert the bad list is
  `[]`. Include the male variant (`{ gender: 1, ...body }`): many problems appear only at male corners.
- Animated, a few bodies: add `[outfit, body]` to `MATRIX` in `tests/integrity.test.mjs` (short timeline,
  `every: 6`). If a case must stay failing for now, add it to `KNOWN_FAILING` with a reason; the suite checks that
  every known entry still fails.
- Per garment: limits in `tests/clothing.test.mjs` (`LIM` walk / run skin / mm / layers / legs, holes `MAX`,
  `UNDER` layers). Write the measured value and the date in a comment next to the limit; never raise a limit to
  pass.
- A new outfit for the long matrix: `CONFIG.outfits` in `tools/cloth_integrity.mjs` (and a reason in a comment if
  a pair is left out because of a conflict).
- Checker-level: `tools/check_garment.mjs` `CONFIG` (budgets, holes `max` with a `reason`). Put any exception in
  `knownExceptions` with a reason and a TODO, not a silent threshold change.
