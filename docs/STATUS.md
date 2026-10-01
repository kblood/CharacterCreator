# Status (2026-10-01)

## Working
- MPFB 2.0.17 installed in Blender 5.2 (user_default extension repo). Base: 13 380 verts body, `game_engine` rig (53 bones).
- `blender/build_base.py` -> `output/base_body.glb` (7.43 MB): 12 morph targets, body + eyes/brows/lashes/teeth/tongue,
  textured skin (see below), plus the hair GLBs,
  plus `output/base_body.joints.json` (bind-pose joint heads + per-morph joint offsets).
  Run: `C:\Tools\Blender\blender.exe -b --python blender/build_base.py -- <out.glb>`
- `web/` Three.js viewer. `web/character.js` is the engine-agnostic mapping: bipolar slider -1..1 = two morph
  targets, per-slider `scale` caps a side's influence, `applySkeleton()` moves bones from the sidecar,
  `validateMorphs()` reports missing morph names.

## Fixed in the 2026-09-30 review round
- [x] Bind-pose skeleton was ~0.8 m below the mesh (`detailed_helpers=False` dropped the `joint-*` groups, bones fell back to
      `default_position`): now `detailed_helpers=True` + refit via `reposition_edit_bone()`, build asserts bind == neutral fit.
- [x] Skeleton did not follow morphs (bones stayed at bind pose -> animation distorted): joints sidecar + `applySkeleton`.
- [x] `height_tall` was +0.7 m at max: slider scale caps it at ~+0.3 m.
- [x] `applySliders` zeroed all influences (`inf.fill(0)`), clobbering morphs it does not own: now only touches its own targets.
- [x] Unknown morph names failed silently: `validateMorphs` logs them.
- [x] `build_base.py` hardcoded scratch paths / unexplained constants; stray `probe.py` moved out of the build path.
- [x] Viewer robustness: load-error handling, DPR cap, no always-on `preserveDrawingBuffer`, reset button.
- [x] Deploy: no absolute skill path (param/env/fallbacks), `.htaccess` guaranteed in the upload (tar, not `scp *`),
      post-deploy header check, ETag revalidation instead of blanket no-cache, gzip for glb/json/js, MIME types.
- [x] Hygiene: README matches real status, `LICENSE-NOTES.md`, `.gitignore` covers `build/` and Blender temp files.

- [x] Integration check (headless Chrome, local `build/site`): no console errors, 12 morphs / 53 bones loaded,
      `height=1` -> influence 0.45, head bone +0.30 m, skinned mesh top +0.32 m; reset restores bind pose exactly.

## More clips: idle variants, walk_back, strafe, jump / fall / land (2026-10-01, uncommitted)
- [x] 9 new clips in `web/animation/clips.js` (12 in total), details and references in
      [ANIMATION_CLIPS.md](ANIMATION_CLIPS.md): `idle_look` 10 s, `idle_breathe` 8 s, `idle_fidget` 9 s,
      `walk_back` 1.05 s (0.87 m/s), `strafe_left` / `strafe_right` 0.90 s (0.45 m/s), one-shot `jump` 2.09 s
      (countermovement, ballistic flight, land, back to idle), `fall` 1.2 s loop, one-shot `land` 1.06 s (neutral body).
- [x] Measured on 7 bodies: foot sliding 0.0 mm and no floating in every planted phase; knees never hyperextend
      (jump take-off exactly straight, margin 0.0 deg); jump root y'' = -9.81 in flight; pelvis peak 2.2 m/s.
- [x] Animator: one-shots (`loop: false`, `next`), `play(name, { then, once, fadeOut })`, `state().rootVelocity`,
      cross-direction locomotion joins at the foot-matched phase. Crossfades between all 132 ordered pairs tested
      (no pops; worst pelvis step 20.7 mm/frame at 60 fps, land -> run). Idle variation (`web/animation/idlevary.js`,
      seeded, deterministic under `?shot`). Viewer: all clips in the selector (da/en), "Jump!" button, "Idle
      variation" checkbox (`?idleVary=`, `?idleSeed=`).
- [x] Baked: `output/animations/*.json` (idle/walk/run byte-identical), `output/base_body_anim.glb` 12 clips,
      `check_anim_glb` CHECK OK (floor check now on every clip). `tests/moves.test.mjs` (7) + new animator/clip tests;
      breast physics bounded and finite through jump/fall/land at 30/60/144 fps.
- [x] Cloth (`node tools/cloth_integrity.mjs --timeline moves`, coat / tee+skirt+shoes / tee+jeans+shoes x 6
      bodies, 768 cases): every poke <= 2 vertices or < 5 mm (the jump arm swing was reduced to 85 deg + 20-25 deg
      abduction for this; at 100 deg the T-shirt armpit poked 10 vertices / 10 mm). 13 cases still over the
      threshold, all "sink" (body vertices 22-30 mm inside the garment, 3-6 vertices): child T-shirt in strafe /
      walk_back / idle_fidget, neutral T-shirt in the jump (4/24), coat thigh / spine in walk_back, idle_fidget -
      the same kind as the default
      matrix's existing failures (child T-shirt 3-4/30 in walk/run, coat child/tall).
- [ ] Not done: the `run -> walk_back` crossfade lifts the pelvis smoothly ~5 cm (ground guard); turn-in-place,
      start/stop transitions; a gravity-driven controller (`fall` + `land` exist for one).

