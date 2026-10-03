# SPDX-License-Identifier: GPL-3.0-or-later
"""Clothing for build_base.py (runs inside Blender: bpy + numpy). See docs/BLENDER_WORKFLOW.md "Clothing" and
docs/CLOTH_SPEC.md.

Every garment becomes its own GLB (output/clothing_<id>.glb), skinned to the same 53-bone rig and carrying the
same 92 morph targets as the body, plus an entry in output/clothing.json (slot, layer, conflicts, body zones,
colour slots, license). Pipeline per garment (in layer order, inner garments first):

 1. license gate (pack index + the .mhclo and .mhmat headers must say CC0, like the hair);
 2. MHCLO fit on the neutral basemesh and on every morph sample (build_base.add_asset); then only the wanted
    connected components of the MakeHuman suit are kept (the CC0 pack only has whole outfits: T-shirt + jeans in
    one .obj, blouse + skirt, jacket + shirt + collar + jeans);
 3. trench coat only (project code, coat_skirt): the jacket is cut at the waist, a long skirt (waist to ~8 cm above
    the floor, open front, back vent) and a belt band over the seam are generated; the new vertices get a
    synthetic MHCLO-style binding (nearest body polygon + scaled offset), so they follow every morph with the
    same formula as the rest; before that the chest pocket pieces are removed and their holes filled
    (coat_drop_pockets);
 4. clearance: every vertex near the skin is pushed PUSH m outward along the nearest body normal, then at the
    neutral shape, every macro extreme and every corrective corner the garment is pushed out of the body
    (>= EPS_BODY) and out of every garment of a lower layer (>= EPS_LAYER); corrections are smoothed over the
    mesh and written back into the Basis / morph deltas; the trench coat then gets its standing collar and peaked
    lapels (coat_collar: generated, bound like the skirt, pinned, own clearance pass);
 5. weights: MPFB's interpolated weights; cloth garments (skirt, coat) blend their free part toward a smooth
    pelvis / thigh mix so the legs do not tear the fabric in walk / run;
 6. cloth-ready data (skirt, coat): vertex attribute _CLOTH_PIN (1 = follows the skin, 0 = free cloth) and mesh
    extras ccCloth (docs/CLOTH_SPEC.md); no simulation here;
 7. textures: the used part of the MakeHuman atlas is cropped and normalised to grey (primary and secondary region
    separately) for the runtime tint; a small mask texture (ccMask, R = secondary colour weight) marks the
    secondary region (T-shirt trim/logo, socks, coat belt); the coat's back faces take the secondary colour
    (material extras tint.lining);
 8. body zones: the body vertices the garment covers (MakeHuman delete_verts of the suit, restricted to the kept
    components) become one bit of the body attribute _CCZONE; the viewer drops body triangles whose three
    vertices all carry a hidden bit. Items with hides_lower (the coat) also write their bit into the _CCZONE
    attribute of lower garments they cover (hide_lower), and the viewer drops those garment triangles too.
"""
import json
import math
import os
import re

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc
from mathutils.kdtree import KDTree

PUSH = 0.0015        # m, uniform outward push along the nearest body normal
EPS_BODY = 0.003     # m, minimum garment - skin clearance at every sampled shape
EPS_LAYER = 0.003    # m, minimum clearance over a garment of a lower layer
FIX_RANGE = 0.03     # m, vertices deeper than this inside a collider are assumed to be mis-associated (not moved)
WRAP_BODY_REACH = 0.01  # m, spec wrap_body: deepest skin poke through a garment face that wrap() fixes

SLOTS = ["underwear", "bra", "top", "bottom", "shoes", "outerwear"]
UNDERWEAR_SLOTS = ["underwear", "bra"]
SLOT_LABELS = {"underwear": {"da": "Undertøj", "en": "Underwear"}, "bra": {"da": "Bh", "en": "Bra"},
               "top": {"da": "Overdel", "en": "Top"}, "bottom": {"da": "Underdel", "en": "Bottom"},
               "shoes": {"da": "Sko", "en": "Shoes"}, "outerwear": {"da": "Overtøj", "en": "Outerwear"}}

# keep: vertex counts of the connected parts of the MakeHuman .obj that make this garment.
# layer: fit / draw order (1 innermost; every garment is fitted over all lower-layer garments).
GARMENTS = [
    dict(id="shoes", slot="shoes", layer=1, pack="shoes01", keep=[717, 717, 144, 144], zone="feet", closed=True,
         label={"da": "Sko", "en": "Shoes"}, primary="#6b3f24", secondary="#d9d9d9",
         secondary_from="small_components", roughness=0.55, source_part="shoes01 (shoes + socks)"),
    dict(id="jeans", slot="bottom", layer=2, pack="male_casualsuit04", keep=[886], zone="legs",
         label={"da": "Jeans", "en": "Jeans"}, primary="#3d5f8c", roughness=0.85,
         source_part="jeans of male_casualsuit04"),
    dict(id="skirt", slot="bottom", layer=2, pack="female_elegantsuit01", keep=[395], zone="hips",
         label={"da": "Nederdel", "en": "Skirt"}, primary="#4b4b52", roughness=0.8,
         source_part="skirt of female_elegantsuit01, lower part flared by this project",
         # flare: the lower skirt is widened radially by up to k (smoothstep from `top` down to `bottom`): the
         # pencil cut of the source lay on the thighs, a running knee came out through its front
         # (tools/cloth_integrity.mjs skirt:body); limitSlackPinned: the nearly pinned waist band may lie only this
         # far beyond its skinned shape on the hip / thigh capsules (solver.js limitSlackOf), so it stays under the
         # T-shirt hem (tshirt:skirt)
         flare=dict(k=0.15, top="floor+0.75", bottom="floor+0.58"),
         cloth=dict(pinTop="pelvis+0.03", pinBottom="thigh_mid", legShare=0.8, shareWidth=0.05,
                    maxDistance=0.04, stretch=0.95, bend=0.3, damping=0.12, gravityScale=1.0, wind=0.3,
                    limit="arms,hips,thighs", limitSlackPinned=0.006)),
    dict(id="tshirt", slot="top", layer=3, pack="male_casualsuit04", keep=[810], zone="torso",
         label={"da": "T-shirt", "en": "T-shirt"}, primary="#2f5f9e", secondary="#e08a2c",
         secondary_from="orange", roughness=0.9, source_part="T-shirt of male_casualsuit04"),
    # Long dark coat ("Syndicate" duster): the CC0 jacket is cut at the waist (drops its lower patch pockets), a
    # generated skirt runs from under the jacket down to ~8 cm above the floor (open front that opens a little
    # toward the hem, back vent), and a generated belt band covers the seam (coat_skirt).
    dict(id="trenchcoat", slot="outerwear", layer=4, pack="male_casualsuit05", keep=[1659], zone="coat",
         label={"da": "Trenchcoat", "en": "Trench coat"}, primary="#2b2b30", secondary="#1f1b1a",
         roughness=0.78, lining=1.0, hides_lower=True,
         source_part="jacket of male_casualsuit05, cut at the waist; long skirt, belt, standing collar and lapels "
                     "generated by this project",
         coat=dict(cut="spine_02", hem="floor+0.08", row=0.045, columns=36, top_overlap=0.02, tuck=0.003,
                   clearance=0.045, clearance_ramp=0.22, flare=0.07, max_slope=0.3, open_deg=7.0, open_width_deg=70.0,
                   vent="knee+0.04", vent_gap=0.002, belt=0.055, belt_offset=0.007,
                   uv=(0.01, 0.58, 0.01, 0.385), belt_uv=(0.01, 0.58, 0.395, 0.425), drop_pockets=True, pocket_z=(1.06, 1.25),
                   collar=dict(lapel_break="neck_01-0.245", own_collar_deg=75.0, gorge_deg=140.0, side_deg=70.0, height_back=0.072,
                               height_front=0.045, flare_back=0.024, flare_front=0.03, lapel_width=0.075,
                               lapel_min=0.01, notch_width=0.014, peak_deg=35.0, lapel_offset=0.005, step=0.018,
                               body_gap=0.008)),
         cloth=dict(pinTop="spine_02-0.02", pinBottom="hip-0.06", legShare=0.5, legShareFront=0.8, shareWidth=0.06,
                    # maxDistance 0.45 (was 0.6): the free skirt over-swung in run and the female front panel at the
                    # opening stretched (p99 1.687 > 1.65, review 2026-10-01); 0.45: max p99 1.544 over 8 bodies
                    maxDistance=0.45, stretch=0.95, bend=0.35, bendVertical=0.7, damping=0.12, gravityScale=1.0,
                    # layerThickness 0.015 (default 0.012): coat over socks / shoes / jeans / skirt / body, 5 coat
                    # outfits x 9 bodies (tools/cloth_integrity.mjs, full timeline): 16 -> 11 failing pair cases,
                    # max coat stretch p99 1.694 -> 1.666; 0.018 was 11 too but with new toe pokes (ball_r)
                    wind=0.6, friction=0.3, thickness=0.02, layerThickness=0.015, limit="arms,hips")),
    # Underwear (project-original, no third-party asset: the CC0 pack has none). Generated by add_generated from the
    # body surface itself: the body faces inside a smooth region field are copied and clipped along the field's zero
    # line, every vertex is bound to the body (barycentric on a body edge / vertex) and offset along the body normal,
    # so it follows every morph, the breast physics and the body's own skinning. Layer 0 = under everything; built
    # after the other garments (it never changes them). Hidden where a higher garment covers it (_CCZONE,
    # underwear_cover); never a cloth collision layer (catalog collidesAsLayer false).
    # gen: "trunks" = short-leg briefs (male default), "bikini" = bikini briefs + "bra" = strapless bra (female
    # default; two items / two GLBs so each stays small and the bra can be taken off on its own).
    # band: width (m) of the secondary-colour band: trunks = waistband below the top edge, otherwise a trim along
    # every open edge.
    dict(id="briefs", slot="underwear", layer=0, gen="trunks", sex="male", zone="underwear_m",
         label={"da": "Underbukser", "en": "Briefs"}, primary="#2b2b30", secondary="#c9c9cc", roughness=0.85,
         offset=0.002, band=0.032,
         source_part="short-leg briefs generated from the body surface by blender/cc_clothing.py add_generated"),
    dict(id="panties", slot="underwear", layer=0, gen="bikini", sex="female", zone="underwear_f",
         label={"da": "Trusser", "en": "Panties"}, primary="#2a2630", secondary="#b58a9c", roughness=0.7,
         offset=0.002, band=0.007,
         source_part="bikini briefs generated from the body surface by blender/cc_clothing.py add_generated"),
    dict(id="bra", slot="bra", layer=0, gen="bra", sex="female", zone="bra",
         label={"da": "Bh", "en": "Bra"}, primary="#2a2630", secondary="#b58a9c", roughness=0.7,
         offset=0.0025, band=0.007,
         source_part="strapless bra generated from the body surface by blender/cc_clothing.py add_generated"),
    # --- added 2026-10-01 (after the underwear, so the earlier zone bits keep their numbers: zone_bit). All three use
    # tex_procedural (grey albedo + PNG mask painted per texel, no normal map) instead of the striped / logo atlases.
    # Shorts: the jeans of male_casualsuit04 cut above the knee (cut_legs) and widened toward the hem (flare_legs:
    # room for the thighs in walk / run); the atlas' denim weave, belt loops and pockets + a double-stitched hem.
    dict(id="shorts", slot="bottom", layer=2, pack="male_casualsuit04", keep=[886], zone="shorts",
         label={"da": "Shorts", "en": "Shorts"}, primary="#9c8a64", roughness=0.85,
         cut=dict(z="knee+0.09"), flare_legs=dict(k=0.12, top="knee+0.3"), zone_tris=True,
         # not part of the coat skirt envelope: its flared hem moved the simulated coat skirt (2.6 mm), enough to
         # change the female run in tests/cloth.test.mjs (jeans through the coat 0 -> 32 mm)
         coat_envelope=False,
         tex=dict(style="denim", stitch=(0.010, 0.016)),
         source_part="jeans of male_casualsuit04, cut above the knee and widened toward the hem by this project; "
                     "texture: the pack's atlas luminance + a stitched hem painted by this project"),
    # Long-sleeve shirt, worn untucked (a tucked shirt would need a layer below the bottoms, guide f): the shirt of
    # male_casualsuit03 without the cuff tubes turned inside the sleeves (drop_inner_cuffs). Secondary colour: the
    # collar, the cuffs and the buttons.
    dict(id="shirt", slot="top", layer=3, pack="male_casualsuit03", keep=[1613], zone="shirt",
         label={"da": "Langærmet skjorte", "en": "Long-sleeve shirt"}, primary="#9fb7d4", secondary="#f2f2f2",
         roughness=0.75, drop_inner_cuffs=True, zone_tris=True,
         # not part of the coat skirt envelope: its loose back hem widened the skinned skirt (run: 23.7 -> 26.6 mm into the
         # legs, tests/clothing.test.mjs limit 25); the coat clearance pass still fits the coat over it
         coat_envelope=False,
         hides_lower=True, sim_layer_gap=0.018,   # over the skirt: its simulated part came out through the hem
         zone_near=0.045,   # the loose waist sits > 2 cm off the skin: that ring stayed drawn and came through in run
         tex=dict(style="shirt", collar_islands="neck_01-0.03", cuff=0.055, button_first=0.08, button_step=0.09,
                  button_r=0.0055),
         source_part="shirt of male_casualsuit03 (the cuff tubes turned inside the sleeves removed); woven texture "
                     "with collar, cuffs, placket and buttons painted by this project"),
    # Hoodie: the long-sleeve top of male_casualsuit02, loosened 6 mm (inflate), with a generated hood lying down
    # around the neck and on the upper back (hood_down: pinned, bound below the head). Layer 4 like the coat: it is
    # worn instead of the T-shirt / shirt (same slot) and conflicts with the coat (CONFLICTS), so it is fitted over the
    # bottoms and shoes only. Secondary colour: the rib bands (cuffs, hem, front neckline) and the lining (inside).
    dict(id="hoodie", slot="top", layer=4, pack="male_casualsuit02", keep=[1250], zone="hoodie",
         label={"da": "Hættetrøje", "en": "Hoodie"}, primary="#6b7480", secondary="#4f5660", roughness=0.92,
         lining=1.0, inflate=0.006, zone_tris=True, hides_lower=True, sim_layer_gap=0.018, zone_near=0.045,
         hood=dict(phi_max=150.0, half_cols=16, rows=7, stand=0.03, roll=0.025, puff_top=0.03, puff_edge=0.008,
                   bag=0.012, length=[0.27, 0.25, 0.20, 0.11, 0.05, 0.02],
                   dirs=[[1.0, 0.0, 0.1], [1.0, 0.25, 0.1], [0.8, 0.6, 0.2], [0.5, 0.8, 0.4], [0.35, 0.4, 0.9],
                         [0.3, 0.1, 1.0]],
                   body_gap=0.006, uv=(0.01, 0.72, 0.02, 0.57)),
         tex=dict(style="hoodie", cuff=0.06, hem=0.065, neck=0.012, rib=0.005, pocket_h=0.19, pocket_top=0.085,
                  pocket_bottom=0.15, pocket_open_low=0.035),
         source_part="long-sleeve top of male_casualsuit02, loosened 6 mm; hood (lying down) generated, rib bands "
                     "and kangaroo pocket painted by this project"),
    # --- added 2026-10-01, second batch (after the hoodie: zone bits keep their numbers) ---------------------------
    # Dress (route C): the short-sleeve fitted top of female_casualsuit01 is the bodice (MHCLO-bound, so it follows the
    # breast morphs and dyn_breast_* like the T-shirt), cut at the waist; coat_skirt (closed=True: a tube, no front
    # opening, no vent) generates an A-line knee-length skirt from the waist and a belt over the seam. Only the skirt is
    # cloth (pinned over the hips like the skirt). Slot top, occupies top + bottom (OCCUPIES), layer 3: it replaces
    # every top and bottom and is worn under the coat / jacket. Not in the coat skirt envelope (coat_envelope): the coat
    # is fitted over it by the clearance pass only, so the coat's skirt keeps its shape for every other outfit.
    dict(id="dress", slot="top", layer=3, pack="female_casualsuit01", keep=[1311], zone="dress",
         label={"da": "Kjole", "en": "Dress"}, primary="#7a2434", secondary="#221c1e", roughness=0.8,
         # zone_near 0.05: the skin under the loose skirt top (3 cm clearance) must be hidden, else the dress
         # vertices there count as layered over drawn skin and the hands hanging at the hips "sink" them
         # (cloth_integrity dress:body, female walk 7 verts / 29 mm); with it 0 failing cases on 9 bodies
         zone_tris=True, zone_near=0.05, coat_envelope=False, zone_near_pinned=(0.2, 0.10),
         coat=dict(cut="spine_02-0.02", hem="knee+0.05", closed=True, row=0.04, columns=36, top_overlap=0.02,
                   tuck=0.003, clearance=0.03, clearance_ramp=0.15, flare=0.15, max_slope=0.3, open_deg=0.0,
                   open_width_deg=70.0, belt=0.04, belt_offset=0.004, uv=(0.01, 0.70, 0.01, 0.55),
                   belt_uv=(0.73, 0.99, 0.02, 0.12), what="knee-length A-line skirt below the waist and belt"),
         tex=dict(style="dress", piping=0.006, hem_stitch=0.012, buckle=(0.022, 0.016)),
         # clearance_ramp 0.15 (full clearance just below the belt: the hard thighUp capsule caps stick out of the hip
         # sides, a skirt top closer than that was pushed out against its pins, stretch p99 up to 1.9); limitSlack
         # 0.008 (default 0.02): the hands at the sides push the nearly pinned rows less (short body p99 1.88 -> 1.56);
         # legShare 0.6 + legShareFront 0.8 (0.8 all round: skinned stretch p99 3.6, sim p99 > 2 on short / child);
         # pinTop / pinBottom lower (pelvis-0.04 / hip-0.18) let the thighs poke the pinned front: 43 failing cases
         cloth=dict(pinTop="pelvis+0.03", pinBottom="hip-0.12", legShare=0.6, legShareFront=0.8, shareWidth=0.06,
                    maxDistance=0.25, stretch=0.95, bend=0.3, bendVertical=0.6, damping=0.12, gravityScale=1.0,
                    wind=0.4, friction=0.3, thickness=0.012, limit="arms,hips", limitSlack=0.008,
                    limitSlackPinned=0.006),
         source_part="short-sleeve top of female_casualsuit01 as the bodice, cut at the waist; knee-length skirt and "
                     "belt generated, piping and buckle painted by this project"),
    # Jacket: the hip-length padded jacket of male_casualsuit05 (the coat's source, uncut) with its collar / lapels
    # (277, secondary colour), without the shirt front inside it: open front, worn over the T-shirt / shirt / dress.
    # Layer 4 (outerwear): fitted over every lower layer it can be worn with; skinned, no cloth (the hem ends at the
    # hips, nothing to swing). Conflicts with the hoodie (the hood lying on the upper back fills the jacket's collar
    # space; fitting over it would bulk the jacket for every outfit), the coat (same slot) and the dress (its
    # simulated skirt under the skinned jacket hem: 33 failing integrity cases on 9 bodies).
    # inflate 8 mm: the front corners sank into the jeans / shorts in the female run (3 verts, 11 mm); zone_near 0.07:
    # skin under the loose hem (hand sink); hide_grow 2: the T-shirt armpit (upper-arm weights) came out through the
    # jacket's side in the jump (4 verts, 17 mm, tall).
    dict(id="jacket", slot="outerwear", layer=4, pack="male_casualsuit05", keep=[1659, 277], zone="jacket",
         label={"da": "Jakke", "en": "Jacket"}, primary="#8a7350", secondary="#4a3526",
         secondary_from="small_components", roughness=0.85, lining=1.0, hides_lower=True, sim_layer_gap=0.018,
         zone_tris=True, zone_near=0.07, inflate=0.008, hide_grow=2,
         source_part="jacket of male_casualsuit05 with its collar and lapels (the shirt front inside it removed)"),
    # Boots: shoes03 (shoe + calf-high sock) as a mid-calf boot: the sock is the leather shaft (secondary colour,
    # small_components), reweighted to the shoe and kept inside it like shoes01's sock (sock_weights / keep_inside).
    # Layer 1 like the shoes (same slot): the jeans / skirt / dress / coat are fitted over the shaft (jeans worn OVER
    # the boot, not tucked in: the jeans legs are skinned, a tucked hem would need its own reshaping).
    dict(id="boots", slot="shoes", layer=1, pack="shoes03", keep=[759, 759, 144, 144], zone="boots", closed=True,
         label={"da": "Støvler", "en": "Boots"}, primary="#3b2a1e", secondary="#2a1f17",
         secondary_from="small_components", roughness=0.6, sole=dict(top=0.004, floor=-0.001), dissolve_flat=1.0,
         sec_leather=True, wrap_body=True, zone_fill=True,
         source_part="shoes03 (shoes + calf-high socks as the boot shaft; the strap buckles removed)"),
]
# occupies: slots an item fills (default: its own slot). The dress is slot "top", occupies ["top", "bottom"],
# layer 3 -> it sits under the coat (layer 4). conflicts: item ids removed when this item is put on.
OCCUPIES = {"dress": ["top", "bottom"]}
# hoodie x trench coat: the coat's standing collar (8 mm from the neck) and the hood lying around the neck occupy the
# same space, and fitting the coat over the hood would make the coat bulky for every other outfit.
# dress x trench coat: the coat is built before the dress (GARMENTS order keeps the zone bits), so neither its
# clearance pass nor its skirt envelope (coat_envelope) knows the dress; worn together (tools/cloth_integrity.mjs,
# 9 bodies, full timeline): 13 failing cases, the dress skirt 22-30 mm through the coat skirt in walk / jump.
CONFLICTS = {"hoodie": ["trenchcoat"], "jacket": ["trenchcoat", "hoodie", "dress"], "dress": ["trenchcoat"]}
HIDES_EXTRA = {}
# catalog "defaultUnderwear": worn by default per sex (web/clothing_rules.js defaultUnderwear)
DEFAULT_UNDERWEAR = {"male": ["briefs"], "female": ["panties", "bra"]}


def wearable_together(a, b):
    """Two garment specs can be worn at the same time: no shared occupied slot and no conflict either way. Only such
    a lower garment is a clearance collider / coat envelope / hide_lower target of an outer one (the hoodie, layer 4,
    is not fitted over the T-shirt it replaces)."""
    sa = set(OCCUPIES.get(a["id"], [a["slot"]]))
    sb = set(OCCUPIES.get(b["id"], [b["slot"]]))
    return not (sa & sb) and b["id"] not in CONFLICTS.get(a["id"], []) and a["id"] not in CONFLICTS.get(b["id"], [])


def uv_islands(me, uv, q=1e5):
    """UV island id per polygon: polygons that share an edge with the same UVs at both ends are one island."""
    lvi = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", lvi)
    par = list(range(len(me.polygons)))

    def f(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    seen = {}
    for p in me.polygons:
        li = list(p.loop_indices)
        for j in range(len(li)):
            a, b = li[j], li[(j + 1) % len(li)]
            ka = (int(lvi[a]), int(round(uv[a, 0] * q)), int(round(uv[a, 1] * q)))
            kb = (int(lvi[b]), int(round(uv[b, 0] * q)), int(round(uv[b, 1] * q)))
            key = (min(ka, kb), max(ka, kb))
            if key in seen:
                ra, rb = f(p.index), f(seen[key])
                if ra != rb:
                    par[ra] = rb
            else:
                seen[key] = p.index
    return np.array([f(i) for i in range(len(par))])


def boundary_loops(co, polys, weld=1e-5):
    """Open boundary loops of a mesh (coincident vertices welded, so MakeHuman seam splits are not edges): list of
    ordered vertex index lists (one representative vertex per welded position)."""
    _, wi = np.unique(np.round(np.asarray(co) / weld).astype(np.int64), axis=0, return_inverse=True)
    wi = wi.ravel()
    rep = {}
    for i, w in enumerate(wi):
        rep.setdefault(int(w), i)
    cnt = {}
    for p in polys:
        for u, v in zip(p, p[1:] + p[:1]):
            k = (min(wi[u], wi[v]), max(wi[u], wi[v]))
            if k[0] != k[1]:
                cnt[k] = cnt.get(k, 0) + 1
    adj = {}
    for (a, b), c in cnt.items():
        if c == 1:
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
    loops, seen = [], set()
    for s0 in sorted(adj):
        if s0 in seen:
            continue
        loop, prev, cur = [s0], None, s0
        seen.add(s0)
        while True:
            nx = [q for q in adj[cur] if q != prev and q not in seen]
            if not nx:
                break
            prev, cur = cur, nx[0]
            seen.add(cur)
            loop.append(cur)
        loops.append([rep[w] for w in loop])
    return loops


def loop_points(co, loop, step=0.002, closed=True):
    """Points every `step` m along a boundary loop + their arc length (m)."""
    P = np.asarray(co)[loop]
    if closed:
        P = np.r_[P, P[:1]]
    pts, arc, s = [], [], 0.0
    for a, b in zip(P[:-1], P[1:]):
        L = float(np.linalg.norm(b - a))
        n = max(1, int(np.ceil(L / step)))
        for j in range(n):
            pts.append(a + (b - a) * (j / n))
            arc.append(s + L * j / n)
        s += L
    pts.append(P[-1])
    arc.append(s)
    return np.array(pts), np.array(arc)


def kd_of(pts):
    kd = KDTree(max(1, len(pts)))
    for i, p in enumerate(pts):
        kd.insert(p, i)
    kd.balance()
    return kd


def pad_islands(L, sec, cover, rings=16):
    """Edge padding: grow every UV island by `rings` texels (each uncovered texel takes the mean of its covered
    8-neighbours, ring by ring), so bilinear / mip sampling along an island edge never reaches the background."""
    h, w = L.shape
    known = cover.copy()
    L, sec = np.where(cover, L, 0.0), np.where(cover, sec, 0.0)
    for _ in range(rings):
        kf = known.astype(np.float64)
        pk, pl, ps = np.pad(kf, 1), np.pad(L * kf, 1), np.pad(sec * kf, 1)
        cnt, sl, ss = np.zeros_like(kf), np.zeros_like(kf), np.zeros_like(kf)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                if dy == 1 and dx == 1:
                    continue
                cnt += pk[dy:dy + h, dx:dx + w]
                sl += pl[dy:dy + h, dx:dx + w]
                ss += ps[dy:dy + h, dx:dx + w]
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        L = np.where(grow, sl / np.maximum(cnt, 1), L)
        sec = np.where(grow, ss / np.maximum(cnt, 1), sec)
        known = known | grow
    return L, sec, known


def parse_delete_verts(path):
    """delete_verts section of a .mhclo: basemesh vertex indices ('a - b' ranges allowed)."""
    out, on = set(), False
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("delete_verts"):
                on = True
                continue
            if on:
                if re.match(r"^[a-z_]", line):
                    break
                t = line.split()
                k = 0
                while k < len(t):
                    if k + 2 < len(t) and t[k + 1] == "-":
                        out.update(range(int(t[k]), int(t[k + 2]) + 1))
                        k += 3
                    else:
                        out.add(int(t[k]))
                        k += 1
    return out


def mesh_arrays(obj):
    me = obj.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3), [tuple(p.vertices) for p in me.polygons]


