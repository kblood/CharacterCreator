# Status (2026-09-30)

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
  | trench coat (long) | outerwear / 4 | CC0 `male_casualsuit05` jacket + collar cut at the waist; long skirt (to 6–9 cm above the floor) + belt generated by `coat_skirt` | 0.99 MB |

  Catalog: `output/clothing.json`.
- Build steps: MPFB mhclo fit, all 60 morph targets baked, 3 mm clearance per shape (body and lower layers,
  neutral + 12 macros + 16 corrective corners), 53-bone skin.
- Hidden skin: body zones in the `_CCZONE` body attribute (MakeHuman delete_verts, limited to skin the
  garment really covers along the skin normal). The viewer drops body triangles whose 3 vertices are all
  hidden.
- Tinting: grey-normalised albedo, primary tint, and a secondary colour through a mask texture (T-shirt
  trim, socks, coat collar/trim).
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
  | trench coat | 0 skin; <= 26 of 2634 inside tee/jeans (weight + muscle max, front edges) | <= 7 (10 mm) | <= 2 (17 mm) | |

  - Trench coat vs tee in poses: 48-104 vertices, mostly at the armpit/side (the arm pressing the coat side
    into the tee).
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
  - charcoal primary, brown secondary (belt/collar).
  - Still from the CC0 jacket: the chest patch pockets and the collar. There are no real lapels and the
    collar is not a high storm collar.

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
  2.0 ms/frame.
- Not verified: mobile, browsers other than headless Chrome, hour-long runs, coat vs T-shirt/jeans layer
  collision (the cloth collides with body capsules only).

## Open issues
- Macro morphs outside the 16 corrective pairs (and 3-way combinations) are still linear.
- Joint offsets are linear per morph (correctives and face morphs move no joints).

## TODO (scope v1)
- Jaw bone / mouth expressions (teeth/tongue are rigid on the head).
- Clothing: cloth vs lower garment layers; a dress (occupies top+bottom, rules exist); more garments.
- More clips (jump, wave, crouch, ...) as new `CLIPS` entries; retarget test of the baked GLB in other engines.
- Hair: second alpha-blended card layer for a soft hairline; hair physics; CC0 beard if one turns up.
- Engine ports of `character.js` (Unity/Godot/Unreal) reading the same GLB + joints sidecar.

## Licensing
MPFB code is GPL; the MakeHuman base mesh/targets/assets are CC0 -> exported GLBs are free to use. Every shipped
asset (skin, eyes, brows, lashes, teeth, tongue, 8 hair styles, 4 clothing packs) is checked for CC0 by the build; face/expression
targets are CC0 per MakeHuman's LICENSE.md; list in `LICENSE-NOTES.md`.
