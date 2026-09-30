"""Build the base body: MPFB human + game_engine rig + linearised macro morph targets,
exported as GLB, plus a joints sidecar so the skeleton can follow the morphs at runtime.

Run (from the project root, PowerShell):
    C:\\Tools\\Blender\\blender.exe -b --python blender/build_base.py -- [out.glb] [--blend PATH] [--no-ground-fix]

    out.glb          default <project>/output/base_body.glb  (env CC_OUT_GLB)
    --blend PATH     where the .blend snapshot is saved; default <project>/build/blend/base_body.blend
                     (env CC_BLEND). Parent directories are created.
    --no-ground-fix  keep MPFB's raw target deltas (feet may sink/float under height/age morphs)

Outputs:
    <out>.glb                 mesh "Body" (13 380 verts, 12 morph targets) skinned to "Armature" (53 bones)
    <out>.joints.json         sidecar, see "Joints sidecar" below
    build/blend/base_body.blend

Blender output is noisy: grep for "BUILD".
Verify: python blender/tools/check_glb.py output/base_body.glb  (GLB vs sidecar, prints "CHECK OK").

Morph targets ("linearised" sampling)
-------------------------------------
Every macro starts at 0.5, which is MPFB/MakeHuman's neutral: for gender/muscle/weight/
proportions 0.5 is the mid point, for height 0.5 lies in the dead band (0.49..0.51) where neither
minheight nor maxheight is applied, and for age 0.5 is exactly the "young" knot (25 years).
For each morph ONE macro is set to its extreme, the evaluated vertices are read, and the delta vs
neutral becomes a plain shape key. Interactions (gender x weight ...) are therefore lost.
age_child uses 0.1875, not 0.0: in data/targets/macrodetails/macro.json the age parts are
baby(0.0) -> child(0.1875) -> young(0.5) -> old(1.0); 0.1875 is the pure "child" knot (~11 years),
0.0 would be a baby, which is not what the slider should reach.

height_tall: MPFB's maxheight target at full weight is physically "right" (MakeHuman's own tallest
figure) but large: neutral 1.66 m -> 2.37 m (+0.71 m), height_short 1.30 m; the build keeps it unscaled and the web layer caps the slider influence via the
per-slider "scale" in web/character.js. Numbers are printed as "BUILD sample ... height".

Ground fix: MPFB applies feet_on_ground once at creation, so a raw target delta may also move the
soles (measured: at most ~3 mm, age_child / height_tall). Unless --no-ground-fix, each sample is translated
along Z so the lowest 'body' vertex stays where it is at neutral (the same thing MPFB does when it
creates a human with non-default macros). The same translation is applied to the joint offsets.

Joints sidecar (<out>.joints.json)
----------------------------------
glTF morph targets move vertices only; the skeleton would stay at the neutral bind pose. For each
morph sample the rig's bone head positions are recomputed with MPFB's own fitting code (what its
"refit rig" does after a macro change): the rig definition rig.game_engine.json is loaded through
MPFB's Rig class, the "joint-*" cube centres are rebuilt from the sampled (evaluated) vertices
(mean of each joint vertex group, as Rig.build_basemesh_position_info does) and every bone head is
placed with Rig.get_best_location_from_strategy() (CUBE / VERTEX / MEAN strategies + offsets).
offset = fitted_head(sample) - fitted_head(neutral). The real armature is refitted from the same
neutral data (reposition_edit_bone), and the build asserts bind pose == neutral fit.
Weight/muscle morphs barely move joints (offsets ~0-9 mm); height/age/gender move them a lot.
Format (glTF Y-up, metres; Blender (x, y, z) -> glTF (x, z, -y)):
    {"version": 1,
     "bones":  {"<bone>": [x, y, z]},                     bind-pose head (armature space = world)
     "morphs": {"<morph>": {"<bone>": [dx, dy, dz]}}}     head offset at morph weight 1.0
Bone names equal the node names in the GLB. Only heads are given; the runtime translates bones
(no rotation/scale change), which is what the linear morph approximation needs.
"""
import argparse
import json
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.locationservice import LocationService
from bl_ext.user_default.mpfb.entities.objectproperties import HumanObjectProperties
from bl_ext.user_default.mpfb.entities.rig import Rig
from bl_ext.user_default.mpfb.entities.clothes.mhclo import Mhclo

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_HERE, os.path.join(_HERE, "tools")]
import cc_textures as tex                                   # noqa: E402  blender/cc_textures.py
from glbutil import read_glb, write_glb, patch_materials    # noqa: E402  blender/tools/glbutil.py

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RIG = "game_engine"
NEUTRAL = 0.5  # see docstring: neutral for every macro incl. height dead band and age "young"

