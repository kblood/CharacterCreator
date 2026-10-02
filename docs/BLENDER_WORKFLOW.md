# Blender workflow (how this project is built)

## Environment
- Blender 5.2.2 LTS, portable: `<blender>` = the path to its `blender.exe` (not on PATH; no admin needed). Scratch area: `<scratch>\{blend,export,render,scripts}` (a work folder outside the repo).
- Everything is run **headless**: `blender.exe -b --python blender/build_base.py -- <out.glb>`. Blender output is noisy; grep for your own markers (`BUILD ...`).
- Live control is opt-in via blender-mcp (`<tools>\blender-mcp.json`, start Blender with `<tools>\start-blender-mcp.ps1`, launch Claude with `--mcp-config`). Not needed for builds. Its tools all require a `user_prompt` argument. See the global `blender` skill.
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
2. For each morph: set one macro to its extreme, read positions, reset. The delta becomes a plain shape key ("linearised" sampling).
   92 targets per mesh, in this order (`MORPH_KIND`): 16 macro (incl. `breast_cup_min/max`, `breast_firm_min/max` =
   MakeHuman `cupsize` / `firmness` 0 and 1); 26 face (`face_<stem>_decr/_incr`, `FACE_TARGETS`:
   MakeHuman detail targets from MPFB's `data/targets` loaded with `TargetService.load_target(weight=1)` on the
   neutral human, sampled, removed; sided targets load l- and r- together); 2 expression (`blink_left/right`,
   MakeHuman eyelid-closure expression units); 4 look (`look_*`, rigid eyeball rotations about a sphere fit of each
   sclera, 30 deg yaw / 25 deg pitch at weight 1, Eyes mesh only, zero elsewhere); 32 corrective
   (`corr_<A>__<B>` for the pairs in `CORRECTIVE_PAIRS` = sample with both macros set minus neutral minus
   delta(A) minus delta(B); the runtime weight is inf(A) x inf(B)). Face/expression/look/corrective morphs have
   no joint offsets in the sidecar (they would be sub-millimetre or meaningless for bones).
3. `bake_targets` + `shape_key_clear` to drop MPFB's own macro shape keys, then add ours (`Basis` + 92 morphs).
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
  each sampled morph mesh (incl. helper geometry, same ground shift dz) -> Basis + the same 92 shape keys as the
  body (look morphs only move the Eyes).
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
  Skin fixes in UV space (`skin_region_masks`: 3D landmarks of the neutral mesh -> per-vertex weights ->
  `cc_textures.raster`, a barycentric triangle rasteriser, so masks have no gaps): knee/elbow/eye-surround
  redness pulled toward the mean skin, bald-scalp stubble painted to skin, subtle cheek/nose/ear flush. A
  512 px region mask (R = thin parts for back-light transmission, G = areola, B = flush) is embedded as an
  extra image (`glbutil.embed_textures`) and referenced from the Skin material extras `ccRegions.index`; the
  viewer loads it with `parser.getDependency('texture', i)`. The iris is scaled up a little (`iris_scale`).
- Hair vertex attributes (`add_hair_length_attr`): `_CCHAIR` = distance to the head/neck skin (root-to-tip
  gradient, collision weight), `_CCEDGE` = distance to bare skin outside the scalp mask (hairline fade, off by
  default in the viewer).
- Materials: the exporter cannot express alphaMode/alphaCutoff/extras reliably, so after export
  `blender/tools/glbutil.py patch_materials` rewrites them by material name. The spec is stored in
  `scene["cc_materials"]` in the .blend so `bake_clips.py` patches `base_body_anim.glb` identically.
- Export: base GLB = armature + objects with `cc_export == "base"` (Body + face parts); each hair object
  (`cc_export == "hair"`) goes to its own `output/hair_<id>.glb` (armature included, `export_morph_normal=False`
  to save size) + `output/hair.json` (`version, default, defaultColor, styles[{id,file,label,mesh,bytes,license,source}]`).
  8 styles: short02 (default), bob02, long01, ponytail01, braid01, short04, bob01, afro01.
- Size: after export `glbutil.quantize_morphs` rewrites POSITION morph deltas as normalised int16 and NORMAL deltas as int8 (sparse where
  that is smaller) and adds `KHR_mesh_quantization` to `extensionsRequired`
  (three.js GLTFLoader supports it). 92 targets: base 7.23 MB (60 targets were 6.97 MB; 12 float targets used to be 7.43 MB).
  `bake_clips.py` runs the same `embed_textures` + `quantize_morphs` on `base_body_anim.glb`.
  All files sit flat in `output/`, so the deploy staging (`output/*.glb`, `output/*.json`) picks them up.
- Viewer side: GLTFLoader gives every skinned mesh its own Skeleton; `bindToSkeleton` in `web/character.js`
  remaps skinIndex by bone name onto the body's Skeleton so `applySkeleton` and the clips move all parts.

