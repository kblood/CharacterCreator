# glTF export

The viewer can save the configured character as one binary glTF 2.0 file (`.glb`): body, face parts, hair and the
worn garments on one skeleton, optionally with all animation clips fitted to that body. The same panel saves and
loads the character as a small settings JSON, and the same JSON can go in a share link.

Code: `web/export/exporter.js` (browser: UI, scene build, three.js `GLTFExporter` r170), `web/export/util.js`
(pure: settings, options, tint maths, names, credits, bone table), `web/export/glbpack.js` (pure: GLB post-processing).
Tests: `tests/export.test.mjs`.

## Options

UI: section "Eksport" / "Export" (above Reset). Scripted: `await window.__export(options)` returns an `ArrayBuffer`.
Unknown keys are ignored; the defaults are in `EXPORT_DEFAULTS` (`web/export/util.js`).

| Option (UI) | Key | Values (default first) | What it does |
|---|---|---|---|
| Form / Shape | `shape` | `baked`, `morphs` | **baked**: the current slider values are added into the vertices (positions and normals) and the bones sit where `applySkeleton` puts them. The bind matrices match those bone positions. Only the dynamic morphs stay as shape keys: `blink_*`, `look_*` and, on a female adult body, `dyn_breast_*`, all at weight 0. **morphs**: all 92 targets are kept, and their default weights are the current slider influences, so the file opens looking like the viewer. The skeleton is the current body's. Moving the morphs alone does **not** move the bones: an engine that drives sliders must also run the joint offsets from `base_body.joints.json` (see `applySkeleton` in `web/character.js`). |
| Positur / Pose | `pose` | `rest`, `current` | `current` writes the viewer's current animation frame as the node pose (rotations, plus the Root offset). The skin keeps the rest bind pose, so the mesh deforms correctly in any engine. |
| Animationer / Animations | `animations` | `none`, `all`, or an array of clip names | Samples every clip in `web/animation/clips.js` for **this** body, using the same `makeContext(measure(humanoid))` the animator uses, so the clips are fitted to the leg length and hip height. Bone tracks are rotation only. `Root` gets a translation track: the pelvis bob plus the animator's ground lift. |
| Billeder pr. sekund / FPS | `fps` | 60, 30 (5-120) | Key rate. Between keys at 30 fps, linear interpolation strays up to ~15 mm in walk; at 60 fps it is ≤ 4 mm (see Verification). Quaternions are sign-continuous. A track whose value never changes is written with 2 keys. |
| Teksturstørrelse / Texture size | `textureSize` | 0 (original), 1024, 512 | Longest image edge. Normal maps are scaled too. |
| Tøj, Hår, Øjne, Tænder, Tunge, Øjenbryn, Øjenvipper | `clothing`, `hair`, `eyes`, `teeth`, `tongue`, `brows`, `lashes` | true | Include or leave out each part. The body is always included. Only the garments being worn are written. |
| Fjern skjult hud / Remove hidden skin | `removeHiddenSkin` | true | true: body and underwear triangles hidden under worn clothing are dropped, as is a garment that is fully covered. false: the full meshes are written, with `_CCZONE` (see below) and `ccHiddenZones` so the engine can hide them itself. |
| Saml i ét mesh / Merge into one mesh | `merge` | false | One node, "Character", holding one primitive per part (each with its own material). Otherwise there is one node per part, and the three eye primitives form one mesh "Eyes". |
| (script only) | `dynamicMorphs` | true | baked: keep blink, look and breast-motion shape keys. |
| (script only) | `quantize` | auto | int16 morph deltas (`KHR_mesh_quantization`). Auto turns it on for `morphs` mode only. |
| (script only) | `pinAsColor` | false | Also write the cloth pin mask as `COLOR_0` (note: engines may tint the garment with it). |

Progress is shown in the panel. The export runs on the main thread in short steps that yield between parts and
materials. A Web Worker cannot help here because `GLTFExporter` needs the scene and canvas textures. Typical
times in headless Chrome are 2-9 s. The page keeps rendering, but it stutters during the encode.

## Settings JSON, share link, restore

- **Gem indstillinger (JSON) / Save settings (JSON)**: downloads `character_<sex>.json`. Its format is
  `{"format": "charactercreator.character", "version": 1, sex, values, colors, hair, outfit, clothColors}`.