# (morph name, macro property, value). age_child = 0.1875 = pure "child" knot (see docstring).
MACRO_MORPHS = [
    ("gender_female", "gender", 0.0), ("gender_male", "gender", 1.0),
    ("age_child", "age", 0.1875), ("age_old", "age", 1.0),
    ("weight_min", "weight", 0.0), ("weight_max", "weight", 1.0),
    ("muscle_min", "muscle", 0.0), ("muscle_max", "muscle", 1.0),
    ("height_short", "height", 0.0), ("height_tall", "height", 1.0),
    ("proportions_ideal", "proportions", 1.0), ("proportions_uncommon", "proportions", 0.0),
]


# MakeHuman system assets (all CC0, checked at build time by check_license()).
SKIN = "young_caucasian_female"   # skin texture source (normalised to grey, tinted at runtime)
EYE_TEX = "lightblue"             # eye texture source (iris made grey, tinted at runtime)
BROWS, LASHES = "eyebrow001", "eyelashes01"
# (id, UI labels). Every style becomes output/hair_<id>.glb + an entry in output/hair.json.
HAIR_STYLES = [
    ("short02", {"da": "Kort", "en": "Short"}),
    ("bob02", {"da": "Page", "en": "Bob"}),
    ("long01", {"da": "Langt", "en": "Long"}),
    ("ponytail01", {"da": "Hestehale", "en": "Ponytail"}),
    ("braid01", {"da": "Fletning", "en": "Braid"}),
]
HAIR_DEFAULT = "short02"
HAIR_BONES = {"head", "neck_01", "spine_03", "spine_02", "clavicle_l", "clavicle_r"}  # no arm bones in hair
# default runtime tints (sRGB hex); web/main.js uses the same values
DEFAULTS = {"skin": "#c99a80", "hair": "#3b2a1e", "brows": "#3b2a1e", "lashes": "#1c1510", "eyes": "#4a2f19"}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="build_base.py")
    p.add_argument("out", nargs="?", default=os.environ.get("CC_OUT_GLB",
                   os.path.join(PROJECT, "output", "base_body.glb")))
    p.add_argument("--blend", default=os.environ.get("CC_BLEND",
                   os.path.join(PROJECT, "build", "blend", "base_body.blend")))
    p.add_argument("--no-ground-fix", action="store_true")
    p.add_argument("--assets", default=os.environ.get("CC_MH_ASSETS", os.path.join(PROJECT, "build", "mh_assets")),
                   help="unpacked MakeHuman CC0 system assets (blender/tools/fetch_mh_assets.py)")
    p.add_argument("--no-assets", action="store_true", help="bare body only (no eyes/brows/teeth/hair/skin texture)")
    p.add_argument("--textures", default=os.path.join(PROJECT, "build", "textures"), help="prepared texture files")
    a = p.parse_args(argv)
    a.out = os.path.abspath(a.out)
    a.blend = os.path.abspath(a.blend)
    a.assets = os.path.abspath(a.assets)
    a.textures = os.path.abspath(a.textures)
    a.joints = os.path.splitext(a.out)[0] + ".joints.json"
    return a


args = parse_args()
for d in (os.path.dirname(args.out), os.path.dirname(args.blend)):
    os.makedirs(d, exist_ok=True)
print("BUILD out", args.out, "| joints", args.joints, "| blend", args.blend, "| ground fix", not args.no_ground_fix)