## Animation (idle / walk / run), 2026-09-30
- [x] Own procedural clips (`web/animation/clips.js`) on canonical joint names (`web/humanoid.js`, `web/animation/`),
      rotation deltas vs. rest only; leg IK adapts stride/tempo/pelvis to the current body. Viewer UI: clip select,
      play/pause, speed 0.25..2. Contracts: `docs/ANIMATION_PLAN.md`.
- [x] Tests: `node --test "tests/*.test.mjs"` = 37 tests, 36 pass, 1 skipped (three.js test, needs `THREE_DIR`).
- [x] Baked: `node tools/sample_clips.mjs` -> `output/animations/*.json` (60 fps); `blender/bake_clips.py` ->
      `output/base_body_anim.glb` (4.67 MB, neutral body); `node tools/check_anim_glb.mjs` -> CHECK OK.
- [x] Headless Chrome on `build/site`: no console errors; feet no sink/float/slide on 8 extreme bodies (tolerances
      in the plan).
- Not verified: motion quality over time / side view (run knee bend may look "sitting"), sliding right after a speed
  change mid-step, mobile / real GPU, playback of the baked GLB in Blender/Unity/Godot.
- Open: `deploy.ps1` stages `base_body_anim.glb` too (+4.67 MB) and not `output/animations/*.json` - decide before deploy.

## Face assets, hair, skin texture, lighting (2026-09-30)
- [x] Eyes (sclera / tintable iris / cornea as 3 materials), eyebrows, eyelashes, teeth, tongue from the MakeHuman
      CC0 system pack (`blender/tools/fetch_mh_assets.py` -> `build/mh_assets`), added via MPFB `add_mhclo_asset`,
      fitted by our own MHCLO fit (numpy) to the neutral body and to each of the 12 morph samples -> every part has
      the same 12 morph targets as the body. Rigid 100 % on `head` (the rig has no eye/jaw bones).
- [x] 5 hair styles (short02 default, bob02, long01, ponytail01, braid01) as separate `output/hair_<id>.glb`
      (0.9-1.65 MB each) + `output/hair.json` manifest, loaded on demand. Same 12 morphs, weights limited to
      head/neck/upper spine/clavicles. Why separate files: the initial load only pays for one style
      (base 7.43 MB + short02 1.03 MB = 8.5 MB); all 5 inside the base GLB would add 6.3 MB.
- [x] Skin: PBR with the CC0 `young_caucasian_female` albedo (2048 px JPEG, colour-normalised to a neutral grey
      so the runtime tint still works) + a generated normal map (1024 px); roughness 0.52.
- [x] Tint contract: material extras `tint {gain, default}` -> three.js `material.userData.tint`;
      `color = picked colour * gain`. Viewer: skin, eye, hair and eyebrow colour pickers, hair dropdown (+ bald).
- [x] Viewer lighting: RoomEnvironment IBL, NeutralToneMapping, soft shadow on a shadow-catcher ground,
      alpha-to-coverage for hair/brows/lashes. Camera presets `?view=face|eyes|mouth|side|...`.
- [x] All parts share the body's `Skeleton` (`bindToSkeleton`), so `applySkeleton()` and the clips move them too.
- [x] `output/base_body_anim.glb` re-baked with all face parts (7.67 MB); `check_anim_glb.mjs` checks every mesh.
- [x] Tests: `node --test "tests/*.test.mjs"` = 48 tests, 47 pass, 1 skipped (`THREE_DIR`). New
      `tests/assets.test.mjs`: parts / morph names / skin, head-only weights, parts follow every morph, teeth
      behind the lips and eyes behind the brow at every morph, tint defaults == viewer defaults, size budget,
      hair GLBs (joints, bone set, morph following), unit tests of the tint/skeleton helpers.
- [x] Headless Chrome on `build/site`: no console errors; front/side/face/eyes/mouth, all hair styles, bald,
      colour changes, 5 extreme bodies, walk/run, `?lang=en`, Reset (restores sliders, colours, default hair).
- Not verified / known look issues (at that time; see the next section for what changed): hairline alpha edge is jagged (one alpha-tested card layer); braid01 top
  still a bit glossy; knees/elbows reddish from the source texture; bald scalp slightly orange; no blinking or eye
  movement (no eye bones); no hair physics (hair is skinned to head/neck/spine only, long hair can clip into
  the shoulders during run); morph fit at combined extremes is only checked per single morph; mobile / real GPU.
- Size: initial viewer load ~8.5 MB (base 7.43 MB incl. 1.1 MB textures + default hair 1.03 MB + JS/JSON),
  three.js from the CDN on top. `deploy.ps1` also stages `base_body_anim.glb` (7.67 MB, not loaded by the
  viewer) and all hair GLBs.

## Face, eyes, skin, hair, body round (2026-09-30, uncommitted)
- [x] Face sliders: 13 bipolar sliders (nose width/length/height, jaw width, chin, cheekbones, eye size/spacing/
      tilt, lips, mouth width, ear size, forehead) on 26 MakeHuman detail targets (`face_<stem>_decr/_incr`),
      "Ansigt / Face" UI section, da/en labels, reset with everything else. Every part (eyes, brows, lashes,
      teeth, tongue, all hair GLBs) carries the same targets, so hair follows e.g. forehead/ear changes
      (drift checked in `tests/assets.test.mjs` and in screenshots). They move no joints.
