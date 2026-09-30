# Status (2026-09-30)

## Working
- MPFB 2.0.17 installed in Blender 5.2 (user_default extension repo). Base: 13 380 verts body, `game_engine` rig (53 bones).
- `blender/build_base.py` -> `output/base_body.glb` (4.3 MB): 12 morph targets, 1 skinned mesh, 'Skin' PBR material.
  Run: `C:\Tools\Blender\blender.exe -b --python blender/build_base.py -- <out.glb>`
- `web/` Three.js viewer (`python -m http.server` in project root -> /web/index.html). `web/character.js` is the
  engine-agnostic slider->morph mapping (bipolar slider -1..1 = two morph targets).

## Known limits / next
- Macro morphs are linearised samples (no gender x weight interaction) -> extremes combined may look off.
- height_tall is +0.7 m at max (too extreme): rescale influence range.
- Skeleton is not adjusted per morph (joints stay at bind pose): export per-morph joint offsets as JSON sidecar and apply in engine.
- TODO: face sliders (MPFB detail targets), eyes/teeth/eyebrows, hair (swappable meshes+colour), clothing fitting, animation retarget test (Mixamo/KayKit), skin texture.
- MPFB code is GPL; the MakeHuman base mesh/targets/assets are CC0 -> exported GLBs are free to use.