rig_file = os.path.join(LocationService.get_mpfb_data("rigs"), "standard", "rig." + RIG + ".json")
# detailed_helpers=True is REQUIRED: it loads the "joint-*" vertex groups the rig fitter uses.
# Without them every bone silently falls back to its "default_position" (MakeHuman space, origin
# at the hips), i.e. a skeleton ~0.8 m below a feet-on-ground mesh that ignores all morphs.
human = HumanService.create_human(mask_helpers=False, detailed_helpers=True, extra_vertex_groups=False,
                                  feet_on_ground=True)
body_gi = human.vertex_groups["body"].index
body_idx = [v.index for v in human.data.vertices if any(g.group == body_gi for g in v.groups)]


def dg():
    return bpy.context.evaluated_depsgraph_get()


def coords():
    dg().update()
    ev = human.evaluated_get(dg())
    m = ev.to_mesh()
    c = [v.co.copy() for v in m.vertices]
    ev.to_mesh_clear()
    return c


# MPFB's rig loader (strategies, scale handling). Its own position_info comes from a shape-key
# "from mix" snapshot, which does not reliably reflect the macro just set in background mode, so
# fit_heads() feeds it the evaluated vertices instead, rebuilding the joint cubes the same way
# Rig.build_basemesh_position_info does (cube centre = mean of the "joint*" vertex group).
bpy.context.view_layer.objects.active = human
fitter = Rig.from_json_file_and_basemesh(rig_file, human)
joint_groups = {g.index: g.name for g in human.vertex_groups if "joint" in g.name}
joint_members = {n: [] for n in joint_groups.values()}
for v in human.data.vertices:
    for g in v.groups:
        if g.group in joint_groups:
            joint_members[joint_groups[g.group]].append(v.index)
# every CUBE strategy must resolve, otherwise MPFB would silently use default_position
_need = {i[e]["cube_name"] for i in fitter.rig_definition.values() for e in ("head", "tail")
         if i[e]["strategy"] == "CUBE"}
_missing = sorted(n for n in _need if not joint_members.get(n))
assert not _missing, "joint cubes missing (detailed_helpers off?): %s" % _missing[:10]
print("BUILD joint cubes", len(joint_members), "needed", len(_need))


def fit_heads(c):
    """Bone heads (basemesh space) for vertex positions c, via MPFB's rig fitting strategies."""
    fitter.position_info = {
        "vertices": [list(p) for p in c],
        "cubes": {n: list(sum((c[i] for i in idx), Vector()) / len(idx)) for n, idx in joint_members.items() if idx},
    }
    return {name: Vector(fitter.get_best_location_from_strategy(info["head"]))
            for name, info in fitter.rig_definition.items()}


def set_macro(name, value):
    HumanObjectProperties.set_value(name, value, entity_reference=human)
    TargetService.reapply_macro_details(human)


def to_gltf(v):
    return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


def body_extent(c):
    zs = [c[i].z for i in body_idx]
    return min(zs), max(zs)


base = coords()
base_heads = fit_heads(base)
base_lo, base_hi = body_extent(base)
print("BUILD base verts", len(base), "body verts", len(body_idx), "bones fitted", len(base_heads),
      "height %.4f m" % (base_hi - base_lo))

samples, offsets, raw = {}, {}, {}
for key, prop, val in MACRO_MORPHS:
    set_macro(prop, val)
    c = coords()
    heads = fit_heads(c)
    lo, hi = body_extent(c)
    dz = (base_lo - lo) if not args.no_ground_fix else 0.0
    shift = Vector((0.0, 0.0, dz))
    samples[key] = [p + shift for p in c]
    raw[key] = (np.array([tuple(p) for p in c]), dz)       # full basemesh (incl. helpers), for asset fitting
    offsets[key] = {b: heads[b] + shift - base_heads[b] for b in base_heads}
    mx = max(offsets[key].items(), key=lambda kv: kv[1].length)
    print("BUILD sample %-20s height %.4f m (%+.4f)  ground shift %+.4f  max bone offset %.4f (%s)"
          % (key, hi - lo, (hi - lo) - (base_hi - base_lo), dz, mx[1].length, mx[0]))
    set_macro(prop, NEUTRAL)

