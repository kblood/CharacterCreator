# Blender workflow (how this project is built)

## Environment
- Blender 5.2.2 LTS, portable: `C:\Tools\Blender\blender.exe` (not on PATH; no admin needed). Scratch area: `C:\Tools\BlenderWorkTemp\{blend,export,render,scripts}`.
- Everything is run **headless**: `blender.exe -b --python blender/build_base.py -- <out.glb>`. Blender output is noisy; grep for your own markers (`BUILD ...`).
- Live control is opt-in via blender-mcp (`C:\Tools\blender-mcp.json`, start Blender with `C:\Tools\start-blender-mcp.ps1`, launch Claude with `--mcp-config`). Not needed for builds. Its tools all require a `user_prompt` argument. See the global `blender` skill.
- Run deploy/PowerShell things from PowerShell, not Git Bash (MSYS rewrites `/var/www/...` into `C:/Program Files/Git/var/www/...`).

## MPFB (MakeHuman base) setup
- MPFB 2.0.17 is a Blender *extension*, module path `bl_ext.user_default.mpfb`.
- `blender --command extension install mpfb` fails here (repo sync error). Working install: download the zip from the `extensions.blender.org/api/v1/extensions/` entry with id `mpfb`, then
  `blender -b --command extension install-file -r user_default --enable mpfb.zip`.
- Useful API: `HumanService.create_human(...)`, `HumanObjectProperties.set_value(name, v, entity_reference=obj)` + `TargetService.reapply_macro_details(obj)`, `TargetService.bake_targets(obj)`, `HumanService.add_builtin_rig(obj, "game_engine")`.
  Macro keys: gender, age, muscle, weight, proportions, height (all 0..1, neutral 0.5; age child = 0.1875, old = 1.0), plus `race`.
- Available built-in rigs: default, default_no_toes, game_engine, game_engine_with_breast, mixamo, mixamo_unity, cmu_mb, openpose.

## How the morph targets are made (build_base.py)
1. Create the human at neutral macros, read evaluated vertex positions as the base.
2. For each morph: set one macro to its extreme, read positions, reset. The delta becomes a plain shape key ("linearised" sampling, so gender x weight etc. interactions are lost).
3. `bake_targets` + `shape_key_clear` to drop MPFB's own macro shape keys, then add ours (`Basis` + 12 morphs).
4. Rig with `game_engine` **on the full mesh** (weights are indexed on the complete basemesh incl. helper geometry), *then* delete everything outside the `body` vertex group (13 380 verts remain; shape keys and weights survive bmesh deletion).
5. Export GLB: `export_morph=True, export_skins=True, export_animations=False, export_yup=True`.

## Gotchas
- `create_human(feet_on_ground=True)` is required, otherwise the figure floats/sinks relative to the origin (I had it off first: feet ended below the grid).
- MPFB scale factor 0.1 gives metres; `height_tall` is +0.7 m at full influence, so `web/character.js` caps that side with `scale: { pos: 0.45 }` (~+0.3 m). Keep the morph itself unscaled in the GLB.
- glTF morphs move vertices only; the skeleton would stay at bind pose. The build therefore writes `output/base_body.joints.json` (`{"version":1,"bones":{name:[x,y,z]},"morphs":{morph:{bone:[dx,dy,dz]}}}`, glTF Y-up metres, bone names = GLB node names) and engines apply `sum(influence * offset)` to the bones (`applySkeleton` in `web/character.js`).
- Morph target names travel in `mesh.extras.targetNames` and `morphTargetDictionary` in three.js; keep names stable, `web/character.js` depends on them.

## Verify a build
- Inspect the GLB (targets count, accessor min/max per target) with a small Python script; expect 12 targets, 1 skin, 53 joints.
- Render check: `webxr-test` skill (`node check.js --url=... --screenshot=...`); the page exposes `window.__ready` and `window.__set(id, value)` for scripted slider tests.

## Licensing
MPFB code is GPL; MakeHuman base mesh, targets and system assets are CC0, so exported GLBs are unencumbered. Third-party assets (clothes, hair) must be checked individually (prefer CC0).
