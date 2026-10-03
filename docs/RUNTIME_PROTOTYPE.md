# Runtime prototype: MakeHuman targets in three.js (no Blender, no baked morphs)

Page: `web/runtime.html` (+ `runtime.js`, `mh/human.js`). Live: https://dionysus.dk/webxr/charactercreator/runtime.html

## How it works
- `tools/export_data.py` packs CC0 MakeHuman data from the installed MPFB (`...\extensions\user_default\mpfb\data`) into `web/data/` (git-ignored, regenerate with `python tools/export_data.py`):
  `mesh.bin` (base positions, uv, vertex map, triangles; body group only = 13 380 verts), `macro.json`, `meta.json`, `targets/*.bin` (348 sparse macro targets, int16 deltas, 28.5 MB total, loaded on demand).
- `web/mh/human.js` ports MPFB `TargetService.calculate_target_stack_from_macro_info_dict`: macro sliders -> interpolated weights (race x gender x age, universal gender-age-muscle-weight, height, proportions) -> `positions = base + sum(w_i * target_i)`. Engine-agnostic (typed arrays + a loader).
- `runtime.js` drives a THREE.BufferGeometry from it; normals recomputed per update (3-140 ms, depends on how many new targets must be fetched).

## Verification against MPFB (Blender)
`C:\Tools\BlenderWorkTemp\scripts\dump_reference.py` dumps MPFB's own vertex positions for 5 macro profiles, `compare.mjs` diffs them against the JS runtime:
max error 0.6-1.1 mm (3.6 mm for the child case) on a ~1.7 m body, i.e. visually identical.
Axis mapping: OBJ (x, y, z) -> Blender (x, -z, y); units are decimetres (x0.1 = metres).

## Not done yet
- Skeleton + skin weights (`rig.game_engine.json`/`weights.*.json`) and joint repositioning per morph.
- Detail targets (face, ears, nose, ...; thousands of micro targets), cupsize/firmness, baby proportions.
- Clothes (`.mhclo` proxy fitting), hair, eyes/teeth, skin textures (MakeHuman skin blending by race).
- Data size: 28.5 MB of targets; consider gzip on the server, float16 and dropping rarely used targets.