# neutral must be restored exactly, otherwise every delta is off
drift = max((a - b).length for a, b in zip(base, coords()))
assert drift < 1e-5, "neutral not restored, drift %g" % drift

# bake neutral, drop MPFB's macro shape keys, add ours as plain morphs
TargetService.bake_targets(human)
if human.data.shape_keys:
    human.shape_key_clear()
human.shape_key_add(name="Basis", from_mix=False)
for key, _, _ in MACRO_MORPHS:
    sk = human.shape_key_add(name=key, from_mix=False)
    sk.slider_min, sk.slider_max = 0.0, 1.0
    for i, c in enumerate(samples[key]):
        sk.data[i].co = c
print("BUILD morphs", len(MACRO_MORPHS), [k.name for k in human.data.shape_keys.key_blocks])

# rig with weights on the full mesh (weights are indexed on the complete basemesh)
bpy.context.view_layer.objects.active = human
rig = HumanService.add_builtin_rig(human, RIG, import_weights=True)
print("BUILD rig", rig.name, len(rig.data.bones), "bones")

# add_builtin_rig fits the bones from a shape-key "from mix" snapshot, which in background mode
# was measured to be stale (bones off by up to 5 cm vs the actual neutral mesh). Refit the edit
# bones (heads, tails, roll strategies) with MPFB's own reposition_edit_bone() on the true neutral
# vertices, so the bind pose and the sidecar come from the same data.
fit_heads(base)  # loads neutral position_info into the fitter
fitter.armature_object = rig
bpy.context.view_layer.objects.active = rig
fitter.reposition_edit_bone()
bpy.context.view_layer.objects.active = human

# bind pose from the real armature; must agree with our neutral fit
mw = rig.matrix_world
bind = {b.name: mw @ b.head_local for b in rig.data.bones}
missing = sorted(set(bind) ^ set(base_heads))
assert not missing, "bone set mismatch between rig and fit: %s" % missing
fit_err = max((bind[n] - base_heads[n]).length for n in bind)
print("BUILD bind vs neutral fit max error %.2e m" % fit_err)
for n in ("Root", "pelvis", "head", "foot_l", "hand_r"):
    if n in bind:
        print("BUILD bind %-7s blender (%.3f, %.3f, %.3f)" % ((n,) + tuple(bind[n])))
lo_bone = min(bind.values(), key=lambda p: p.z).z
assert base_lo - 0.05 < lo_bone < base_hi, "skeleton not inside the mesh (lowest head z %.3f)" % lo_bone
assert fit_err < 1e-4, "neutral refit does not match the created rig"

# ---- MakeHuman system assets (eyes, brows, lashes, teeth, tongue, hair) ---------------------------
# Added AFTER the rig (MPFB interpolates their bone weights from the basemesh) and BEFORE the helper
# geometry is deleted (the .mhclo vertex references also point at helper vertices, e.g. the hair helper).
# Each asset vertex = sum(w_i * basemesh_vertex_i) + offset * (per-axis scale measured on the basemesh),
# i.e. MPFB's ClothesService.fit_clothes_to_human. The same formula is evaluated on every morph sample,
# so every asset carries the same 12 morph targets as the body.
BASE_NP = np.array([tuple(p) for p in base])
morph_names = [k for k, _, _ in MACRO_MORPHS]


class MhcloFit:
    """Vectorised MPFB mhclo fitting (see ClothesService.fit_clothes_to_human)."""

    def __init__(self, mh):
        n = len(mh.verts)
        self.idx = np.array([mh.verts[i]["verts"] for i in range(n)], dtype=np.int64)
        self.w = np.array([mh.verts[i]["weights"] for i in range(n)], dtype=np.float64)
        self.off = np.array([tuple(mh.verts[i]["offsets"]) for i in range(n)], dtype=np.float64)
        assert mh.x_scale and mh.y_scale and mh.z_scale, "mhclo without x/y/z_scale is not supported"
        self.xs, self.ys, self.zs = mh.x_scale, mh.y_scale, mh.z_scale

    def __call__(self, hv):
        xs = abs(hv[self.xs[0], 0] - hv[self.xs[1], 0]) / self.xs[2]
        ys = abs(hv[self.ys[0], 2] - hv[self.ys[1], 2]) / self.ys[2]
        zs = abs(hv[self.zs[0], 1] - hv[self.zs[1], 1]) / self.zs[2]
        return (self.w[:, :, None] * hv[self.idx]).sum(1) + self.off * np.array([xs, zs, ys])


