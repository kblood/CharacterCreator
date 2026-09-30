# Status (2026-09-30)

## Working
- MPFB 2.0.17 installed in Blender 5.2 (user_default extension repo). Base: 13 380 verts body, `game_engine` rig (53 bones).
- `blender/build_base.py` -> `output/base_body.glb` (4.4 MB): 12 morph targets, 1 skinned mesh, 'Skin' PBR material,
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

## Open issues
- Macro morphs are linearised samples (no gender x weight interaction) -> extremes combined may look off.
- Joint offsets are linear per morph too (same limitation as the vertices).

## TODO (scope v1)
- Face sliders (MPFB detail targets), eyes/teeth/eyebrows.
- Hair: swappable meshes + hair colour.
- Clothing fitting (swappable parts fitted to the body).
- Animation retarget test (Mixamo/KayKit clips on the `game_engine` rig, with morphs + skeleton offsets applied).
- Skin texture (currently flat baseColor).
- Engine ports of `character.js` (Unity/Godot/Unreal) reading the same GLB + joints sidecar.

## Licensing
MPFB code is GPL; the MakeHuman base mesh/targets/assets are CC0 -> exported GLBs are free to use. See `LICENSE-NOTES.md`.
