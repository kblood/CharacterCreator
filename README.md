# CharacterCreator

Realistic, engine-agnostic 3D character generator.
Blender (headless, MPFB/MakeHuman) builds a rigged base body with morph targets and exports a GLB plus a
JSON sidecar with per-morph joint offsets. Any engine (Three.js here; Unity/Godot/Unreal later) drives
sliders, skeleton and skin colour at runtime.

Live viewer: https://dionysus.dk/webxr/charactercreator/

## Status vs. scope v1

| Scope v1 item | Status |
|---|---|
| Body: height, weight, muscle, proportions, sex, age (morph targets) | **Done** - 12 linearised macro morphs, 6 bipolar sliders. Height range capped (tall ~ +0.3 m instead of +0.7 m). |
| Skeleton follows body morphs (so animation does not distort) | **Done** - `output/base_body.joints.json` sidecar + `applySkeleton()` in `web/character.js`. |
| Skin colour (runtime material baseColor) | **Done** - CC0 skin texture (albedo 2048 px + generated normal map) normalised to grey, tinted at runtime (see "Colour tints"). |
| Standard humanoid rig | **Done** - MPFB `game_engine` rig (53 bones). Retarget test with Mixamo/KayKit clips: **planned**. |
| Animation: idle, walk, run | **Done** - own procedural clips on canonical (VRM-style) joint names, rotations only, adapt to the current body (leg IK keeps feet planted). Baked to `output/animations/*.json` and `output/base_body_anim.glb`. See [docs/ANIMATION_PLAN.md](docs/ANIMATION_PLAN.md). |
| Eyes (+ iris colour), eyebrows, eyelashes, teeth, tongue | **Done** - MakeHuman CC0 assets, fitted to all 12 morphs, rigid on the `head` bone. No blinking / eye movement (rig has no eye or jaw bones). |
| Face sliders | Planned |
| Hair: swappable meshes + hair colour | **Done** - 5 CC0 styles (short, bob, long, ponytail, braid) as on-demand `output/hair_<id>.glb` + `output/hair.json`; colour picker. No hair physics. |
| Clothing: swappable parts fitted to the body | Planned |
| Combined macro interactions (e.g. gender x weight) | Not planned for v1 - morphs are sampled one macro at a time, so extreme combinations can look off. |

Details and the running TODO list: [docs/STATUS.md](docs/STATUS.md).

## Layout

| Path | Contents |
|---|---|
| `blender/` | bpy build scripts (`build_base.py`, `bake_clips.py`; helpers in `blender/tools/`) |
| `output/` | built assets: `base_body.glb` (body + face parts), `base_body.joints.json`, `hair_<id>.glb` + `hair.json`, `base_body_anim.glb` (base + baked clips), `animations/*.json` |
| `web/` | Three.js viewer + slider UI; `character.js` is the engine-agnostic slider -> morph/skeleton mapping; `humanoid.js` + `animation/` = canonical skeleton, clips, animator |
| `tools/` | node scripts: `sample_clips.mjs` (clips -> JSON), `check_anim_glb.mjs` (validates the baked GLB), `glb.mjs` (GLB reader for tests/tools) |
| `tests/` | `node --test` tests (`assets.test.mjs` checks the built face/hair assets in `output/`) |
| `docs/` | `BLENDER_WORKFLOW.md` (how the build works, gotchas), `STATUS.md`, `ANIMATION_PLAN.md` (pose convention, contracts) |
| `build/` | generated, git-ignored: staging site `build/site/`, MakeHuman asset pack `build/mh_assets/`, prepared textures `build/textures/`, `.blend` snapshot `build/blend/` |

## Build the assets

Requires Blender 5.2 (portable at `C:\Tools\Blender`) with the MPFB 2 extension installed
(see [docs/BLENDER_WORKFLOW.md](docs/BLENDER_WORKFLOW.md) for the install workaround).