def check_license(pack_key, path):
    """Every shipped asset must be CC0: the pack metadata AND the file header must say so."""
    meta = PACK.get(pack_key)
    assert meta and meta.get("license") == "CC0", \
        "asset %s: license %s (only CC0 is shipped)" % (pack_key, meta and meta.get("license"))
    with open(path, encoding="utf-8", errors="replace") as f:
        head = f.read(600)
    assert "released as CC0" in head, "asset %s: %s header does not state CC0" % (pack_key, path)
    LICENSES.append({"asset": pack_key, "type": meta.get("type"),
                     "file": os.path.relpath(path, args.assets).replace("\\", "/"),
                     "license": "CC0", "author": meta.get("author"), "source": meta.get("source")})


def set_weights(obj, allowed=None, rigid=None):
    """rigid='head': every vertex 100 % on that bone. allowed={bones}: drop other groups, renormalise."""
    if rigid:
        for g in list(obj.vertex_groups):
            obj.vertex_groups.remove(g)
        obj.vertex_groups.new(name=rigid).add(list(range(len(obj.data.vertices))), 1.0, 'REPLACE')
        return
    head = obj.vertex_groups.get("head") or obj.vertex_groups.new(name="head")
    names = {g.index: g.name for g in obj.vertex_groups}
    for v in obj.data.vertices:
        tot = sum(g.weight for g in v.groups if names.get(g.group) in allowed)
        if tot <= 1e-6:
            head.add([v.index], 1.0, 'REPLACE')
            continue
        for g in v.groups:
            if names.get(g.group) in allowed:
                g.weight = g.weight / tot
    for g in list(obj.vertex_groups):
        if g.name not in allowed:
            obj.vertex_groups.remove(g)


def add_asset(name, pack_key, rel, atype):
    f = os.path.join(args.assets, rel)
    check_license(pack_key, f)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = human
    obj = HumanService.add_mhclo_asset(f, human, asset_type=atype, subdiv_levels=0, material_type="NONE",
                                       set_up_rigging=True, interpolate_weights=True,
                                       import_subrig=False, import_weights=False)
    mh = Mhclo()
    mh.load(f)
    fit = MhcloFit(mh)
    neutral = fit(BASE_NP)
    n = len(obj.data.vertices)
    assert n == len(neutral), "%s: %d verts vs %d mhclo refs" % (name, n, len(neutral))
    cur = np.empty(n * 3)
    obj.data.vertices.foreach_get("co", cur)
    # MPFB fits from a "from mix" shape-key snapshot of the basemesh, which is stale in background mode once
    # our morph keys exist (same issue as add_builtin_rig, see below); our fit uses the true neutral vertices.
    # (Checked separately: on a basemesh without extra shape keys both fits agree to < 1e-6 m.)
    err = float(np.abs(cur.reshape(-1, 3) - neutral).max())
    obj.data.vertices.foreach_set("co", neutral.ravel())
    obj.shape_key_add(name="Basis", from_mix=False)
    for key in morph_names:
        hv, dz = raw[key]
        co = fit(hv) + np.array([0.0, 0.0, dz])
        sk = obj.shape_key_add(name=key, from_mix=False)
        sk.slider_min, sk.slider_max = 0.0, 1.0
        sk.data.foreach_set("co", co.ravel())
    for md in list(obj.modifiers):
        if md.type != 'ARMATURE':
            obj.modifiers.remove(md)
    obj.name = obj.data.name = name
    obj.data.materials.clear()
    print("BUILD asset %-16s %-12s verts %5d  faces %5d  MPFB snapshot diff %.1e m" % (name, pack_key, n, len(obj.data.polygons), err))
    return obj


