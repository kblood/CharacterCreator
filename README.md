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
| Skin colour (runtime material baseColor) | **Done** - flat colour; no skin texture yet. |
| Standard humanoid rig | **Done** - MPFB `game_engine` rig (53 bones). Retarget test with Mixamo/KayKit clips: **planned**. |
| Face sliders, eyes/teeth/eyebrows | Planned |
| Hair: swappable meshes + hair colour | Planned |
| Clothing: swappable parts fitted to the body | Planned |
| Combined macro interactions (e.g. gender x weight) | Not planned for v1 - morphs are sampled one macro at a time, so extreme combinations can look off. |

Details and the running TODO list: [docs/STATUS.md](docs/STATUS.md).

## Layout

| Path | Contents |
|---|---|
| `blender/` | bpy build scripts (`build_base.py`; helpers in `blender/tools/`) |
| `output/` | built assets: `base_body.glb`, `base_body.joints.json` (committed) |
| `web/` | Three.js viewer + slider UI; `character.js` is the engine-agnostic slider -> morph/skeleton mapping |
| `docs/` | `BLENDER_WORKFLOW.md` (how the build works, gotchas), `STATUS.md` |
| `build/` | generated, git-ignored: local staging site `build/site/` |

## Build the assets

Requires Blender 5.2 (portable at `C:\Tools\Blender`) with the MPFB 2 extension installed
(see [docs/BLENDER_WORKFLOW.md](docs/BLENDER_WORKFLOW.md) for the install workaround).

```powershell
C:\Tools\Blender\blender.exe -b --python blender\build_base.py -- output\base_body.glb
```

Writes `output/base_body.glb` and `output/base_body.joints.json` next to it. Blender output is noisy;
look for the `BUILD ...` lines.

## Run locally

```powershell
New-Item -ItemType Directory -Force build\site | Out-Null
Copy-Item web\* build\site -Recurse -Force; Copy-Item output\*.glb, output\*.json build\site -Force
python -m http.server -d build\site 8000    # open http://localhost:8000/
```

The page needs HTTP (not `file://`) because it loads the GLB and ES modules. For scripted tests it exposes
`window.__ready` and `window.__set(id, value)`.

## License

Short version (full table in [LICENSE-NOTES.md](LICENSE-NOTES.md)):

- **MPFB 2** is GPL-3.0 code. It runs inside Blender at build time only and is not part of this repo or the output.
- **MakeHuman base mesh, targets, rig and weights** are **CC0**, so the exported `output/*.glb` / `*.json`
  are free to use, including commercially, with no attribution required.
- **three.js** is MIT.
- Future hair/clothing/texture assets: check each one's license (prefer CC0) and list it in LICENSE-NOTES.md.
- The repo's own scripts have no license file yet.