- **Indlæs indstillinger... / Load settings...**: accepts either that JSON or an exported `.glb`. A GLB is read from
  `extras.characterCreator.settings`, so a GLB made by the viewer also serves as a save file.
- **Kopiér delingslink / Copy share link**: `?character=<base64url JSON>` (~1 kB).
- `?character=` accepts base64url JSON, inline JSON (`?character={"sex":"female",...}`) or a URL ending in
  `.json` (absolute, `./` or `/` relative).
- Scripted: `window.__exportSettings()` returns the settings, `await window.__loadSettings(obj)` applies them, and
  `window.__shareLink()` returns the link.
- Settings are validated before use:
  - sliders are clamped to -1..1;
  - colours must be `#rrggbb`;
  - ids must match `[A-Za-z0-9_-]`;
  - a wrong format or version throws.
- The outfit is restored as given. If it holds no underwear, the default underwear is switched off.

## File structure

```
scene "Character"   extras.characterCreator.settings
├─ Armature (node; the viewer's armature transform, identity for the built body)
│   └─ Root (joint 0; -90° X = MPFB Z-up -> glTF Y-up) ─ pelvis ─ spine_01 ... (53 joints, MPFB game_engine names)
├─ Body             SkinnedMesh, skin 0
├─ Eyes             3 primitives (Eye, Iris, Cornea)
├─ Eyebrows, Eyelashes, Teeth, Tongue
├─ Hair_<style>
└─ Cloth_<id> ...   one per worn garment
```

- **Skin and nodes.** All meshes share **one skin**. GLTFExporter writes one skin per mesh; `glbpack.dedupeSkins`
  merges the identical ones. Skinned mesh nodes sit at the scene root, as glTF recommends; their parent transforms
  are ignored anyway.
- **Units and axes.** Metres, Y up, and the character faces +Z. Names are engine-safe (`[A-Za-z0-9_.-]`) and unique.
- **Vertex attributes.**
  - `POSITION`, `NORMAL`, `TEXCOORD_0`, `JOINTS_0` (u16) and `WEIGHTS_0` (float, renormalised to sum exactly 1) are
    written as plain float or unsigned data.
  - Morph deltas are written as sparse accessors when that is smaller. An all-zero target has no bufferView.
    Identical targets share one accessor.
  - Morph mode adds int16 normalised deltas through `KHR_mesh_quantization`, which is then *required*.
  - Morph names are in `mesh.extras.targetNames` (three.js, Blender and Godot read it).
- **Custom attributes.**
  - `_CLOTH_PIN` (float, 1 = follows the skin, 0 = free cloth) is on the cloth garments (coat, skirt).
  - `_CCZONE` (body zone id per vertex) is written only when hidden skin is kept.
  - The viewer-only `_CCHAIR` and `_CCEDGE` (hair shader) and `_CCCOLLAR` (coat collar runtime) are not exported.
- **Materials.** Every material is `pbrMetallicRoughness` and keeps its normal map, `doubleSided`, and alpha mode:
  `MASK` with cutoff for brows, lashes and hair; `BLEND` only where the viewer really blends.
  - The runtime tint is baked: `baseColorFactor = min(1, tint)` per channel.
  - Where the tint exceeds 1, the rest is baked into a copy of the texture. Textures are normalised to grey with a
    gain, so the skin tint is usually > 1.
  - Garments with a secondary colour always get a baked texture: texel × mix(primary, secondary, mask) / factor.
  - The maths is `planTint` / `bakeTintPixels` and is tested.
  - Baked copies are JPEG, or PNG when the material has alpha. Untouched textures keep their original encoding.
  - ImageBitmaps go through a 2D canvas.

### Extras contract