def image_node(nt, path, non_color=False):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = bpy.data.images.load(path, check_existing=True)
    if non_color:
        n.image.colorspace_settings.name = "Non-Color"
    return n


def make_material(name, tex_path=None, alpha=False, normal_path=None, color=(1, 1, 1, 1), alpha_value=None):
    """Principled material the glTF exporter understands; factors/extras are patched after export."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    if tex_path:
        im = image_node(nt, tex_path)
        nt.links.new(im.outputs["Color"], b.inputs["Base Color"])
        if alpha:
            nt.links.new(im.outputs["Alpha"], b.inputs["Alpha"])
    if alpha_value is not None:
        b.inputs["Alpha"].default_value = alpha_value
    if normal_path:
        im = image_node(nt, normal_path, non_color=True)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(im.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    return mat


def tint_spec(hex_default, gain, **kw):
    lin = tex.hex_to_lin(hex_default) * gain
    if lin.max() > 1.0:
        print("BUILD note: default tint %s x gain %.2f = %s > 1, clamped in baseColorFactor" % (hex_default, gain, lin))
    d = {"baseColorFactor": [float(min(1.0, v)) for v in lin] + [1.0],
         "extras": {"tint": {"gain": round(float(gain), 4), "default": hex_default}}}
    d.update(kw)
    return d


PACK, LICENSES, MATERIALS = {}, [], {}
face_objs, hair_objs = [], {}
if not args.no_assets:
    pack_json = os.path.join(args.assets, "packs", "makehuman_system_assets.json")
    assert os.path.isfile(pack_json), ("MakeHuman assets missing in %s: run python blender/tools/fetch_mh_assets.py "
                                       "(or pass --no-assets)" % args.assets)
    with open(pack_json, encoding="utf-8") as f:
        PACK = json.load(f)
    T = args.textures
    os.makedirs(T, exist_ok=True)

    def A(*p):
        return os.path.join(args.assets, *p)

    # --- textures (see blender/cc_textures.py for the normalisation / tint contract) ---
    check_license(SKIN, A("skins", SKIN, SKIN + ".mhmat"))
    skin_src = A("skins", SKIN, sorted(fn for fn in os.listdir(A("skins", SKIN)) if fn.endswith(".png"))[0])
    skin_gain, skin_mean = tex.skin_albedo(skin_src, os.path.join(T, "skin_albedo.jpg"))
    tex.skin_normal(skin_src, os.path.join(T, "skin_normal.jpg"))
    check_license(EYE_TEX, A("eyes", "materials", EYE_TEX + ".mhmat"))
    iris_gain, eye_c, iris_r, ring_r = tex.eye(A("eyes", "materials", EYE_TEX + "_eye.png"), os.path.join(T, "eye.jpg"))
    brow_gain = tex.tintable_alpha(A("eyebrows", BROWS, BROWS + ".png"), os.path.join(T, "eyebrow.png"), 512, k=0.55)
    lash_gain = tex.tintable_alpha(A("eyelashes", LASHES, LASHES + ".png"), os.path.join(T, "eyelash.png"), 512, k=0.55)
    tex.plain(A("teeth", "teeth_base", "teeth.png"), os.path.join(T, "teeth.jpg"), 512)
    tex.plain(A("tongue", "tongue01", "tongue01_diffuse.png"), os.path.join(T, "tongue.jpg"), 512)
    print("BUILD textures skin gain %.3f (mean lin %s) iris gain %.3f eye centres %s brow %.3f lash %.3f"
          % (skin_gain, np.round(skin_mean, 3).tolist(), iris_gain, np.round(eye_c, 4).tolist(), brow_gain, lash_gain))

    # --- face assets ---
    eyes = add_asset("Eyes", "high-poly", "eyes/high-poly/high-poly.mhclo", "Eyes")
    brows = add_asset("Eyebrows", BROWS, "eyebrows/%s/%s.mhclo" % (BROWS, BROWS), "Eyebrows")
    lashes = add_asset("Eyelashes", LASHES, "eyelashes/%s/%s.mhclo" % (LASHES, LASHES), "Eyelashes")
    teeth = add_asset("Teeth", "teeth_base", "teeth/teeth_base/teeth_base.mhclo", "Teeth")
    tongue = add_asset("Tongue", "tongue01", "tongue/tongue01/tongue01.mhclo", "Tongue")
    face_objs = [eyes, brows, lashes, teeth, tongue]
    for o in face_objs:                       # rigid on the head: no neck bone may pull them apart
        set_weights(o, rigid="head")

    # eye: split faces into sclera (0) / iris (1, runtime tint) / cornea (2, transparent) by UV
    eyes.data.materials.append(make_material("Eye", os.path.join(T, "eye.jpg")))
    eyes.data.materials.append(make_material("Iris", os.path.join(T, "eye.jpg")))
    eyes.data.materials.append(make_material("Cornea", alpha_value=0.1))
    uvl = eyes.data.uv_layers[0].data
    counts = [0, 0, 0]
    for poly in eyes.data.polygons:
        uvs = [uvl[li].uv for li in poly.loop_indices]
        cu = sum(u.x for u in uvs) / len(uvs)
        cv = sum(u.y for u in uvs) / len(uvs)
        if cu > 0.8 and cv < 0.2:              # MakeHuman eye UV: the cornea shell maps to the empty corner
            poly.material_index = 2
        elif all(min(float(np.hypot(u.x - c[0], u.y - c[1])) for c in eye_c) <= iris_r + 18 / 1024 for u in uvs):
            poly.material_index = 1            # all corners inside the iris incl. the dark limbal ring
        else:
            poly.material_index = 0
        counts[poly.material_index] += 1
    print("BUILD eye faces sclera/iris/cornea", counts)
    brows.data.materials.append(make_material("Eyebrow", os.path.join(T, "eyebrow.png"), alpha=True))
    lashes.data.materials.append(make_material("Eyelash", os.path.join(T, "eyelash.png"), alpha=True))
    teeth.data.materials.append(make_material("Teeth", os.path.join(T, "teeth.jpg")))
    tongue.data.materials.append(make_material("Tongue", os.path.join(T, "tongue.jpg")))

    MATERIALS.update({
        "Skin": tint_spec(DEFAULTS["skin"], skin_gain, roughness=0.52, metallic=0.0, normalScale=0.6, doubleSided=True),
        "Eye": {"roughness": 0.25, "metallic": 0.0, "doubleSided": False},
        "Iris": tint_spec(DEFAULTS["eyes"], iris_gain, roughness=0.3, metallic=0.0, doubleSided=False),
        "Cornea": {"baseColorFactor": [1, 1, 1, 0.08], "alphaMode": "BLEND", "roughness": 0.03, "metallic": 0.0},
        "Eyebrow": tint_spec(DEFAULTS["brows"], brow_gain, alphaMode="MASK", alphaCutoff=0.3, roughness=0.6,
                             metallic=0.0, doubleSided=True),
        "Eyelash": tint_spec(DEFAULTS["lashes"], lash_gain, alphaMode="MASK", alphaCutoff=0.3, roughness=0.6,
                             metallic=0.0, doubleSided=True),
        "Teeth": {"roughness": 0.25, "metallic": 0.0},
        "Tongue": {"roughness": 0.35, "metallic": 0.0},
    })

    # --- hair styles: one object each, exported to their own GLB below ---
    for hid, labels in HAIR_STYLES:
        o = add_asset("Hair_" + hid, hid, "hair/%s/%s.mhclo" % (hid, hid), "Hair")
        set_weights(o, allowed=HAIR_BONES)
        src = sorted(fn for fn in os.listdir(A("hair", hid)) if fn.endswith("_diffuse.png"))[0]
        gain = tex.tintable_alpha(A("hair", hid, src), os.path.join(T, "hair_%s.png" % hid), 1024, k=0.5)
        o.data.materials.append(make_material("Hair_" + hid, os.path.join(T, "hair_%s.png" % hid), alpha=True))
        MATERIALS["Hair_" + hid] = tint_spec(DEFAULTS["hair"], gain, alphaMode="MASK", alphaCutoff=0.35,
                                            roughness=0.62, metallic=0.0, doubleSided=True)
        hair_objs[hid] = o
    for o in face_objs:
        o["cc_export"] = "base"
    for o in hair_objs.values():
        o["cc_export"] = "hair"

# strip helper geometry: keep only the 'body' vertex group
bpy.ops.object.select_all(action='DESELECT')
human.select_set(True); bpy.context.view_layer.objects.active = human
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(human.data)
dl = bm.verts.layers.deform.verify()
bpy.ops.mesh.select_all(action='DESELECT')
for v in bm.verts:
    v.select = body_gi not in v[dl]
bmesh.update_edit_mesh(human.data)
bpy.ops.mesh.delete(type='VERT')
bpy.ops.object.mode_set(mode='OBJECT')
print("BUILD final verts", len(human.data.vertices))

# skin material: MakeHuman CC0 skin texture, normalised for runtime tinting (see blender/cc_textures.py)
if args.no_assets:
    mat = bpy.data.materials.new("Skin"); mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.8, 0.6, 0.5, 1); b.inputs["Roughness"].default_value = 0.6
else:
    mat = make_material("Skin", os.path.join(args.textures, "skin_albedo.jpg"),
                        normal_path=os.path.join(args.textures, "skin_normal.jpg"))
human.data.materials.clear(); human.data.materials.append(mat)
human.name = "Body"; rig.name = "Armature"
human["cc_export"] = "base"

GLTF_OPTS = dict(export_format='GLB', use_selection=True, export_morph=True, export_skins=True,
                 export_animations=False, export_apply=False, export_yup=True, export_image_format='AUTO')


def export(path, objs, **kw):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=path, **dict(GLTF_OPTS, **kw))
    g, b = read_glb(path)
    patched = patch_materials(g, MATERIALS)
    write_glb(path, g, b)
    print("BUILD exported %s  %d bytes  meshes %s  materials patched %s"
          % (os.path.basename(path), os.path.getsize(path), [m["name"] for m in g.get("meshes", [])], patched))


# base GLB: body + face assets (+ rig). Hair is exported separately (one small GLB per style, loaded on demand).
export(args.out, [human, rig] + face_objs)

out_dir = os.path.dirname(args.out)
if hair_objs:
    manifest = {"version": 1, "default": HAIR_DEFAULT, "defaultColor": DEFAULTS["hair"], "styles": []}
    for hid, labels in HAIR_STYLES:
        fn = "hair_%s.glb" % hid
        # hair morph normals are not worth the bytes (cards; the base normals are fine)
        export(os.path.join(out_dir, fn), [hair_objs[hid], rig], export_morph_normal=False)
        manifest["styles"].append({"id": hid, "file": fn, "label": labels, "mesh": "Hair_" + hid,
                                   "bytes": os.path.getsize(os.path.join(out_dir, fn)),
                                   "license": "CC0", "source": "MakeHuman system assets: hair/" + hid})
    with open(os.path.join(out_dir, "hair.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print("BUILD hair manifest", [s["id"] for s in manifest["styles"]])
if LICENSES:
    with open(os.path.join(os.path.dirname(args.blend), "asset_licenses.json"), "w", encoding="utf-8") as f:
        json.dump(LICENSES, f, indent=1)
    print("BUILD licenses verified (CC0):", ", ".join(l["asset"] for l in LICENSES))

# offsets are vectors, so only the rotation part of the armature matrix applies
rot = mw.to_3x3()
sidecar = {
    "version": 1,
    "rig": RIG,
    "bones": {n: to_gltf(p) for n, p in bind.items()},
    "morphs": {k: {n: to_gltf(rot @ o) for n, o in offs.items()} for k, offs in offsets.items()},
}
with open(args.joints, "w", encoding="utf-8") as f:
    json.dump(sidecar, f, separators=(",", ":"))
print("BUILD joints", args.joints, len(sidecar["bones"]), "bones", len(sidecar["morphs"]), "morphs")

bpy.context.scene["cc_materials"] = json.dumps(MATERIALS)   # bake_clips.py applies the same glTF material patch
bpy.ops.wm.save_as_mainfile(filepath=args.blend)
print("BUILD done", args.out)
