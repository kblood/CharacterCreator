# MakeHuman / MPFB clothing ecosystem vs. our planned outside-author kit

Research date: 2026-10-02. Labels: VERIFIED = read on the cited page/source (via a fetch tool that summarises pages, so wording may be paraphrased); INFERRED = my deduction; UNKNOWN = not found.
Pages that returned 404 or only navigation: oldsite mhclo doc, makeclothes sub-pages, assetfileformats.html (nav only), rigging_clothes.html.

## 1. Clothing format (.mhclo / .mhmat / .mhw)
- VERIFIED: In MPFB every attachment (clothes, hair, eyes, teeth...) is an MHCLO asset = "a mesh object combined with instructions on how a vertex on the asset should be matched with a vertex on the Basemesh". https://static.makehumancommunity.org/mpfb/docs/assets/concept_clothes_hair_bodyparts.html
- VERIFIED (MPFB parser source): header keys basemesh, name, uuid, obj_file, material (.mhmat), vertexboneweights (.mhw), z_depth (int, default 50), tag (comma list, lowercase), max_pole; comment lines "# author", "# license", "# description"; x_scale/y_scale/z_scale lines "<vertA> <vertB> <float>"; section "verts 0" where each line is either a single basemesh vertex index (exact match) or "v0 v1 v2 w0 w1 w2 d0 d1 d2" (3 basemesh verts, barycentric weights, XYZ offset); section "delete_verts" with indices or "a - b" ranges. Y/Z are flipped on serialisation. https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/src/mpfb/entities/clothes/mhclo.py
- VERIFIED: the parser does minimal validation (file existence only, no format strictness). Same source.
- VERIFIED: basemesh "hm08" has been unchanged for more than a decade and always has identical vertex/face count regardless of shape; clothes bind to it plus helper geometry. https://static.makehumancommunity.org/mpfb/docs/assets/concept_basemesh_and_helpers.html
- VERIFIED: clothes deform with sliders; after changing the basemesh you must "refit assets" (or enable auto refit). https://static.makehumancommunity.org/mpfb/docs/assets/concept_clothes_hair_bodyparts.html
- VERIFIED: MPFB fit_clothes_to_human() refits using shape keys + scale; interpolate_weights() copies rig weights basemesh->clothes through the MHCLO vertex mapping; update_delete_group() maintains delete groups. https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/src/mpfb/services/clothesservice.py
- INFERRED: the format is stable in practice (same base mesh for 10+ years, shared by MakeHuman and MPFB), but there is no versioned formal spec I could read; the code is the de facto spec.
- UNKNOWN: whether a normative written spec exists (assetfileformats.html https://static.makehumancommunity.org/assets/assetfileformats.html returned navigation only; old wiki page 404). Details of .mhmat and .mhw syntax: UNKNOWN (not read).

## 2. MPFB 2 clothes authoring workflow
- VERIFIED: all tools are inside MPFB: MakeClothes, MakeTarget, MakeSkin (materials/.mhmat), MakeWeight and MakeRig (advanced), MakePose. https://static.makehumancommunity.org/mpfb/docs/assets/asset_creation_intro.html
- VERIFIED workflow: build cross-reference cache once; extract a template from the human using the "helper-tights" vertex group; edit mesh; create material via MakeSkin; fill metadata + generate UUID; "check" basemesh and clothes object, then "store in library"; restart Blender to see it in the apply-assets panel. https://static.makehumancommunity.org/mpfb/docs/assets/creating_clothes.html
- VERIFIED constraints: all faces same vertex count (tris or quads, not mixed); every vertex belongs to exactly one vertex group. Same page. Template extraction and mesh editing are manual; the check is semi-automated.
- VERIFIED: docs list sub-pages for modeling clothes, vertex groups, delete groups, materials (I could not read them). https://static.makehumancommunity.org/mpfb/docs/assets.html
- VERIFIED: clothes weights are produced by interpolation from the body (clothesservice above). The creating_clothes page itself does not discuss rigging.
- UNKNOWN: whether stored assets are weighted for our 53-bone game_engine rig out of the box (our cc_clothing.py presumably handles that).

## 3. Community asset library
- VERIFIED: asset packs/repositories use CC0 and CC-BY only; system assets CC0; some clothing packs are CC-BY. Packs are zips of "checked" assets from MakeHuman and the asset repositories. https://static.makehumancommunity.org/assets/assetpacks/index.html , https://static.makehumancommunity.org/assets/assetpacks/faq.html
- VERIFIED: "checked" = opened in MPFB2 and MakeHuman and cursorily inspected for obvious breakage; third-party assets are not modified by the dev team; issues go to the author. https://static.makehumancommunity.org/assets/assetpacks/faq.html
- VERIFIED: 50+ packs listed (clothes, hair, shoes, poses, materials...). https://static.makehumancommunity.org/mpfb/docs/assets.html . Exact item count: UNKNOWN.
- VERIFIED: licence/author live as comment lines in the .mhclo and MPFB copies them into object properties (set_makeclothes_object_properties_from_mhclo). Sources in sections 1-2. Free text; INFERRED no enforcement.
- UNKNOWN: the upload/review/submission procedure for user-contributed assets. No automated licence enforcement found.
- VERIFIED caveat: core assets are CC0; third-party assets keep their own licence and the user must fulfil it. https://static.makehumancommunity.org/mpfb/faq/use_in_closed_source.html , https://static.makehumancommunity.org/oldsite/faq/what_do_i_need_to_do_when_i_use_a_ccby_asset.html
- INFERRED: before Sept 2020 assets defaulted to AGPL, afterwards CC0 (https://static.makehumancommunity.org/oldsite/faq/what_changed_regarding_the_license_in_2020.html); old uploads may carry an older licence line, so check each file.

## 4. Linters / validators
- VERIFIED: only mesh_is_valid_as_clothes() in MPFB (vertex groups, face consistency, scale alignment) behind the "check" button; the .mhclo parser does not validate. Sources above.
- VERIFIED: the "checked" flag on packs is a human cursory review.
- UNKNOWN: any standalone CLI validator or CI linter from MakeHuman or the community; my searches found none (INFERRED none exists).

## 5. Plugin system, asset packs, host-app consumption
- VERIFIED: MPFB2 has an "install asset pack" button in library settings (zip with standard folder layout); restart Blender. MakeHuman 1.x: unzip into makehuman/v1py3/data keeping subfolders. https://static.makehumancommunity.org/assets/assetpacks/faq.html
- UNKNOWN: any manifest/versioning/dependency format beyond folder layout. INFERRED none; a pack is just files.
- VERIFIED: MPFB 2.x requires Blender 4.2+. https://github.com/makehumancommunity/mpfb2
- VERIFIED: export is Blender-side. FBX is the documented route; the "GameEngine" rig has "100% mapping for Unity's Mecanim"; "GameEngine" material for texture-based PBR; bake shapekeys + delete helpers; delete-group mask modifiers must be applied or removed; "Export copy" automates this on a duplicate. https://static.makehumancommunity.org/mpfb/docs/exporting.html , https://static.makehumancommunity.org/mpfb/docs/exporting/export_copy.html
- VERIFIED (search summary of the same docs): for glTF use PBR material types and check "apply modifiers".
- UNKNOWN: any Unity/Godot/Unreal importer that reads .mhclo at runtime; none found. INFERRED none mainstream; consumption is via Blender bake to FBX/GLB.

## 6. Limitations relevant to us
- VERIFIED: refit is a Blender-time operation. INFERRED: runtime fitting in an engine does not exist in the ecosystem; baked fit is the only game-engine path.
- Clothes following runtime morph targets in the engine: not documented (docs say bake the basemesh). INFERRED we must produce per-garment morph targets ourselves (cc_clothing.py).
- Cloth physics: none found in MPFB docs (INFERRED none).
- Layering: z_depth (default 50) and delete_verts are the fields (VERIFIED, mhclo.py). A "subtype"/conflict rule system: not found in the parser (only tag). INFERRED no formal conflict rules.
- Other body proportions: offsets/scales are relative to base-mesh vertices, so garments adapt to sliders; extreme shapes can clip and quality varies per author (INFERRED from design plus packs FAQ).
- Game-engine rig clothes: weights are interpolated from the body (VERIFIED interpolate_weights); INFERRED this works for game_engine.

## 7. Licensing facts
- VERIFIED: MPFB code GPL-3.0 (https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/LICENSE.CODE.md); MakeHuman code AGPL; system assets CC0 (https://static.makehumancommunity.org/about/license.html , https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/LICENSE.ASSETS.md).
- VERIFIED: models made with MPFB may be used in closed-source games; third-party assets keep their licence. https://static.makehumancommunity.org/mpfb/faq/use_in_closed_source.html
- INFERRED (not legal advice) safe in our MIT repo: CC0 assets, our own scripts, our own format notes. CC-BY items only with an attribution file. Do not paste MPFB source (GPL-3.0); write our own parser.
- Recommendation: require explicit licence (CC0 / CC-BY / own), author, and source per garment; reject unknown, AGPL, NC.

## Summary table
| Planned capability | Covered by MakeHuman/MPFB? | Still to build | Recommendation |
|---|---|---|---|
| Pack template | Partly: asset-pack folder layout, mhclo header (author, license, tag, uuid) | Pack manifest (id, version, compat with our base/rig, licence list) | Reuse MakeHuman layout + mhclo header; add thin pack.json |
| Fitting tool | Yes: MPFB MakeClothes (template, fit, delete groups, weight interpolation, store) | Pointers in docs; our bake to game_engine rig + morphs (cc_clothing.py) | Reuse MPFB, do not build own |
| Linter CLI | No: only in-Blender mesh_is_valid_as_clothes; parser unvalidated | Standalone checker: mhclo syntax, index ranges, delete_verts, licence/author/uuid, obj tri/quad uniformity, material paths, z_depth, weights | Build (small, own code) |
| Handbook | Partly: MPFB docs/videos cover MakeClothes generally | Our rig/morph/GLB rules | Build thin, link out |
| Licence/provenance | Partly: license/author comment lines, CC0/CC-BY convention; no enforcement | Allowed-licence list, provenance file, CI check, attribution generator | Build (small) |
| Compatibility report | No | Fit/clipping across morph ranges, weight sanity | Build on existing pipeline checks |