| Where | Key | Content |
|---|---|---|
| root `extras.characterCreator` | `format`, `version` | `"charactercreator.export"`, 1 |
| | `settings` | the settings JSON (see above); `sex`, `values`, `outfit`, `hair`, `colors` (+ `colors.clothing`) repeated for convenience |
| | `export` | the normalised export options; `animations` = the clip names written |
| | `units`, `rig`, `rootBone`, `humanoid` | metres / Y-up / +Z forward, `mpfb-game_engine`, `Root`, the bone table below |
| | `notInExport` | the viewer features that are not in the file |
| | `credits` | `{summary, licenseNotes, sources: [{part, asset, license, author?, source}]}` from `asset_licenses.json`, `hair.json`, `clothing.json` |
| `asset` | `generator`, `copyright` | `CharacterCreator glTF export v1 (three.js GLTFExporter r170)`, licence summary (CC0 + project output) |
| scene `extras.characterCreator.settings` | | settings, for tools that only read the scene |
| node + mesh `extras` (garment) | `ccClothing`, `ccSlot`, `ccLayer` | catalogue id, slot, layer |
| | `ccCloth` | cloth params as in the garment GLBs ([CLOTH_SPEC.md](CLOTH_SPEC.md)); with `_CLOTH_PIN` |
| node + mesh `extras` (Body) | `ccJiggle` | female adult only: the breast spring setup (`driverBone`, `morphs` = the `dyn_breast_*` names, `params`, current `runtime` scale) ([BREAST_PHYSICS.md](BREAST_PHYSICS.md)) |
| | `ccBodyZones`, `ccHiddenZones`, `ccHiddenSkin` | zone table, zones hidden by the outfit, `"removed"` or how to use `_CCZONE` |
| merged / Eyes | `ccParts` | the parts in primitive order (`name`, `kind`, `material`, clothing fields, `ccCloth`) |
| `animations[i].extras` | `loop`, `next`, `events` | as `output/animations/*.json` ([ANIMATION_CLIPS.md](ANIMATION_CLIPS.md)); `events` in seconds |
| | `rootMotion` | `{mode: "in-place", speed, axis, stride}`: the travel is **not** baked; move the character at `speed` m/s along `axis` |
| | `fps`, `fittedTo` | key rate and the `legLength` / `hipHeight` the clip was fitted to |

**Hidden skin: what we chose and why.** By default the hidden triangles are **removed**. The file is then smaller,
nothing pokes through in engines with a different skinning precision, and it is what the viewer draws. If you want
outfits you can change in the engine, export with "remove hidden skin" off. You then get the full body and
underwear, with `_CCZONE` per vertex and `ccHiddenZones`. Drop the triangles whose three vertices are all in a
hidden zone, which is the viewer's rule (`web/clothing.js`).

## Import notes

- **Blender (verified, 5.2).**
  - File > Import > glTF 2.0, with the defaults.
  - The result is one armature with 53 bones; every mesh is parented to it with an Armature modifier and 53
    vertex groups.
  - Shape keys come from `targetNames`. There is one action per clip (`walk`, `run`, ...).
  - `_CLOTH_PIN` and `_CCZONE` arrive as mesh attributes. `extras` arrive as custom properties: scene
    `characterCreator`, plus object and mesh props such as `ccCloth` and `ccClothing`.
  - The importer adds an "Icosphere" bone-shape object; ignore it.
  - Set the scene to 60 fps, because the keys sit at fractional frames at 24 fps.
- **Unity (not verified).**
  - Use glTFast or UniGLTF. They need `KHR_mesh_quantization` for morph mode; glTFast supports it.
  - Set the rig to Humanoid and map the bones with the Unity column below. The automatic mapping usually finds
    the UE4 names.
  - Animations import as legacy or generic clips. Apply root motion yourself from `rootMotion`.
- **Godot 4 (not verified).**
  - Imports natively, including `KHR_mesh_quantization`.
  - For retargeting, use the Skeleton3D BoneMap with SkeletonProfileHumanoid; the Godot names are in the table.
  - Blend shapes keep their names. Whether `extras` arrive as node metadata depends on the Godot version and its
    import options.
- **Unreal 5 (not verified).**
  - Import the glTF as a skeletal mesh. The bone names are the UE4 mannequin names, so the IK Retargeter maps them
    to Manny/Quinn almost one to one.
  - Baked mode needs no morph targets except blink and look.
  - Scale: the file is in metres; check the import scale, because Unreal works in centimetres.
- **three.js.** `GLTFLoader` loads the file as it is. `mesh.morphTargetDictionary` comes from `targetNames`.

## Bone mapping

`Root` (not humanoid) carries the axis rotation and the clip's `Root` translation. The other 52 bones:

| VRM / canonical | glTF node (export) | Unity HumanBodyBones | Godot SkeletonProfileHumanoid | Mixamo |
|---|---|---|---|---|
| hips | pelvis | Hips | Hips | mixamorig:Hips |
| spine | spine_01 | Spine | Spine | mixamorig:Spine |
| chest | spine_02 | Chest | Chest | mixamorig:Spine1 |
| upperChest | spine_03 | UpperChest | UpperChest | mixamorig:Spine2 |
| neck | neck_01 | Neck | Neck | mixamorig:Neck |
| head | head | Head | Head | mixamorig:Head |
| leftShoulder | clavicle_l | LeftShoulder | LeftShoulder | mixamorig:LeftShoulder |
| leftUpperArm | upperarm_l | LeftUpperArm | LeftUpperArm | mixamorig:LeftArm |
| leftLowerArm | lowerarm_l | LeftLowerArm | LeftLowerArm | mixamorig:LeftForeArm |
| leftHand | hand_l | LeftHand | LeftHand | mixamorig:LeftHand |
| leftThumbMetacarpal | thumb_01_l | LeftThumbProximal | LeftThumbMetacarpal | mixamorig:LeftHandThumb1 |
| leftThumbProximal | thumb_02_l | LeftThumbIntermediate | LeftThumbProximal | mixamorig:LeftHandThumb2 |
| leftThumbDistal | thumb_03_l | LeftThumbDistal | LeftThumbDistal | mixamorig:LeftHandThumb3 |
| leftIndexProximal | index_01_l | LeftIndexProximal | LeftIndexProximal | mixamorig:LeftHandIndex1 |
| leftIndexIntermediate | index_02_l | LeftIndexIntermediate | LeftIndexIntermediate | mixamorig:LeftHandIndex2 |
| leftIndexDistal | index_03_l | LeftIndexDistal | LeftIndexDistal | mixamorig:LeftHandIndex3 |
| leftMiddleProximal | middle_01_l | LeftMiddleProximal | LeftMiddleProximal | mixamorig:LeftHandMiddle1 |
| leftMiddleIntermediate | middle_02_l | LeftMiddleIntermediate | LeftMiddleIntermediate | mixamorig:LeftHandMiddle2 |
| leftMiddleDistal | middle_03_l | LeftMiddleDistal | LeftMiddleDistal | mixamorig:LeftHandMiddle3 |
| leftRingProximal | ring_01_l | LeftRingProximal | LeftRingProximal | mixamorig:LeftHandRing1 |
| leftRingIntermediate | ring_02_l | LeftRingIntermediate | LeftRingIntermediate | mixamorig:LeftHandRing2 |
| leftRingDistal | ring_03_l | LeftRingDistal | LeftRingDistal | mixamorig:LeftHandRing3 |
| leftLittleProximal | pinky_01_l | LeftLittleProximal | LeftLittleProximal | mixamorig:LeftHandPinky1 |
| leftLittleIntermediate | pinky_02_l | LeftLittleIntermediate | LeftLittleIntermediate | mixamorig:LeftHandPinky2 |
| leftLittleDistal | pinky_03_l | LeftLittleDistal | LeftLittleDistal | mixamorig:LeftHandPinky3 |
| leftUpperLeg | thigh_l | LeftUpperLeg | LeftUpperLeg | mixamorig:LeftUpLeg |
| leftLowerLeg | calf_l | LeftLowerLeg | LeftLowerLeg | mixamorig:LeftLeg |
| leftFoot | foot_l | LeftFoot | LeftFoot | mixamorig:LeftFoot |
| leftToes | ball_l | LeftToes | LeftToes | mixamorig:LeftToeBase |
| right* | *_r | Right* | Right* | mixamorig:Right* (same pattern as left) |

The full table, both sides, is in every export at `extras.characterCreator.humanoid` and comes from
`humanoidBoneTable()` in `web/export/util.js`. Mixamo clips use a different rest pose (T-pose) and a different bone
roll. Retarget them; don't copy the rotations directly.

## Licence and credits

Everything in an export is either CC0 or the project's own output:
- the MakeHuman base mesh, targets, rig and weights, and the skin, eyes, brows, lashes, teeth, tongue and hair from
  the MakeHuman system pack;
- the CC0 MakeHuman garments, and the garments and garment parts generated by this project;
- the joint offsets, corrective and eye/breast morphs, and the animation clips.