- [x] Blink: MakeHuman eyelid-closure expression units (`blink_left/right`), random interval 2-6 s (15 %
      double blinks), 120-180 ms, own timer independent of the animation clock, dt clamped. Look-at:
      `look_left/right/up/down` = rigid eyeball rotation morphs (30 deg yaw / 25 deg pitch at weight 1),
      camera or mouse target, clamps 24 deg yaw / 8 deg up / 18 deg down, saccades + micro-saccades, upper lid
      follows a downward gaze. UI: "Øjne / Eyes" section (blink checkbox, look off/camera/mouse). No bone writes
      (`web/eyelife.js`, unit tests in `tests/face.test.mjs`).
- [x] Skin (`web/materials.js`, onBeforeCompile on three r170): per-channel wrap lighting (fake SSS), back-light
      transmission masked to ears/nose, flush on cheeks/nose/ears (baked), procedural pore micro-normals faded
      out beyond ~1.2 m, specular F0 ~0.026 + roughness >= 0.56 + faint sheen (less waxy). Build-side texture
      fixes: knees/elbows/eye-surround redness reduced, bald scalp stubble painted to skin (triangle-rasterised
      UV masks, `blender/cc_textures.py`). Male areolas toned down by a gender-driven region mask. Iris
      enlarged, cornea catchlight. Tint contract unchanged (see README "Colour tints").
- [x] Hair: root-to-tip shade (`_CCHAIR` attribute), duller specular (braid01 top no longer glossy), 3 more CC0
      styles (short04, bob01, afro01), optional shoulder/upper-back capsule push-out in the vertex shader
      (rotations untouched, roots fixed, toggle "Hår undgår skuldrene"). Probe during run: 0 capsule
      penetrations for long01/braid01/ponytail01 even without it (clearance >= 14 mm arms, 2-3 mm back).
- [x] Body: 16 corrective morphs `corr_A__B` (MakeHuman sample of A+B minus the linear sum), runtime weight =
      inf(A) x inf(B); fixes the largest interaction errors (gender x age up to 65 mm, weight x muscle 81 mm).
      Small breasts at gender = 1: the geometry is flat; the impression came from the painted areolas of the
      female albedo -> toned down by the mask.
- [x] Morph deltas quantised (`KHR_mesh_quantization`, int16/int8 normalised, sparse): 60 targets in 6.97 MB
      (was 12 targets in 7.43 MB). Initial load base + short02 = 8.07 MB. `base_body_anim.glb` 7.20 MB.
- [x] Tests: `node --test "tests/*.test.mjs"` = 57 tests, 56 pass, 1 skipped (`THREE_DIR`).
      `blender/tools/check_glb.py` and `tools/check_anim_glb.mjs` -> CHECK OK.
- [x] Headless Chrome on a staged `build/site`: face sliders, blink (full/half), look directions, scalp/nape,
      knees, eye surround, dark skin tint, all 8 styles, walk/run, Reset (sliders, tints, toggles, hair),
      `?lang=en`, error display for an unknown hair id.
- Reverted / not shipped: a hairline alpha fade on `_CCEDGE` (kept in the shader, default off): with one
  alpha-tested card layer it ate temples/sideburns into a jagged, balder edge instead of softening it.
- Not verified / still unrealistic: hairline still a hard alpha-tested edge (short02, short04, bob02); pores are
  subtle; catchlight is small; no anisotropic hair highlight, no second blended hair layer, no hair physics; no
  beard (the CC0 pack has none); look=mouse only unit-tested, not screenshot-tested; long-hair shoulder clipping
  was not reproduced, so the collider is a safety net; upward gaze has no lid-raise morph (hence the 8 deg clamp);
  correctives cover pairs only (small dark patch on the hip at combined extremes); mobile / real GPU.

## Clothing prototype (2026-09-30, uncommitted)
- Built by `blender/cc_clothing.py` (called from `build_base.py`; `--no-clothing` skips it):

  | item | slot / layer | source | size |
  |---|---|---|---|
  | T-shirt | top / 3 | CC0 `male_casualsuit04` | 0.35 MB |
  | jeans | bottom / 2 | CC0 `male_casualsuit04` | 0.41 MB |
  | skirt | bottom / 2 | CC0 `female_elegantsuit01` | 0.19 MB |
  | shoes + socks | shoes / 1 | CC0 `shoes01` | 0.83 MB |
  | trench coat (long) | outerwear / 4 | CC0 `male_casualsuit05` jacket cut at the waist (its own collar and patch pockets removed); long skirt (to 6–9 cm above the floor) + belt generated by `coat_skirt`, standing collar + peaked lapels generated by `coat_collar` | 0.94 MB |

  Catalog: `output/clothing.json`.
- Build steps: MPFB mhclo fit, all 60 morph targets baked, 3 mm clearance per shape (body and lower layers,
  neutral + 12 macros + 16 corrective corners), 53-bone skin.
- Hidden skin: body zones in the `_CCZONE` body attribute (MakeHuman delete_verts, limited to skin the
  garment really covers along the skin normal). The viewer drops body triangles whose 3 vertices are all
  hidden.
- Tinting: grey-normalised albedo, primary tint, and a secondary colour through a mask texture (T-shirt
  trim, socks, coat belt). Coat material extras `tint.lining`: back faces (inside of the coat, collar and
  lapels) take the secondary colour.