def components(n, polys):
    """Connected component id (root vertex) per vertex."""
    par = np.arange(n)

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    for p in polys:
        r0 = find(p[0])
        for b in p[1:]:
            rb = find(b)
            if rb != r0:
                par[rb] = r0
    return np.array([find(i) for i in range(n)])


def neighbours(n, polys):
    nb = [set() for _ in range(n)]
    for p in polys:
        for a, b in zip(p, p[1:] + p[:1]):
            nb[a].add(b)
            nb[b].add(a)
    return [np.array(sorted(s), dtype=np.int64) for s in nb]


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def get_shapes(obj):
    me = obj.data
    n = len(me.vertices)
    out = {}
    for blk in me.shape_keys.key_blocks:
        a = np.empty(n * 3, np.float32)
        blk.data.foreach_get("co", a)
        out[blk.name] = a.reshape(-1, 3).astype(np.float64)
    return out


class SynthFit:
    """MHCLO-style binding made by this project for generated vertices:
    vertex = sum(w_i * basemesh_i) + offset * (scale / neutral scale), per-axis scale measured on the same
    reference vertex pairs as the source garment's .mhclo (x/y/z_scale), like MhcloFit."""

    def __init__(self, idx, w, off, ref, base):
        self.idx, self.w, self.off, self.ref = idx, w, off, ref
        self.s0 = self._scale(base)

    def _scale(self, hv):
        r = self.ref
        return np.array([abs(hv[r.xs[0], 0] - hv[r.xs[1], 0]), abs(hv[r.zs[0], 1] - hv[r.zs[1], 1]),
                         abs(hv[r.ys[0], 2] - hv[r.ys[1], 2])])

    def __call__(self, hv):
        return (self.w[:, :, None] * hv[self.idx]).sum(1) + self.off * (self._scale(hv) / self.s0)


def vertex_normals(P, tris):
    """Area-weighted vertex normals (unit) of positions P for triangles tris (t, 3)."""
    fn = np.cross(P[tris[:, 1]] - P[tris[:, 0]], P[tris[:, 2]] - P[tris[:, 0]])
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, tris[:, k], fn)
    return N / np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]


class SurfaceFit:
    """Binding of generated skin-tight vertices (underwear, add_generated): vertex = sum(w_i * body_i) + off * n, n =
    the same barycentric mix of the body's vertex normals at that shape (normalised). Evaluated like MhcloFit on every
    morph sample (build_base.fit_keys), so the garment keeps its distance to the skin at every shape."""

    def __init__(self, idx, w, off, tris, n_body, sign=1.0):
        self.idx, self.w, self.off, self.tris, self.n, self.sign = idx, w, np.asarray(off, float), tris, n_body, sign

    def __call__(self, hv):
        P = hv[:self.n]
        Nv = vertex_normals(P, self.tris) * self.sign
        p = (self.w[:, :, None] * P[self.idx]).sum(1)
        nn = (self.w[:, :, None] * Nv[self.idx]).sum(1)
        nn /= np.maximum(np.linalg.norm(nn, axis=1), 1e-12)[:, None]
        return p + self.off[:, None] * nn