`asset.copyright` holds the summary, and `extras.characterCreator.credits.sources` lists the actual parts in the
file with licence and source (no machine paths). The full table is in [LICENSE-NOTES.md](../LICENSE-NOTES.md).
Attribution is not required.

## Known limitations

- **Plain PBR only.** These viewer shaders are not exported:
  - the skin SSS, wrap lighting, pores and region tones;
  - the hair root-to-tip gradient, hairline fade and capsule push-out;
  - the garment lining colour on back faces (glTF has no back-face colour);
  - the eye catchlight.
  The baked tints reproduce the viewer's **unlit** albedo (texel × tint), so lit colours differ by shader.
- **No tangents.** The normal maps come without `TANGENT`, as in the source GLBs. The validator warns
  `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE`, and the spec says the importer then computes MikkTSpace tangents
  (Blender, Unity and Godot do).
- **No live simulation.** Cloth and breast physics are not simulated in the file; their data is in `extras`. The
  garments are written in the skinned rest shape (or in the current frame's skinned shape with `pose: current`),
  not in the cloth-simulated shape.
- **Clips fitted at export time.** Each clip is fitted to the body at export time. Changing the morphs of a morph-mode
  export afterwards does not refit the clips or move the bones.
- **No root travel in the clips.** Root motion stays in place; the travel is in `rootMotion`.
- **File size.** Morph mode is 9-11 MB, which is the 92 targets × every part. Baked mode is 2.5-6 MB.

## Verification (2026-10-01)

Ten configurations were exported in headless Chrome (swiftshader) and checked three ways:
- with the Khronos glTF-Validator (npm `gltf-validator`);
- re-imported with three.js `GLTFLoader` in the same page and compared against the live viewer;
- imported into Blender 5.2 headless.

Configurations:
1. male default, baked
2. male default, morphs
3. female (breast 0.8, age 0.2), baked
4. hoodie + jeans + shoes (height 0.8, weight 0.5, muscle -0.3, nose 0.6), baked
5. coat + T-shirt + jeans + shoes, baked + all clips
6. female, long hair, skirt + shirt (blue/white), morphs + all clips, 1024 px textures
7. 512 px textures
8. pose = current frame of walk at 0.3 s
9. merged, hidden skin kept
10. body only

| Check | Result |
|---|---|
| glTF-Validator | 0 errors in all 10. Warnings: only `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` (1-5 per file, one per normal-mapped primitive). Infos: unused `TEXCOORD_0` on the untextured cornea, NPOT eye texture. |
| three.js re-import vs viewer (CPU skin + morph, world space) | max vertex deviation ≤ 0.001 mm in all configurations, every part; 53 bones, 1 skeleton; morph counts 6-12 (baked) / 92 (morphs) |
| three.js clips vs the viewer animator (bone world positions, 12 clips) | on keys 0.000 mm; between keys at 60 fps max 0.8 mm (walk), 1.3-1.6 mm (run), ≤ 5.5 mm (walk_back, strafe), pelvis height ≤ 0.3 mm |
| Blender 5.2 import vs viewer | 1 armature, 53 bones, every mesh with Armature modifier + 53 groups; max vertex deviation 0.001 mm (rest and `pose: current`); bones 0.0005 mm |
| Blender actions vs viewer animator (walk, run, jump, idle_look, half-way between keys) | max bone deviation 3.4 mm (walk), 2.9 mm (run), 0.8 mm (jump), 0.004 mm (idle_look); pelvis height ≤ 0.34 mm (Blender interpolates quaternions per component) |
| Blender renders (EEVEE) | male default, female in underwear, hoodie + jeans, coat at walk 0.3 s, female skirt + shirt: textures, tints, alpha cards and normals look like the viewer |
| UI | export button download, save JSON, load JSON and load GLB (settings round trip identical), share link in a fresh page (identical) |

Sizes:

| Configuration | Size |
|---|---|
| male default, baked | 3.59 MB |
| morphs | 9.37 MB |
| female, baked | 3.70 MB |
| hoodie, baked | 3.91 MB |
| coat + 12 clips | 5.43 MB |
| female, morphs + clips, 1024 px | 10.42 MB |
| 512 px | 2.46 MB |
| current pose | 3.90 MB |
| merged | 3.76 MB |
| body only | 1.71 MB |