- Viewer (`web/clothing.js`, `web/clothing_rules.js`):
  - a "Clothes" section with one select per slot plus two colour pickers, in da/en;
  - Reset takes the clothes off;
  - `?outfit=`, and `__set('outfit' | 'wear' | 'takeOff' | 'clothColor')`, `__clothingState()`.
- Cloth data: `_CLOTH_PIN` + `ccCloth` extras on skirt and coat, `output/body_colliders.json` (16
  capsules/sphere + a 20-capsule cloth set, all scaling with the sliders), [CLOTH_SPEC.md](CLOTH_SPEC.md).
  Simulated in the viewer (next section).
- Measurements (`node tools/cloth_check.mjs`). Counts are garment vertices more than 2 mm inside visible
  skin; 8 frames per clip, neutral body.

  | item | morph extremes | walk | run | other |
  |---|---|---|---|---|
  | T-shirt | <= 4 | <= 48 (<= 24 mm) | <= 41 (<= 26 mm) | walk/run count is the armpit: the arm swings down into the tee's side, the same overlap as the bare body |
  | jeans | <= 2 | 0 | 0 | |
  | skirt | 0 | <= 4 (15 mm) | <= 9 (13 mm) | |
  | shoes | 0 | 0 | 0 | |
  | trench coat | 0 skin; <= 20 of 2584 inside the drawn tee/jeans (female + weight max, front edges; was 26) | <= 8 (21 mm) | <= 10 (22 mm) | |

  - Trench coat vs *drawn* tee in poses: walk 19–78 (mean 40; before 116 max / 78 mean), run 36–63 (mean 47;
    before 88 / 77), mostly at the armpit/side and under the belt where the skirt is not fully pinned.
  - Covered lower layers (`hide_lower`, 2026-09-30): T-shirt vertices under a fully pinned part of the coat,
    more than 3 cm from its open edges (+ one ring), carry the coat zone bit in the tee's own `_CCZONE`
    (470 build vertices, catalog `hidesLowerVertices`); the viewer drops those tee triangles while the coat is
    worn. This removed the blue specks at the shoulders and upper arms (linear blend skinning of tee and coat
    differs there). Tee vertices poking through the coat (nearest coat vertex, >3 cm from coat edges): idle
    124–137 → 46–58, walk 100–129 → 24–50, run 85–115 → 23–37; shoulder 11–12 → 0, arm 17–28 → 4–15 (the rest
    sits under the coat body/belt and is not visible in the close-ups).
  - Coat into the legs: <= 7.
  - Holes (hidden skin not covered): T-shirt 2, jeans 2, skirt 0, coat 0, shoes 32 (foot soles facing the
    ground, not visible).
- The measurement table above predates the long coat (it was the knee-length version). For the long coat
  with and without cloth, see the cloth section below.
- Screenshots (git-ignored): `build/shots/clothing/` (front/side/back, extremes 10-16, walk/run 20-26,
  close-ups 30-35).