class Clothing:
    def __init__(self, B):
        """B: namespace with the build_base state (see the call in build_base.py)."""
        self.B = B
        self.done = {}                                   # id -> record
        self.zone_bits = {}
        self.body_zone = np.zeros(B.N_BODY, np.int64)
        self.body_polys = [tuple(p.vertices) for p in B.human.data.polygons if max(p.vertices) < B.N_BODY]
        self.body_poly_index = [p.index for p in B.human.data.polygons if max(p.vertices) < B.N_BODY]
        self.bvh0 = self.body_bvh(B.BASE_ARR)
        self.heads = {k: np.array(tuple(v)) for k, v in B.base_heads.items()}

    @staticmethod
    def zone_bit(g):
        """Body zone bit of a garment: 1 << (index of its zone in GARMENTS order), so a garment added to the end of
        GARMENTS never renumbers the bits of the existing ones (the build order is by layer)."""
        zones = []
        for x in GARMENTS:
            if x["zone"] not in zones:
                zones.append(x["zone"])
        return 1 << zones.index(g["zone"])

    def body_bvh(self, P):
        return BVHTree.FromPolygons([Vector(p) for p in P[:self.B.N_BODY]], self.body_polys)

    def z_of(self, expr):
        """'pelvis+0.03' / 'knee+0.06' / 'hip-0.14' / 'thigh_mid' -> height (m, Blender z) on the neutral body."""
        h = self.heads
        named = {"knee": h["calf_l"][2], "hip": h["thigh_l"][2], "thigh_mid": (h["thigh_l"][2] + h["calf_l"][2]) / 2,
                 "floor": 0.0}
        m = re.match(r"^([a-z_0-9]+?)([+-][0-9.]+)?$", expr)
        name, off = m.group(1), float(m.group(2) or 0)
        return float((named[name] if name in named else h[name][2]) + off)

    # ---- per garment ---------------------------------------------------------------------------------
    def add(self, g):
        if g.get("gen"):
            return self.add_generated(g)
        B = self.B
        rel ="clothes/%s/%s.mhclo" % (g["pack"], g["pack"])
        f = os.path.join(B.args.assets, rel)
        B.check_license(g["pack"], os.path.join(B.args.assets, "clothes", g["pack"], g["pack"] + ".mhmat"))
        obj = B.add_asset("Cloth_" + g["id"], g["pack"], rel, "Clothes")   # checks the .mhclo license too
        fit = B.last_fit()
        # MPFB leaves a "Delete.<asset>" vertex group (and possibly a MASK modifier) on the basemesh
        for vg in list(B.human.vertex_groups):
            if vg.name.startswith("Delete"):
                B.human.vertex_groups.remove(vg)
        for md in list(B.human.modifiers):
            if md.type == 'MASK':
                B.human.modifiers.remove(md)
        full, polys = mesh_arrays(obj)
        roots = components(len(full), polys)
        ids, counts = np.unique(roots, return_counts=True)
        want, keep_roots = list(g["keep"]), []
        for r, c in sorted(zip(ids.tolist(), counts.tolist()), key=lambda t: -t[1]):
            if c in want:
                want.remove(c)
                keep_roots.append(r)
        assert not want, "%s: components %s not found (have %s)" % (g["id"], want, sorted(counts.tolist()))
        keep = np.isin(roots, keep_roots)
        small = np.zeros(len(full), bool)
        if g.get("secondary_from") == "small_components":
            big = max(g["keep"])
            for r in keep_roots:
                if (roots == r).sum() < big * 0.5:
                    small |= roots == r
        # body zone: delete_verts are for the whole suit -> keep a body vertex if its nearest suit vertex is kept
        dv = np.array(sorted(i for i in parse_delete_verts(f) if i < B.N_BODY), dtype=np.int64)
        if len(dv):
            kd = KDTree(len(full))
            for i, p in enumerate(full):
                kd.insert(p, i)
            kd.balance()
            dv = dv[np.array([keep[kd.find(B.BASE_ARR[i])[1]] for i in dv], bool)]
        self.delete_unkept(obj, keep, small)
        rec = dict(obj=obj, spec=g, bit=self.zone_bit(g))
        if g.get("dissolve_flat"):
            rec["dissolve"] = self.dissolve_flat(obj, g["dissolve_flat"])
        if g.get("sole"):
            rec["sole"] = self.sole_squash(obj, g["sole"])
        if g.get("secondary_from") == "small_components" and g.get("closed"):
            rec["socks"] = self.sock_weights(obj)
        if g.get("cut"):
            rec["cut"] = self.cut_legs(obj, g["cut"])
        if g.get("drop_inner_cuffs"):
            rec["dropInner"] = self.drop_inner_cuffs(obj)
        if g.get("flare"):
            rec["flare"] = self.flare(obj, g["flare"])
        if g.get("flare_legs"):
            rec["flareLegs"] = self.flare_legs(obj, g["flare_legs"])
        if g.get("inflate"):
            rec["inflate"] = self.inflate(obj, g["inflate"])
        if g.get("coat"):
            rec["ext"] = self.coat_skirt(obj, g, fit)
        self.orient_outward(obj)
        self.clearance(obj, g, rec)
        if g.get("coat", {}).get("closed"):
            rec["ext"]["beltClamp"] = self.belt_clamp(obj, rec["ext"])
        if g.get("coat", {}).get("collar"):
            rec["ext"]["collar"] = self.coat_collar(obj, g, fit, rec)
            self.orient_outward(obj)
        if g.get("hood"):
            rec["hood"] = self.hood_down(obj, g, fit, rec)
            self.orient_outward(obj)
        if not g.get("closed"):          # a shoe encloses the foot: keep its whole delete list
            dv = self.covered(obj, dv, tris=bool(g.get("flare") or g.get("zone_tris")), near=g.get("zone_near", 0.02),
                              fill=g.get("zone_fill", False),
                              near_hi=((self.z_of(g["cloth"]["pinTop"]) - g["zone_near_pinned"][0], g["zone_near_pinned"][1])
                                       if g.get("zone_near_pinned") else None))
        elif g.get("zone_fill"):
            dv = self.fill_lone(obj, dv)
        if not g.get("closed"):
            # no hidden skin above the garment's top: the jacket zone reached 5 cm above its collar (the ray from
            # the underside of the jaw meets the collar within `reach`), a hole under the jaw showed the mouth
            # interior; the dress zone reached 3.4 cm above its neckline
            ztop = mesh_arrays(obj)[0][:, 2].max() + 0.005
            dv = np.asarray(dv, np.int64)
            dv = dv[self.B.BASE_ARR[dv, 2] <= ztop]
        bit = rec["bit"]
        self.zone_bits[g["zone"]] = bit
        self.body_zone[dv] |= bit
        rec["hidden"] = int(len(dv))
        if g.get("cloth"):
            self.cloth_weights_and_pin(obj, g, rec)
        if g.get("hides_lower"):
            self.hide_lower(obj, g, rec)
        if g.get("tex"):
            self.tex_procedural(obj, g, rec)
        else:
            self.textures_and_material(obj, g, rec)
        obj["cc_export"] = "cloth"
        self.done[g["id"]] = rec
        print("BUILD cloth %-10s verts %5d faces %5d hides %4d body verts (zone %s, bit %d)"
              % (g["id"], len(obj.data.vertices), len(obj.data.polygons), len(dv), g["zone"], bit))
        return obj

    # ---- generated underwear (project-original geometry, see GARMENTS) ------------------------------------
    def body_weights(self):
        """Dense skin weights of the body vertices over the rig's bone vertex groups: (N_BODY, n) array, names."""
        if getattr(self, "_bw", None) is None:
            B = self.B
            h = B.human
            gi = {g.index: g.name for g in h.vertex_groups if g.name in B.bone_names}
            names = sorted(set(gi.values()))
            col = {n: k for k, n in enumerate(names)}
            W = np.zeros((B.N_BODY, len(names)))
            vs = h.data.vertices
            for i in range(B.N_BODY):
                for e in vs[i].groups:
                    if e.group in gi:
                        W[i, col[gi[e.group]]] = e.weight
            W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
            self._bw = (W, names)
        return self._bw

    def underwear_fields(self, g):
        """Region fields on the neutral body vertices (metres-ish, > 0 = inside the garment; the garment edge is the
        zero line): {'f': region, 'tb' (trunks only): distance below the top edge (waistband where tb < g['band']);
        without 'tb' the band is a trim along the open edges}. Blender space: +Z up, -Y front, +X left."""
        B = self.B
        N = B.N_BODY
        P = B.BASE_ARR[:N]
        x, y, z = P[:, 0], P[:, 1], P[:, 2]
        ax = np.abs(x)
        h = self.heads
        W, names = self.body_weights()
        share = lambda bones: W[:, [names.index(b) for b in bones if b in names]].sum(1)
        cy = float(h["pelvis"][1])
        back = smoothstep(cy - 0.02, cy + 0.06, y)            # 1 on the back
        legs = share(["pelvis", "spine_01", "thigh_l", "thigh_r"]) > 0.6
        mid = (ax < 0.012) & legs & (z > h["calf_l"][2] + 0.1) & (z < h["pelvis"][2])
        z_c = float(z[mid].min())                              # crotch (lowest midline point between the legs)
        out = {"z_crotch": z_c}
        if g["gen"] == "trunks":
            z_top = float(h["spine_01"][2]) - 0.036            # under the jeans waistband (jeans top ~ spine_01 - 0.01)
            f_top = z_top - z
            f_leg = z - (z_c - 0.045 + 0.2 * np.clip(ax - 0.03, 0, None))
            f = np.minimum(f_top, f_leg)
            f[~legs] = -1.0
            out.update(f=f, tb=f_top, z_top=z_top)
            return out
        zp = float(h["pelvis"][2])
        if g["gen"] == "bikini":                                # low waist, high leg
            z_top = zp + 0.03 + 0.012 * back
            f_top = z_top - z
            slope = ((zp + 0.03 - 0.035) - (z_c - 0.004)) / (0.16 - 0.035)
            f_leg = z - (z_c - 0.004 + slope * np.clip(ax - 0.035, 0, None) - 0.025 * back)
            f = np.minimum(f_top, f_leg)
            f[~legs] = -1.0
            out.update(f=f, z_top=z_top)
            return out
        # strapless bra: cups = the breast tissue (|delta(breast_cup_max)|, smoothed) up to 4.5 cm above the
        # nipple, plus an underbust band all around the ribcage
        dc = np.linalg.norm(B.delta["breast_cup_max"][:N], axis=1)
        wb = np.clip(dc / (0.6 * dc.max()), 0, 1)
        nb = neighbours(N, self.body_polys)
        for _ in range(3):
            wb = 0.5 * wb + 0.5 * np.array([wb[n].mean() if len(n) else wb[i] for i, n in enumerate(nb)])
        torso = share(["spine_01", "spine_02", "spine_03", "clavicle_l", "clavicle_r"]) > 0.6
        sh = float(h["upperarm_l"][2])
        tips = []
        for sgn in (1, -1):
            chest = torso & (sgn * x > 0.04) & (sgn * x < 0.16) & (z < sh - 0.06) & (z > sh - 0.3)
            tips.append(P[chest][np.argmin(y[chest])])
        z_tip = float(np.mean([t[2] for t in tips]))
        z_u = float(z[(wb > 0.35) & (y < cy)].min())            # underbust: lower rim of the breast tissue
        cups = np.minimum(0.08 * (wb - 0.12), z_tip + 0.045 - z)
        band_lo, band_hi = z_u - 0.018, z_u + 0.014
        band = np.minimum(z - band_lo, band_hi - z)
        f = np.maximum(cups, band)
        f[~torso | (z < zp + 0.15)] = -1.0
        out.update(f=f, z_top=z_tip + 0.045, z_tip=z_tip, z_under=z_u)
        return out

    def clip_region(self, f):
        """Body faces inside the field f (> 0), clipped along its zero line. Returns nodes [(a, b, t)] (a point on the
        body edge a-b at parameter t; a == b for a body vertex), faces (node indices, body winding), the source body
        polygon per face and the (a, b, t) of every face corner (for the UVs), and f after snapping."""
        f = np.array(f, float)
        # clipped per body TRIANGLE (the body's own split: Blender / glTF split a quad (0, 1, 2) + (0, 2, 3)), not per
        # polygon: a clipped polygon was fan-split along the other diagonal and the body's diagonal ridge came out
        # through the underwear as small skin squares near the leg line (review 2026-10-01). Every underwear face now
        # lies in the plane of one body triangle, offset outward.
        polys = [(pi, (p[0], p[k], p[k + 1])) for pi, p in enumerate(self.body_polys) for k in range(1, len(p) - 1)]
        # vertices very close to the zero line (crossing within 20 % of an edge) are moved onto it: no slivers
        snap = np.zeros(len(f), bool)
        for _, p in polys:
            for a, b in zip(p, p[1:] + p[:1]):
                if f[a] * f[b] < 0:
                    t = f[a] / (f[a] - f[b])
                    if t < 0.2:
                        snap[a] = True
                    elif t > 0.8:
                        snap[b] = True
        f[snap] = 0.0
        key, nodes, faces, src, corners = {}, [], [], [], []

        def node(a, b, t):
            if a == b or t <= 0.0:
                k, rec = ("v", a), (a, a, 0.0)
            elif a < b:
                k, rec = ("e", a, b), (a, b, t)
            else:
                k, rec = ("e", b, a), (b, a, 1.0 - t)
            if k not in key:
                key[k] = len(nodes)
                nodes.append(rec)
            return key[k]
        for pi, p in polys:
            fp = f[list(p)]
            if not (fp > 0).any():
                continue
            cs = []
            if (fp >= 0).all():
                cs = [(v, v, 0.0) for v in p]
            else:
                for k in range(len(p)):
                    a, b = p[k], p[(k + 1) % len(p)]
                    if f[a] >= 0:
                        cs.append((a, a, 0.0))
                    if (f[a] > 0 > f[b]) or (f[a] < 0 < f[b]):
                        cs.append((a, b, f[a] / (f[a] - f[b])))
            if len(cs) < 3:
                continue
            faces.append([node(*c) for c in cs])
            src.append(pi)
            corners.append(cs)
        return nodes, faces, src, corners, f

    def add_generated(self, g):
        """Underwear generated from the body surface (see GARMENTS): region field -> clipped copy of the body faces ->
        SurfaceFit binding (all morphs via fit_keys) -> weights mixed from the body -> clearance -> body zone ->
        procedural knit texture with a secondary-colour band. Its own _CCZONE (covered by which garments) is written
        by underwear_cover() in finish_body, once every garment exists."""
        B = self.B
        N = B.N_BODY
        F = self.underwear_fields(g)
        nodes, faces, src, corners, f = self.clip_region(F["f"])
        a = np.array([n[0] for n in nodes]); b = np.array([n[1] for n in nodes]); t = np.array([n[2] for n in nodes])
        idx = np.stack([a, b], 1)
        w = np.stack([1.0 - t, t], 1)
        off = np.full(len(nodes), g["offset"])
        tris = np.array([(p[0], p[k], p[k + 1]) for p in self.body_polys for k in range(1, len(p) - 1)], np.int64)
        # body normals must point out of the body (compare with Blender's at neutral)
        bn = np.array([tuple(B.human.data.vertices[i].normal) for i in range(0, N, 50)])
        sign = 1.0 if (vertex_normals(B.BASE_ARR[:N], tris)[::50] * bn).sum(1).mean() > 0 else -1.0
        sf = SurfaceFit(idx, w, off, tris, N, sign)
        neutral = sf(B.BASE_ARR)
        deltas = B.fit_keys(sf, neutral)
        # mesh + UVs (body UVs of the source face, interpolated along the clipped edges)
        name = "Cloth_" + g["id"]
        me = bpy.data.meshes.new(name)
        me.from_pydata(neutral.tolist(), [], faces)
        me.polygons.foreach_set("use_smooth", np.ones(len(faces), bool))   # flat faces would split every corner
        me.update()
        hme = B.human.data
        huv = hme.uv_layers[0].data
        uvs = []
        for pi, cs in zip(src, corners):
            poly = hme.polygons[self.body_poly_index[pi]]
            luv = {hme.loops[li].vertex_index: np.array(huv[li].uv) for li in poly.loop_indices}
            for (ca, cb, ct) in cs:
                uvs.append(luv[ca] * (1 - ct) + luv[cb] * ct)
        uvl = me.uv_layers.new(name="UVMap")
        uvl.data.foreach_set("uv", np.array(uvs).ravel())
        obj = bpy.data.objects.new(name, me)
        for c in B.human.users_collection:
            c.objects.link(obj)
        rig = next(md.object for md in B.human.modifiers if md.type == 'ARMATURE')
        obj.parent = B.human.parent
        obj.matrix_parent_inverse = B.human.matrix_parent_inverse.copy()
        obj.matrix_basis = B.human.matrix_basis.copy()
        md = obj.modifiers.new("Armature", 'ARMATURE')
        md.object = rig
        # skin weights: the same mix of the body weights (at most 4 bones, renormalised)
        W, bnames = self.body_weights()
        Wn = W[a] * (1 - t)[:, None] + W[b] * t[:, None]
        groups = {}
        for i in range(len(nodes)):
            top = np.argsort(-Wn[i])[:4]
            top = top[Wn[i, top] > 1e-4]
            s = Wn[i, top].sum()
            for k in top:
                nm = bnames[k]
                if nm not in groups:
                    groups[nm] = obj.vertex_groups.new(name=nm)
                groups[nm].add([i], float(Wn[i, k] / s), 'REPLACE')
        obj.shape_key_add(name="Basis", from_mix=False)
        for key, d in deltas.items():
            sk = obj.shape_key_add(name=key, from_mix=False)
            sk.slider_min, sk.slider_max = 0.0, 1.0
            sk.data.foreach_set("co", (neutral + d).astype(np.float32).ravel())
        rec = dict(obj=obj, spec=g, bit=self.zone_bit(g), nodes=(a, b, t))
        self.orient_outward(obj)
        self.clearance(obj, g, rec, only=np.ones(len(nodes), bool), eps_body=0.6 * g["offset"])
        # body zone: body vertices whose every face lies inside the garment (the triangles they drop are all under it)
        inside = np.zeros(N, bool)
        outside = np.zeros(N, bool)
        for p in self.body_polys:
            fp = f[list(p)]
            if (fp >= 0).all() and (fp > 0).any():
                inside[list(p)] = True
            else:
                outside[list(p)] = True
        dv = np.where(inside & ~outside)[0]
        bit = rec["bit"]
        self.zone_bits[g["zone"]] = bit
        self.body_zone[dv] |= bit
        rec["hidden"] = int(len(dv))
        # texture: band (secondary) / hem from the metric distance (neutral) of every TEXEL to the open edges (the
        # boundary segments, not the nearest boundary vertex: that scalloped the trim into steps)
        ecount = {}
        for fc in faces:
            for u, v in zip(fc, fc[1:] + fc[:1]):
                k = (min(u, v), max(u, v))
                ecount[k] = ecount.get(k, 0) + 1
        bedges = [k for k, c in ecount.items() if c == 1]
        tbn = (F["tb"][a] * (1 - t) + F["tb"][b] * t) if "tb" in F else None
        self.tex_generated(obj, g, rec, np.array(uvs), [[fn for fn in fc] for fc in faces], tbn, neutral, bedges)
        obj["cc_export"] = "cloth"
        rec["gen"] = {"verts": len(nodes), "faces": len(faces), "zCrotch": round(F["z_crotch"], 4),
                      "zTop": round(float(np.max(F["z_top"])), 4)}
        self.done[g["id"]] = rec
        print("BUILD cloth %-10s generated %s: verts %5d faces %5d (from %d body faces), hides %4d body verts "
              "(zone %s, bit %d), offset %.1f mm, fields %s"
              % (g["id"], g["gen"], len(nodes), len(faces), len(set(src)), len(dv), g["zone"], bit,
                 1000 * g["offset"], {k: round(float(np.max(v)), 3) for k, v in F.items() if k.startswith("z")}))
        return obj

    def tex_generated(self, obj, g, rec, loop_uv, faces, tb, pos, bedges, k=0.5, max_size=1024, step=0.0004,
                      min_mpt=0.001):
        """Procedural knit texture for generated underwear (tint contract of tex_cloth: grey mean k, gain 1 / k):
        fine seeded grain, the secondary region (mask R) where the band field < g['band'] (briefs: tb, the distance
        below the top edge = the waistband; panties / bra: the metric distance to the open edges = a trim along every
        edge), a darker stitch line at the band's inner edge and a hem line at the edge.
        Per texel, not per vertex: the neutral 3D position is rasterised and its distance to the open edges taken from
        boundary points sampled every `step` m, and the band / lines are antialiased over one texel. The mask has the
        albedo's resolution (it was 256 px and blurred: a smeared, stepped trim, review 2026-10-01)."""
        B = self.B
        tex = B.tex
        me = obj.data
        # triangles (fan) of the faces, with loop UVs and per-corner values (tb, x, y, z)
        tri_uv, tri_v = [], []
        li = 0
        for fc in faces:
            n = len(fc)
            for q in range(1, n - 1):
                cs = (0, q, q + 1)
                tri_uv.append([loop_uv[li + c] for c in cs])
                tri_v.append([[tb[fc[c]] if tb is not None else 0.0] + list(pos[fc[c]]) for c in cs])
            li += n
        tri_uv, tri_v = np.array(tri_uv), np.array(tri_v)
        lo = np.floor(np.clip(tri_uv.reshape(-1, 2).min(0) - 0.01, 0, 1) * 64) / 64
        hi = np.ceil(np.clip(tri_uv.reshape(-1, 2).max(0) + 0.01, 0, 1) * 64) / 64
        ext = hi - lo
        cuv = (tri_uv - lo) / ext
        e3 = np.linalg.norm(tri_v[:, [1, 2, 0], 1:] - tri_v[:, :, 1:], axis=2)

        def texel(s_):                                      # metres per texel (median over the triangles' edges)
            tp = cuv * ext * s_
            e2 = np.linalg.norm(tp[:, [1, 2, 0]] - tp, axis=2)
            ok = e2 > 0.5
            return float(np.median(e3[ok] / e2[ok]))
        s = max_size / ext.max()
        # no finer than min_mpt: the bra (smaller in 3D) reached 0.72 mm/texel at 1024 px and broke the 0.3 MB
        # underwear budget; ~1 mm like the briefs / panties is sharp enough for the antialiased trim
        if texel(s) < min_mpt:
            s *= texel(s) / min_mpt
        w, h = max(16, int(ext[0] * s)), max(16, int(ext[1] * s))
        size = max(w, h)
        vals = np.concatenate([np.ones(tri_v.shape[:2] + (1,)), tri_v], -1)
        m = tex.raster(cuv * np.array([w / size, h / size]), vals, size=size, radius=1)[:h, :w]
        cover = m[..., 0] > 0.5
        mpt = texel(s)
        # distance of every covered texel to the open edges (neutral, metres)
        pts = []
        for u, v in bedges:
            pu, pv = np.asarray(pos[u]), np.asarray(pos[v])
            nseg = max(1, int(np.ceil(np.linalg.norm(pv - pu) / step)))
            for j in range(nseg + 1):
                pts.append(pu + (pv - pu) * (j / nseg))
        kd = KDTree(len(pts))
        for i, p in enumerate(pts):
            kd.insert(p, i)
        kd.balance()
        fem = np.full((h, w), 1.0)
        P = m[..., 2:5] / np.maximum(m[..., :1], 1e-6)
        ys, xs = np.where(m[..., 0] > 1e-3)
        fem[ys, xs] = [kd.find(P[y_, x_])[2] for y_, x_ in zip(ys, xs)]
        tbm = fem
        if tb is not None:
            # waistband (briefs): per-texel metric distance to the top opening (the boundary loop highest up). The
            # interpolated per-vertex field tb zigzagged along the clipped triangles (sawtooth band edge, review
            # 2026-10-01); this is the same exact distance as the panties / bra trim, to one loop only.
            par = {}
            def root(x):
                while par.setdefault(x, x) != x:
                    par[x] = par[par[x]]
                    x = par[x]
                return x
            for u, v in bedges:
                par[root(u)] = root(v)
            loops = {}
            for u, v in bedges:
                loops.setdefault(root(u), []).append((u, v))
            top = max(loops.values(), key=lambda es: np.mean([pos[u][2] + pos[v][2] for u, v in es]))
            tp = [np.asarray(pos[u]) + (np.asarray(pos[v]) - np.asarray(pos[u])) * (j / n_)
                  for u, v in top
                  for n_ in [max(1, int(np.ceil(np.linalg.norm(np.asarray(pos[v]) - np.asarray(pos[u])) / step)))]
                  for j in range(n_ + 1)]
            kt = KDTree(len(tp))
            for i, p in enumerate(tp):
                kt.insert(p, i)
            kt.balance()
            tbm = np.full((h, w), 1.0)
            tbm[ys, xs] = [kt.find(P[y_, x_])[2] for y_, x_ in zip(ys, xs)]
        band = g["band"]
        # local metres per texel (the larger finite difference of the rasterised position, both axes): the body UV
        # is stretched at the back waist (1.5-2.4 mm/texel against the 1.1 mm median), where a ramp of one MEDIAN
        # texel was under one local texel and the band edge came out as a staircase (review 2026-10-01)
        cv = m[..., 0] > 0.5
        lm = np.full((h, w), 0.0)
        for ax in (0, 1):
            dP = np.linalg.norm(np.diff(P, axis=ax), axis=-1)
            ok = cv.take(range(1, cv.shape[ax]), axis=ax) & cv.take(range(cv.shape[ax] - 1), axis=ax)
            dP = np.where(ok, dP, 0.0)
            pad_a = [(0, 0), (0, 0)]
            pad_a[ax] = (1, 0)
            pad_b = [(0, 0), (0, 0)]
            pad_b[ax] = (0, 1)
            lm = np.maximum(lm, np.maximum(np.pad(dP, pad_a), np.pad(dP, pad_b)))
        lm = np.clip(lm, mpt, 3 * mpt)                      # (texels across a UV seam are far apart in 3D)
        aa = lambda d: np.clip(0.5 - d / (1.5 * lm), 0.0, 1.0)  # 1 inside (d < 0), ramp of 1.5 local texels
        sec = aa(tbm - band)
        rng = np.random.default_rng(11 + len(g["id"]))
        nz = rng.standard_normal((h, w))
        nz = nz - tex.blur(nz, 2)
        nz = nz / (np.std(nz) + 1e-6)
        yy, xx = np.mgrid[0:h, 0:w]
        rib = np.sin((xx + 0.5 * yy) * 2 * np.pi / 2.5)     # faint knit
        L = k * (1 + 0.03 * nz + 0.015 * rib)
        stitch = aa(np.abs(tbm - band) - 0.0008)
        hem = aa(fem - 0.0012)
        L = L * (1 - 0.2 * stitch) * (1 - 0.14 * hem)
        # edge padding: grow every island by 16 texels (each uncovered texel takes the mean of its covered
        # 8-neighbours, ring by ring). The 3-texel blur fill left the mask 0 (= primary) just past the island, and
        # bilinear / mip sampling along the island's staircase edge drew dark teeth on the briefs' waistband
        # (screenshot, review 2026-10-01).
        known = cover.copy()
        L, sec = np.where(cover, L, 0.0), np.where(cover, sec, 0.0)
        for _ in range(16):
            kf = known.astype(np.float64)
            pk, pl, ps = np.pad(kf, 1), np.pad(L * kf, 1), np.pad(sec * kf, 1)
            cnt, sl, ss = np.zeros_like(kf), np.zeros_like(kf), np.zeros_like(kf)
            for dy in (0, 1, 2):
                for dx in (0, 1, 2):
                    if dy == 1 and dx == 1:
                        continue
                    cnt += pk[dy:dy + h, dx:dx + w]
                    sl += pl[dy:dy + h, dx:dx + w]
                    ss += ps[dy:dy + h, dx:dx + w]
            grow = (~known) & (cnt > 0)
            if not grow.any():
                break
            L = np.where(grow, sl / np.maximum(cnt, 1), L)
            sec = np.where(grow, ss / np.maximum(cnt, 1), sec)
            known = known | grow
        L = np.where(known, L, k)
        out = os.path.join(B.args.textures, "cloth_%s" % g["id"])
        sv = tex.l2s(np.clip(L, 0, 1))
        albedo = tex.save(np.stack([sv, sv, sv], -1), out + "_albedo.jpg", quality=86)
        mask = tex.save(sec, out + "_mask.png")
        uv = (loop_uv - lo) / ext
        me.uv_layers.active.data.foreach_set("uv", uv.ravel())
        name = "Cloth_" + g["id"]
        me.materials.clear()
        me.materials.append(B.make_material(name, albedo))
        gain = 1.0 / k
        lin = tex.hex_to_lin(g["primary"]) * gain
        tint = {"gain": round(float(gain), 4), "default": g["primary"], "secondaryDefault": g["secondary"]}
        B.MATERIALS[name] = {"baseColorFactor": [float(min(1.0, v)) for v in lin] + [1.0], "roughness": g["roughness"],
                             "metallic": 0.0, "doubleSided": True, "extras": {"tint": tint},
                             "extraTextures": {"ccMask": mask}}
        rec["secondary"] = True
        print("BUILD cloth %s generated texture %dx%d px (uv %.3f..%.3f / %.3f..%.3f), %.2f mm/texel, %d edge points, "
              "secondary %.1f%% of texels" % (g["id"], w, h, lo[0], hi[0], lo[1], hi[1], 1000 * mpt, len(pts),
                                              100 * float((sec * cover).sum()) / max(1, int(cover.sum()))))

    def underwear_cover(self, rec, reach=0.08, edge=0.012, near=0.045, behind=0.012, snug=0.006):
        """_CCZONE of a generated underwear item: per vertex the zone bits of the garments that cover it.
        web/clothing.js drops the underwear triangles whose three vertices are covered by worn garments, and hides
        the mesh when none is left, so fully covered underwear is neither drawn nor skinned. Covered by garment G:
          * the body skin under the vertex (both body vertices of its binding) lies in G's own body zone, i.e. G
            already hides that skin. Without this, a dropped underwear triangle over skin that the underwear's own
            zone hides left a hole through the body (the T-shirt hem over the briefs / panties, review 2026-10-01);
            OR G is skinned (not simulated) and lies within `snug` m over the vertex: no gap to look into (the jeans
            crotch; the hem rule below still keeps G's open edges drawn);
          * a ray from the vertex along its normal hits G within `reach` m, at least `edge` m from G's open edges
            (grazing normals between the legs: the nearest G point within `near`, if it is not behind the vertex);
          * both on the neutral build shape AND on the item's sex shape (the viewer only shows male / female);
          * plus one ring of vertices that are under G at all (same zone test).
        Free-hanging parts count too (the skirt over the buttocks: the panties came through it as dark patches): the
        body-zone test already limits the drop to skin that G hides, so nothing becomes visible that is not
        already hidden there."""
        obj = rec["obj"]
        me = obj.data
        me.update()
        a, b, t = rec["nodes"]
        polys = [tuple(p.vertices) for p in me.polygons]
        utris = np.array([(p[0], p[k], p[k + 1]) for p in polys for k in range(1, len(p) - 1)], np.int64)
        nrm0 = np.array([tuple(v.normal) for v in me.vertices])
        usk = get_shapes(obj)
        sex_key = "gender_%s" % rec["spec"]["sex"] if rec["spec"].get("sex") else None
        shapes = ["Basis"] + ([sex_key] if sex_key in usk else [])
        n = len(nrm0)
        zone = np.zeros(n, np.int64)
        per = {}
        for r in self.done.values():
            if r["spec"].get("gen") or r["spec"].get("closed"):
                continue                                   # other underwear, footwear
            gz = (self.body_zone & r["bit"]) != 0
            inzone = gz[a] & (gz[b] | (t <= 0.0))
            gsk = get_shapes(r["obj"])
            _, gpolys = mesh_arrays(r["obj"])
            # open edges of the garment, with coincident vertices welded (the MakeHuman meshes are split along
            # seams, e.g. the jeans inseam: those are not open edges)
            g0 = gsk["Basis"]
            _, weld = np.unique(np.round(g0 / 1e-5).astype(np.int64), axis=0, return_inverse=True)
            weld = weld.ravel()
            ecnt = {}
            for p in gpolys:
                for u, v in zip(p, p[1:] + p[:1]):
                    k = (min(weld[u], weld[v]), max(weld[u], weld[v]))
                    ecnt[k] = ecnt.get(k, 0) + 1
                    ecnt.setdefault(("v", k), (u, v))
            bnd = sorted({x for k, c in ecnt.items() if k[0] != "v" and c == 1 for x in ecnt[("v", k)]})
            # the gate (skin hidden by G) or G snug on the vertex: under a garment that lies within `snug` m of the
            # underwear (the jeans crotch) there is no gap to look into, so dropping the underwear there opens no
            # visible hole; the hem rule (`edge`) still keeps the underwear drawn along G's open edges
            sim = bool(r["spec"].get("cloth"))
            cov_all, hit_all = np.ones(n, bool), np.ones(n, bool)
            for sname in shapes:
                co = usk[sname]
                nrm = vertex_normals(co, utris)
                nrm *= np.where((nrm * nrm0).sum(1) < 0, -1.0, 1.0)[:, None]
                gco = gsk.get(sname, g0)
                bvh = BVHTree.FromPolygons([Vector(p) for p in gco], gpolys)
                kd = KDTree(max(1, len(bnd)))
                for k, i in enumerate(bnd):
                    kd.insert(gco[i], k)
                kd.balance()
                cov = np.zeros(n, bool)
                hit = np.zeros(n, bool)
                for i in np.where(hit_all)[0]:
                    # the ray starts `behind` m under the vertex: where a tight garment sits closer to the skin than
                    # the underwear (front crotch of the jeans) the underwear would poke through it -> covered
                    loc, _, fi, dist = bvh.ray_cast(Vector(co[i] - nrm[i] * behind), Vector(nrm[i]), reach + behind)
                    if loc is not None:
                        gap = dist - behind
                    else:
                        loc, _, fi, dist = bvh.find_nearest(Vector(co[i]), near)
                        if loc is None or (np.array(loc) - co[i]).dot(nrm[i]) < -behind:
                            continue
                        gap = dist
                    if not inzone[i] and (sim or gap > snug):
                        continue
                    de = kd.find(loc)[2] if bnd else 1.0
                    if de < edge * 0.5:
                        continue
                    hit[i] = True
                    if de >= edge:
                        cov[i] = True
                cov_all &= cov
                hit_all &= hit
            cov = cov_all.copy()
            for e in me.edges:
                p, q = e.vertices
                if cov_all[p] and not cov_all[q] and hit_all[q]:
                    cov[q] = True
                elif cov_all[q] and not cov_all[p] and hit_all[p]:
                    cov[p] = True
            zone[cov] |= r["bit"]
            per[r["spec"]["id"]] = int(cov.sum())
        at = me.attributes.new("_CCZONE", 'FLOAT', 'POINT')
        at.data.foreach_set("value", zone.astype(np.float32))
        rec["coveredBy"] = per
        print("BUILD cloth %s covered vertices (of %d) per garment: %s" % (rec["spec"]["id"], len(co), per))

    def hide_lower(self, obj, g, rec, reach=0.08, edge=0.03, edge_collar=0.008):
        """Lower-layer garment vertices this garment covers get its zone bit in their own attribute _CCZONE; the
        viewer drops the lower garment's triangles whose three vertices are covered while this garment is worn
        (clothing.js applyZones). This removes the T-shirt poking through the coat where linear blend skinning of
        the two layers differs (shoulders, armpits, upper arms). Covered = a ray from the vertex along its normal
        hits this garment within `reach` m, on a fully pinned part (never under the free-hanging skirt), more than
        `edge` m from any open edge of this garment (front opening, neckline, cuffs, hem); a lower garment with its own
        collar (the shirt) under the back of a standing collar (coat_collar: collar_back) uses `edge_collar` m, so the
        part of the shirt collar the coat collar is not fitted over is hidden behind it."""
        me = obj.data
        co, polys = mesh_arrays(obj)
        bvh = BVHTree.FromPolygons([Vector(p) for p in co], polys)
        pin = np.ones(len(co), np.float32)
        if "_CLOTH_PIN" in me.attributes:
            me.attributes["_CLOTH_PIN"].data.foreach_get("value", pin)
        col = getattr(self, "collar_back", {}).get(g["id"], np.zeros(len(co), bool))
        bm = bmesh.new()
        bm.from_mesh(me)
        bnd = sorted({v.index for e in bm.edges if e.is_boundary for v in e.verts})
        bm.free()
        kd = KDTree(len(bnd))
        for k, i in enumerate(bnd):
            kd.insert(co[i], k)
        kd.balance()
        out = {}
        for r in self.done.values():
            if r["spec"]["layer"] >= g["layer"] or r["spec"].get("gen") or not wearable_together(g, r["spec"]):
                continue                                   # underwear: covered via underwear_cover
            lo = r["obj"].data
            lc, _ = mesh_arrays(r["obj"])
            own_collar = bool(r["spec"].get("tex", {}).get("collar_islands"))
            z = np.zeros(len(lc), np.float32)
            hit = np.zeros(len(lc), bool)        # under the coat at all, away from its open edges (for the grow step)
            for v in lo.vertices:
                loc, _, fi, dist = bvh.ray_cast(Vector(lc[v.index]) - v.normal * 0.01, v.normal, reach + 0.01)
                if loc is None:
                    continue
                e = edge_collar if own_collar and all(col[k] for k in polys[fi]) else edge
                if kd.find(loc)[2] < e * 0.5:
                    continue
                hit[v.index] = True
                if min(pin[k] for k in polys[fi]) < 0.99 or kd.find(loc)[2] < e:
                    continue
                z[v.index] = rec["bit"]
            # grow one ring: the boundary vertices of the covered region still carry drawn triangles, which is where
            # the specks were; the extra ring must itself lie under the coat. hide_grow (jacket: 2): more rings, for
            # the T-shirt's armpit, whose upper-arm weights carry it out through the jacket's side in the jump; its
            # normal points down along the side, so the ray misses the jacket: for those rings a vertex also counts
            # as under the jacket when the nearest jacket surface (<= 3 cm) faces away from it (it lies behind it)
            under = hit.copy()
            if g.get("hide_grow", 1) > 1:
                for v in lo.vertices:
                    if under[v.index]:
                        continue
                    loc, nrm, fi, dist = bvh.find_nearest(Vector(lc[v.index]), 0.03)
                    if loc is not None and (Vector(lc[v.index]) - loc).dot(nrm) < 0 and kd.find(loc)[2] >= edge:
                        under[v.index] = True
            for ring in range(g.get("hide_grow", 1)):
                grow = set()
                ok = hit if ring == 0 else under
                for e in lo.edges:
                    a, b = e.vertices
                    if z[a] and not z[b] and ok[b]:
                        grow.add(b)
                    elif z[b] and not z[a] and ok[a]:
                        grow.add(a)
                for i in grow:
                    z[i] = rec["bit"]
            if not z.any() and "_CCZONE" not in lo.attributes:
                continue
            if "_CCZONE" in lo.attributes:
                old = np.empty(len(lc), np.float32)
                lo.attributes["_CCZONE"].data.foreach_get("value", old)
                z = (old.astype(np.int64) | z.astype(np.int64)).astype(np.float32)
                lo.attributes.remove(lo.attributes["_CCZONE"])
            at = lo.attributes.new("_CCZONE", 'FLOAT', 'POINT')
            at.data.foreach_set("value", z)
            out[r["spec"]["id"]] = int((z > 0).sum())
        rec["hidesLower"] = out
        print("BUILD cloth %s hides covered vertices of the lower layers: %s" % (g["id"], out))

    def covered(self, obj, dv, reach=0.2, near=0.02, edge=0.035, tris=False, fill=False, near_hi=None):
        """Body vertices the fitted garment hides (its body zone):
        - of the MakeHuman delete_verts (made for the complete suit) only those the garment really covers: a ray from
          the body vertex along its normal must hit the garment within `reach` m (drops skin just above a waistband /
          below a hem, which would show up as holes, and self-occluded spots like armpit and crotch);
        - plus skin the delete list misses but the garment clearly covers: garment within `near` m (spec zone_near: a
          loose waist), ray hit, and more than `edge` m from any garment boundary (skin under a sleeve that the arm
          pushes through in walk / run);
        - tris (a flared skirt): a body triangle whose three vertices are covered but whose centre is not (the ray
          along its face normal leaves through the wide hem: the crotch under the flared skirt) keeps its skin."""
        B = self.B
        co, polys = mesh_arrays(obj)
        bvh = BVHTree.FromPolygons([Vector(p) for p in co], polys)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bnd = sorted({v.index for e in bm.edges if e.is_boundary for v in e.verts})
        bm.free()
        kd = KDTree(max(1, len(bnd)))
        for k, i in enumerate(bnd):
            kd.insert(co[i], k)
        kd.balance()
        me = B.human.data
        hit = lambda i: bvh.ray_cast(Vector(B.BASE_ARR[i]), Vector(me.vertices[i].normal), reach)[0] is not None
        ok = np.array([hit(i) for i in dv], bool)
        extra = []
        dvs = set(dv.tolist())
        for i in range(B.N_BODY):
            if i in dvs:
                continue
            p = Vector(B.BASE_ARR[i])
            if near_hi is None:
                loc = bvh.find_nearest(p, near)[0]
                if loc is None or not hit(i):
                    continue
            else:
                # near_hi = (z, near2): skin whose ray meets the garment at or above z (the pinned top of a cloth
                # skirt) is hidden within near2 m
                h = bvh.ray_cast(Vector(B.BASE_ARR[i]), Vector(me.vertices[i].normal), reach)
                if h[0] is None:
                    continue
                if bvh.find_nearest(p, near_hi[1] if h[0].z >= near_hi[0] else near)[0] is None:
                    continue
            if bnd and kd.find(p)[2] < edge:
                continue
            extra.append(i)
        out = set(dv[ok].tolist()) | set(extra)
        if tris:
            drop = set()
            me.calc_loop_triangles()
            for lt in me.loop_triangles:                  # per triangle, as the GLB draws it (tests: holes())
                vs = tuple(lt.vertices)
                if max(vs) >= B.N_BODY or not all(v in out for v in vs):
                    continue
                p = me.polygons[lt.polygon_index]
                T = B.BASE_ARR[list(vs)]
                n = np.cross(T[1] - T[0], T[2] - T[0])
                if n.dot(np.array(p.normal)) < 0:
                    n = -n
                n = n / max(np.linalg.norm(n), 1e-12)
                if bvh.ray_cast(Vector(T.mean(0)), Vector(n), reach)[0] is None:
                    drop.update(tuple(p.vertices))
            out -= drop
            if drop:
                print("BUILD cloth %s zone: %d skin verts of triangles whose centre is not covered stay drawn"
                      % (obj.name, len(drop)))
        if fill:
            out = set(self.fill_lone(obj, np.array(sorted(out), dtype=np.int64)).tolist())
        out = np.array(sorted(out), dtype=np.int64)
        print("BUILD cloth %s zone: %d of %d delete_verts covered along the skin normal, + %d covered skin verts -> %d"
              % (obj.name, int(ok.sum()), len(dv), len(extra), len(out)))
        return out

    def fill_lone(self, obj, dv):
        """Spec zone_fill: a skin vertex left drawn with every edge neighbour in the zone joins it. Such a lone vertex
        (not in the MakeHuman delete list of shoes03, or its ray slipped between two faces) keeps a fan of skin
        drawn deep inside the garment: the boots' instep vertex came 20..30 mm through the boot in walk / run
        (tools/cloth_integrity.mjs boots:body), and the clearance check measured boot vertices 27 mm away against
        that vertex's plane (4..22 'inside' at the inner arch, all 5..8 mm OUTSIDE the true skin)."""
        B = self.B
        out = set(np.asarray(dv).tolist())
        nb = {}
        for e in B.human.data.edges:
            a, b = e.vertices
            nb.setdefault(a, []).append(b)
            nb.setdefault(b, []).append(a)
        # islands of up to 8 drawn verts enclosed by the zone (the boots' instep hole is two verts)
        add, seen = set(), set()
        for s in {j for i in out for j in nb.get(i, ()) if j not in out and j < B.N_BODY}:
            if s in seen:
                continue
            comp, stack = {s}, [s]
            while stack and len(comp) <= 8:
                for j in nb.get(stack.pop(), ()):
                    if j not in out and j not in comp:
                        comp.add(j)
                        stack.append(j)
            seen |= comp
            if len(comp) <= 8 and not stack and all(j < B.N_BODY for j in comp):
                add |= comp
        print("BUILD cloth %s zone: %d drawn skin verts in islands of <= 8 inside the zone hidden" % (obj.name, len(add)))
        return np.array(sorted(out | add), dtype=np.int64)

    def delete_unkept(self, obj, keep, small):
        """Drop the suit parts we do not use (shape keys and weights survive the bmesh round trip).
        The secondary-colour flag of the kept small parts travels as an int vertex layer 'cc_sec'."""
        me = obj.data
        bm = bmesh.new()
        bm.from_mesh(me)
        lay = bm.verts.layers.int.new("cc_sec")
        bm.verts.ensure_lookup_table()
        for v in bm.verts:
            v[lay] = int(small[v.index])
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context='VERTS')
        bm.to_mesh(me)
        bm.free()
        me.update()

    def sock_weights(self, obj, k=4, near=0.015, far=0.04):
        """shoes01 = shoe + sock in one mesh: the MakeHuman weights skin the sock more to the foot / calf than the
        shoe around it, so the sock came out through the heel / collar and the shoe sank into it when the foot bent
        (tools/cloth_integrity.mjs shoes:socks). Each sock vertex (cc_sec) takes the inverse-distance blend of the
        weights of its k nearest shoe vertices: fully within `near` of the shoe, fading to its own weights at `far`
        (the cuff above the shoe keeps following the calf)."""
        me = obj.data
        n = len(me.vertices)
        sec = np.zeros(n, np.int32)
        me.attributes["cc_sec"].data.foreach_get("value", sec)
        co, _ = mesh_arrays(obj)
        shoe = np.where(sec == 0)[0]
        sock = np.where(sec != 0)[0]
        if not len(shoe) or not len(sock):
            return {"socks": 0}
        kd = KDTree(len(shoe))
        for j, i in enumerate(shoe):
            kd.insert(co[i], j)
        kd.balance()
        names = {grp.index: grp.name for grp in obj.vertex_groups}
        W = [{names[e.group]: e.weight for e in me.vertices[i].groups} for i in range(n)]
        moved = 0
        for i in sock:
            nn = kd.find_n(co[i], k)
            d0 = nn[0][2]
            t = 1.0 if d0 < near else 0.0 if d0 > far else 1.0 - (d0 - near) / (far - near)
            if t <= 0:
                continue
            acc, ws = {}, 0.0
            for _, j, d in nn:
                w = 1.0 / max(d, 1e-4)
                ws += w
                src = W[shoe[j]]
                tot = sum(src.values()) or 1.0
                for nm, wt in src.items():
                    acc[nm] = acc.get(nm, 0.0) + w * wt / tot
            own = W[i]
            tot = sum(own.values()) or 1.0
            want = {nm: (1 - t) * wt / tot for nm, wt in own.items()}
            for nm, wt in acc.items():
                want[nm] = want.get(nm, 0.0) + t * wt / ws
            for nm, wt in want.items():
                grp = obj.vertex_groups.get(nm) or obj.vertex_groups.new(name=nm)
                if wt > 1e-5:
                    grp.add([int(i)], wt, 'REPLACE')
                else:
                    grp.remove([int(i)])
            moved += 1
        print("BUILD cloth %s socks: %d of %d sock verts take the shoe's weights" % (obj.name, moved, len(sock)))
        return {"socks": int(len(sock)), "reweighted": moved}

    def flare(self, obj, f):
        """Widen the garment radially (x / y about the centre of the band) by s = k * smoothstep(top -> bottom) of
        the bind height, in the basis and every shape key (each about its own centre, so the morphs keep it)."""
        me = obj.data
        S = get_shapes(obj)
        base = S["Basis"]
        z0, z1 = self.z_of(f["top"]), self.z_of(f["bottom"])
        sc = 1.0 + f["k"] * smoothstep(z0, z1, base[:, 2])
        band = (base[:, 2] > z1) & (base[:, 2] < z0)
        for blk in me.shape_keys.key_blocks:
            X = S[blk.name]
            c = X[band][:, :2].mean(0) if band.any() else X[:, :2].mean(0)
            Y = X.copy()
            Y[:, :2] = c + (X[:, :2] - c) * sc[:, None]
            blk.data.foreach_set("co", Y.astype(np.float32).ravel())
        Y = base.copy()
        c = base[band][:, :2].mean(0) if band.any() else base[:, :2].mean(0)
        Y[:, :2] = c + (base[:, :2] - c) * sc[:, None]
        me.vertices.foreach_set("co", Y.astype(np.float32).ravel())
        me.update()
        print("BUILD cloth %s flare: x%.2f at z <= %.3f, from z %.3f" % (obj.name, 1 + f["k"], z1, z0))
        return {"k": f["k"], "top": round(z0, 4), "bottom": round(z1, 4)}

    def orient_outward(self, obj):
        """Per connected part: face normals must point away from the body (vote of the faces near the skin)."""
        me = obj.data
        me.update()
        co, polys = mesh_arrays(obj)
        roots = components(len(co), polys)
        votes = {}
        for poly in me.polygons:
            c = Vector(poly.center)
            loc, nrm, _, d = self.bvh0.find_nearest(c, 0.06)
            if loc is None:
                continue
            r = int(roots[poly.vertices[0]])
            votes[r] = votes.get(r, 0) + (1 if (c - loc).dot(poly.normal) > 0 else -1)
        flip = {r for r, v in votes.items() if v < 0}
        if flip:
            bm = bmesh.new()
            bm.from_mesh(me)
            bmesh.ops.reverse_faces(bm, faces=[f for f in bm.faces if int(roots[f.verts[0].index]) in flip])
            bm.to_mesh(me)
            bm.free()
            me.update()
        print("BUILD cloth %s normals: parts %d, flipped %d, votes %s" % (obj.name, len(votes), len(flip),
                                                                        sorted(votes.values())))

    def coat_drop_pockets(self, obj, ex):
        """Removes the suit jacket's two chest patch pockets and their flaps (small UV islands, <= 60 faces each, in
        front of the chest between z ex['pocket_z']) and closes the holes they leave with fill faces whose UVs point
        into the generated fabric rectangle ex['uv'] (planar x/z mapping, filled by tex_cloth)."""
        me = obj.data
        z0, z1 = ex["pocket_z"]
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        uvl = bm.loops.layers.uv.active
        isl = {}
        for f in bm.faces:
            if f.index in isl:
                continue
            st, isl[f.index] = [f], f.index
            while st:
                a = st.pop()
                for lp in a.loops:
                    e = lp.edge
                    for lo in e.link_loops:
                        b = lo.face
                        if b.index in isl or b is a:
                            continue
                        # UV-connected: the two faces share both edge vertices at the same UVs
                        ua = {l.vert.index: tuple(l[uvl].uv) for l in a.loops}
                        ub = {l.vert.index: tuple(l[uvl].uv) for l in b.loops}
                        if all(np.allclose(ua[v.index], ub[v.index], atol=1e-5) for v in e.verts):
                            isl[b.index] = isl[f.index]
                            st.append(b)
        groups = {}
        for fi, r in isl.items():
            groups.setdefault(r, []).append(bm.faces[fi])
        kill = []
        for r, fs in groups.items():
            c = np.array([tuple(f.calc_center_median()) for f in fs])
            if (len(fs) <= 60 and (c[:, 2] > z0).all() and (c[:, 2] < z1).all() and (np.abs(c[:, 0]) > 0.03).all()
                    and (np.abs(c[:, 0]) < 0.22).all() and (c[:, 1] < -0.03).all()):
                kill.append(fs)
        sizes = sorted(len(fs) for fs in kill)
        boxes = []                              # 3D extent of each removed part (its panel texels are shadowed)
        for fs in kill:
            p = np.array([tuple(v.co) for f in fs for v in f.verts])
            boxes.append((p.min(0) - 0.01, p.max(0) + 0.01))
        dead = [f for fs in kill for f in fs]
        bmesh.ops.delete(bm, geom=dead, context='FACES_ONLY')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        ring = [e for e in bm.edges if e.is_boundary and z0 - 0.02 < e.verts[0].co.z < z1 + 0.02
                and 0.02 < abs(e.verts[0].co.x) < 0.24 and e.verts[0].co.y < -0.02]
        res = bmesh.ops.holes_fill(bm, edges=ring, sides=0)
        holes = list(res["faces"])
        for f in holes:                        # same winding as the panel around it
            f.normal_update()
            nb = [l.face for lp in f.loops for l in lp.edge.link_loops if l.face is not f]
            if nb and sum(f.normal.dot(x.normal) for x in nb) < 0:
                f.normal_flip()
        ring_v = {v for f in holes for v in f.verts}
        for f in holes:                        # UVs: the panel's own UVs at the hole border (its atlas hole is
            f.smooth = True                    # inpainted by tex_cloth, face flag cc_fill)
            for lp in f.loops:
                other = [l for l in lp.vert.link_loops if l.face not in holes]
                lp[uvl].uv = other[0][uvl].uv if other else lp[uvl].uv
        # hole border data (plain arrays: bmesh ops below may reallocate elements)
        dl = bm.verts.layers.deform.verify()
        shp = list(bm.verts.layers.shape.values())
        ring_l = list(ring_v)
        rco = np.array([tuple(v.co) for v in ring_l])
        roff = [np.array([tuple(v[layer] - v.co) for v in ring_l]) for layer in shp]
        rw = [dict(v[dl].items()) for v in ring_l]
        # interior vertices (a flat n-gon would cut into the chest): poke + split the spokes
        key = lambda v: tuple(round(c, 6) for c in v.co)
        old = {key(v) for v in bm.verts}       # new vertices reuse freed slots, so neither index order nor python
        pk = bmesh.ops.poke(bm, faces=holes)
        centers = set(pk["verts"])
        spokes = [e for e in bm.edges if e.verts[0] in centers or e.verts[1] in centers]
        bmesh.ops.subdivide_edges(bm, edges=spokes, cuts=1, use_grid_fill=False)
        bm.verts.index_update()
        new_v = [v for v in bm.verts if key(v) not in old]    # wrappers identify them: position does
        for v in new_v:                        # morph offsets / weights: inverse-distance mix of the hole border
            d = np.linalg.norm(rco - np.array(tuple(v.co)), axis=1)
            wgt = 1.0 / np.maximum(d, 1e-4) ** 4
            wgt /= wgt.sum()
            for layer, off in zip(shp, roff):
                v[layer] = v.co + Vector((wgt[:, None] * off).sum(0))
            acc = {}
            for i in range(len(ring_l)):
                for gi, x in rw[i].items():
                    acc[gi] = acc.get(gi, 0.0) + x * float(wgt[i])
            tot = sum(acc.values()) or 1.0
            v[dl].clear()
            for gi, x in acc.items():
                if x / tot > 1e-4:
                    v[dl][gi] = x / tot
        fl = bm.faces.layers.int.get("cc_fill") or bm.faces.layers.int.new("cc_fill")
        nv = set(new_v)
        for f in bm.faces:
            c = np.array(tuple(f.calc_center_median()))
            f[fl] = int(any(v in nv for v in f.verts) or any((c > lo).all() and (c < hi).all() for lo, hi in boxes))
        bm.to_mesh(me)
        bm.free()
        me.update()
        print("BUILD coat pockets: removed %d islands (faces %s), %d holes filled with %d interior vertices"
              % (len(kill), sizes, len(holes), len(new_v)))

    # ---- trench coat: cut the jacket at the waist, long skirt + belt ------------------------------------
    def coat_skirt(self, obj, g, fit):
        """Long coat from the CC0 jacket (project code):
        1. cut: jacket faces (torso only, |x| < 0.3 m, so the sleeves stay) whose centre lies below the belt line
           ex['cut'] are deleted, with the islands they leave behind (lower patch pockets);
        2. skirt: a regular grid of `columns` + 1 columns (angle around the pelvis axis, from the left front edge
           around the back to the right front edge, back centre = middle column) and rows every ~ex['row'] m from
           just above the belt line (tucked `tuck` m under the jacket) down to ex['hem']. Radius per row and column
           = max(previous row + flare * frac * dz, body envelope at that height/angle + clearance ramped in over
           `clearance_ramp` m), smoothed along the row (never shrinking), so it hangs as a slim A-line over hips and
           legs without entering them. Front columns turn outward by up to `open_deg` toward the hem (open front),
           the back centre column is split below ex['vent'] (back vent, the two edges `vent_gap` m apart);
        3. belt: a 3-row band `belt` m tall, `belt_offset` m over the jacket / skirt around the belt line, open at
           the front edges, UVs in the `belt_uv` rectangle (secondary colour); it hides the cut;
        4. all new vertices get a synthetic MHCLO-style binding (SynthFit) and the weights of the nearest jacket
           vertex at the belt line; the pin mask / leg weights of the skirt are set later (cloth_weights_and_pin).
        Returns the index ranges: jacket [0, n0), skirt [n0, n0 + ns), belt [n0 + ns, n)."""
        B = self.B
        ex = g["coat"]
        me = obj.data
        if ex.get("drop_pockets"):
            self.coat_drop_pockets(obj, ex)
        co, polys = mesh_arrays(obj)
        roots = components(len(co), polys)
        jr = np.bincount(roots).argmax()                   # the jacket = largest part
        z_cut = self.z_of(ex["cut"])
        # 1. cut
        bm = bmesh.new()
        bm.from_mesh(me)
        kill = [f for f in bm.faces if roots[f.verts[0].index] == jr and f.calc_center_median().z < z_cut
                and max(abs(v.co.x) for v in f.verts) < 0.3]
        n_before = len(bm.verts)
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        bm.to_mesh(me)
        bm.free()
        me.update()
        co, polys = mesh_arrays(obj)
        roots = components(len(co), polys)
        ids, cnt = np.unique(roots, return_counts=True)
        tiny = set(ids[cnt < 40].tolist())
        if tiny:
            bm = bmesh.new()
            bm.from_mesh(me)
            bm.verts.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if roots[v.index] in tiny], context='VERTS')
            bm.to_mesh(me)
            bm.free()
            me.update()
            co, polys = mesh_arrays(obj)
            roots = components(len(co), polys)
        n0 = len(co)
        jr = np.bincount(roots).argmax()
        # faces that straddle the cut leave points hanging below it: lift them to just under the belt's lower edge
        z_min = z_cut - ex["belt"] / 2 + 0.008
        low = (roots == jr) & (co[:, 2] < z_min) & (np.abs(co[:, 0]) < 0.3)
        if low.any():
            dz = np.where(low, z_min - co[:, 2], 0.0)
            for blk in me.shape_keys.key_blocks:
                arr = np.empty(n0 * 3, np.float32)
                blk.data.foreach_get("co", arr)
                arr = arr.reshape(-1, 3)
                arr[:, 2] += dz
                blk.data.foreach_set("co", arr.ravel())
            me.vertices.foreach_set("co", (co + np.c_[np.zeros((n0, 2)), dz]).astype(np.float32).ravel())
            me.update()
            co[:, 2] += dz
        print("BUILD coat cut at z %.3f: %d jacket faces removed, verts %d -> %d (%d loose islands dropped)"
              % (z_cut, len(kill), n_before, n0, len(tiny)))
        jpolys = [p for p in polys if roots[p[0]] == jr]
        bvhJ = BVHTree.FromPolygons([Vector(p) for p in co], jpolys)
        cy = float(self.heads["pelvis"][1])
        R0 = 0.35                                          # inside the sleeves (|x| > 0.4), outside the torso

        def jacket_r(alpha, z):
            d = Vector((np.sin(alpha), -np.cos(alpha), 0.0))
            hit = bvhJ.ray_cast(Vector((0.0, cy, z)) + d * R0, -d, R0)
            return None if hit[0] is None else R0 - hit[3]

        # closed (the dress): a tube without a front opening; column M is column 0 again (one UV seam at the front
        # centre, no duplicated vertices), no vent unless ex['vent'] is given
        closed = bool(ex.get("closed"))
        if closed:
            alpha0 = 0.0
        else:
            # front edges: jacket boundary vertices just above the belt line, in front of the body, near x = 0
            bmj = bmesh.new()
            bmj.from_mesh(me)
            bnd = np.array(sorted({v.index for e in bmj.edges if e.is_boundary for v in e.verts}), dtype=np.int64)
            bmj.free()
            bnd = bnd[(roots[bnd] == jr) & (co[bnd, 2] > z_cut) & (co[bnd, 2] < z_cut + 0.12) & (co[bnd, 1] < cy - 0.05)
                      & (np.abs(co[bnd, 0]) < 0.12)]
            alpha0 = float(np.median(np.arctan2(np.abs(co[bnd, 0]), cy - co[bnd, 1]))) if len(bnd) else np.radians(8)
        M = int(ex["columns"]) // 2 * 2
        MC = M if closed else M + 1                       # distinct columns
        alphas = alpha0 + (2 * np.pi - 2 * alpha0) * np.arange(M + 1) / M
        z_top = z_cut + ex["top_overlap"]
        z_hem = self.z_of(ex["hem"])
        R = int(np.ceil((z_top - z_hem) / ex["row"]))
        zs = z_top - (z_top - z_hem) * np.arange(R + 1) / R
        z_vent = self.z_of(ex["vent"]) if ex.get("vent") else None
        # envelope = body + every lower-layer garment (the skirt's hem would otherwise leave a step in the coat)
        P = np.concatenate([B.BASE_ARR[:B.N_BODY]] + [get_shapes(r["obj"])["Basis"] for r in self.done.values()
                                                      if r["spec"]["layer"] < g["layer"] and not r["spec"].get("gen")
                                                      and wearable_together(g, r["spec"]) and r["spec"].get("coat_envelope", True)])
        legs = np.abs(P[:, 0]) < 0.28
        dPa = np.arctan2(P[:, 0], cy - P[:, 1])            # body vertex angle, same convention as alpha
        dPr = np.hypot(P[:, 0], P[:, 1] - cy)

        def envelope(alpha, z):
            sl = legs & (np.abs(P[:, 2] - z) < 0.015)
            da = np.abs((dPa[sl] - alpha + np.pi) % (2 * np.pi) - np.pi)
            near = da < np.radians(12)
            return float(dPr[sl][near].max()) if near.any() else 0.0

        r_top = np.array([jacket_r(a, z_top) or 0.0 for a in alphas])
        miss = r_top <= 0
        if miss.any():                                     # fill gaps from the neighbours
            ok = np.where(~miss)[0]
            r_top[miss] = np.interp(np.where(miss)[0], ok, r_top[ok])
        r_top = r_top - ex["tuck"]
        side = np.where(np.arange(M + 1) < M / 2, 1.0, -1.0)
        dfront = np.minimum(alphas, 2 * np.pi - alphas) - alpha0
        wopen = np.clip(1 - dfront / np.radians(ex["open_width_deg"]), 0, 1)
        grid_pos = np.zeros((R + 1, M + 1, 3))
        radius = np.zeros((R + 1, M + 1))
        a_all = [alphas + side * np.radians(ex["open_deg"]) * ((z_top - zs[k]) / (z_top - z_hem)) ** 1.5 * wopen
                 for k in range(R + 1)]
        need = np.zeros((R + 1, M + 1))
        for k in range(1, R + 1):
            env = np.array([envelope(a, zs[k]) for a in a_all[k]])
            clr = ex["clearance"] * smoothstep(0.0, ex["clearance_ramp"], z_top - zs[k])
            need[k] = np.where(env > 0, env + clr, 0.0)
        for k in range(R - 1, 0, -1):                       # cone hull: widen early above a bulge (knee, calf)
            need[k] = np.maximum(need[k], need[k + 1] - ex.get("max_slope", 0.3) * (zs[k] - zs[k + 1]))
        r_prev = r_top
        for k in range(R + 1):
            d = z_top - zs[k]
            frac = d / (z_top - z_hem)
            a_k = a_all[k]
            if k == 0:
                r = r_top.copy()
            else:
                r = np.maximum(r_prev + ex["flare"] * frac * (zs[k - 1] - zs[k]), need[k])
                r = np.maximum(r, r_prev)
                for _ in range(4):                          # smooth along the row, never shrink
                    r[1:-1] = np.maximum(r[1:-1], 0.25 * r[:-2] + 0.5 * r[1:-1] + 0.25 * r[2:])
            grid_pos[k] = np.c_[r * np.sin(a_k), cy - r * np.cos(a_k), np.full(M + 1, zs[k])]
            radius[k] = r
            r_prev = r
        # back vent: rows strictly below the first row at or under z_vent get a second back-centre vertex
        kv = int(np.argmax(zs <= z_vent)) if z_vent is not None else R
        vent_rows = list(range(kv + 1, R + 1))
        mid = M // 2
        vent_pos = grid_pos[vent_rows, mid].copy()
        grid_pos[vent_rows, mid, 0] += ex.get("vent_gap", 0.0) / 2      # left edge (x > 0 = character's left)
        vent_pos[:, 0] -= ex.get("vent_gap", 0.0) / 2                   # right edge

        # belt: 3 rows around the belt line, over the jacket and the skirt
        def skirt_r(j, z):
            return float(np.interp(-z, -zs, radius[:, j]))
        bz = [z_cut + ex["belt"] / 2, z_cut, z_cut - ex["belt"] / 2]
        belt_pos = np.zeros((3, M + 1, 3))
        for i, z in enumerate(bz):
            for j, a in enumerate(alphas):
                rj = jacket_r(a, z)
                r = max(rj or 0.0, skirt_r(j, z) if z <= z_top else 0.0) + ex["belt_offset"]
                belt_pos[i, j] = (r * np.sin(a), cy - r * np.cos(a), z)

        skirt_list = grid_pos[:, :MC].reshape(-1, 3)
        new_pos = np.concatenate([skirt_list, vent_pos, belt_pos[:, :MC].reshape(-1, 3)])
        ns = len(skirt_list) + len(vent_pos)
        # binding of the new vertices to the neutral body (nearest body polygon, barycentric weights)
        nn = len(new_pos)
        idx = np.zeros((nn, 4), np.int64)
        w = np.zeros((nn, 4))
        for i, p in enumerate(new_pos):
            loc, _, pi, _ = self.bvh0.find_nearest(Vector(p))
            vids = self.body_polys[pi]
            ws = poly_3d_calc([Vector(B.BASE_ARR[k]) for k in vids], loc)
            idx[i, :len(vids)] = vids
            w[i, :len(vids)] = ws
        off = new_pos - (w[:, :, None] * B.BASE_ARR[idx]).sum(1)
        sf = SynthFit(idx, w, off, fit, B.BASE_ARR)
        neutral = sf(B.BASE_ARR)
        assert np.abs(neutral - new_pos).max() < 1e-6
        deltas = B.fit_keys(sf, neutral)
        # the body morphs are symmetric, but the nearest-polygon binding of the two edges of the back vent / front
        # opening may pick polygons on opposite sides of the midline, so a morph (child, short) could carry one edge
        # across the other: symmetrize the deltas over mirror pairs (x -> -x)
        mir = [int(np.argmin(np.linalg.norm(new_pos - p * (-1, 1, 1), axis=1))) for p in new_pos]
        ok = np.array([np.linalg.norm(new_pos[m] - new_pos[i] * (-1, 1, 1)) < 0.005 for i, m in enumerate(mir)])
        flip = np.array([-1.0, 1.0, 1.0])
        # and a vertex on the midline (vent edges: x = +-vent_gap/2) stays on it: fade the x delta out within 3 cm
        fade = np.minimum(1.0, np.abs(new_pos[:, 0]) / 0.03)
        for name, d in deltas.items():
            sym = (d + d[mir] * flip) / 2
            d[ok] = sym[ok]
            d[:, 0] *= fade
        print("BUILD coat skirt: %d of %d new vertices have a mirror partner, morph deltas symmetrized" % (ok.sum(), nn))
        # UVs: free rectangle of the atlas (the suit's jeans area); v span for roughly square texels
        u0, u1, v0, v1 = ex["uv"]
        arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(grid_pos[R // 2, :, :2], axis=0), axis=1))]
        v1 = min(v1, v0 + (u1 - u0) * float(z_top - z_hem) / arc[-1])
        uu = u0 + (u1 - u0) * arc / arc[-1]
        bu0, bu1, bv0, bv1 = ex["belt_uv"]
        # weights: nearest jacket vertex at the belt line (per column)
        jband = np.where((roots == jr) & (co[:, 2] > z_cut) & (co[:, 2] < z_cut + 0.08) & (np.abs(co[:, 0]) < 0.3))[0]
        src = [int(jband[np.argmin(np.linalg.norm(co[jband] - grid_pos[0, j], axis=1))]) for j in range(M + 1)]
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        uvl = bm.loops.layers.uv.active
        sec = bm.verts.layers.int.get("cc_sec")
        dl = bm.verts.layers.deform.verify()
        src_w = [dict(bm.verts[s][dl].items()) for s in src]

        def vnew(p, j):
            v = bm.verts.new(Vector(p))
            for gi, wt in src_w[j].items():
                v[dl][gi] = wt
            if sec:
                v[sec] = 0
            return v
        G = [[vnew(grid_pos[k, j], j) for j in range(MC)] for k in range(R + 1)]
        V = {k: vnew(p, mid) for k, p in zip(vent_rows, vent_pos)}
        BL = [[vnew(belt_pos[i, j], j) for j in range(MC)] for i in range(3)]
        if closed:                                         # the last column is the first one (closed tube)
            for row in G + BL:
                row.append(row[0])
        new_faces = []

        def quad(vs, uvs):
            f = bm.faces.new(vs)
            f.smooth = True
            for lp, uv in zip(f.loops, uvs):
                lp[uvl].uv = uv
            new_faces.append(f)
        vv = lambda k: v1 - (v1 - v0) * k / R
        for k in range(R):
            for j in range(M):
                a, b = G[k][j], G[k][j + 1]
                c, d = G[k + 1][j + 1], G[k + 1][j]
                if j == mid and k in V:                     # right of the vent: the second edge column
                    a = V[k]
                if j == mid and (k + 1) in V:
                    d = V[k + 1]
                quad((a, b, c, d), ((uu[j], vv(k)), (uu[j + 1], vv(k)), (uu[j + 1], vv(k + 1)), (uu[j], vv(k + 1))))
        bus = bu0 + (bu1 - bu0) * np.arange(M + 1) / M
        for i in range(2):
            for j in range(M):
                quad((BL[i][j], BL[i][j + 1], BL[i + 1][j + 1], BL[i + 1][j]),
                     ((bus[j], bv1 - (bv1 - bv0) * i / 2), (bus[j + 1], bv1 - (bv1 - bv0) * i / 2),
                      (bus[j + 1], bv1 - (bv1 - bv0) * (i + 1) / 2), (bus[j], bv1 - (bv1 - bv0) * (i + 1) / 2)))
        bmesh.ops.recalc_face_normals(bm, faces=new_faces)   # orient_outward decides the side afterwards
        new_verts = [v for row in G for v in row[:MC]] + [V[k] for k in vent_rows] + [v for row in BL for v in row[:MC]]
        for layer in bm.verts.layers.shape.values():        # placeholder = neutral; exact keys written below
            for v in new_verts:
                v[layer] = v.co
        bm.verts.index_update()
        order = [v.index for v in new_verts]
        bm.to_mesh(me)
        bm.free()
        me.update()
        n = len(me.vertices)
        assert n == n0 + nn and order == list(range(n0, n)), "new vertices must follow the jacket in order"
        for blk in me.shape_keys.key_blocks:
            arr = np.empty(n * 3, np.float32)
            blk.data.foreach_get("co", arr)
            arr = arr.reshape(-1, 3)
            arr[n0:] = neutral + (deltas[blk.name] if blk.name in deltas else 0.0)
            blk.data.foreach_set("co", arr.ravel())
        print("BUILD coat skirt %d cols x %d rows (+%d vent) z %.3f..%.3f, hem radius %.3f..%.3f m, front edge %.1f deg, "
              "belt %d verts, uv v %.3f..%.3f"
              % (M + 1, R + 1, len(vent_rows), z_top, z_hem, radius[-1].min(), radius[-1].max(), np.degrees(alpha0),
                 3 * MC, v0, v1))
        return dict(verts=nn, skirt=(n0, n0 + ns), belt=(n0 + ns, n), rows=R + 1, cols=MC, n0=n0,
                    uv=(u0, u1, v0, v1), uv_per_m=float((u1 - u0) / arc[-1]), belt_uv=(bu0, bu1, bv0, bv1), z_cut=z_cut, hem_z=z_cut, z_hem=z_hem)

    # ---- trench coat: standing collar + broad lapels ---------------------------------------------------
    def coat_collar(self, obj, g, fit, rec):
        """Tall standing collar + broad peaked lapels (project code; replaces the suit's small collar part).
        One strip of quads follows the jacket's open edge (neckline + front edges, found as the jacket boundary loop
        with the highest point) from the lapel break ex['lapel_break'] on the character's right, around the back of the
        neck, down to the break on the left; symmetric by construction (left half mirrored).
        - collar columns (back / sides, neck angle < ex['gorge_deg'] from the back): the strip stands up along the
          neck axis (neck_01 -> head) by H (ex['height_back'] .. ex['height_front']) and flares out radially by F
          (ex['flare_back'] .. ex['flare_front']) at the top; the top edge folds 12 mm back down inside (crisp,
          thick-looking rim; the inside face shows the lining colour at runtime);
        - lapel columns (front edges): the strip rolls over the jacket edge and lies on the jacket (projected onto
          it + ex['lapel_offset']), width ex['lapel_width'] at the top tapering to ex['lapel_min'] at the break; the
          top columns tilt upward by up to ex['peak_deg'] (peak lapel); one narrow column (ex['notch_width']) between
          the lapel peak and the collar's front end makes the notch; the outer edge folds 6 mm under (crisp edge).
        Binding: synthetic MHCLO-style (SynthFit) on the nearest body polygon below the head (neck / chest), so the
        collar follows every morph like the jacket but never the face morphs; weights = nearest jacket vertex
        without 'head' (rotations of the head never pull the collar); pinned (_CLOTH_PIN = 1) like the jacket.
        Afterwards a clearance pass (collar only): >= ex['body_gap'] over the skin, >= EPS_LAYER over the lower
        layers, and the lapels >= 2.5 mm over the jacket, at every sampled shape."""
        B = self.B
        ex = g["coat"]["collar"]
        me = obj.data
        co, polys = mesh_arrays(obj)
        n0 = rec["ext"]["n0"]
        jpolys = [p for p in polys if max(p) < n0]
        bvhJ = BVHTree.FromPolygons([Vector(p) for p in co], jpolys)
        # 1. the jacket edge path (left half, back centre -> lapel break)
        bm = bmesh.new()
        bm.from_mesh(me)
        adj = {}
        for e in bm.edges:
            a, b = e.verts[0].index, e.verts[1].index
            if e.is_boundary and a < n0 and b < n0:
                adj.setdefault(a, []).append(b)
                adj.setdefault(b, []).append(a)
        bm.free()
        loops, seen = [], set()
        for s0 in adj:
            if s0 in seen:
                continue
            loop, prev, cur = [s0], None, s0
            seen.add(s0)
            while True:
                nx = [q for q in adj[cur] if q != prev and q not in seen]
                if not nx:
                    break
                prev, cur = cur, nx[0]
                seen.add(cur)
                loop.append(cur)
            loops.append(loop)
        L = co[max(loops, key=lambda l: co[l, 2].max())]
        L = np.roll(L, -int(np.argmax(L[:, 2] + (L[:, 1] > 0) - 5 * np.abs(L[:, 0]))), axis=0)   # back neck centre
        if L[1, 0] < 0:
            L = np.r_[L[:1], L[1:][::-1]]                                    # walk toward the character's left
        z_break = self.z_of(ex["lapel_break"])
        half = [L[0] * (0, 1, 1)]
        for p in L[1:]:
            if p[2] < z_break:
                q = half[-1]
                half.append(q + (p - q) * (q[2] - z_break) / (q[2] - p[2]))
                break
            half.append(p)
        half = np.array(half)
        seg = np.linalg.norm(np.diff(half, axis=0), axis=1)
        keep = np.r_[True, seg > 1e-4]
        half = half[keep]
        arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(half, axis=0), axis=1))]
        S = float(arc[-1])
        O = self.heads["neck_01"]
        A = self.heads["head"] - O
        A = A / np.linalg.norm(A)

        def at(s):
            return np.array([np.interp(s, arc, half[:, c]) for c in range(3)])

        def radial(P):
            v = P - O
            rho = v - v.dot(A) * A
            r = float(np.linalg.norm(rho))
            return rho / max(r, 1e-6), r

        theta = np.array([np.degrees(np.arctan2(abs(radial(p)[0][0]), radial(p)[0][1])) for p in half])
        s_g = float(np.interp(ex["gorge_deg"], theta, arc)) if theta.max() > ex["gorge_deg"] else S * 0.5

        def outward(P, nrm):
            loc = self.bvh0.find_nearest(Vector(P))[0]
            n = np.array(nrm)
            return n if loc is None or np.dot(P - np.array(loc), n) >= 0 else -n

        def frame(s):
            P = at(s)
            t = at(min(S, s + 0.004)) - at(max(0.0, s - 0.004))
            t /= np.linalg.norm(t)
            loc, nrm, _, _ = bvhJ.find_nearest(Vector(P))
            n = outward(P, nrm)
            a = np.cross(n, t)
            a /= np.linalg.norm(a)
            d1 = bvhJ.find_nearest(Vector(P + a * 0.015))[3]
            d2 = bvhJ.find_nearest(Vector(P - a * 0.015))[3]
            if d1 is None or d2 is None:
                raise RuntimeError("collar frame at s=%.3f: P %s t %s n %s a %s" % (s, P, t, n, a))
            return P, t, n, (a if d1 <= d2 else -a)

        def on_jacket(Q, off):
            loc, nrm, _, _ = bvhJ.find_nearest(Vector(Q))
            return np.array(loc) + outward(np.array(loc), nrm) * off

        def lapel(s, w, tilt):
            P, t, n, a = frame(s)
            d = a * np.cos(np.radians(tilt)) - t * np.sin(np.radians(tilt))   # -t = up along the edge
            off = ex["lapel_offset"]
            return P, [P - a * 0.004 + n * 0.003, on_jacket(P + d * w * 0.4, off), on_jacket(P + d * w * 0.75, off),
                       on_jacket(P + d * w, off + 0.001), on_jacket(P + d * (w - 0.006), off - 0.0035)]

        def collar(s):
            P = at(s)
            e, r0 = radial(P)
            th = np.degrees(np.arctan2(abs(e[0]), e[1]))
            k = smoothstep(ex["side_deg"], ex["gorge_deg"], th)
            H = ex["height_back"] + (ex["height_front"] - ex["height_back"]) * k
            F = ex["flare_back"] + (ex["flare_front"] - ex["flare_back"]) * k
            pt = lambda f: P + A * (f * H) + e * (0.004 + F * f ** 1.6)
            return P, [pt(0.0) - A * 0.008, pt(0.4), pt(0.75), pt(1.0), pt(1.0) - A * 0.012 - e * 0.0045]

        cols = []                                       # (kind, P, 5 row positions), left half, back -> break
        nc = max(2, int(np.ceil(s_g / ex["step"])))
        for s in np.linspace(0.0, s_g, nc + 1):
            cols.append(("collar",) + collar(s))
        cols.append(("lapel",) + lapel(min(S, s_g + 0.006), ex["notch_width"], ex["peak_deg"]))
        sl0 = s_g + 0.016
        nl = max(2, int(np.ceil((S - sl0) / ex["step"])))
        for s in np.linspace(sl0, S, nl + 1):
            u = (s - sl0) / max(S - sl0, 1e-6)
            w = ex["lapel_min"] + (ex["lapel_width"] - ex["lapel_min"]) * (1 - u) ** 0.75
            cols.append(("lapel",) + lapel(s, w, ex["peak_deg"] * (1 - smoothstep(0.0, 0.3, u))))
        mir = lambda c: (c[0], c[1] * (-1, 1, 1), [p * (-1, 1, 1) for p in c[2]])
        cols = [mir(c) for c in cols[:0:-1]] + cols
        C, K = len(cols), 5
        grid = np.array([c[2] for c in cols])          # (C, K, 3)
        base_p = np.array([c[1] for c in cols])
        is_lapel = np.array([c[0] == "lapel" for c in cols])
        new_pos = grid.reshape(-1, 3)
        nn = len(new_pos)
        # 2. binding to the body below the head (neck / chest polygons only)
        zlim = float(self.heads["head"][2]) - 0.04
        sub = [p for p in self.body_polys if B.BASE_ARR[list(p), 2].max() < zlim]
        bvhS = BVHTree.FromPolygons([Vector(p) for p in B.BASE_ARR[:B.N_BODY]], sub)
        idx = np.zeros((nn, 4), np.int64)
        w = np.zeros((nn, 4))
        for i, p in enumerate(new_pos):
            loc, _, pi, _ = bvhS.find_nearest(Vector(p))
            vids = sub[pi]
            ws = poly_3d_calc([Vector(B.BASE_ARR[k]) for k in vids], loc)
            idx[i, :len(vids)] = vids
            w[i, :len(vids)] = ws
        off = new_pos - (w[:, :, None] * B.BASE_ARR[idx]).sum(1)
        sf = SynthFit(idx, w, off, fit, B.BASE_ARR)
        neutral = sf(B.BASE_ARR)
        assert np.abs(neutral - new_pos).max() < 1e-6
        deltas = B.fit_keys(sf, neutral)
        mi = [int(np.argmin(np.linalg.norm(new_pos - p * (-1, 1, 1), axis=1))) for p in new_pos]
        ok = np.array([np.linalg.norm(new_pos[m] - new_pos[i] * (-1, 1, 1)) < 0.002 for i, m in enumerate(mi)])
        fade = np.minimum(1.0, np.abs(new_pos[:, 0]) / 0.03)
        for d in deltas.values():
            sym = (d + d[mi] * (-1.0, 1.0, 1.0)) / 2
            d[ok] = sym[ok]
            d[:, 0] *= fade
        # 3. mesh: vertices (weights of the nearest jacket vertex, no head), quads, UVs in the generated fabric
        kd = KDTree(n0)
        for i in range(n0):
            kd.insert(co[i], i)
        kd.balance()
        u0, u1, v0, v1 = rec["ext"]["uv"]
        dens = rec["ext"]["uv_per_m"]
        mid_row = grid[:, 2]
        uarc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(mid_row, axis=0), axis=1))]
        uu = u0 + 0.005 + uarc * dens
        across = np.concatenate([np.zeros((C, 1)), np.cumsum(np.linalg.norm(np.diff(grid, axis=1), axis=2), axis=1)], 1)
        vv = v1 - 0.005 - across * dens
        assert uu[-1] < u1 and vv.min() > v0, "collar UVs leave the fabric rectangle"
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        uvl = bm.loops.layers.uv.active
        sec = bm.verts.layers.int.get("cc_sec")
        dl = bm.verts.layers.deform.verify()
        head_gi = obj.vertex_groups["head"].index if obj.vertex_groups.get("head") else -1
        src_w = {}
        for c in range(C):
            for k in range(K):
                src = kd.find(base_p[c] if not is_lapel[c] else grid[c, k])[1]
                src_w[c, k] = {gi: x for gi, x in bm.verts[src][dl].items() if gi != head_gi}
        G = []
        for c in range(C):
            row = []
            for k in range(K):
                p = grid[c, k]
                wt = src_w[c, k]
                tot = sum(wt.values()) or 1.0
                v = bm.verts.new(Vector(p))
                for gi, x in wt.items():
                    v[dl][gi] = x / tot
                if sec:
                    v[sec] = 0
                row.append(v)
            G.append(row)
        faces = []
        for c in range(C - 1):
            if is_lapel[c] != is_lapel[c + 1]:
                continue                                # notch: collar and lapels are separate pieces
            for k in range(K - 1):
                f = bm.faces.new((G[c][k], G[c + 1][k], G[c + 1][k + 1], G[c][k + 1]))
                f.smooth = True
                for lp, (cc, kk) in zip(f.loops, ((c, k), (c + 1, k), (c + 1, k + 1), (c, k + 1))):
                    lp[uvl].uv = (uu[cc], vv[cc, kk])
                faces.append(f)
        new_verts = [v for row in G for v in row]
        for layer in bm.verts.layers.shape.values():
            for v in new_verts:
                v[layer] = v.co
        bm.verts.index_update()
        c0 = len(me.vertices)
        order = [v.index for v in new_verts]
        bm.to_mesh(me)
        bm.free()
        me.update()
        n = len(me.vertices)
        assert n == c0 + nn and order == list(range(c0, n))
        for blk in me.shape_keys.key_blocks:
            arr = np.empty(n * 3, np.float32)
            blk.data.foreach_get("co", arr)
            arr = arr.reshape(-1, 3)
            arr[c0:] = neutral + (deltas[blk.name] if blk.name in deltas else 0.0)
            blk.data.foreach_set("co", arr.ravel())
        only = np.zeros(n, bool)
        only[c0:] = True
        lap = np.zeros(n, bool)
        lap[c0:] = np.repeat(is_lapel, K)
        # _CCCOLLAR = 1 on the standing collar (identifies it for tests / other engines; the viewer ignores it)
        at = me.attributes.new("_CCCOLLAR", 'FLOAT', 'POINT')
        at.data.foreach_set("value", (only & ~lap).astype(np.float32))
        # a lower garment with its own collar (the shirt) is no collider for the BACK of the standing collar (within
        # ex['own_collar_deg'] of the back centre): pushing it out over the shirt collar there moved single vertices
        # of its top edge up to 19 mm, into short hair (tests/collar.test.mjs); hide_lower hides that part of the shirt
        # collar instead. Toward the front (seen through the open gorge) the coat collar is still fitted over it.
        cn = mesh_arrays(obj)[0]
        ang = np.degrees(np.arctan2(np.abs(cn[:, 0] - O[0]), cn[:, 1] - O[1]))     # 0 = back (+Y), 180 = front
        back = only & ~lap & (ang < ex["own_collar_deg"])
        self.collar_back = {g["id"]: back}
        own_collar = {r["spec"]["id"]: back for r in self.done.values()
                      if r["spec"].get("tex", {}).get("collar_islands")}
        self.clearance(obj, g, rec, only=only, eps_body=ex["body_gap"], label="collarClearance",
                       self_polys=jpolys, self_only=lap, self_eps=0.0025, skip_lower=own_collar)
        top = grid[~is_lapel, 3]
        print("BUILD coat collar: path %.3f m (gorge at %.3f m, %.0f deg), %d columns (%d lapel) x %d rows = %d verts, "
              "collar top z %.3f..%.3f, uv u %.3f..%.3f"
              % (S, s_g, ex["gorge_deg"], C, int(is_lapel.sum()), K, nn, top[:, 2].min(), top[:, 2].max(), uu[0], uu[-1]))
        return dict(range=(c0, n), verts=nn, cols=C, rows=K, lapel_cols=int(is_lapel.sum()),
                    top_z=float(top[:, 2].max()))

    # ---- shorts / shirt / hoodie: edits of a CC0 suit part -----------------------------------------------
    def cut_legs(self, obj, c):
        """Shorts from the jeans: the mesh is bisected at z = z_of(c['z']) and everything below is removed. bmesh
        interpolates the shape keys, weights and UVs of a cut edge into its new hem vertex, so the hem follows every
        morph exactly like the jeans leg did."""
        me = obj.data
        z = self.z_of(c["z"])
        n0 = len(me.vertices)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-4, plane_co=(0.0, 0.0, z),
                               plane_no=(0.0, 0.0, 1.0), clear_inner=True)
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.to_mesh(me)
        bm.free()
        me.update()
        co, _ = mesh_arrays(obj)
        S = get_shapes(obj)
        hem = np.abs(co[:, 2] - z) < 2e-4
        err = float(np.abs(S["Basis"] - co).max())
        # the morph deltas of a new hem vertex must match its nearest old neighbour's (interpolated, not zero)
        kd = kd_of(co[~hem])
        nb_ = np.where(~hem)[0][[kd.find(p)[1] for p in co[hem]]]
        spread = max(float(np.abs((S[k][hem] - co[hem]) - (S[k][nb_] - co[nb_])).max()) for k in S)
        print("BUILD cloth %s cut at z %.3f: verts %d -> %d, hem verts %d, basis err %.1e, max hem delta vs neighbour "
              "%.3f m" % (obj.name, z, n0, len(co), int(hem.sum()), err, spread))
        assert err < 1e-5 and spread < 0.05, "cut_legs: shape keys not interpolated"
        return {"z": round(z, 4), "verts": [n0, len(co)], "hemVerts": int(hem.sum())}

    def drop_inner_cuffs(self, obj, reach=0.02, tube=0.15):
        """male_casualsuit03's sleeves end in a cuff turned inside: a tube runs ~10 cm back up inside each sleeve (a
        thin double shell, guide c). A forearm vertex whose ray away from the forearm axis hits the sleeve within
        `reach`, within `tube` m of the sleeve end, and that is connected to the tube's open end through such
        vertices is removed; the sleeve then ends at the fold (the wrist edge)."""
        me = obj.data
        co, polys = mesh_arrays(obj)
        n = len(co)
        h = self.heads
        bvh = BVHTree.FromPolygons([Vector(p) for p in co], polys)
        _, wi = np.unique(np.round(co / 1e-5).astype(np.int64), axis=0, return_inverse=True)
        wi = wi.ravel()
        adj = {}
        for p in polys:
            for a, b in zip(p, p[1:] + p[:1]):
                adj.setdefault(int(wi[a]), set()).add(int(wi[b]))
                adj.setdefault(int(wi[b]), set()).add(int(wi[a]))
        loops = boundary_loops(co, polys)
        drop = np.zeros(n, bool)
        out = {}
        for side, sgn in (("l", 1.0), ("r", -1.0)):
            a0, a1 = h["lowerarm_" + side], h["hand_" + side]
            ax = (a1 - a0) / np.linalg.norm(a1 - a0)
            arm = np.where(sgn * co[:, 0] > 0.2)[0]
            t = (co[arm] - a0) @ ax
            cand = set()
            for i, ti in zip(arm, t):
                if ti < t.max() - tube:
                    continue
                v = co[i] - a0
                r = v - v.dot(ax) * ax
                rn = np.linalg.norm(r)
                if rn < 1e-6:
                    continue
                r = r / rn
                if bvh.ray_cast(Vector(co[i] + r * 5e-4), Vector(r), reach)[0] is not None:
                    cand.add(int(wi[i]))
            seeds = {int(wi[i]) for L in loops if (sgn * co[L, 0] > 0.2).all() for i in L}
            seen, stack = set(seeds), list(seeds)
            while stack:
                x = stack.pop()
                for y in adj.get(x, ()):
                    if y not in seen and y in cand:
                        seen.add(y)
                        stack.append(y)
            m = np.isin(wi, np.array(sorted(seen), np.int64))
            drop |= m
            out[side] = int(m.sum())
        if drop.any():
            bm = bmesh.new()
            bm.from_mesh(me)
            bm.verts.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.where(drop)[0]], context='VERTS')
            bm.to_mesh(me)
            bm.free()
            me.update()
        print("BUILD cloth %s inner cuff tubes removed: %s verts (of %d)" % (obj.name, out, n))
        return out

    def flare_legs(self, obj, f):
        """Shorts: each leg widens toward its hem, x / y about the leg's own hem centre (per shape key, like flare),
        by up to k at the hem from z_of(f['top']) down; the inner side (toward the other leg) only by k / 3, so the
        two hems do not meet between the thighs."""
        me = obj.data
        S = get_shapes(obj)
        base = S["Basis"]
        z0, z1 = self.z_of(f["top"]), float(base[:, 2].min())
        s = f["k"] * smoothstep(z0, z1, base[:, 2])

        def apply(X):
            Y = X.copy()
            for sgn in (1.0, -1.0):
                m = (base[:, 2] < z0) & (sgn * base[:, 0] > 0)
                hem = m & (base[:, 2] < z1 + 0.02)
                c = X[hem][:, :2].mean(0)
                d = X[m][:, :2] - c
                kx = np.where(sgn * d[:, 0] < 0, s[m] / 3, s[m])
                Y[m, 0] = c[0] + d[:, 0] * (1 + kx)
                Y[m, 1] = c[1] + d[:, 1] * (1 + s[m])
            return Y
        for blk in me.shape_keys.key_blocks:
            blk.data.foreach_set("co", apply(S[blk.name]).astype(np.float32).ravel())
        me.vertices.foreach_set("co", apply(base).astype(np.float32).ravel())
        me.update()
        print("BUILD cloth %s leg flare: x%.2f (inner x%.2f) at the hem z %.3f, from z %.3f"
              % (obj.name, 1 + f["k"], 1 + f["k"] / 3, z1, z0))
        return {"k": f["k"], "top": round(z0, 4), "hem": round(z1, 4)}

    def belt_clamp(self, obj, ext, margin=0.004, pad=0.006):
        """Closed coat_skirt (the dress): the belt is placed by rays at its 36 columns only, so bodice / skirt-top
        faces between the columns and the parts the clearance pass pushed out came through the belt as red shards
        at the hip (screenshots, every body, cloth on and off). Every bodice / skirt vertex from 2 mm under the
        belt's top edge down to `pad` m under its lower edge is pulled radially to `margin` m inside the belt, per
        shape key (the belt radius interpolated by angle around each belt row's centre, then by z between the rows).
        Vertices above the top edge stay: clamping them too (pad above) pulled the bodice under the skin there."""
        me = obj.data
        S = get_shapes(obj)
        b0, b1 = ext["belt"]
        nb = b1 - b0
        rows = 3
        cols = nb // rows
        base = S["Basis"]
        zb = base[b0:b1, 2]
        sel = np.where((np.arange(len(base)) < b0) & (base[:, 2] <= zb.max() - 0.002) & (base[:, 2] >= zb.min() - pad))[0]
        moved = 0

        def apply(X):
            nonlocal moved
            Bt = X[b0:b0 + rows * cols].reshape(rows, cols, 3)
            c = Bt[:, :, :2].mean(1)                          # row centres
            P = X[sel]
            zr = Bt[:, :, 2].mean(1)                          # row heights (top -> bottom)
            rad = np.zeros((rows, len(sel)))
            for i in range(rows):
                d = Bt[i, :, :2] - c[i]
                a = np.arctan2(d[:, 0], -d[:, 1])
                o = np.argsort(a)
                dp = P[:, :2] - c[i]
                ap = np.arctan2(dp[:, 0], -dp[:, 1])
                rad[i] = np.interp(ap, a[o], np.linalg.norm(d, axis=1)[o], period=2 * np.pi)
            # z interpolation between rows (np.interp wants increasing x: bottom -> top)
            rb = np.array([np.interp(P[k, 2], zr[::-1], rad[::-1, k]) for k in range(len(sel))])
            cz = np.array([np.interp(P[k, 2], zr[::-1], c[::-1, 0]) for k in range(len(sel))])
            cyz = np.array([np.interp(P[k, 2], zr[::-1], c[::-1, 1]) for k in range(len(sel))])
            d = P[:, :2] - np.c_[cz, cyz]
            r = np.linalg.norm(d, axis=1)
            lim = rb - margin
            m = r > lim
            moved = max(moved, int(m.sum()))
            Y = X.copy()
            Y[sel[m], :2] = np.c_[cz, cyz][m] + d[m] * (lim[m] / np.maximum(r[m], 1e-9))[:, None]
            return Y
        for blk in me.shape_keys.key_blocks:
            blk.data.foreach_set("co", apply(S[blk.name]).astype(np.float32).ravel())
        me.vertices.foreach_set("co", apply(base).astype(np.float32).ravel())
        me.update()
        print("BUILD cloth %s belt clamp: %d of %d bodice / skirt-top verts pulled under the belt (max over keys)"
              % (obj.name, moved, len(sel)))
        return moved

    def sole_squash(self, obj, s):
        """Thick CC0 soles (shoes03, the boots) reach ~2 cm below the floor the feet stand on (z 0): every vertex below
        s['top'] moves up so the lowest one lands on s['floor'] (z' = top - (top - z) * k, by the Basis z; the same
        offset in every shape key, so the morph deltas are unchanged)."""
        me = obj.data
        S = get_shapes(obj)
        z = S["Basis"][:, 2]
        top, floor, zmin = s["top"], s["floor"], float(z.min())
        if zmin >= floor:
            return {"moved": 0}
        k = (top - floor) / (top - zmin)
        dz = np.where(z < top, (top - (top - z) * k) - z, 0.0)
        for blk in me.shape_keys.key_blocks:
            X = S[blk.name].copy()
            X[:, 2] += dz
            blk.data.foreach_set("co", X.astype(np.float32).ravel())
        X = S["Basis"].copy()
        X[:, 2] += dz
        me.vertices.foreach_set("co", X.astype(np.float32).ravel())
        me.update()
        print("BUILD cloth %s sole: z %.4f..%.3f squashed to %.4f..%.3f (x%.2f), %d verts"
              % (obj.name, zmin, top, floor, top, k, int((dz > 0).sum())))
        return {"zMin": round(zmin, 4), "top": top, "floor": floor, "moved": int((dz > 0).sum())}

    def dissolve_flat(self, obj, deg):
        """Fewer vertices on flat regions (the boot soles: 2094 GLB vertices against the 2000 budget): bmesh
        dissolve_limit at `deg` degrees, delimited by UV seams and materials, so only interior vertices of flat,
        same-island patches go (their neighbours keep their positions in every shape key)."""
        me = obj.data
        n0 = len(me.vertices)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(deg), use_dissolve_boundaries=False,
                                 verts=bm.verts[:], edges=bm.edges[:], delimit={'UV', 'MATERIAL', 'SEAM', 'SHARP'})
        # the dissolved n-gons are triangulated here, so the fit passes (which fan-triangulate) see the triangles
        # the GLB gets: the exporter's own split of a 6-gon on the boot shaft held a sliver that folded over at
        # male + muscle_max, 10 mm outside the boot (tests/integrity.test.mjs 'sock triangles stay inside')
        # Only the inner part's (cc_sec, the shaft) n-gons: triangulating the outer boot too changed the jeans'
        # fit over it and on to the shoes (m-child walk jeans:shoes 0 -> 7 verts / 5.1 mm).
        sl = bm.verts.layers.int.get("cc_sec")
        if sl is not None:
            bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4 and all(v[sl] for v in f.verts)],
                                  quad_method='BEAUTY', ngon_method='BEAUTY')
        bm.to_mesh(me)
        bm.free()
        me.update()
        print("BUILD cloth %s dissolve flat (%.1f deg): verts %d -> %d" % (obj.name, deg, n0, len(me.vertices)))
        return {"deg": deg, "before": n0, "after": len(me.vertices)}

    def inflate(self, obj, d):
        """Loosen a tight CC0 top (hoodie): every vertex moves d m out along the nearest body normal (smoothed over the
        mesh, per welded position so seams stay closed), by the same offset in the Basis and every shape key (the
        morph deltas are unchanged; the clearance pass runs afterwards)."""
        me = obj.data
        co, polys = mesh_arrays(obj)
        _, wi = np.unique(np.round(co / 1e-5).astype(np.int64), axis=0, return_inverse=True)
        wi = wi.ravel()
        nw = int(wi.max()) + 1
        rep = np.zeros(nw, np.int64)
        rep[wi] = np.arange(len(co))
        D = np.array([np.array(self.bvh0.find_nearest(Vector(co[i]))[1]) for i in rep])
        nb = neighbours(nw, [tuple(int(wi[v]) for v in p) for p in polys])
        for _ in range(3):
            D = 0.5 * D + 0.5 * np.array([D[x].mean(0) if len(x) else D[i] for i, x in enumerate(nb)])
        D = D / np.maximum(np.linalg.norm(D, axis=1), 1e-9)[:, None] * d
        Dv = D[wi]
        S = get_shapes(obj)
        for blk in me.shape_keys.key_blocks:
            blk.data.foreach_set("co", (S[blk.name] + Dv).astype(np.float32).ravel())
        me.vertices.foreach_set("co", (S["Basis"] + Dv).astype(np.float32).ravel())
        me.update()
        print("BUILD cloth %s inflated by %.1f mm" % (obj.name, 1000 * d))
        return {"m": d}

    def hood_down(self, obj, g, fit, rec):
        """Hood lying down (project code, hoodie): one strip of quads around the neckline of the top, from the back
        centre to ex['phi_max'] degrees on each side (the two ends stop short of the front centre, where the rib
        neckline shows). Per column (left half built, mirrored):
          rows 0-4  a stand: tucked 1 cm under the neckline, up ex['stand'] along the neck axis, then a roll ex['roll']
                    outward (the thick hood rim lying around the neck);
          rows 5..  the hood itself: marched over the top's own surface from the roll, ex['length'] m (table over the
                    angle from the back: a long rounded flap down the back, short over the shoulders), lifted
                    ex['puff_top'] -> ex['puff_edge'] off the top (+ ex['bag'] in the middle of the back flap);
          last row  the edge turned under (a crisp, thick-looking rim; the inside shows the lining colour).
        Toward the ends the stand, roll, puff and length taper, so the hood runs out into the neckline.
        Binding / weights / pin: like coat_collar (SynthFit on body polygons below the head, mirror-symmetrised
        deltas, nearest-vertex weights without 'head', never simulated, _CCCOLLAR = 1). Clearance: >= ex['body_gap']
        over the skin, the lying part >= 4 mm over the top itself, at every sampled shape."""
        B = self.B
        ex = g["hood"]
        me = obj.data
        co, polys = mesh_arrays(obj)
        n0 = len(co)
        bvhG = BVHTree.FromPolygons([Vector(p) for p in co], polys)
        loops = boundary_loops(co, polys)
        NL = co[max(loops, key=lambda l: co[l, 2].mean())]
        O = self.heads["neck_01"]
        A = self.heads["head"] - O
        A = A / np.linalg.norm(A)

        def radial(P):
            v = P - O
            rho = v - v.dot(A) * A
            return rho / max(float(np.linalg.norm(rho)), 1e-6)
        E = np.array([radial(p) for p in NL])
        phi = np.degrees(np.arctan2(E[:, 0], E[:, 1]))     # 0 = back centre (+y), + = character's left (+x)
        o = np.argsort(phi)
        ph = np.r_[phi[o][-1] - 360.0, phi[o], phi[o][0] + 360.0]
        pts = np.r_[NL[o][-1:], NL[o], NL[o][:1]]

        def neck_at(a):
            return np.array([np.interp(a, ph, pts[:, c]) for c in range(3)])

        def surf(Q):
            loc, nrm, _, _ = bvhG.find_nearest(Vector(Q))
            loc, nv = np.array(loc), np.array(nrm)
            bl = self.bvh0.find_nearest(Vector(loc))[0]
            if bl is not None and np.dot(loc - np.array(bl), nv) < 0:
                nv = -nv
            return loc, nv
        TH = np.array([0.0, 30.0, 60.0, 90.0, 120.0, 150.0])
        dirs = np.array(ex["dirs"])                         # per TH: (down, lateral, out)
        M = ex["rows"]
        pmax = ex["phi_max"]

        def column(a):
            th = abs(a)
            P = neck_at(a)
            if a == 0.0:
                P[0] = 0.0
            e = radial(P)
            xs = np.array([np.sign(a) if a else 0.0, 0.0, 0.0])
            tp = 1.0 - float(smoothstep(pmax - 35.0, pmax, th))
            sc = 0.3 + 0.7 * tp
            H, R = ex["stand"] * sc, ex["roll"] * sc
            rows = [P - A * 0.010 - e * 0.002,
                    P + A * 0.35 * H + e * 0.004,
                    P + A * H + e * 0.009,
                    P + A * (H + 0.004) + e * (0.010 + 0.45 * R),
                    P + A * (H - 0.004) + e * (0.010 + 0.9 * R)]
            a_, b_, c_ = [np.interp(th, TH, dirs[:, k]) for k in range(3)]
            d0 = -A * a_ + xs * b_ + e * c_
            loc, nv = surf(P + e * (0.012 + R) - A * 0.012)
            d = d0 - d0.dot(nv) * nv
            d = d / np.linalg.norm(d)
            Lt = float(np.interp(th, TH, ex["length"]))
            targets = np.linspace(0.0, Lt, M)
            lying = [(loc, nv, d)]
            p, s = loc, 0.0
            for _ in range(2000):
                if len(lying) >= M:
                    break
                l2, n2 = surf(p + d * 0.004)
                stp = float(np.linalg.norm(l2 - p))
                if stp < 1e-6:
                    break
                dn = (l2 - p) / stp
                while len(lying) < M and targets[len(lying)] <= s + stp:
                    t = (targets[len(lying)] - s) / stp
                    nn_ = nv + (n2 - nv) * t
                    lying.append((p + (l2 - p) * t, nn_ / np.linalg.norm(nn_), dn))
                p, nv, s, d = l2, n2, s + stp, dn
            assert len(lying) == M, "hood: march ended early at %.0f deg" % th
            back = 1.0 - float(smoothstep(60.0, 140.0, th))
            for k, (q, nq, dq) in enumerate(lying):
                u = k / (M - 1)
                off = (ex["puff_edge"] + (ex["puff_top"] - ex["puff_edge"]) * (1 - u) ** 1.5
                       + ex["bag"] * np.sin(np.pi * u) * back) * (0.35 + 0.65 * tp)
                rows.append(q + nq * off)
            q, nq, dq = lying[-1]
            off_end = ex["puff_edge"] * (0.35 + 0.65 * tp)
            rows.append(q + nq * (off_end - 0.6 * off_end) - dq * 0.006)
            return np.array(rows)
        half = [column(a) for a in np.linspace(0.0, pmax, ex["half_cols"] + 1)]
        grid = np.array([c * (-1, 1, 1) for c in half[:0:-1]] + half)          # (C, K, 3), right -> left
        C, K = grid.shape[:2]
        new_pos = grid.reshape(-1, 3)
        nn = len(new_pos)
        # binding to the body below the head (neck / chest / back polygons only)
        zlim = float(self.heads["head"][2]) - 0.04
        sub = [p for p in self.body_polys if B.BASE_ARR[list(p), 2].max() < zlim]
        bvhS = BVHTree.FromPolygons([Vector(p) for p in B.BASE_ARR[:B.N_BODY]], sub)
        idx = np.zeros((nn, 4), np.int64)
        w = np.zeros((nn, 4))
        for i, p in enumerate(new_pos):
            loc, _, pi, _ = bvhS.find_nearest(Vector(p))
            vids = sub[pi]
            ws = poly_3d_calc([Vector(B.BASE_ARR[k]) for k in vids], loc)
            idx[i, :len(vids)] = vids
            w[i, :len(vids)] = ws
        off = new_pos - (w[:, :, None] * B.BASE_ARR[idx]).sum(1)
        sf = SynthFit(idx, w, off, fit, B.BASE_ARR)
        neutral = sf(B.BASE_ARR)
        assert np.abs(neutral - new_pos).max() < 1e-6
        deltas = B.fit_keys(sf, neutral)
        mi = [int(np.argmin(np.linalg.norm(new_pos - p * (-1, 1, 1), axis=1))) for p in new_pos]
        ok = np.array([np.linalg.norm(new_pos[m] - new_pos[i] * (-1, 1, 1)) < 0.002 for i, m in enumerate(mi)])
        fade = np.minimum(1.0, np.abs(new_pos[:, 0]) / 0.03)
        for dd in deltas.values():
            sym = (dd + dd[mi] * (-1.0, 1.0, 1.0)) / 2
            dd[ok] = sym[ok]
            dd[:, 0] *= fade
        # UVs: the free rectangle ex['uv'] of the source atlas, flattened (u along the rows, v down the columns)
        u0, u1, v0, v1 = ex["uv"]
        rowarc = np.concatenate([np.zeros((1, K)), np.cumsum(np.linalg.norm(np.diff(grid, axis=0), axis=2), 0)], 0)
        rowarc -= rowarc[C // 2]
        across = np.concatenate([np.zeros((C, 1)), np.cumsum(np.linalg.norm(np.diff(grid, axis=1), axis=2), 1)], 1)
        dens = min((u1 - u0 - 0.01) / float(np.ptp(rowarc, axis=0).max()), (v1 - v0 - 0.01) / float(across.max()))
        uu = (u0 + u1) / 2 + rowarc * dens
        vv = v1 - 0.005 - across * dens
        # mesh
        kd = KDTree(n0)
        for i in range(n0):
            kd.insert(co[i], i)
        kd.balance()
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        uvl = bm.loops.layers.uv.active
        sec = bm.verts.layers.int.get("cc_sec")
        dl = bm.verts.layers.deform.verify()
        head_gi = obj.vertex_groups["head"].index if obj.vertex_groups.get("head") else -1
        src_w = {}
        for c in range(C):
            for k in range(K):
                src = kd.find(grid[c, k] if k >= 5 else grid[c, 0])[1]
                src_w[c, k] = {gi: x for gi, x in bm.verts[src][dl].items() if gi != head_gi}
        G = []
        for c in range(C):
            row = []
            for k in range(K):
                wt = src_w[c, k]
                tot = sum(wt.values()) or 1.0
                v = bm.verts.new(Vector(grid[c, k]))
                for gi, x in wt.items():
                    v[dl][gi] = x / tot
                if sec:
                    v[sec] = 0
                row.append(v)
            G.append(row)
        for c in range(C - 1):
            for k in range(K - 1):
                f = bm.faces.new((G[c][k], G[c + 1][k], G[c + 1][k + 1], G[c][k + 1]))
                f.smooth = True
                for lp, (cc, kk) in zip(f.loops, ((c, k), (c + 1, k), (c + 1, k + 1), (c, k + 1))):
                    lp[uvl].uv = (uu[cc, kk], vv[cc, kk])
        new_verts = [v for row in G for v in row]
        for layer in bm.verts.layers.shape.values():
            for v in new_verts:
                v[layer] = v.co
        bm.verts.index_update()
        order = [v.index for v in new_verts]
        bm.to_mesh(me)
        bm.free()
        me.update()
        n = len(me.vertices)
        assert n == n0 + nn and order == list(range(n0, n))
        for blk in me.shape_keys.key_blocks:
            arr = np.empty(n * 3, np.float32)
            blk.data.foreach_get("co", arr)
            arr = arr.reshape(-1, 3)
            arr[n0:] = neutral + (deltas[blk.name] if blk.name in deltas else 0.0)
            blk.data.foreach_set("co", arr.ravel())
        only = np.zeros(n, bool)
        only[n0:] = True
        lying = np.zeros(n, bool)
        lying[n0:] = np.tile(np.arange(K) >= 5, C)
        at = me.attributes.new("_CCCOLLAR", 'FLOAT', 'POINT')
        at.data.foreach_set("value", only.astype(np.float32))
        self.clearance(obj, g, rec, only=only, eps_body=ex["body_gap"], label="hoodClearance",
                       self_polys=polys, self_only=lying, self_eps=0.004)
        print("BUILD hood: %d columns x %d rows = %d verts, neckline %d pts, length back %.2f m, bottom z %.3f, "
              "uv u %.3f..%.3f v %.3f..%.3f (%.2f uv/m)"
              % (C, K, nn, len(NL), ex["length"][0], grid[C // 2, -2, 2], uu.min(), uu.max(), vv.min(), vv.max(), dens))
        return dict(range=(n0, n), verts=nn, cols=C, rows=K)

    # ---- procedural, normal-less textures (shorts, shirt, hoodie) -----------------------------------------
    def tex_procedural(self, obj, g, rec, k=0.5, max_size=1024, min_mpt=0.0008, step=0.0015):
        """Grey albedo (+ grey PNG mask for the secondary colour) painted per texel from the neutral 3D position of
        the texel (rasterised over the garment's own UVs, cropped like tex_cloth) and its metric distance to the
        garment's open edges (classified per style: hem, cuff, neck, collar, front, waist). No normal map. Tint
        contract of tex_cloth: each region (primary / secondary) normalised to the linear mean k, gain 1 / k.
        Styles (g['tex']['style']):
          denim  - the source atlas' luminance (weave, belt loops, pockets, fly) + a double-stitched hem at the cut;
          shirt  - fine woven grain; secondary = collar (its UV islands), cuffs (g['tex']['cuff'] m from the sleeve
                   end) and the buttons down the front edge; stitch lines along hem, placket, collar and cuffs;
          hoodie - fine knit; secondary = rib bands (cuffs, hem, the open front of the neckline) with ribs across the
                   edge; kangaroo pocket drawn on the front (outline stitching, shaded hand openings); hood centre
                   seam."""
        B = self.B
        tex = B.tex
        st = g["tex"]
        style = st["style"]
        me = obj.data
        me.update()
        co, polys = mesh_arrays(obj)
        n = len(co)
        nl = len(me.loops)
        uv = np.empty(nl * 2)
        me.uv_layers.active.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        lv = np.empty(nl, np.int64)
        me.loops.foreach_get("vertex_index", lv)
        if "cc_sec" in me.attributes:
            me.attributes.remove(me.attributes["cc_sec"])
        me.calc_loop_triangles()
        T = len(me.loop_triangles)
        tl = np.empty(T * 3, np.int64)
        me.loop_triangles.foreach_get("loops", tl)
        tl = tl.reshape(-1, 3)
        tpi = np.empty(T, np.int64)
        me.loop_triangles.foreach_get("polygon_index", tpi)
        hood_v = np.zeros(n)
        if rec.get("hood"):
            a_, b_ = rec["hood"]["range"]
            hood_v[a_:b_] = 1.0
        belt_v = np.zeros(n)                                # generated belt band (coat_skirt, the dress)
        if rec.get("ext", {}).get("belt"):
            a_, b_ = rec["ext"]["belt"]
            belt_v[a_:b_] = 1.0
        collar_p = np.zeros(len(polys))
        if st.get("collar_islands"):
            isl = uv_islands(me, uv)
            zc = np.array([co[list(p), 2].mean() for p in polys])
            zlim = self.z_of(st["collar_islands"])
            for r in np.unique(isl):
                m_ = isl == r
                if zc[m_].mean() > zlim:
                    collar_p[m_] = 1.0
        collar_v = np.zeros(n)
        for p, f in zip(polys, collar_p):
            if f:
                collar_v[list(p)] = 1.0
        lo = np.floor(np.clip(uv.min(0) - 0.01, 0, 1) * 32) / 32
        hi = np.ceil(np.clip(uv.max(0) + 0.01, 0, 1) * 32) / 32
        ext = hi - lo
        tri_uv = (uv[tl] - lo) / ext
        P3 = co[lv[tl]]
        e3 = np.linalg.norm(P3[:, [1, 2, 0]] - P3, axis=2)

        def texel(s_):                                      # metres per texel (median over the triangles' edges)
            tp_ = tri_uv * ext * s_
            e2 = np.linalg.norm(tp_[:, [1, 2, 0]] - tp_, axis=2)
            ok = e2 > 0.5
            return float(np.median(e3[ok] / e2[ok]))
        s = max_size / ext.max()
        if texel(s) < min_mpt:
            s *= texel(s) / min_mpt
        w, h = max(16, int(ext[0] * s)), max(16, int(ext[1] * s))
        size = max(w, h)
        vals = np.concatenate([np.ones((T, 3, 1)), P3, hood_v[lv[tl]][..., None],
                               np.repeat(collar_p[tpi][:, None, None], 3, 1), belt_v[lv[tl]][..., None]], -1)
        m = tex.raster(tri_uv * np.array([w / size, h / size]), vals, size=size, radius=1)[:h, :w]
        cov = m[..., 0]
        cover = cov > 0.5
        q = np.maximum(cov, 1e-6)
        P = m[..., 1:4] / q[..., None]
        hoodT = (m[..., 4] / q) > 0.5
        collarT = (m[..., 5] / q) > 0.5
        beltT = (m[..., 6] / q) > 0.5
        mpt = texel(s)
        ys, xs = np.where(cov > 1e-3)
        # open edges, sampled every `step` m, one class per point
        zmin = float(co[:n - int(hood_v.sum()), 2].min())
        loops = boundary_loops(co, polys)
        body_loops = [L for L in loops if hood_v[L].mean() < 0.5]
        top_loop = max(body_loops, key=lambda L: co[L, 2].mean())
        low_loop = min(body_loops, key=lambda L: co[L, 2].mean())
        groups = {}
        for L in loops:
            pts, arc, seg = [], [], []
            Lc = list(L) + [L[0]]
            acc = 0.0
            for j in range(len(L)):
                pa, pb = co[Lc[j]], co[Lc[j + 1]]
                ln = float(np.linalg.norm(pb - pa))
                ns = max(1, int(np.ceil(ln / step)))
                for t in range(ns):
                    pts.append(pa + (pb - pa) * (t / ns))
                    arc.append(acc + ln * t / ns)
                    seg.append(Lc[j] if t < ns / 2 else Lc[j + 1])
                acc += ln
            absx = float(np.abs(co[L, 0]).mean())
            for p_, a_, v_ in zip(pts, arc, seg):
                if hood_v[L].mean() >= 0.5:
                    c = "hood"
                elif style == "denim":
                    c = "hem" if co[L, 2].mean() < self.z_of("hip") - 0.05 else "waist"
                elif style == "dress":                      # neckline, sleeve ends, hem; the waist seam under the belt
                    c = ("neck" if L is top_loop else "hem" if L is low_loop
                         else "seam" if abs(co[L, 2].mean() - rec["ext"]["z_cut"]) < 0.06 else "cuff")
                elif absx > 0.3:
                    c = "cuff"
                elif style == "hoodie":
                    c = "neck" if L is top_loop else "hem" if L is low_loop else "other"
                elif collar_v[v_]:
                    c = "collar"
                elif p_[2] < zmin + 0.03:
                    c = "hem"
                else:
                    c = "front"
                groups.setdefault(c, ([], []))
                groups[c][0].append(p_)
                groups[c][1].append(a_)
        D, ARC = {}, {}
        Pq = P[ys, xs]
        for c, (pl, al) in groups.items():
            kd = kd_of(pl)
            d_ = np.ones((h, w))
            a2 = np.zeros((h, w))
            res = [kd.find(p_) for p_ in Pq]
            d_[ys, xs] = [r_[2] for r_ in res]
            a2[ys, xs] = [al[r_[1]] for r_ in res]
            D[c], ARC[c] = d_, a2
        one = np.ones((h, w))
        Dg = lambda c: D.get(c, one)
        aa = lambda d_: np.clip(0.5 - d_ / (1.5 * mpt), 0.0, 1.0)      # 1 inside (d < 0), ramp of 1.5 texels
        line = lambda d_, c_, wd: aa(np.abs(d_ - c_) - wd / 2)
        rng = np.random.default_rng(st.get("seed", 17))
        nz = tex.blur(rng.standard_normal((h, w)), 1)
        nz = nz - tex.blur(nz, 4)
        nz = nz / (np.std(nz) + 1e-6)
        sec = np.zeros((h, w))
        info = {}
        if style == "denim":
            pdir = os.path.join(B.args.assets, "clothes", g["pack"])
            src = os.path.join(pdir, sorted(f for f in os.listdir(pdir) if f.endswith("_diffuse.png"))[0])
            at_ = tex.load(src)
            HA, WA = at_.shape[:2]
            La = tex.lum(tex.s2l(at_[..., :3].astype(np.float64)))
            fA = max(1, int(round(ext[0] * WA / w)))
            if fA >= 2:
                La = tex.blur(La, fA // 2)
            yy, xx = np.mgrid[0:h, 0:w]
            ax_ = np.clip(((lo[0] + (xx + 0.5) / w * ext[0]) * WA).astype(np.int64), 0, WA - 1)
            ay_ = np.clip(((lo[1] + (yy + 0.5) / h * ext[1]) * HA).astype(np.int64), 0, HA - 1)
            L = La[ay_, ax_]
            L = L / max(float(L[cover].mean()), 1e-4)
            dh = Dg("hem")
            L = L * (1 - 0.32 * np.maximum(line(dh, st["stitch"][0], 0.0012), line(dh, st["stitch"][1], 0.0012)))
            L = L * (1 - 0.15 * aa(dh - 0.0015))
            info["atlas"] = os.path.basename(src)
        elif style == "shirt":
            yy, xx = np.mgrid[0:h, 0:w]
            L = 1 + 0.025 * nz + 0.012 * np.sin((xx - yy) * 2 * np.pi / 2.5)
            dc = Dg("cuff")
            cuff = aa(dc - st["cuff"])
            sec = np.maximum(collarT.astype(float), cuff)
            # buttons: on the front centre line, every st['button_step'] m from the hem to the collar
            bvhG = BVHTree.FromPolygons([Vector(p_) for p_ in co], polys)
            zc0 = zmin + st["button_first"]
            zc1 = float(co[collar_v > 0, 2].min()) - 0.02 if collar_v.any() else float(co[:, 2].max()) - 0.1
            centres = []
            for zb in np.arange(zc0, zc1, st["button_step"]):
                loc = bvhG.ray_cast(Vector((0.0, -1.0, float(zb))), Vector((0.0, 1.0, 0.0)), 2.0)[0]
                if loc is not None:
                    centres.append(np.array(loc))
            br = st["button_r"]
            for cb in centres:
                r_ = np.linalg.norm(P - cb, axis=-1)
                front = P[..., 1] <= cb[1] + 0.005
                disc = aa(r_ - br) * front
                ring = line(r_, br - 0.0009, 0.0008) * front
                holes = np.maximum(aa(np.linalg.norm(P - cb - (0.0015, 0, 0), axis=-1) - 0.0006),
                                   aa(np.linalg.norm(P - cb + (0.0015, 0, 0), axis=-1) - 0.0006)) * front
                sec = np.maximum(sec, disc)
                L = L * (1 + 0.1 * disc) * (1 - 0.3 * ring) * (1 - 0.45 * holes)
            st_ = 0.22
            L = L * (1 - st_ * line(Dg("hem"), 0.006, 0.0008))
            L = L * (1 - st_ * np.maximum(line(Dg("front"), 0.003, 0.0008), line(Dg("front"), 0.028, 0.0008)))
            L = L * (1 - st_ * line(Dg("collar"), 0.004, 0.0008))
            L = L * (1 - st_ * np.maximum(line(dc, 0.004, 0.0008), line(dc, st["cuff"] - 0.004, 0.0008)))
            L = L * (1 - 0.3 * line(dc, st["cuff"], 0.0012))
            info["buttons"] = len(centres)
        elif style == "dress":
            # fine twill; secondary = the belt band + a piping along the neckline and the sleeve ends; stitched hem;
            # a buckle (brighter ring) on the belt at the front centre
            yy, xx = np.mgrid[0:h, 0:w]
            L = 1 + 0.022 * nz + 0.012 * np.sin((xx + yy) * 2 * np.pi / 3.0)
            pip = np.maximum(aa(Dg("neck") - st["piping"]), aa(Dg("cuff") - st["piping"]))
            sec = np.maximum(beltT.astype(float), pip)
            st_ = 0.22
            dh = Dg("hem")
            L = L * (1 - st_ * line(dh, st["hem_stitch"], 0.0008)) * (1 - 0.12 * aa(dh - 0.0015))
            L = L * (1 - st_ * line(Dg("neck"), st["piping"] + 0.003, 0.0008))
            L = L * (1 - st_ * line(Dg("cuff"), st["piping"] + 0.003, 0.0008))
            L = L * (1 - 0.25 * line(Dg("seam"), 0.003, 0.0008) * beltT)
            cy = float(self.heads["pelvis"][1])
            zc_ = rec["ext"]["z_cut"]
            bx, bz = np.abs(P[..., 0]), np.abs(P[..., 2] - zc_)
            hw, hh = st["buckle"]
            fr = (P[..., 1] < cy - 0.04) & beltT
            box = np.maximum(bx - hw, bz - hh)                # < 0 inside the buckle rectangle
            ring = line(box, -0.002, 0.003) * fr
            L = L * (1 + 0.45 * ring) * (1 - 0.3 * line(box, 0.0, 0.0008) * fr)
            info["piping"] = st["piping"]
        else:                                               # hoodie
            L = 1 + 0.03 * nz
            bands = []
            for c, wd in (("cuff", st["cuff"]), ("hem", st["hem"]), ("neck", st["neck"])):
                if c not in D:
                    continue
                b = aa(D[c] - wd) * ~hoodT
                rib = np.sin(ARC[c] * 2 * np.pi / st["rib"])
                L = L * (1 + 0.12 * rib * b) * (1 - 0.25 * line(D[c], wd, 0.0012) * ~hoodT)
                bands.append(b)
            sec = np.max(bands, axis=0) if bands else sec
            # kangaroo pocket (front, over the hem band)
            cy = float(self.heads["pelvis"][1])
            zh = float(np.mean([co[i, 2] for i in low_loop]))
            zb = zh + st["hem"] + 0.003
            zt = zb + st["pocket_h"]
            zo = zb + st["pocket_open_low"]
            wt_, wb_ = st["pocket_top"], st["pocket_bottom"]
            X, Z = np.abs(P[..., 0]), P[..., 2]
            fr = (P[..., 1] < cy - 0.04) & ~hoodT
            wz = np.where(Z < zo, wb_, wt_ + (wb_ - wt_) * np.clip((zt - Z) / (zt - zo), 0, 1) ** 0.8)
            d_in = np.minimum(np.minimum(zt - Z, Z - zb), wz - X)
            inside = (d_in > 0) & fr
            opening = (Z > zo) & (Z < zt) & fr
            L = L * (1 + 0.04 * inside)
            L = L * (1 - 0.25 * line(np.minimum(zt - Z, Z - zb) * ((X < wz) & fr), 0.004, 0.0009) * inside)
            L = L * (1 - 0.25 * line(wz - X, 0.006, 0.0009) * opening * inside)
            L = L * (1 + 0.10 * aa(np.abs(wz - X) - 0.0012) * opening)
            shadow = np.clip(1 - (X - wz) / 0.004, 0, 1) * (X > wz) * opening
            L = L * (1 - 0.3 * shadow)
            # hood: centre seam down the middle, stitched
            L = L * (1 - 0.3 * line(np.abs(P[..., 0]), 0.0, 0.0012) * hoodT)
            info["pocket"] = [round(zb, 3), round(zt, 3)]
        # per region to the mean k (tint contract), then edge padding
        secb = (sec >= 0.5) & cover
        out = np.full((h, w), k)
        for region in (cover & ~secb, secb):
            if region.sum() >= 16:
                out = np.where(region, L * (k / max(float(L[region].mean()), 1e-4)), out)
        out, sec, known = pad_islands(out, np.where(cover, sec, 0.0), cover)
        out = np.where(known, out, k)
        base = os.path.join(B.args.textures, "cloth_%s" % g["id"])
        sv = tex.l2s(np.clip(out, 0, 1))
        albedo = tex.save(np.stack([sv, sv, sv], -1), base + "_albedo.jpg", quality=st.get("quality", 86))
        has_sec = bool(secb.sum() >= 16 and g.get("secondary"))
        me.uv_layers.active.data.foreach_set("uv", ((uv - lo) / ext).ravel())
        name = "Cloth_" + g["id"]
        me.materials.clear()
        me.materials.append(B.make_material(name, albedo))
        gain = 1.0 / k
        lin = tex.hex_to_lin(g["primary"]) * gain
        tint = {"gain": round(float(gain), 4), "default": g["primary"]}
        spec = {"baseColorFactor": [float(min(1.0, v)) for v in lin] + [1.0], "roughness": g["roughness"],
                "metallic": 0.0, "doubleSided": True, "extras": {"tint": tint}}
        if has_sec:
            tint["secondaryDefault"] = g["secondary"]
            if g.get("lining"):
                tint["lining"] = g["lining"]
            spec["extraTextures"] = {"ccMask": tex.save(np.clip(sec, 0, 1), base + "_mask.png")}
        B.MATERIALS[name] = spec
        rec["secondary"] = has_sec
        print("BUILD cloth %s procedural texture (%s) %dx%d px (uv %.3f..%.3f / %.3f..%.3f), %.2f mm/texel, edges %s, "
              "secondary %.1f%% of texels, %s" % (g["id"], style, w, h, lo[0], hi[0], lo[1], hi[1], 1000 * mpt,
                                                 {c: len(v[0]) for c, v in groups.items()},
                                                 100 * float(secb.sum()) / max(1, int(cover.sum())), info))

    # ---- clearance -----------------------------------------------------------------------------------
    def key_contexts(self, d):
        """(order, context) for fixing the shape keys d one at a time: context(k) = the keys k is fixed on top of (see
        clearance), order = contexts before the keys that use them."""
        B = self.B
        F, CUP = "gender_female", "breast_cup_max"
        corr_keys = [c for c in d if B.MORPH_KIND[c] == "corr"]

        def is_breast(k):
            parts = B.CORR_PARTS[k] if B.MORPH_KIND[k] == "corr" else (k,)
            return F in d and any(p.startswith(("breast_", "bdet_", "dyn_")) for p in parts), parts

        def context(k):
            br, parts = is_breast(k)
            lst = list(parts) if B.MORPH_KIND[k] == "corr" else []
            if br:
                lst = [F] + ([] if CUP not in d or any(p.startswith("breast_cup") for p in parts) else [CUP]) + lst
            lst += [c for c in corr_keys if c != k and B.CORR_PARTS[c][0] in lst and B.CORR_PARTS[c][1] in lst]
            return lst

        order = ([k for k in d if B.MORPH_KIND[k] == "macro" and not is_breast(k)[0]]
                 + [k for k in d if B.MORPH_KIND[k] == "macro" and is_breast(k)[0]]      # cup keys before firmness
                 + [k for k in corr_keys if not is_breast(k)[0]]
                 + [k for k in corr_keys if is_breast(k)[0]]      # cup x firm, cup x age, cup x muscle, firm x age
                 + [k for k in d if B.MORPH_KIND[k] in ("bdet", "dyn")])
        return order, context

    def under_outer(self, rec, margin=0.001, reach=0.006):
        """Underwear stays >= margin under every outer garment, at neutral and at every shape key on its context
        (the contexts of clearance()). The outer garments are fitted first and only see the body, so where both sit
        close to the skin (the coat over a pointed cup-max breast: coat 3 mm, bra 2.5 mm over the skin along a
        different normal) the underwear came out through the outer garment's vertices (review 2026-10-01). An
        underwear vertex within `reach` under (or outside) an outer garment's nearest surface moves in along that
        surface's normal to `margin` under it, never closer than 0.6 * offset to the skin."""
        B = self.B
        g = rec["spec"]
        obj = rec["obj"]
        me = obj.data
        S = get_shapes(obj)
        base = S["Basis"]
        d = {k: S[k] - base for k in S if k != "Basis"}
        outer = []
        for r in self.done.values():
            sp = r["spec"]
            if sp.get("gen") or sp.get("closed") or sp["layer"] <= g["layer"]:
                continue
            sh = get_shapes(r["obj"])
            outer.append((sp["id"], sh, mesh_arrays(r["obj"])[1]))
        floor = 0.6 * g["offset"]

        def fix(X, combo):
            body = B.BASE_ARR.copy()
            for k in combo:
                body = body + B.delta[k]
            bb = self.body_bvh(body)
            Y = X.copy()
            n = 0
            for _, sh, pl in outer:
                O = sh["Basis"].copy()
                for k in combo:
                    if k in sh:
                        O += sh[k] - sh["Basis"]
                bvh = BVHTree.FromPolygons([Vector(p) for p in O], pl)
                for i in range(len(Y)):
                    p = Vector(Y[i])
                    loc, nrm, _, dist = bvh.find_nearest(p, reach)
                    if loc is None:
                        continue
                    sd = (p - loc).dot(nrm)               # > 0: outside the outer garment
                    if sd <= -margin or sd < -reach:
                        continue
                    bl, bn, _, _ = bb.find_nearest(p, 0.05)
                    if bl is None or nrm.dot(bn) < 0.5:
                        continue                          # an inner face (waistband / lining) or a fold: not "over" it
                    q = p - nrm * (sd + margin)
                    bl, bn, _, _ = bb.find_nearest(q, 0.05)
                    if bl is not None and (q - bl).dot(bn) < floor:
                        continue                          # no room: leave it (the outer garment is on the skin)
                    Y[i] = q[:]
                    n += 1
            return Y, n

        new_base, n0 = fix(base, [])
        new = {}
        order, context = self.key_contexts(d)
        report = {"neutral": n0}
        for k in order:
            c = context(k)
            X0 = new_base + sum((new[x] for x in c), np.zeros_like(new_base))
            Y, report[k] = fix(X0 + d[k], c + [k])
            new[k] = Y - X0
        for k in d:
            if k not in new:
                new[k] = d[k]
        kb = me.shape_keys.key_blocks
        kb["Basis"].data.foreach_set("co", new_base.astype(np.float32).ravel())
        for k, dk in new.items():
            kb[k].data.foreach_set("co", (new_base + dk).astype(np.float32).ravel())
        me.vertices.foreach_set("co", new_base.astype(np.float32).ravel())
        me.update()
        worst = sorted(((v, k) for k, v in report.items() if v), reverse=True)[:4]
        rec["underOuter"] = {"neutral": n0, "worst": [[k, v] for v, k in worst]}
        print("BUILD cloth %s under outer garments %s: verts moved at neutral %d, worst %s"
              % (g["id"], [o[0] for o in outer], n0, worst))

    def clearance(self, obj, g, rec, only=None, eps_body=EPS_BODY, label="clearance", self_polys=None, self_only=None,
                  self_eps=0.003, skip_lower=()):
        """only: bool mask of the vertices that may move (None = all). With a mask the uniform PUSH is skipped
        (used for the coat's generated collar / lapels, which are placed with their own offsets).
        self_polys: polygons of this object (e.g. the jacket) used as one more collider, with clearance self_eps, for
        the vertices in self_only (the lapels lying on the jacket).
        skip_lower: {lower garment id: bool mask of this object's vertices it is no collider for} (the back of the
        coat collar over the shirt collar)."""
        B = self.B
        me = obj.data
        S = get_shapes(obj)
        base = S["Basis"]
        d = {k: S[k] - base for k in S if k != "Basis"}
        _, polys = mesh_arrays(obj)
        nb = neighbours(len(base), polys)
        movable = np.arange(len(base)) if only is None else np.where(only)[0]
        lo_z, hi_z = base[:, 2].min() - 0.1, base[:, 2].max() + 0.1
        lower = []
        for r in sorted(self.done.values(), key=lambda r: r["spec"]["layer"]):
            if r["spec"]["layer"] >= g["layer"] or r["spec"].get("gen"):
                continue                                   # underwear is never a collider for the outer garments
            if not wearable_together(g, r["spec"]):
                continue                                   # never worn under it (the tee under the hoodie)
            sh = get_shapes(r["obj"])
            if sh["Basis"][:, 2].max() < lo_z or sh["Basis"][:, 2].min() > hi_z:
                continue                                   # far apart (coat vs shoes)
            # one collider per connected part (shoe / sock): the nearest surface of one would hide the other
            pl = mesh_arrays(r["obj"])[1]
            roots = components(len(sh["Basis"]), pl)
            parts = {}
            for f in pl:
                parts.setdefault(int(roots[f[0]]), []).append(f)
            tris = np.array([(f[0], f[k], f[k + 1]) for f in pl for k in range(1, len(f) - 1)], np.int64)
            # a simulated lower garment (the skirt) leaves its fitted shape in motion: an outer garment that hangs over
            # its free part keeps `sim_layer_gap` m more room (spec of the outer garment; the shirt / hoodie hem)
            eps = EPS_LAYER + (g.get("sim_layer_gap", 0.0) if r["spec"].get("cloth") else 0.0)
            lower.append((r["spec"]["id"], sh, list(parts.values()), tris if r["spec"].get("closed") else None, eps))

        class Colliders(list):
            pts = ()

        # wrap_body (boots): the skin near the garment is wrapped like a closed lower garment (wrap below): the big
        # toe came out 2-3 mm through the middle of the boot's large toe-cap faces while every boot vertex cleared
        # the skin (tools/check_garment.mjs holes: 222 hidden toe triangles uncovered)
        wrap_v = wrap_t = None
        if g.get("wrap_body"):
            bb0, bb1 = base.min(0) - 0.02, base.max(0) + 0.02
            P0 = B.BASE_ARR[:B.N_BODY]
            wrap_v = np.where(((P0 >= bb0) & (P0 <= bb1)).all(1))[0]
            wrap_t = np.array([(f[0], f[k], f[k + 1]) for f in self.body_polys for k in range(1, len(f) - 1)], np.int64)

        def colliders(combo):
            """combo: morph keys at weight 1 (corrective corners: both macros + the corrective)."""
            body = B.BASE_ARR.copy()
            for k in combo:
                body = body + B.delta[k]
            cs = Colliders([(self.body_bvh(body), eps_body, None)])
            pts = []
            if wrap_v is not None:
                bn = vertex_normals(body[:B.N_BODY], wrap_t)
                # reach WRAP_BODY_REACH, not FIX_RANGE: the toe sides against the squashed sole met the large sole
                # faces 15-27 mm away and the wrap rounds pushed the toe tip of one boot up to 75 mm out (a spike
                # through the floor at weight_max + muscle_max, 60 mm at age_old); the toe-cap pokes are 2-3 mm
                pts.append((body[wrap_v], bn[wrap_v], WRAP_BODY_REACH))
            for lid, sh, parts, tris, eps in lower:
                X = sh["Basis"].copy()
                for k in combo:
                    X += sh[k] - sh["Basis"]
                allow = ~skip_lower[lid] if lid in skip_lower else None
                for pl in parts:
                    cs.append((BVHTree.FromPolygons([Vector(p) for p in X], pl), eps, allow))
                if tris is not None:                      # closed lower garment (shoes): its vertices + normals
                    pts.append((X, vertex_normals(X, tris)))
            cs.pts = pts
            if self_polys:
                X = base.copy()
                for k in combo:
                    X += d[k]
                cs.append((BVHTree.FromPolygons([Vector(p) for p in X], self_polys), self_eps, self_only))
            return cs

        def push(X, cs):
            X = X.copy()
            moved = np.zeros(len(X), bool)
            for i in movable:
                p = Vector(X[i])
                for bvh, eps, msk in cs:
                    if msk is not None and not msk[i]:
                        continue
                    loc, nrm, _, dist = bvh.find_nearest(p, eps + FIX_RANGE)
                    if loc is None:
                        continue
                    sd = (p - loc).dot(nrm)
                    if -FIX_RANGE < sd < eps:
                        p = p + nrm * (eps - sd)
                        moved[i] = True
                X[i] = p[:]
            return X, moved

        mov = np.zeros(len(base), bool)
        mov[movable] = True

        # shoes01: the sock (cc_sec != 0) is part of this object and pushed off the body like the shoe; on the wide
        # bodies (heavy, child) it then came out through the shoe's sides in patches, already standing still (the
        # integrity harness tests vertices and missed it: the patches are sock triangle interiors).
        inner = None
        if g.get("secondary_from") == "small_components" and g.get("closed") and "cc_sec" in me.attributes:
            sec = np.zeros(len(base), np.int32)
            me.attributes["cc_sec"].data.foreach_get("value", sec)
            if sec.any() and not sec.all():
                shoe_p = [f for f in polys if not any(sec[v] for v in f)]
                sock_p = [f for f in polys if all(sec[v] for v in f)]
                inner = (np.where(sec != 0)[0], shoe_p, sock_p,
                         np.array([(f[0], f[k], f[k + 1]) for f in shoe_p for k in range(1, len(f) - 1)], np.int64),
                         np.array([(f[0], f[k], f[k + 1]) for f in sock_p for k in range(1, len(f) - 1)], np.int64))

        def keep_inside(X):
            """Sock under the shoe: a sock vertex outside the shoe (its backward ray hits a shoe face that faces the
            same way) or closer than EPS_LAYER under it moves in to EPS_LAYER; a shoe vertex whose forward ray hits a
            sock face (the sock bulges out between its vertices) moves that face in the same way."""
            if inner is None:
                return X, 0
            sock, shoe_p, sock_p, shoe_t, sock_t = inner
            X = X.copy()
            n = 0
            for _ in range(3):
                bshoe = BVHTree.FromPolygons([Vector(p) for p in X], shoe_p)
                bsock = BVHTree.FromPolygons([Vector(p) for p in X], sock_p)
                Ns, Nk = vertex_normals(X, shoe_t), vertex_normals(X, sock_t)
                disp = np.zeros_like(X)
                for i in sock:
                    q, m = Vector(X[i]), Vector(Nk[i])
                    loc, nrm, _, dist = bshoe.ray_cast(q, -m, FIX_RANGE)
                    if loc is not None and nrm.dot(m) > 0.3:          # outside the shoe by dist
                        dv = -np.array(nrm) * (dist + EPS_LAYER)
                    else:
                        loc, nrm, _, dist = bshoe.ray_cast(q, m, EPS_LAYER)
                        if loc is None or nrm.dot(m) < 0.3:
                            continue
                        dv = -np.array(nrm) * (EPS_LAYER - dist)       # under it, but too close
                    if dv.dot(dv) > disp[i].dot(disp[i]):
                        disp[i] = dv
                shoe_v = np.unique(np.array([v for f in shoe_p for v in f]))
                for j in shoe_v:
                    q, m = Vector(X[j]), Vector(Ns[j])
                    loc, nrm, fi, dist = bsock.ray_cast(q - m * EPS_LAYER, m, FIX_RANGE + EPS_LAYER)
                    if loc is None or nrm.dot(m) < 0.3:
                        continue
                    dv = -np.array(nrm) * (dist + 1e-4)                 # face to EPS_LAYER under the shoe vertex
                    for v in sock_p[fi]:
                        if dv.dot(dv) > disp[v].dot(disp[v]):
                            disp[v] = dv
                moved = np.linalg.norm(disp, axis=1) > 1e-6
                if not moved.any():
                    break
                n = max(n, int(moved.sum()))
                X = X + disp
            return X, n

        def wrap(X, cs):
            """The other way round, for a closed lower garment (the shoe under the jeans hem): this garment's faces
            are much larger than the shoe's curvature, so a shoe vertex can come out through the middle of a face
            while every vertex of the face clears the shoe. A shoe vertex whose backward ray (against its normal)
            hits a face of this garment within FIX_RANGE, with no face in front of it (= it is outside: the poke of
            tools/cloth_integrity.mjs), moves that face's vertices out along the face normal by depth + EPS_LAYER."""
            if not cs.pts:
                return X, np.zeros(len(X), bool)
            bvh = BVHTree.FromPolygons([Vector(p) for p in X], polys)
            disp = np.zeros_like(X)
            hit = np.zeros(len(X), bool)
            for P, N, *rr in cs.pts:
                reach = rr[0] if rr else FIX_RANGE
                for q, m in zip(P, N):
                    qv, mv = Vector(q), Vector(m)
                    loc, nrm, fi, dist = bvh.ray_cast(qv, -mv, reach)
                    if loc is None or nrm.dot(mv) < 0.3:
                        continue
                    if bvh.ray_cast(qv + mv * 1e-4, mv, FIX_RANGE)[0] is not None:
                        continue
                    dv = np.array(nrm) * (dist + EPS_LAYER)
                    for v in polys[fi]:
                        if mov[v] and dv.dot(dv) > disp[v].dot(disp[v]):
                            disp[v] = dv
                            hit[v] = True
            return X + disp, hit

        def fix(X, cs):
            Y, moved = push(X, cs)
            for _ in range(3):
                Y, w = wrap(Y, cs)
                if not w.any():
                    break
                moved |= w
                Y, _ = push(Y, cs)
            if not moved.any():
                Y, k = keep_inside(Y)
                return Y, 0
            for _ in range(2):                             # spread each correction to its neighbours, re-enforce
                c = Y - X
                mag = np.linalg.norm(c, axis=1)
                sm = c.copy()
                for i, ns in enumerate(nb):
                    if len(ns):
                        sm[i] = 0.5 * c[i] + 0.5 * c[ns].mean(0)
                c = np.where((np.linalg.norm(sm, axis=1) > mag)[:, None], sm, c)
                Y, _ = push(X + c, cs)
            Y, w = wrap(Y, cs)
            if w.any():
                Y, _ = push(Y, cs)
            Y, _ = keep_inside(Y)
            return Y, int(moved.sum())

        pushed = base.copy()
        for i in (range(len(base)) if only is None else []):
            loc, nrm, _, dist = self.bvh0.find_nearest(Vector(base[i]), 0.03)
            if loc is not None:
                pushed[i] = base[i] + np.array(nrm) * PUSH
        new_base, m0 = fix(pushed, colliders([]))
        report = {"neutral": m0}
        new = {}

        # Each key k is fixed on top of a context: its corrective's parts, plus for the breast keys (breast macros,
        # their correctives, the detail targets bdet_* and the motion morphs dyn_*) the body they only ever show on:
        # female (web/character.js breastGate), and at the largest cup unless k is a cup key itself. The context also
        # carries every corrective between two of its keys (what the runtime adds there). k keeps only what the fix
        # adds on top of the (already fixed) context, so the context's own deltas are unchanged.
        order, context = self.key_contexts(d)

        def fix_key(k):
            c = context(k)
            X0 = new_base + sum((new[x] for x in c), np.zeros_like(new_base))
            Y, report[k] = fix(X0 + d[k], colliders(c + [k]))
            new[k] = Y - X0
            kind = B.MORPH_KIND[k]
            if kind in B.ZERO_BELOW:
                new[k][np.linalg.norm(new[k], axis=1) < B.ZERO_BELOW[kind]] = 0.0

        for k in order:
            fix_key(k)
        for k in d:
            if k not in new:
                new[k] = d[k]                              # face / blink / look: unchanged relative deltas
        kb = me.shape_keys.key_blocks
        kb["Basis"].data.foreach_set("co", new_base.astype(np.float32).ravel())
        for k, dk in new.items():
            kb[k].data.foreach_set("co", (new_base + dk).astype(np.float32).ravel())
        me.vertices.foreach_set("co", new_base.astype(np.float32).ravel())
        me.update()
        worst = sorted(((v, k) for k, v in report.items()), reverse=True)[:3]
        rec[label] = {"fixedNeutral": m0, "worst": [[k, v] for v, k in worst]}
        print("BUILD cloth %s %s vs body%s: verts pushed at neutral %d, worst %s"
              % (g["id"], label, "".join(" + " + x[0] for x in lower), m0, worst))

    # ---- cloth garments: weights + pin mask ------------------------------------------------------------
    def cloth_weights_and_pin(self, obj, g, rec):
        c = g["cloth"]
        me = obj.data
        co, _ = mesh_arrays(obj)
        z_top, z_bot = self.z_of(c["pinTop"]), self.z_of(c["pinBottom"])
        pin = smoothstep(z_bot, z_top, co[:, 2])
        if rec.get("ext"):                     # long coat: only the generated skirt hangs free (jacket, sleeves,
            s0, s1 = rec["ext"]["skirt"]       # collar and belt follow the skin)
            keep = np.ones(len(co), bool)
            keep[s0:s1] = False
            pin[keep] = 1.0
        for n in ("pelvis", "thigh_l", "thigh_r"):
            if not obj.vertex_groups.get(n):
                obj.vertex_groups.new(name=n)
        side = smoothstep(-c["shareWidth"], c["shareWidth"], co[:, 0])     # 1 = character's left (+x)
        # thigh share: legShare, or (legShareFront) more on the front panels, which hang in front of the thighs
        # and would be pierced by a lifted knee (Blender -Y = front; blend over +-5 cm around the thigh joints)
        yc = self.heads["thigh_l"][1]
        front = smoothstep(yc + 0.05, yc - 0.05, co[:, 1]) if "legShareFront" in c else np.zeros(len(co))
        a_v = c["legShare"] + (c.get("legShareFront", c["legShare"]) - c["legShare"]) * front
        names = {grp.index: grp.name for grp in obj.vertex_groups}
        for v in me.vertices:
            i = v.index
            f = 1.0 - pin[i]
            if f <= 1e-4:
                continue
            cur = {names[e.group]: e.weight for e in v.groups}
            tot = sum(cur.values()) or 1.0
            want = {k: wt / tot * (1 - f) for k, wt in cur.items()}
            a = a_v[i]
            for k, wt in (("pelvis", 1 - a), ("thigh_l", a * side[i]), ("thigh_r", a * (1 - side[i]))):
                want[k] = want.get(k, 0.0) + f * wt
            for k, wt in want.items():
                grp = obj.vertex_groups[k]
                if wt > 1e-5:
                    grp.add([i], wt, 'REPLACE')
                else:
                    grp.remove([i])
        at = me.attributes.new("_CLOTH_PIN", 'FLOAT', 'POINT')
        at.data.foreach_set("value", pin.astype(np.float32))
        rec["pin"] = {"top": z_top, "bottom": z_bot, "free": int((pin < 0.01).sum()), "pinned": int((pin > 0.99).sum())}
        print("BUILD cloth %s pin: 1 above z %.3f, 0 below z %.3f; free %d, pinned %d of %d verts"
              % (g["id"], z_top, z_bot, rec["pin"]["free"], rec["pin"]["pinned"], len(pin)))

    @staticmethod
    def cloth_extras(g):
        c = g.get("cloth")
        if not c:
            return None
        return {"version": 1, "pinAttribute": "_CLOTH_PIN", "pinMeaning": "1 = follows the skinned mesh, 0 = free",
                "maxDistance": c["maxDistance"], "stiffness": {"stretch": c["stretch"], "bend": c["bend"]},
                "damping": c["damping"], "gravityScale": c["gravityScale"], "wind": c["wind"],
                "colliders": "body_colliders.json", "units": "metres, glTF Y-up"} | {
                k: c[k] for k in ("bendVertical", "friction", "thickness", "floor", "limit", "limitSlack",
                                  "limitSlackPinned", "layerThickness") if k in c}

    # ---- textures / material -------------------------------------------------------------------------
    def textures_and_material(self, obj, g, rec):
        B = self.B
        me = obj.data
        pdir = os.path.join(B.args.assets, "clothes", g["pack"])
        diffuse = os.path.join(pdir, sorted(f for f in os.listdir(pdir) if f.endswith("_diffuse.png"))[0])
        normals = sorted(f for f in os.listdir(pdir) if f.endswith("_normal.png"))
        normal = os.path.join(pdir, normals[0]) if normals else None
        nl = len(me.loops)
        uv = np.empty(nl * 2)
        me.uv_layers.active.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        lv = np.empty(nl, np.int64)
        me.loops.foreach_get("vertex_index", lv)
        sec_v = np.zeros(len(me.vertices))
        if "cc_sec" in me.attributes:
            a = np.empty(len(me.vertices), np.int32)
            me.attributes["cc_sec"].data.foreach_get("value", a)
            sec_v = a.astype(float)
            me.attributes.remove(me.attributes["cc_sec"])
        me.calc_loop_triangles()
        tl = np.empty(len(me.loop_triangles) * 3, np.int64)
        me.loop_triangles.foreach_get("loops", tl)
        tl = tl.reshape(-1, 3)
        tri_fill = np.zeros(len(tl))
        if "cc_fill" in me.attributes:              # faces closing the removed pockets: inpainted texels
            fa = np.empty(len(me.polygons), np.int32)
            me.attributes["cc_fill"].data.foreach_get("value", fa)
            tp = np.empty(len(tl), np.int64)
            me.loop_triangles.foreach_get("polygon_index", tp)
            tri_fill = fa[tp].astype(float)
            me.attributes.remove(me.attributes["cc_fill"])
        lo = np.floor(np.clip(uv.min(0) - 0.01, 0, 1) * 32) / 32
        hi = np.ceil(np.clip(uv.max(0) + 0.01, 0, 1) * 32) / 32
        out = os.path.join(B.args.textures, "cloth_%s" % g["id"])
        ref_v = np.zeros(len(me.vertices))
        if rec.get("ext"):                      # jacket vertices up to 12 cm above the cut: fabric reference
            co_, _ = mesh_arrays(obj)
            n0 = rec["ext"]["n0"]
            ref_v[:n0] = (co_[:n0, 2] < rec["ext"]["hem_z"] + 0.12) & (sec_v[:n0] < 0.5)
        info = tex_cloth(B.tex, diffuse, normal, out, uv[tl],
                         np.stack([sec_v[lv[tl]], ref_v[lv[tl]], np.repeat(tri_fill[:, None], 3, 1)], -1), (lo, hi),
                         g.get("secondary_from"), fill_rect=rec.get("ext", {}).get("uv"),
                         belt_rect=rec.get("ext", {}).get("belt_uv"), sec_leather=g.get("sec_leather", False))
        me.uv_layers.active.data.foreach_set("uv", ((uv - lo) / (hi - lo)).ravel())
        name = "Cloth_" + g["id"]
        me.materials.clear()
        me.materials.append(B.make_material(name, info["albedo"], normal_path=info.get("normal")))
        gain = info["gain"]
        lin = B.tex.hex_to_lin(g["primary"]) * gain
        tint = {"gain": round(float(gain), 4), "default": g["primary"]}
        spec = {"baseColorFactor": [float(min(1.0, v)) for v in lin] + [1.0], "roughness": g["roughness"],
                "metallic": 0.0, "doubleSided": True, "normalScale": 0.8, "extras": {"tint": tint}}
        if g.get("secondary") and info.get("mask"):
            tint["secondaryDefault"] = g["secondary"]
            if g.get("lining"):                 # back faces (coat inside, collar inside) show the secondary colour
                tint["lining"] = g["lining"]
            spec["extraTextures"] = {"ccMask": info["mask"]}
        B.MATERIALS[name] = spec
        rec["secondary"] = bool(g.get("secondary") and info.get("mask"))
        print("BUILD cloth %s texture %s crop u %.3f..%.3f v %.3f..%.3f -> %s px, gain %.2f, secondary %.1f%% of texels"
              % (g["id"], os.path.basename(diffuse), lo[0], hi[0], lo[1], hi[1], info["size"], gain,
                 100 * info["sec_frac"]))

    # ---- output --------------------------------------------------------------------------------------
    def finish_body(self):
        """_CCZONE on the body (float bitmask per vertex; glTF attribute _CCZONE)."""
        B = self.B
        for rec in self.done.values():
            if rec["spec"].get("gen"):
                self.under_outer(rec)
                self.underwear_cover(rec)
        me = B.human.data
        vals = np.zeros(len(me.vertices), np.float32)
        vals[:B.N_BODY] = self.body_zone
        at = me.attributes.new("_CCZONE", 'FLOAT', 'POINT')
        at.data.foreach_set("value", vals)
        print("BUILD body zones %s: %s" % (self.zone_bits, {z: int(((self.body_zone & b) > 0).sum())
                                                            for z, b in self.zone_bits.items()}))

    def export_all(self, out_dir, export, rig, read_glb, write_glb):
        items = []
        for g in sorted(GARMENTS, key=lambda g: (SLOTS.index(g["slot"]), g["layer"], g["id"])):
            if g["id"] not in self.done:
                continue
            rec = self.done[g["id"]]
            fn = "clothing_%s.glb" % g["id"]
            path = os.path.join(out_dir, fn)
            export(path, [rec["obj"], rig], export_morph_normal=False, export_attributes=True)
            ce = self.cloth_extras(g)
            if ce:
                gl, bin_ = read_glb(path)
                for m in gl["meshes"]:
                    m.setdefault("extras", {})["ccCloth"] = ce
                write_glb(path, gl, bin_)
            colors = {"primary": g["primary"]}
            if rec.get("secondary"):
                colors["secondary"] = g["secondary"]
            item = {"id": g["id"], "file": fn, "mesh": "Cloth_" + g["id"], "label": g["label"], "slot": g["slot"],
                    "occupies": OCCUPIES.get(g["id"], [g["slot"]]), "conflicts": CONFLICTS.get(g["id"], []),
                    "layer": g["layer"], "hidesBodyZones": [g["zone"]] + HIDES_EXTRA.get(g["id"], []),
                    "colors": colors, "bytes": os.path.getsize(path), "vertices": len(rec["obj"].data.vertices),
                    "license": "CC0",
                    "source": "MakeHuman system assets: clothes/%s (%s)" % (g.get("pack"), g["source_part"])}
            if g.get("gen"):
                item["license"] = "project-original"
                item["source"] = "project-original: %s (no third-party asset)" % g["source_part"]
                item["projectOriginal"] = ("whole mesh (%d vertices, %d faces) generated from the body surface by "
                                           "blender/cc_clothing.py add_generated (%s)"
                                           % (rec["gen"]["verts"], rec["gen"]["faces"], g["gen"]))
                item["sex"] = g["sex"]
                item["collidesAsLayer"] = False
                item["coveredBy"] = rec.get("coveredBy", {})
            if g.get("coat"):
                item["license"] = "CC0 source + project-original extension"
                item["projectOriginal"] = ("%s (%d vertices, %d rows x %d columns) generated by blender/cc_clothing.py "
                                           "coat_skirt" % (g["coat"].get("what", "long skirt below the waist and belt"),
                                                           rec["ext"]["verts"], rec["ext"]["rows"], rec["ext"]["cols"]))
                cl = rec["ext"].get("collar")
                if cl:
                    item["projectOriginal"] += ("; standing collar and lapels (%d vertices, %d columns x %d rows) "
                                                "generated by coat_collar" % (cl["verts"], cl["cols"], cl["rows"]))
            if rec.get("hood"):
                item["license"] = "CC0 source + project-original extension"
                item["projectOriginal"] = ("hood lying down around the neck and on the upper back (%d vertices, %d "
                                           "columns x %d rows) generated by blender/cc_clothing.py hood_down"
                                           % (rec["hood"]["verts"], rec["hood"]["cols"], rec["hood"]["rows"]))
            if rec.get("hidesLower"):
                item["hidesLowerVertices"] = rec["hidesLower"]
            if ce:
                item["cloth"] = ce
            items.append(item)
        cat = {"version": 1, "slots": SLOTS, "slotLabels": SLOT_LABELS,
               "bodyZones": dict(sorted(self.zone_bits.items(), key=lambda kv: kv[1])),
               "bodyZoneAttribute": "_CCZONE", "default": [], "defaultUnderwear": DEFAULT_UNDERWEAR,
               "underwearSlots": UNDERWEAR_SLOTS, "items": items,
               "rules": {"occupies": "putting an item on removes every worn item that occupies one of its slots",
                         "conflicts": "putting an item on also removes the worn items listed in its conflicts "
                                      "(and items that list it)",
                         "layer": "higher layer = outside; each item was fitted over every lower-layer item",
                         "covered": "a garment whose vertex attribute _CCZONE carries the zone bit of a worn "
                                    "higher-layer item drops its triangles whose three vertices carry that bit",
                         "underwear": "underwear (underwearSlots, layer 0) is worn by default (defaultUnderwear per "
                                      "sex; switching sex swaps it); a non-empty outfit without underwear gets the "
                                      "default added, outfit 'none' / [] is naked; it is hidden where worn garments "
                                      "cover it (rule 'covered'; mesh not drawn when nothing is left) and is never "
                                      "a cloth collision layer (collidesAsLayer false)"}}
        with open(os.path.join(out_dir, "clothing.json"), "w", encoding="utf-8") as f:
            json.dump(cat, f, indent=1, ensure_ascii=False)
        print("BUILD clothing catalog", [(i["id"], i["bytes"]) for i in items])
        return cat


def tex_cloth(tex, src, normal_src, out_prefix, tri_uv, tri_sec, crop, sec_rule, fill_rect=None, belt_rect=None, k=0.5,
              max_size=1024, normal_size=512, mask_size=256, sec_leather=False):
    """Crop + grey-normalise a MakeHuman clothing atlas for runtime tinting (tint contract of cc_textures.py:
    region mean -> k, gain = 1 / k). Primary and secondary regions are normalised separately so both take their
    colour from the tint. Returns {albedo, normal, mask, gain, sec_frac, size}. Row 0 = v 0 (Blender order)."""
    a = tex.load(src)
    H, W = a.shape[:2]
    (u0, v0), (u1, v1) = crop
    a = a[int(v0 * H):int(v1 * H), int(u0 * W):int(u1 * W)]
    f = 1
    while max(a.shape[0], a.shape[1]) / f > max_size:
        f *= 2
    h, w = (a.shape[0] // f) * f, (a.shape[1] // f) * f
    a = a[:h, :w].reshape(h // f, f, w // f, f, 4).mean((1, 3))
    lin = tex.s2l(a[..., :3].astype(np.float64))
    h, w = lin.shape[:2]
    cuv = (np.asarray(tri_uv) - np.array([u0, v0])) / np.array([u1 - u0, v1 - v0])
    size = max(h, w)
    tri_sec = tri_sec if tri_sec.ndim == 3 else tri_sec[..., None]
    vals = np.concatenate([np.ones(tri_sec.shape[:2] + (1,)), tri_sec], -1)
    m = tex.raster(cuv * np.array([w / size, h / size]), vals, size=size, radius=1)[:h, :w]
    cover = m[..., 0] > 0.5
    sec = np.where(cover, np.clip(m[..., 1], 0, 1), 0.0)
    near_hem = (m[..., 2] > 0.5) & cover if vals.shape[2] > 2 else None
    inpaint = (m[..., 3] > 0.05) & cover if vals.shape[2] > 3 else None
    if sec_rule == "orange":
        mx = lin.max(-1)
        sat = (mx - lin.min(-1)) / np.maximum(mx, 1e-4)
        orange = (lin[..., 0] > 2.0 * lin[..., 2]) & (lin[..., 0] > 1.1 * lin[..., 1]) & (sat > 0.45) & cover
        sec = np.maximum(sec, np.clip(tex.blur(orange.astype(np.float64), 1) * 2 - 0.3, 0, 1))
    L = tex.lum(lin)
    if fill_rect is not None:
        # generated fabric for the coat extension's UV rectangle: the jacket fabric's median brightness and
        # fine-detail contrast, seeded noise and a faint diagonal twill
        fu0, fu1 = [(x - u0) / (u1 - u0) for x in fill_rect[:2]]
        fv0, fv1 = [(x - v0) / (v1 - v0) for x in fill_rect[2:]]
        c0, c1, r0, r1 = int(fu0 * w), int(fu1 * w), int(fv0 * h), int(fv1 * h)
        ref = (near_hem if near_hem is not None and near_hem.sum() > 100 else cover) & (sec < 0.5)
        ref[r0:r1, c0:c1] = False
        # reference = the jacket texels just above its hem (same shading as the fabric it continues). Only fine grain (1-2 texels), low contrast: large-scale noise reads as
        # stains on the model.
        mu = float(np.median(L[ref]))
        rng = np.random.default_rng(3)
        nz = rng.standard_normal((r1 - r0, c1 - c0))
        nz = nz - tex.blur(nz, 2)
        nz = nz / (np.std(nz) + 1e-6)
        yy, xx = np.mgrid[0:r1 - r0, 0:c1 - c0]
        twill = np.sin((xx + yy) * 2 * np.pi / 3.0)
        L[r0:r1, c0:c1] = mu * (1 + 0.035 * nz + 0.025 * twill)
        cover[r0:r1, c0:c1] = True
        sec[r0:r1, c0:c1] = 0.0
    if inpaint is not None and inpaint.any():
        # texels of the faces that close the removed pockets (the atlas has a hole there): smooth fill from the
        # surrounding fabric (growing blur radius until every texel has neighbours) + the same fine grain
        known = (cover & ~inpaint & (sec < 0.5)).astype(np.float64)
        fillL = np.zeros_like(L)
        todo = inpaint.copy()
        for r in (2, 4, 8, 16, 32, 64):
            wk = tex.blur(known, r)
            est = tex.blur(L * known, r) / np.maximum(wk, 1e-6)
            ok = todo & (wk > 0.05)
            fillL[ok] = est[ok]
            todo &= ~ok
        rng = np.random.default_rng(7)
        nz = rng.standard_normal(L.shape)
        nz = nz - tex.blur(nz, 2)
        nz = nz / (np.std(nz) + 1e-6)
        L = np.where(inpaint, fillL * (1 + 0.03 * nz), L)
    if belt_rect is not None:
        # generated belt: secondary region (leather-like fine grain, darker stitch lines 12 % from each edge)
        bu0, bu1 = [(x - u0) / (u1 - u0) for x in belt_rect[:2]]
        bv0, bv1 = [(x - v0) / (v1 - v0) for x in belt_rect[2:]]
        c0, c1, r0, r1 = int(bu0 * w), int(bu1 * w), int(bv0 * h), max(int(bv1 * h), int(bv0 * h) + 4)
        rng = np.random.default_rng(5)
        nz = tex.blur(rng.standard_normal((r1 - r0, c1 - c0)), 1)
        nz = nz / (np.std(nz) + 1e-6)
        rows = np.arange(r1 - r0)[:, None] / max(r1 - r0 - 1, 1)
        stitch = ((np.abs(rows - 0.12) < 0.05) | (np.abs(rows - 0.88) < 0.05)) &                  ((np.arange(c1 - c0)[None, :] // 2) % 2 == 0)
        L[r0:r1, c0:c1] = 0.5 * (1 + 0.05 * nz) * np.where(stitch, 0.7, 1.0)
        cover[r0:r1, c0:c1] = True
        sec[r0:r1, c0:c1] = 1.0
    sec_b = sec >= 0.5
    leather = None
    if sec_leather and (sec_b & cover).sum() >= 16:
        # boots: the sock's rib knit becomes a leather shaft: the shoe's median brightness, fine low-contrast grain,
        # faint creases across the ankle (sideways stripes in the sock's UV layout run along v) and a flat normal
        leather = sec_b & cover
        mu = float(np.median(L[cover & ~sec_b])) if (cover & ~sec_b).any() else float(L[leather].mean())
        rng = np.random.default_rng(11)
        nz = tex.blur(rng.standard_normal(L.shape), 1)
        nz = nz / (np.std(nz) + 1e-6)
        crease = tex.blur(rng.standard_normal(L.shape), 6)
        crease = crease / (np.std(crease) + 1e-6)
        L = np.where(leather, mu * (1 + 0.05 * nz + 0.06 * crease), L)
    out = np.full_like(L, k)
    for region in (~sec_b & cover, sec_b & cover):
        if region.sum() >= 16:
            out = np.where(region, L * (k / max(float(L[region].mean()), 1e-4)), out)
    wsum = tex.blur(cover.astype(np.float64), 3)           # bleed covered texels outward (mip-maps, seams)
    fill = tex.blur(out * cover, 3) / np.maximum(wsum, 1e-4)
    out = np.where(cover, out, np.where(wsum > 1e-3, fill, k))
    s = tex.l2s(np.clip(out, 0, 1))
    res = {"albedo": tex.save(np.stack([s, s, s], -1), out_prefix + "_albedo.jpg", quality=86),
           "gain": 1.0 / k, "sec_frac": float(sec_b.sum() / max(cover.sum(), 1)), "size": [int(w), int(h)]}
    if normal_src:
        nm = tex.load(normal_src)
        NH, NW = nm.shape[:2]
        nm = nm[int(v0 * NH):int(v1 * NH), int(u0 * NW):int(u1 * NW), :3]
        fn = 1
        while max(nm.shape[:2]) / fn > normal_size:
            fn *= 2
        nh, nw = (nm.shape[0] // fn) * fn, (nm.shape[1] // fn) * fn
        nm = nm[:nh, :nw].reshape(nh // fn, fn, nw // fn, fn, 3).mean((1, 3))
        nh, nw = nm.shape[:2]
        if fill_rect is not None:
            nm[int(fv0 * nh):int(fv1 * nh), int(fu0 * nw):int(fu1 * nw)] = (0.5, 0.5, 1.0)
        if inpaint is not None and inpaint.any():
            ih, iw = inpaint.shape
            yy = (np.arange(nh) * ih // nh)[:, None]
            xx = (np.arange(nw) * iw // nw)[None, :]
            nm[inpaint[yy, xx]] = (0.5, 0.5, 1.0)
        if belt_rect is not None:
            nm[int(bv0 * nh):max(int(bv1 * nh), int(bv0 * nh) + 1), int(bu0 * nw):int(bu1 * nw)] = (0.5, 0.5, 1.0)
        if leather is not None:
            ih, iw = leather.shape
            yy = (np.arange(nh) * ih // nh)[:, None]
            xx = (np.arange(nw) * iw // nw)[None, :]
            nm[leather[yy, xx]] = (0.5, 0.5, 1.0)
        res["normal"] = tex.save(nm, out_prefix + "_normal.jpg", quality=85)
    if sec_b.any():
        f2 = max(1, max(h, w) // mask_size)
        mh, mw = (h // f2) * f2, (w // f2) * f2
        mk = sec[:mh, :mw].reshape(mh // f2, f2, mw // f2, f2).mean((1, 3))
        res["mask"] = tex.save(np.stack([mk, mk, mk], -1), out_prefix + "_mask.jpg", quality=92)
    return res