Animation bake (`blender/bake_clips.py`, separate step): opens a fresh `.blend` from `build_base.py --blend`, keys
`output/animations/*.json` as one action per clip (rotations + a Root translation only) and exports
`output/base_body_anim.glb` (Body + face parts, no hair). The default `--blend` of `build_base.py` is
`build/blend/base_body.blend`, so `bake_clips.py -- --blend build/blend/base_body.blend` right after a build
keeps both GLBs consistent. Details/gotchas (slotted actions, frame offset, no forced sampling) in
`docs/ANIMATION_PLAN.md` section 4 D; gate with `node tools/check_anim_glb.mjs`.

## Clothing (blender/cc_clothing.py, after the hair)
- `GARMENTS` lists each item: pack, the connected components to keep (by vertex count), slot/layer/zone,
  colours and cloth settings. Garments are added lowest layer first; each is fitted with MPFB's mhclo fit
  (`add_asset`).
  - The fit is evaluated on every morph sample (`fit_keys`), so all 92 targets are baked like the hair.
  - MPFB's side effects on the basemesh (`Delete.*` vertex group, MASK modifier) are removed after each
    garment.
- Per garment:
  1. delete the unused parts;
  2. orient the normals outward;
  3. clearance: push out of the body and out of the lower layers by 3 mm, per shape (neutral, 12 macros,
     16 corrective corners), then rebuild the deltas.
     - Every connected part of a lower garment is its own collider (the sock inside the shoe must not hide
       the shoe's tongue from the jeans hem: a nearest-surface query returns only one).
     - `wrap` (closed lower garments, the shoes): a shoe vertex whose backward ray hits a face of this garment
       within range, with nothing in front of it, has come out through the middle of that (large) face; the
       face's vertices move out by depth + 3 mm. Up to 3 passes after the push, one after smoothing.
     - `keep_inside` (shoes01 only, shoe + sock in one mesh): a sock vertex outside the shoe, or closer than
       3 mm under it, moves in to 3 mm; a shoe vertex that a sock face bulges past pushes that face in.
       3 passes, per shape. Without it, the sock showed through the shoe sides in patches on wide male bodies;
  4. body zone: delete_verts, limited to skin the garment covers along the skin normal, plus covered skin
     away from the garment edges. Shoes keep the whole list. For a flared garment (the skirt) every fan
     triangle of a hidden body polygon is also checked from its centre (ray along its normal): where it is not
     covered, its vertices stay drawn (8 skin vertices at the crotch, which the flare opened);
  - `sock_weights` (shoes01): each sock vertex takes the inverse-distance blend of the skin weights of its 4
    nearest shoe vertices, fully within 1.5 cm of the shoe, fading to its own weights at 4 cm (the cuff keeps
    following the calf). The MakeHuman weights skinned the sock more to the foot / calf than the shoe around it.
  - `flare` (skirt): the lower skirt is widened radially by up to ×1.15 (smoothstep from floor + 0.75 m down to
    floor + 0.58 m, in the basis and every shape key, no new vertices); a running knee came out through the
    pencil cut;
  5. pin mask + pelvis/thigh weights for the free part;
  6. textures.
- Long coat (`coat_skirt`):
  - the CC0 jacket is cut at the waist (spine_02). A generated skirt runs from just under the jacket to
    8 cm above the floor (`hem="floor+0.08"`):
    - A-line with a slight flare and an open front that opens a little toward the hem;
    - back vent from knee + 4 cm;
    - clearance over the body ramps in over the top 22 cm.
  - a 3-row belt band covers the cut;
  - the new vertices are bound to the nearest body triangle (barycentric + scaled offset) so they get all
    morph targets. Their deltas are then symmetrised over mirror pairs, and the x delta fades out within
    3 cm of the centre line, so the front / vent edges cannot cross at any shape;
  - UVs point at a rectangle of the texture filled with the median jacket cloth colour and a fine twill
    noise.
  - `coat_drop_pockets` (before the skirt): the four chest pocket pieces (UV islands of <= 60 faces in the
    chest band) are deleted, the holes filled, poked and subdivided (30 interior vertices with inverse-distance
    morph offsets and weights of the hole border); face flag `cc_fill` makes `tex_cloth` in-paint their
    shadowed texels from the surrounding cloth. The CC0 collar is not kept (`keep=[1659]`).
- Standing collar + lapels (`coat_collar`, after clearance): the path is the jacket's top boundary loop from
  the back neck centre to the lapel break (`neck_01 - 0.245`). Collar columns (up to the gorge at 140° from the
  back) get 4 rows + a turned-in top edge in a neck frame (height 7.2 cm back / 4.5 cm front, flare 2.4–3 cm);
  lapel columns (notch, then a peaked lapel 7.5 cm wide tapering to 1 cm) lie on the jacket with a rim row
  under the edge. Mirrored to the left half. Bound to body triangles below the head (SynthFit, all 92 morphs,
  deltas symmetrised), weights from the nearest jacket vertex with the head dropped, UVs in the cloth
  rectangle, pin 1, `_CCCOLLAR`. Then a per-shape clearance of the collar (8 mm from the body) and of the
  lapels (2.5 mm over the jacket), and `orient_outward`.
- `hide_lower` (items with `hides_lower`, the coat): T-shirt vertices whose ray along the normal hits a fully
  pinned coat face within 8 cm, >= 3 cm from the coat's open edges, plus one ring, get the coat's zone bit in
  the tee's `_CCZONE` attribute (see CLOTH_SPEC.md).
- Generated underwear (`gen` items briefs / panties / bra, `add_generated`, built after all other garments):
  1. a region field on the body vertices (`underwear_fields`: waist line under `spine_01`, leg line from the
     crotch; bra = cups from the `breast_cup_max` delta + an underbust band) is clipped along 0 (`clip_region`,
     crossings within 20 % of an edge snap to the vertex). It clips per body TRIANGLE with the same diagonal
     as the exported body ((0,1,2) + (0,2,3)): clipping whole quads let the cut polygons pick the other
     diagonal, and the body's ridge came through as square skin dots (review 2026-10-01);
  2. the faces inside are copied from the body with interpolated UVs, the top-4 body bone weights and smooth
     shading (flat shading split every vertex and made the GLB 4x larger);
  3. `SurfaceFit` binds each vertex to a body edge point + offset along the re-computed body normal; `fit_keys`
     bakes all 92 morphs from it;
  4. clearance against the body only (60 % of the offset), body zone = body vertices whose faces are all inside;
  5. procedural knit texture + a trim band in the secondary colour, computed per TEXEL (the rasterised neutral
     3D position; panties / bra: metric distance to the open edges; briefs: to the top opening), antialiased
     over one texel, ~1 mm/texel (`min_mpt`: the bra was 0.72 mm and broke the 0.3 MB budget); the mask is an
     8-bit grey PNG at the albedo's resolution (a JPEG mask rang around the trim and was 4x larger);
  6. `finish_body` → `under_outer` (each underwear vertex ≥ 1 mm under the outer garments at every shape key)
     → `underwear_cover`: the `_CCZONE` bits of the garments covering each underwear vertex.
  Underwear is never in another garment's clearance / `hide_lower` / covered lists (`g.get("gen")`).
- Textures: albedo is grey-normalised per region (primary / secondary) for runtime tinting, JPEG <= 1024 px;
  normal 512 px; mask 256 px (R = secondary weight, material extras `ccMask`; the generated underwear: grey PNG
  at the albedo's size).
- Export: `export_attributes=True` for `_CLOTH_PIN` (garments) and `_CCZONE` (body); three.js sees them
  lowercased.
- Verify: `node tools/cloth_check.mjs [dir]` and `node --test "tests/*.test.mjs"`
  (`tests/clothing.test.mjs`).
  - Build into a scratch dir with `-- <scratch>\base_body.glb --blend <scratch>\base_body.blend`, then run
    `cloth_check` on it before building into `output/`.

## Gotchas
- `create_human(feet_on_ground=True)` is required, otherwise the figure floats/sinks relative to the origin (I had it off first: feet ended below the grid).
- MPFB scale factor 0.1 gives metres; `height_tall` is +0.7 m at full influence, so `web/character.js` caps that side with `scale: { pos: 0.45 }` (~+0.3 m). Keep the morph itself unscaled in the GLB.
- glTF morphs move vertices only; the skeleton would stay at bind pose. The build therefore writes `output/base_body.joints.json` (`{"version":1,"bones":{name:[x,y,z]},"morphs":{morph:{bone:[dx,dy,dz]}}}`, glTF Y-up metres, bone names = GLB node names) and engines apply `sum(influence * offset)` to the bones (`applySkeleton` in `web/character.js`).
- Morph target names travel in `mesh.extras.targetNames` and `morphTargetDictionary` in three.js; keep names stable, `web/character.js` depends on them.

## Verify a build
- `python blender/tools/check_glb.py`: every mesh (Body, Eyes, Eyebrows, Eyelashes, Teeth, Tongue) and every
  hair GLB has the same 92 targets and skin 0, hair joints exist in the base skeleton, sidecar == GLB bind pose.
- `node --test "tests/*.test.mjs"` (`tests/assets.test.mjs` checks the fitted assets numerically) and, after a
  bake, `node tools/check_anim_glb.mjs`. Note: Blender writes some morph targets as **sparse** accessors;
  `tools/glb.mjs` handles that (a reader that ignores `sparse` sees weight/muscle as all zeros), and it
  de-normalises the quantised int8/int16 morph accessors.
- Render check: `webxr-test` skill (`node check.js --url=... --screenshot=...`); the page exposes `window.__ready` and `window.__set(id, value)` for scripted slider tests.

## Licensing
MPFB code is GPL; MakeHuman base mesh, targets and system assets are CC0, so exported GLBs are unencumbered. The shipped face/hair/skin assets are all from the CC0 system pack and are checked by the build (see above and `LICENSE-NOTES.md`). The clothing packs (`shoes01`, `male_casualsuit02`, `male_casualsuit03`, `male_casualsuit04`, `female_elegantsuit01`, `male_casualsuit05`) go through the same CC0 check; the trench coat's lengthening is project-original. Third-party assets (community clothes/hair) must be checked individually (prefer CC0).
