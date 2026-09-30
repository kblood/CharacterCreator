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
- Not verified / known look issues: hairline alpha edge is jagged (one alpha-tested card layer); braid01 top
  still a bit glossy; knees/elbows reddish from the source texture; bald scalp slightly orange; no blinking or eye
  movement (no eye bones); no hair physics (hair is skinned to head/neck/spine only, long hair can clip into
  the shoulders during run); morph fit at combined extremes is only checked per single morph; mobile / real GPU.
- Size: initial viewer load ~8.5 MB (base 7.43 MB incl. 1.1 MB textures + default hair 1.03 MB + JS/JSON),
  three.js from the CDN on top. `deploy.ps1` also stages `base_body_anim.glb` (7.67 MB, not loaded by the
  viewer) and all hair GLBs.

## Open issues
- Macro morphs are linearised samples (no gender x weight interaction) -> extremes combined may look off.
- Joint offsets are linear per morph too (same limitation as the vertices).
- Seen in screenshots: gender = 1 (+ muscle/height 1) still shows small breasts; not investigated (body morphs unchanged).

## TODO (scope v1)
- Face sliders (MPFB detail targets).
- Eye bones / blinking, jaw bone (teeth/tongue are rigid on the head).
- Clothing fitting (swappable parts fitted to the body).
- More clips (jump, wave, crouch, ...) as new `CLIPS` entries; retarget test of the baked GLB in other engines.
- Hair: second alpha-blended card layer or better hairline; hair physics.
- Engine ports of `character.js` (Unity/Godot/Unreal) reading the same GLB + joints sidecar.

## Licensing
MPFB code is GPL; the MakeHuman base mesh/targets/assets are CC0 -> exported GLBs are free to use. Every shipped
asset (skin, eyes, brows, lashes, teeth, tongue, 5 hair styles) is checked for CC0 by the build; list in `LICENSE-NOTES.md`.