- Coat design (long "Syndicate"-style coat):
  - the jacket is cut at the waist (this drops the lower patch pockets);
  - a generated A-line skirt with a slight hem flare runs to 6.4–9.1 cm above the floor, scaled with the body;
  - open front that opens a little toward the hem, back vent, belt band over the former seam;
  - charcoal primary (#2b2b30), dark brown-black secondary (#1f1b1a) for the belt and the lining.
  - Standing collar + lapels (`coat_collar`, project-generated, 285 build vertices = 57 columns x 5 rows):
    the collar stands 7.2 cm at the back and 4.5 cm at the gorge, flares out 2.4–3 cm, has a turned-in top
    edge and is open at the front; broad peaked lapels (7.5 cm, 35° peak, notch) roll from the gorge to 24.5 cm
    below the neck joint, with a thin rim under the edge. Bound to the body like the skirt (all 60 morphs),
    weights from the jacket (head dropped), `_CLOTH_PIN` = 1, `_CCCOLLAR` = 1 on the standing collar.
    The CC0 collar (277 vertices) and the four chest pocket pieces are removed; the pocket holes are filled
    (30 interior vertices) and their shadowed texels in-painted.
  - Collar clearance (every macro extreme + corrective corner, every face/gaze morph, big jaw/chin/ears with
    each gaze on 8 bodies, idle/walk/run frames): >= 9.5 mm to the neck, >= 20.9 mm to the jaw, >= 40.9 mm
    to the ears.
  - Collar vs hair: short02, short04, afro01 never touch it (>= 6.6 mm). bob01, bob02, long01, ponytail01 and
    braid01 hang through the collar region: 30, 38, 50, 31 and 309 hair edges cross the collar at their worst
    shape/frame. In the renders the hair looks tucked inside the collar. A vertex-shader push of the hair out
    over the collar was tried and reverted: it splayed bob02 and kinked long01.

## Cloth simulation (2026-09-30, uncommitted)
- `web/cloth/` (XPBD, fixed 60 Hz, 8 substeps, module worker with a sync fallback), `tools/cloth_sim.mjs`
  (headless harness), `tests/cloth.test.mjs`. Details and all numbers: [CLOTH_RUNTIME.md](CLOTH_RUNTIME.md).
- Viewer: "Cloth physics" checkbox (default on) and a Wind slider, da/en; `?cloth=0|1`, `?wind=`,
  `?clothWorker=0`; `window.__cloth()` stats. The cloth resets on outfit change, Reset and anim None.
- Long coat, 8 bodies, 10 s walk/run/idle/idle→run:
  - stretch p99 1.19–1.61 (mean 1.09–1.24), vs 2.7–3.9 skinned only;
  - 0–3 particles more than 2 mm inside a capsule (≤ 17 mm), vs ≥ 20 (≥ 29 mm) skinned;
  - the hem never goes below the floor, and the front panels never cross;
  - in run the hem trails 0.23–0.35 m behind its skinned position.
- Skirt (same system): p99 1.72–2.20 vs 2.8–3.5 skinned. It is better, but still stretches: it is a tight cut
  and the thighs spread further than its width in run.
- Cost: the coat takes ~1.5 ms/step in the worker and 0.6 ms/frame on the main thread; sync mode takes
  2.0 ms/frame. Re-measured with the standing collar + lapels (all pinned, same 860 particles): worker 0.54
  ms/frame main thread + 1.44 ms/step, sync 1.98 ms/frame (before: 0.55 / 1.46, 1.98); node 1.42–1.56 ms/step;
  stretch p99 1.22–1.61, 0–3 particles inside a capsule (unchanged).
- Lower layers (2026-09-30): the cloth also collides with the worn garments under it (`web/cloth/layers.js`,
  footwear excluded). This fixes the blue jeans / T-shirt holes through the coat's knee and back hem in walk and
  run. The cause: the jeans lie up to 37–49 mm outside the skin-fitted capsules, beyond the coat's 20 mm
  thickness.
  - Jeans / T-shirt / skin through the coat (tee + jeans, 8 bodies): 134 → 0.
  - Stretch p99 1.26–1.65; heavy is +0.05, the other changes are within the chaotic noise band.
  - 1–6 particles inside a capsule.
  - Cost: worker 0.76 ms/frame main thread + 1.73 ms/step, sync 2.34 ms/frame.
  - Details: [CLOTH_RUNTIME.md](CLOTH_RUNTIME.md#lower-layers-cloth-vs-the-garments-underneath).
- Not verified:
  - mobile, browsers other than headless Chrome, hour-long runs;
  - (since 2026-10-01 the simulated skirt is a layer in its drawn shape, and leg skin / feet / shoes are layers).

## Cloth integrity harness (2026-10-01, uncommitted)
- `tools/cloth_integrity.mjs` + `tests/integrity.test.mjs`. It counts VISIBLE penetrations between drawn
  layers (poke = inner through outer, sink = outer behind inner). Hidden zones and armpits behind the arm do
  not count. Cloth runs as in the viewer (worker latency included). Details and table:
  [CLOTH_RUNTIME.md](CLOTH_RUNTIME.md#integrity-harness-toolscloth_integritymjs-testsintegritytestmjs).
- Baseline (5 outfits × 9 bodies × idle / walk / run / idle→run): 461 of 1188 cases above threshold
  (> 2 vertices and > 5 mm).
  - Socks through the shoes: 9/9 bodies.
  - Shoe tongue through the jeans hem: 8/9.
  - Thighs through the skirt: 9/9.
  - Skirt through the coat: 9/9.
  - Jeans / legs / shoes through the coat: 9/9.
- The coat cases come mostly from the worker's one-frame latency. On the sync path, jeans through the coat is 0/9.
- The test was green only through `KNOWN_FAILING`, which listed 8 pairs.

## Cloth integrity fixes (2026-10-01, uncommitted)
Details and tables: [CLOTH_RUNTIME.md](CLOTH_RUNTIME.md#integrity-harness-toolscloth_integritymjs-testsintegritytestmjs).

- **Full matrix: 470 → 35 failing cases** (first written as 34; corrected in review 2026-10-01, see below) (6 outfits × 9 bodies × 4 clips, worker path, default underwear).
  - shoes:socks 94 → 0, jeans:shoes 61 → 0, skirt:body 66 → 0, tshirt:skirt 36 → 0;
  - trenchcoat:jeans 70 → 2, trenchcoat:body 52 → 5, trenchcoat:skirt 34 → 0 (first written as 1), trenchcoat:shoes 30 → 3;
  - unchanged: tshirt:body 18 (heavy / child / old), panties:body 2, briefs:body 1; skirt:briefs 6 → 2.
- `KNOWN_FAILING` in `tests/integrity.test.mjs` was emptied (2 entries again since review 2026-10-01, when the
  MATRIX got the failing cases). New tests: shoes on 6 more bodies (incl. male heavy
  / child); a static test that no sock triangle sticks out of the shoe on any body (the vertex-based harness had
  missed sock patches between vertices on the male heavy / child bodies).
- **Shoes** (build, `cc_clothing.py`): socks take the shoe's skin weights near the shoe (`sock_weights`); the sock is
  pushed inside the shoe (`keep_inside`); every part of a lower garment is its own clearance collider; `wrap`
  moves a jeans face out where a shoe vertex comes through its middle.
- **Skirt**: lower part flared up to ×1.15 (`flare`, no new vertices); waist band `limitSlackPinned` 0.006; the
  hidden-skin zone is checked per triangle (8 skin vertices stay drawn where the flare opened the crotch).
- **Coat** (runtime): drawn-frame contacts (`web/cloth/drawfix.js`), one-frame input prediction for the worker,
  the body's leg skin and the shoes as layers, the simulated skirt as a layer in its drawn shape.
- Rebuilt: `clothing_shoes/jeans/skirt/trenchcoat.glb`, `clothing.json`, `base_body.glb`, `base_body_anim.glb`,
  `body_colliders.json`. `check_glb` / `check_anim_glb`: CHECK OK. `cloth_check` holes: shoes 32, skirt 0, jeans 2
  (as before).
- **Tests:** `node --test "tests/*.test.mjs"` = 138 tests, 136 pass, 1 skipped, **1 FAILED** at the time: coat over
  tee + jeans, female, stretch p99 1.687 > 1.65 (fixed in review 2026-10-01, below).
- **Screenshots** (headless Chrome, looked at): shoe close-ups on 6 bodies in idle / walk / run, coat over jeans in
  walk / run, skirt in run front / side / back on 8 bodies + female, skirt + coat. Seen and not fixed: a small notch
  at the back of the jeans hem (old, run), a small dark triangle in the skirt (tall, run), a pointed skirt hem
  (child, run).
- **Not verified:** main-thread cost on an idle machine. Measured on a loaded machine only, as a ratio against the
  old code: worker ×1.5, sync ×1.18, which is roughly 1.1 ms/frame worker and 2.8 ms sync on the earlier
  baseline (targets ~1 ms / 2.5 ms).

## Sex switch, chest sliders, breast physics (2026-10-01, uncommitted)
Details: [BREAST_PHYSICS.md](BREAST_PHYSICS.md).

- **Sex:** a male/female switch replaces the gender slider. The default is male (`?sex=`, `__set('sex', ...)`).
  - Both values are exact MakeHuman macro samples.
- **Chest section (female only, hidden for male):** size, firmness, height, spacing, shape.
  - Uses the MakeHuman CC0 `cupsize` / `firmness` macros and the `breast-dist/point/trans` targets.
  - 4 new corrective pairs.
  - The breast morphs are gated by female x adult in `character.js`, so they are exactly 0 on a male.
  - Default female: size 0.35, firmness 0.45. MakeHuman's own default (cup 0.5 / firmness 0.5) adds no breast target at all, which is why the old female looked flat.
- **Breast physics:** a damped spring (2.6 Hz, damping 0.3) driven by `spine_03` acceleration and tilt.
  - Six generated `dyn_breast_*` morphs, 2 cm each; morph only, no bone writes.
  - The T-shirt and coat carry the same morphs.
  - The cloth runtime adds them sparsely per frame instead of re-morphing the rest shape.
  - Default female, peak tissue motion: idle 0.2 mm, walk 5.8 mm, run 9.9 mm (T-shirt) / 8.1 mm (coat); size 1 / firmness -1 nude run: 18.6 mm.
  - Cost 0.01–0.05 ms/frame. `?breast=0` or the checkbox turns it off.
- **Assets:** 92 morph targets (was 60). `base_body.glb` 7.23 MB (was 7.03), `base_body_anim.glb` 7.41 MB.
  - `check_glb` and `check_anim_glb`: CHECK OK.
- **Garments:** `cloth_check`, 20 female breast extremes. T-shirt and coat: 0 skin penetrations.
  - Coat vs T-shirt: 4 vertices, the same as the female baseline (weight extremes 12/20, as before).
- **Tests:** `node --test "tests/*.test.mjs"` = 126 tests, 125 pass, 1 skipped. New: `tests/breast.test.mjs` (15).
- **Screenshots:** headless Chrome.
  - Default male plus UI.
  - Female: 10 body/breast shapes × nude / T-shirt / coat × front / side / 3/4.
  - Walk/run filmstrips.
- **Still not good:**
  - At large, soft sizes the underside silhouette is visibly polygonal with a dark lower edge (base-mesh resolution).
  - The areola is the small MakeHuman texture spot.
  - Garments are exported without morph normals, so the T-shirt shading over the bust is flat (the silhouette is right).
  - Tools still use `gender: 0` as a "neutral" test body.

## Default underwear (2026-10-01, uncommitted)
Spec: [CLOTH_SPEC.md](CLOTH_SPEC.md) "Underwear"; build: [BLENDER_WORKFLOW.md](BLENDER_WORKFLOW.md).

- **Items:** male `briefs` (boxer-style trunks with a light waistband), female `panties` + strapless `bra`.
  - Ordinary catalog items: slots `underwear` / `bra` (UI "Undertøj" / "Bh"), layer 0, primary + secondary
    colour, 92 morphs, 53 bones, body zones `underwear_m` / `underwear_f` / `bra`.
  - Generated by project code from the body's own faces (`add_generated`, project-original, LICENSE-NOTES.md).
  - Sizes: 0.23 / 0.18 / 0.29 MB (budget 0.3 MB); 538 / 389 / 510 vertices (review 2026-10-01).
- **Default:** worn by default (sex default = male). The sex switch swaps briefs ↔ panties + bra (`setSex`);
  taking it off keeps it off across the swap.
  - The bra row is hidden for a male unless worn.
  - `?outfit=a,b` adds the default underwear unless the list holds an underwear item. `?outfit=none`,
    `?outfit=` or `__set('outfit', [])` = naked. `?underwear=0` / `__set('underwear', false)` turns it off.
- **Covered = not drawn:** `_CCZONE` on the underwear holds the bits of the garments covering it.
  - T-shirt: bra 0 triangles (mesh hidden, `__clothingState().coveredItems`). T-shirt + jeans: briefs 73 / 892,
    panties 62 / 588 (the waistband at the jeans top and the crotch, whose skin the jeans do not hide; before review
    2026-10-01 they were 0 and the culled underwear left holes through the body under the tee hem). Tee + skirt:
    briefs 236 / 892, panties 156 / 588. Coat alone: bra 388 / 860, briefs all.
  - Not a cloth collision layer, not a lower layer for the other garments' clearance.
- **Measured** (`cloth_check`, `tests/clothing.test.mjs`):
  - On the skin at every morph extreme: briefs ≤ 4 vertices, panties ≤ 7, bra ≤ 12. Holes: 0.
  - Walk / run: ≤ 1 vertex inside the skin.
  - Outer garments over drawn underwear: jeans 2–3 vertices, skirt 2 (run), others 0.
- **Integrity harness** (now over the default underwear, + an `underwear` outfit): 470 of 1584 cases above
  threshold. The old pairs are unchanged (459, was 461). 9 new underwear cases:
  - skirt:briefs 6 (≤ 5 vertices / 9 mm, the briefs front through the simulated skirt, the same cause as the
    thighs through the skirt);
  - briefs:body 1 and panties:body 2 (thigh skin over the leg opening when the hip bends, ≤ 5 vertices).
- **Tests:** `node --test "tests/*.test.mjs"` = 131 tests, 130 pass, 1 skipped. `check_glb` / `check_anim_glb`:
  CHECK OK.
- **Screenshots** (headless Chrome, looked at): default male / female; 6+ shapes (heavy, muscular, old thin,
  female heavy, cup max, child); tee + jeans (underwear not drawn); skirt in run; coat; naked; sex swap.
- **Still not good:**
  - Bra at the extreme breasts. At cup max + old + firmness min, 33 band vertices lie inside the folded
    breast; at `dyn_breast_back`, 20. The body overlaps itself there.
  - At cup max + firmness max, small skin-coloured gaps show between the cups and the underbust band.
  - The briefs can show a few vertices through the skirt (see the harness numbers above).

## Review fixes (2026-10-01, uncommitted)
Issues 1–11 of the review of the underwear / cloth / breast work. Details: CLOTH_RUNTIME.md "After review
2026-10-01", CLOTH_SPEC.md "Underwear", BLENDER_WORKFLOW.md (generated underwear), BREAST_PHYSICS.md.

- **Coat stretch, female** (1, 10): trenchcoat `layerThickness` 0.012 → 0.015 (`ccCloth`; `layerThickness` was
  missing from the exported cloth extras). `cloth.test.mjs`: female p99 1.687 → 1.565, coat over layers 1.587;
  the test passes. Full matrix: female 1.666 / 1.656 in two cases (no threshold there).
- **Counts** (2): the earlier "34" was 35; CLOTH_RUNTIME.md corrected, new matrix numbers added.
- **Integrity MATRIX** (3): 6 → 11 cases, incl. the reported coat over underwear only, socks / shoes through the
  coat and skirt + coat on female; `KNOWN_FAILING` now holds the 2 cases that still fail (coat+shoes old
  trenchcoat:socks 5 / 8.6 mm; tee+jeans+shoes old tshirt:body sink 3–4 / ≤ 28 mm).
- **Holes under the T-shirt hem, missing briefs waistband** (4): a covering garment drops an underwear triangle
  only where it hides that skin itself or lies snugly on it (≤ 6 mm, skinned garments); `clip_region` per body
  triangle (no square skin dots). New test: no hole through the body where covered underwear is culled.
- **Panties through the skirt** (5): `under_outer` keeps every underwear vertex ≥ 1 mm under the outer garments
  at every shape key; the harness has no skirt:panties / skirt:briefs failure left. `cloth_check` `countInside`
  now confirms a flagged vertex against its 1-ring triangles (the panties' "weight_max" hits were 1.9–2.0 mm
  OUTSIDE the skin, a nearest-vertex-plane artefact).
- **Breast physics limited** (6) and **damped by garments** (7): travel limit 12 mm × (1 − 0.5 s) with a soft
  stop, output ≤ 0.75; support bra 0.5 / tee 0.2 / coat 0.3 (combined 1 − ∏(1 − s)). Run, size 1: nude ±12 mm
  (9.1 mm tissue motion), bra 3.4 mm, tee + jeans + coat 1.6 mm. Garments loaded later had all `dyn_*` = 1 with
  physics off (the bra moved up to 7.7 mm off the body); now zeroed once per mesh part.
- **Blurry / jagged underwear trim** (8): per-texel trim (rasterised 3D position, exact distance to the edges /
  the top opening), ~1 mm/texel, antialiased over 1.5 LOCAL texels, 16-texel edge padding, mask as an 8-bit grey
  PNG. In an extreme close-up of the briefs' back waistband a faint staircase is still visible (left side).
- **Shoe toe / fingertip through the coat** (9): with the coat layer thickness 0.015 the test cases coat+shoes /
  neutral and tee+jeans+coat+shoes / female pass; the full matrix still has trenchcoat:shoes 2 (male run 8 / 8.3
  mm, old run) and trenchcoat:socks 1 (old run). Screenshot (male, run, coat + shoes): no shoe through the hem. Fingertip in walk: not fixed.
- **Coat over underwear only** (11): `coat` and `coat+shoes` outfits in the matrix and the test; coat over bra at
  cup max + pointed 8 → 0 vertices. Assertions changed: underwear under jeans ≤ 12 % drawn (was "0 drawn",
  which caused issue 4); coat-over-underwear in pose ≤ max(4, the bare coat's own skin count) (the rigid sleeve
  armpit overlap, 16–27 without any underwear).
- **Full matrix: 26 of 2224 failing** (8 outfits × 9 bodies, ~12 min). Suite: 146 tests, 145 pass, 1 skipped,
  0 fail. `check_glb` / `check_anim_glb`: CHECK OK.

## Hoodie, long-sleeve shirt, shorts (2026-10-01, uncommitted)
Three new garments, all skinned (no cloth data). Details and pitfalls: [CLOTHING_GUIDE.md](CLOTHING_GUIDE.md),
section (g) and the appendix.
- **shorts** (layer 2, bottom): the jeans of `male_casualsuit04`, cut above the knee and flared.
- **shirt** (layer 3, top): the shirt of `male_casualsuit03`, with collar, placket, cuffs and buttons
  (secondary colour).
- **hoodie** (layer 4, top): the top of `male_casualsuit02`, loosened, plus a generated hood that lies down.
  `CONFLICTS hoodie: [trenchcoat]`.
- All three are CC0 plus project geometry and have procedural, normal-less textures.
- `check_garment --bodies all`: all 11 garments pass; `knownExceptions` is empty.
- Sizes: shorts 0.24, shirt 0.61, hoodie 0.68 MB.

Build changes:
- Spec flags: `zone_tris`; `hides_lower`; `sim_layer_gap` (0.018, over the simulated skirt); `zone_near` (0.045,
  for a loose waist); `coat_envelope=False` (shirt and shorts).
- Coat collar: `own_collar_deg` 75°. The back of the collar is not fitted over the shirt collar; that part of
  the shirt collar is hidden instead.
- `output/base_body.glb` changed (body zone bits only, positions unchanged). SHA-256 is now `22f10ef4…`.
  `base_body_anim.glb` was not rebuilt, so the animation bake must be redone.
- Hair: `web/materials.js` `calibrate(garments)` now lays long hair, the braid and the ponytail on the hood or
  collar.

Integrity, full matrix (13 outfits, 9 bodies, idle / walk / run / idle>run): **21 of 3368 failing**.
- New outfits: 0 failing.
  - hoodie+jeans+shoes 0 / 292
  - shirt+shorts+shoes 0 / 224
  - shirt+skirt 0 / 184
  - hoodie+skirt 0 / 180
  - shirt+jeans+coat 0 / 264
- Old outfits, before → after: 26 → 21.
  - tee+jeans+shoes 7 → 7
  - tee+jeans+coat+shoes 1 → 0
  - tee+skirt+shoes 7 → 7
  - tee+skirt+coat 2 → 0
  - jeans+coat 1 → 1
  - coat 2 → 1
  - coat+shoes 5 → 4
  - underwear 1 → 1

Tests:
- Suite: 178 tests, 176 pass, 1 skipped, 1 fail.
- The failing test is "long coat over T-shirt + jeans, female" (`tests/cloth.test.mjs`). It is chaotic: ±1e-7 m
  of noise on the T-shirt flips the result, and 5 of 8 such perturbations pass, on the old output and on this
  one alike. This build measures tee run 4 / 22.7 mm against the limit of ≤ 1 / 15 mm.
- `check_glb` / `check_anim_glb`: CHECK OK.

## Open issues
- `tests/cloth.test.mjs` coat over T-shirt + jeans, female, is chaotic (see above) and fails on the current build.
- Visible cloth penetrations: 21 of 3368 cases remain above threshold in the full integrity matrix (see "Hoodie,
  long-sleeve shirt, shorts"); 2 of them are in `tests/integrity.test.mjs` `KNOWN_FAILING` (old body). Fingertips through the coat side
  in walk (hands are not a cloth layer). Coat stretch p99 in the 10 s matrix: 1.666 / 1.656 on female (the test
  threshold 1.65 is met on the test timeline).
- Macro morphs outside the 32 corrective pairs (and 3-way combinations) are still linear.
- Joint offsets are linear per morph (correctives and face morphs move no joints).

## TODO (scope v1)
- Jaw bone / mouth expressions (teeth/tongue are rigid on the head).
- Clothing: a dress (occupies top+bottom, rules exist); more garments. How to make one: [CLOTHING_GUIDE.md](CLOTHING_GUIDE.md), checked by `node tools/check_garment.mjs <id> --bodies all` (2026-10-01: all 11 garments pass, no known exceptions).
- More clips (wave, crouch, turn in place, ...) as new `CLIPS` entries (jump, strafe, walk_back, idle variants: done
  2026-10-01, see [ANIMATION_CLIPS.md](ANIMATION_CLIPS.md)); retarget test of the baked GLB in other engines.
- Hair: second alpha-blended card layer for a soft hairline; hair physics; CC0 beard if one turns up.
- Engine ports of `character.js` (Unity/Godot/Unreal) reading the same GLB + joints sidecar.

## Licensing
MPFB code is GPL; the MakeHuman base mesh/targets/assets are CC0 -> exported GLBs are free to use. Every shipped
asset (skin, eyes, brows, lashes, teeth, tongue, 8 hair styles, 6 clothing packs) is checked for CC0 by the build (the generated underwear is project-original geometry, no asset); face/expression
targets are CC0 per MakeHuman's LICENSE.md; list in `LICENSE-NOTES.md`.