```powershell
python blender\tools\fetch_mh_assets.py      # once: MakeHuman CC0 system asset pack (280 MB download) -> build\mh_assets
C:\Tools\Blender\blender.exe -b --python blender\build_base.py -- output\base_body.glb
python blender\tools\check_glb.py            # must end with CHECK OK
```

Writes `output/base_body.glb`, `output/base_body.joints.json`, `output/hair_<id>.glb` + `output/hair.json`
(and a .blend snapshot in `build/blend/`). `--no-assets` builds the old bare body with a flat material.
Blender output is noisy; look for the `BUILD ...` lines.

Size (2026-09-30): `base_body.glb` 7.43 MB (1.1 MB of it textures), hair 0.89-1.65 MB per style. The viewer
loads the base + the default hair = ~8.5 MB; other styles are fetched only when picked, which is why hair is not
inside the base GLB (all 5 styles would add 6.3 MB to every first load).

## Colour tints

Tintable materials (Skin, Iris, Eyebrow, Eyelash, Hair_*) carry glTF material extras
`{"tint": {"gain": g, "default": "#rrggbb"}}` (three.js: `material.userData.tint`). Their textures are
normalised at build time to a neutral grey with linear mean `1/g` (skin per channel, the others by luminance),
so `baseColor = tint (linear) * g` renders on average exactly the picked colour while the texture keeps
its detail (pores, lips, strands, iris fibres). The GLB's own baseColorFactor is the default tint (clamped to 1).
Engines without this: set `baseColor = tint * gain` yourself (`applyTint` in `web/character.js`).

## Run locally

```powershell
New-Item -ItemType Directory -Force build\site | Out-Null
Copy-Item web\* build\site -Recurse -Force; Copy-Item output\*.glb, output\*.json build\site -Force
python -m http.server -d build\site 8000    # open http://localhost:8000/
```

(`.\deploy.ps1 -StageOnly` does the same staging.) The page needs HTTP (not `file://`) because it loads the
GLB and ES modules. For scripted tests it exposes `window.__ready` and `window.__set(id, value)` (ids: the
sliders, `skin`, `eyeColor`, `hairColor`, `browColor`, and `hair` = style id or `none`, which returns a
promise), `window.__hairState()`, `window.__view(name)`, `window.__anim` / `window.__animProbe()`, and the URL
params `?anim=walk&animT=0.3&animSpeed=1.5` (animT = seek + pause), `?hair=long01|none`,
`?view=front|side|back|face|eyes|mouth|face34|faceSide|headBack`, `?lang=en`.

## Tests and baking the animations

```powershell
node --test "tests/*.test.mjs"              # Node 24; quotes needed. One three.js test is skipped unless THREE_DIR points at a three package
node tools/sample_clips.mjs                 # clips -> output/animations/*.json (60 fps default)
# fresh .blend of the base body into a scratch folder (never into output/), then bake:
C:\Tools\Blender\blender.exe -b --python blender\build_base.py -- <scratch>\base_body.glb --blend <scratch>\base_body.blend
C:\Tools\Blender\blender.exe -b --python blender\bake_clips.py -- --blend <scratch>\base_body.blend
node tools/check_anim_glb.mjs               # must end with CHECK OK
```

Re-run `sample_clips.mjs` + bake whenever `web/animation/clips.js` changes.

## License

Short version (full table in [LICENSE-NOTES.md](LICENSE-NOTES.md)):

- **MPFB 2** is GPL-3.0 code. It runs inside Blender at build time only and is not part of this repo or the output.
- **MakeHuman base mesh, targets, rig and weights** and the shipped **skin texture, eyes, eyebrows,
  eyelashes, teeth, tongue and 5 hair styles** (MakeHuman CC0 system pack, verified per asset by the build)
  are **CC0**, so the exported `output/*.glb` / `*.json` are free to use, including commercially, with no
  attribution required.
- **three.js** is MIT.
- Future clothing/texture assets: check each one's license (prefer CC0) and list it in LICENSE-NOTES.md.
- The repo's own scripts have no license file yet.
