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

## Face assets, hair and textures (build_base.py, after the morph sampling)
- Source: MakeHuman CC0 system pack, fetched once with `python blender/tools/fetch_mh_assets.py [--zip <local zip>]`
  into `build/mh_assets` (git-ignored; override with `--assets` / env `CC_MH_ASSETS`; `--no-assets` = bare body).
- License gate (`check_license`): the pack index `packs/makehuman_system_assets.json` must say CC0 and the
  asset's `.mhclo`/`.mhmat` header must contain "released as CC0"; otherwise the build aborts. The verified list
  is written to `asset_licenses.json` next to the .blend and into `output/hair.json`.
- Each asset is added with MPFB `HumanService.add_mhclo_asset(..., material_type="NONE")` (no subdivision,
  no subrig), then **re-fitted by our own vectorised MHCLO fit** (`MhcloFit`): per vertex
  `sum(w_i * v_i) + offset * scale`, scale from the mhclo scale reference verts (x uses co[0], y uses co[2],
  z uses co[1]; offsets converted to Blender axes as (d0, -d2, d1)). The fit runs on the neutral basemesh and on
  each of the 12 sampled morph meshes (incl. helper geometry, same ground shift dz) -> Basis + 12 shape keys with
  the body's names.
  Gotcha: once our morph shape keys exist, MPFB's own fit snapshot (`from_mix`) is stale (~3-4 cm off); the
  build only prints "MPFB snapshot diff", our neutral fit agrees with MPFB to 3e-8 m on a clean human.
- Weights: eyes/brows/lashes/teeth/tongue rigid 100 % on `head` (the `game_engine` rig has no eye/jaw bones);
  hair keeps MPFB's transferred weights filtered to head, neck_01, spine_02/03, clavicles and renormalised.
- The eye mesh is split by UV into 3 materials: Eye (sclera), Iris (faces inside the iris circle, tintable),
  Cornea (UV island u > 0.8, v < 0.2; BLEND, alpha 0.08).
- Textures (`blender/cc_textures.py`, numpy inside Blender, output `build/textures`): skin albedo 2048 px JPEG,
  normalised per channel to grey mean k (gain = 1/k, k in 0.62..0.72); skin normal map 1024 px from the albedo's
  high-pass luminance + band-passed noise; eye 1024 px with a greyed iris; brows/lashes/hair RGBA PNG
  luminance-only with colour bled into transparent texels. Gains land in material extras `tint {gain, default}`.
- Materials: the exporter cannot express alphaMode/alphaCutoff/extras reliably, so after export
  `blender/tools/glbutil.py patch_materials` rewrites them by material name. The spec is stored in
  `scene["cc_materials"]` in the .blend so `bake_clips.py` patches `base_body_anim.glb` identically.
- Export: base GLB = armature + objects with `cc_export == "base"` (Body + face parts); each hair object
  (`cc_export == "hair"`) goes to its own `output/hair_<id>.glb` (armature included, `export_morph_normal=False`
  to save size) + `output/hair.json` (`version, default, defaultColor, styles[{id,file,label,mesh,bytes,license,source}]`).
  All files sit flat in `output/`, so the deploy staging (`output/*.glb`, `output/*.json`) picks them up.
- Viewer side: GLTFLoader gives every skinned mesh its own Skeleton; `bindToSkeleton` in `web/character.js`
  remaps skinIndex by bone name onto the body's Skeleton so `applySkeleton` and the clips move all parts.

Animation bake (`blender/bake_clips.py`, separate step): opens a fresh `.blend` from `build_base.py --blend`, keys
`output/animations/*.json` as one action per clip (rotations + a Root translation only) and exports
`output/base_body_anim.glb` (Body + face parts, no hair). The default `--blend` of `build_base.py` is
`build/blend/base_body.blend`, so `bake_clips.py -- --blend build/blend/base_body.blend` right after a build
keeps both GLBs consistent. Details/gotchas (slotted actions, frame offset, no forced sampling) in
`docs/ANIMATION_PLAN.md` section 4 D; gate with `node tools/check_anim_glb.mjs`.

## Gotchas
- `create_human(feet_on_ground=True)` is required, otherwise the figure floats/sinks relative to the origin (I had it off first: feet ended below the grid).
- MPFB scale factor 0.1 gives metres; `height_tall` is +0.7 m at full influence, so `web/character.js` caps that side with `scale: { pos: 0.45 }` (~+0.3 m). Keep the morph itself unscaled in the GLB.
- glTF morphs move vertices only; the skeleton would stay at bind pose. The build therefore writes `output/base_body.joints.json` (`{"version":1,"bones":{name:[x,y,z]},"morphs":{morph:{bone:[dx,dy,dz]}}}`, glTF Y-up metres, bone names = GLB node names) and engines apply `sum(influence * offset)` to the bones (`applySkeleton` in `web/character.js`).
- Morph target names travel in `mesh.extras.targetNames` and `morphTargetDictionary` in three.js; keep names stable, `web/character.js` depends on them.

## Verify a build
- `python blender/tools/check_glb.py`: every mesh (Body, Eyes, Eyebrows, Eyelashes, Teeth, Tongue) and every
  hair GLB has the 12 targets and skin 0, hair joints exist in the base skeleton, sidecar == GLB bind pose.
- `node --test "tests/*.test.mjs"` (`tests/assets.test.mjs` checks the fitted assets numerically) and, after a
  bake, `node tools/check_anim_glb.mjs`. Note: Blender writes some morph targets as **sparse** accessors;
  `tools/glb.mjs` handles that (a reader that ignores `sparse` sees weight/muscle as all zeros).
- Render check: `webxr-test` skill (`node check.js --url=... --screenshot=...`); the page exposes `window.__ready` and `window.__set(id, value)` for scripted slider tests.

## Licensing
MPFB code is GPL; MakeHuman base mesh, targets and system assets are CC0, so exported GLBs are unencumbered. The shipped face/hair/skin assets are all from the CC0 system pack and are checked by the build (see above and `LICENSE-NOTES.md`). Third-party assets (clothes, community hair) must be checked individually (prefer CC0).
