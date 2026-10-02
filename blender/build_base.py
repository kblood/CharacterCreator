"""Build the base body: MPFB human + game_engine rig + linearised macro morph targets,
exported as GLB, plus a joints sidecar so the skeleton can follow the morphs at runtime.

Run (from the project root, PowerShell):
    <blender> -b --python blender/build_base.py -- [out.glb] [--blend PATH] [--no-ground-fix]

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
from glbutil import read_glb, write_glb, patch_materials, patch_mesh_extras, embed_textures, quantize_morphs  # noqa: E402

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
    # breast macros (MakeHuman breast/female-<age>-<muscle>-<weight>-<cup>-<firmness> targets, CC0). MPFB applies them
    # for any body with a female component and does NOT scale them by gender (targetservice.py: "there are no male
    # complementary targets"), so the delta sampled at neutral gender equals the one at gender 0 (probe: gender x
    # cupsize interaction 0.0 mm). The runtime gates them with the female weight x adult (web/character.js).
    ("breast_cup_min", "cupsize", 0.0), ("breast_cup_max", "cupsize", 1.0),
    ("breast_firm_min", "firmness", 0.0), ("breast_firm_max", "firmness", 1.0),
]
MACRO_VALUE = {k: (p, v) for k, p, v in MACRO_MORPHS}

# Face-shape morphs from MakeHuman detail targets (MPFB data/targets, CC0 like the macros; see LICENSE-NOTES.md).
# (stem, negative-side targets, positive-side targets); "L/" expands to the l- and r- file of a sided target.
# Each becomes face_<stem>_decr / face_<stem>_incr (one bipolar slider in web/character.js FACE_SLIDERS).
FACE_TARGETS = [
    ("nose_width", ["nose/nose-scale-horiz-decr"], ["nose/nose-scale-horiz-incr"]),
    ("nose_length", ["nose/nose-scale-vert-decr"], ["nose/nose-scale-vert-incr"]),
    ("nose_height", ["nose/nose-trans-down"], ["nose/nose-trans-up"]),
    ("jaw_width", ["chin/chin-bones-decr"], ["chin/chin-bones-incr"]),
    ("chin", ["chin/chin-prominent-decr"], ["chin/chin-prominent-incr"]),
    ("cheekbones", ["L/cheek/cheek-bones-decr"], ["L/cheek/cheek-bones-incr"]),
    ("eye_size", ["L/eyes/eye-scale-decr"], ["L/eyes/eye-scale-incr"]),
    ("eye_spacing", ["L/eyes/eye-trans-in"], ["L/eyes/eye-trans-out"]),
    ("eye_tilt", ["L/eyes/eye-corner2-down"], ["L/eyes/eye-corner2-up"]),
    ("lips", ["mouth/mouth-upperlip-volume-decr", "mouth/mouth-lowerlip-volume-decr"],
             ["mouth/mouth-upperlip-volume-incr", "mouth/mouth-lowerlip-volume-incr"]),
    ("mouth_width", ["mouth/mouth-scale-horiz-decr"], ["mouth/mouth-scale-horiz-incr"]),
    ("ear_size", ["L/ears/ear-scale-decr"], ["L/ears/ear-scale-incr"]),
    ("forehead", ["forehead/forehead-scale-vert-decr"], ["forehead/forehead-scale-vert-incr"]),
]
# Eyelid closure for blinking (MakeHuman expression units, caucasian variant; the skin texture is caucasian too).
EXPR_TARGETS = [("blink_left", ["expression/units/caucasian/eye-left-closure"]),
                ("blink_right", ["expression/units/caucasian/eye-right-closure"])]
# Gaze: rigid rotation of each eyeball (Eyes mesh only, zero on every other mesh), degrees at weight 1.
LOOK_MORPHS = [("look_left", "yaw", 30.0), ("look_right", "yaw", -30.0),
               ("look_up", "pitch", 25.0), ("look_down", "pitch", -25.0)]
# Corrective morphs for macro interactions: sample(A and B together) - neutral - delta(A) - delta(B).
# Runtime weight = weight(A) * weight(B) (web/character.js). Chosen by measured interaction size
# (probe: gender x age up to 65 mm, weight x muscle up to 81 mm, gender x muscle 24 mm, gender x weight 13 mm).
CORRECTIVE_PAIRS = [("gender", "age"), ("weight", "muscle"), ("gender", "muscle"), ("gender", "weight"),
                    # breast pairs (probe, max over the 4 corners): cupsize x firmness 52.7 mm, cupsize x age 36.6 mm,
                    # cupsize x muscle 17.2 mm, firmness x age 16.6 mm (MakeHuman has one breast target per
                    # age/muscle/weight/cup/firmness combination). cupsize x weight (<= 14.5 mm), x height /
                    # proportions / gender (0 mm) stay linear.
                    ("cupsize", "firmness"), ("cupsize", "age"), ("cupsize", "muscle"), ("firmness", "age")]
# Breast detail morphs (MakeHuman breast/ detail targets, CC0): bdet_<stem>_decr / _incr, one bipolar slider each in
# web/character.js (group 'breast', gated like the breast macros). Same loading as FACE_TARGETS.
BREAST_TARGETS = [
    ("breast_dist", ["breast/breast-dist-decr"], ["breast/breast-dist-incr"]),
    ("breast_point", ["breast/breast-point-decr"], ["breast/breast-point-incr"]),
    ("breast_height", ["breast/breast-trans-down"], ["breast/breast-trans-up"]),
]
# Breast physics (web/breastphysics.js, docs/BREAST_PHYSICS.md): generated secondary-motion morphs (project-original,
# no third-party data). The breast tissue weight W (0..1 per basemesh vertex, incl. helper geometry so every
# fitted garment follows) is |delta(breast_cup_max)| normalised, i.e. the tissue MakeHuman's cup target moves; the
# morph translates it by DYN_AMPLITUDE * W along a fixed axis (Blender space: +Z up, -Y forward, +X the character's
# left). Runtime weights 0..1 come from a damped spring driven by the chest acceleration; no joint offsets.
DYN_AMPLITUDE = 0.02
DYN_MORPHS = [("dyn_breast_up", (0, 0, 1)), ("dyn_breast_down", (0, 0, -1)), ("dyn_breast_left", (1, 0, 0)),
              ("dyn_breast_right", (-1, 0, 0)), ("dyn_breast_fwd", (0, -1, 0)), ("dyn_breast_back", (0, 1, 0))]
# glTF mesh extras ccJiggle on Body (contract for other engines; values == web/breastphysics.js BREAST_PHYSICS)
JIGGLE = {"version": 1, "doc": "docs/BREAST_PHYSICS.md", "driverBone": "spine_03", "amplitude": DYN_AMPLITUDE,
          "morphs": {"up": "dyn_breast_up", "down": "dyn_breast_down", "left": "dyn_breast_left",
                     "right": "dyn_breast_right", "forward": "dyn_breast_fwd", "back": "dyn_breast_back"},
          "frequencyHz": 2.6, "dampingRatio": 0.4, "maxDisplacement": 0.012, "gain": 0.75,
          "maxWeight": 0.75, "upMaxWeight": 0.6, "backMaxWeight": 0.35,
          "supportStiffness": 2, "supportDamping": 0.5, "supportTravel": 0.5,
          "gate": "female weight x clamp(1 + age, 0, 1) (web/character.js breastGate)"}


def _expand(paths):
    out = []
    for p in paths:
        if p.startswith("L/"):
            cat, name = p[2:].split("/", 1)
            out += ["%s/l-%s" % (cat, name), "%s/r-%s" % (cat, name)]
        else:
            out.append(p)
    return out


FACE_MORPHS = []
for _stem, _neg, _pos in FACE_TARGETS:
    FACE_MORPHS += [("face_%s_decr" % _stem, _expand(_neg)), ("face_%s_incr" % _stem, _expand(_pos))]
BDET_MORPHS = []
for _stem, _neg, _pos in BREAST_TARGETS:
    BDET_MORPHS += [("bdet_%s_decr" % _stem, _expand(_neg)), ("bdet_%s_incr" % _stem, _expand(_pos))]
CORR_MORPHS = []
for _a, _b in CORRECTIVE_PAIRS:
    for _ka in [k for k, p, _ in MACRO_MORPHS if p == _a]:
        for _kb in [k for k, p, _ in MACRO_MORPHS if p == _b]:
            CORR_MORPHS.append(("corr_%s__%s" % (_ka, _kb), _ka, _kb))
# every mesh (body, face parts, hair) carries exactly these targets, in this order
MORPH_KIND = {}
for _k, _, _ in MACRO_MORPHS:
    MORPH_KIND[_k] = "macro"
for _k, _ in FACE_MORPHS:
    MORPH_KIND[_k] = "face"
for _k, _ in EXPR_TARGETS:
    MORPH_KIND[_k] = "expr"
for _k, _, _ in LOOK_MORPHS:
    MORPH_KIND[_k] = "look"
for _k, _, _ in CORR_MORPHS:
    MORPH_KIND[_k] = "corr"
for _k, _ in BDET_MORPHS:
    MORPH_KIND[_k] = "bdet"
for _k, _ in DYN_MORPHS:
    MORPH_KIND[_k] = "dyn"
CORR_PARTS = {k: (a, b) for k, a, b in CORR_MORPHS}
TARGET_FILES = dict(FACE_MORPHS + EXPR_TARGETS + BDET_MORPHS)
DYN_AXIS = dict(DYN_MORPHS)
# |delta| below this (m) is written as exact 0 (sparse glTF)
ZERO_BELOW = {"face": 5e-5, "expr": 5e-5, "corr": 2e-4, "bdet": 5e-5, "dyn": 5e-5}


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
    ("short04", {"da": "Kort, glat", "en": "Short, sleek"}),
    ("bob01", {"da": "Page, lang", "en": "Bob, long"}),
    ("afro01", {"da": "Afro", "en": "Afro"}),
]
# per style: how much of the painted low-frequency lighting (baked highlights) is flattened, 0..1
HAIR_FLATTEN = {"braid01": 0.85, "bob02": 0.6}
HAIR_FLATTEN_DEFAULT = 0.45
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
    p.add_argument("--no-clothing", action="store_true", help="skip the garments (blender/cc_clothing.py)")
    p.add_argument("--textures",default=os.path.join(PROJECT, "build", "textures"), help="prepared texture files")
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

MPFB_TARGETS = LocationService.get_mpfb_data("targets")
BASE_ARR = np.array([tuple(p) for p in base])


def sample_now():
    c = coords()
    heads = fit_heads(c)
    lo, hi = body_extent(c)
    dz = (base_lo - lo) if not args.no_ground_fix else 0.0
    arr = np.array([tuple(p) for p in c]) + np.array([0.0, 0.0, dz])
    return arr, heads, dz, hi - lo


def with_targets(files):
    """Load MakeHuman target files at weight 1 on top of the neutral human, sample, remove them again."""
    names = []
    for i, rel in enumerate(files):
        full = os.path.join(MPFB_TARGETS, rel + ".target.gz")
        assert os.path.isfile(full), "target missing: %s" % full
        n = "cc_probe_%d" % i
        TargetService.load_target(human, full, weight=1.0, name=n)
        names.append(n)
    s = sample_now()
    for n in names:
        human.shape_key_remove(human.data.shape_keys.key_blocks[n])
    return s


# delta[key]: (n_basemesh, 3) vertex offsets incl. helper geometry (for the asset fit, see add_asset);
# raw[key] = (absolute sampled coordinates incl. ground shift, dz) for the MHCLO fit of the parts;
# offsets[key]: bone head offsets (joints sidecar)
delta, offsets, raw = {}, {}, {}
DYN_W = None                                              # breast tissue weight per basemesh vertex (dyn morphs)


def breast_tissue_weight():
    """0..1 per basemesh vertex: how much of the breast tissue a vertex is (see DYN_MORPHS). |delta(cup_max)| over
    60 % of its body maximum saturates at 1, smoothstepped so the chest wall and the rim fade in softly."""
    dc = np.linalg.norm(delta["breast_cup_max"], axis=1)
    t = np.clip(dc / (0.6 * dc[body_idx].max()), 0, 1)
    w = t * t * (3 - 2 * t)
    w[w < 0.02] = 0.0
    return w


for key, kind in MORPH_KIND.items():
    if kind == "look":
        continue                                          # eyes only, computed from the Eyes mesh below
    if kind == "dyn":
        if DYN_W is None:
            DYN_W = breast_tissue_weight()
        arr = BASE_ARR + DYN_AMPLITUDE * DYN_W[:, None] * np.array(DYN_AXIS[key], float)
        heads, dz, h = base_heads, 0.0, base_hi - base_lo
    elif kind == "macro":
        prop, val = MACRO_VALUE[key]
        set_macro(prop, val)
        arr, heads, dz, h = sample_now()
        set_macro(prop, NEUTRAL)
    elif kind == "corr":
        (pa, va), (pb, vb) = MACRO_VALUE[CORR_PARTS[key][0]], MACRO_VALUE[CORR_PARTS[key][1]]
        set_macro(pa, va)
        set_macro(pb, vb)
        arr, heads, dz, h = sample_now()
        set_macro(pa, NEUTRAL)
        set_macro(pb, NEUTRAL)
    else:
        arr, heads, dz, h = with_targets(TARGET_FILES[key])
    raw[key] = (arr - np.array([0.0, 0.0, dz]), dz)
    d = arr - BASE_ARR
    offs = {b: heads[b] + Vector((0.0, 0.0, dz)) - base_heads[b] for b in base_heads}
    if kind == "corr":
        a, b = CORR_PARTS[key]
        d = d - delta[a] - delta[b]
        offs = {n: offs[n] - offsets[a][n] - offsets[b][n] for n in offs}
    if kind in ZERO_BELOW:
        d[np.linalg.norm(d, axis=1) < ZERO_BELOW[kind]] = 0.0
    delta[key] = d
    if kind in ("expr", "dyn"):
        offs = {}                                         # eyelids / breast motion do not move joints
    elif kind in ("face", "corr", "bdet"):
        offs = {n: o for n, o in offs.items() if o.length > 1e-4}
    offsets[key] = offs
    nb = np.linalg.norm(d[body_idx], axis=1)
    mx = max(offs.items(), key=lambda kv: kv[1].length) if offs else ("-", Vector())
    print("BUILD sample %-34s %-5s height %.4f m (%+.4f)  ground %+.4f  max |d| %.1f mm  verts moved %5d  max bone %.4f (%s)"
          % (key, kind, h, h - (base_hi - base_lo), dz, nb.max() * 1000, int((nb > 0).sum()), mx[1].length, mx[0]))

# neutral must be restored exactly, otherwise every delta is off
drift = max((a - b).length for a, b in zip(base, coords()))
assert drift < 1e-5, "neutral not restored, drift %g" % drift

# bake neutral, drop MPFB's macro shape keys, add ours as plain morphs
TargetService.bake_targets(human)
if human.data.shape_keys:
    human.shape_key_clear()
basis = human.shape_key_add(name="Basis", from_mix=False)
# add the deltas to the stored basis (not to BASE_ARR): the baked mesh differs from the evaluated neutral by
# float noise, which would make every "zero" delta non-zero and defeat sparse export
basis_co = np.empty(len(human.data.vertices) * 3, np.float32)
basis.data.foreach_get("co", basis_co)
basis_co = basis_co.reshape(-1, 3)
print("BUILD basis vs evaluated neutral max diff %.1e m" % float(np.abs(basis_co - BASE_ARR).max()))
morph_names = list(MORPH_KIND)
for key in morph_names:
    sk = human.shape_key_add(name=key, from_mix=False)
    sk.slider_min, sk.slider_max = 0.0, 1.0
    if key in delta:
        sk.data.foreach_set("co", (basis_co + delta[key].astype(np.float32)).ravel())
print("BUILD morphs", len(morph_names), "=", {k: sum(1 for v in MORPH_KIND.values() if v == k)
                                            for k in ("macro", "face", "expr", "look", "corr", "bdet", "dyn")})
if DYN_W is not None:
    print("BUILD breast tissue weight: %d body verts > 0, %d at 1, %d helper verts > 0"
          % (int((DYN_W[body_idx] > 0).sum()), int((DYN_W[body_idx] > 0.99).sum()),
             int((DYN_W > 0).sum() - (DYN_W[body_idx] > 0).sum())))

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
BASE_NP = BASE_ARR


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


_LAST_FIT = [None]


def fit_keys(fit, neutral):
    """Morph deltas of a fitted asset: fit(vertex positions) evaluated on every morph sample (see add_asset)."""
    part_delta = {}
    for key in morph_names:
        kind = MORPH_KIND[key]
        if kind == "look":
            d = np.zeros_like(neutral)                    # set on the Eyes mesh by add_look_morphs()
        else:
            hv, dz = raw[key]
            d = fit(hv) + np.array([0.0, 0.0, dz]) - neutral
            if kind == "corr":
                a, b = CORR_PARTS[key]
                d = d - part_delta[a] - part_delta[b]
            if kind in ZERO_BELOW:
                d[np.linalg.norm(d, axis=1) < ZERO_BELOW[kind]] = 0.0
        part_delta[key] = d
    return part_delta


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
    part_delta = fit_keys(fit, neutral)
    _LAST_FIT[0] = fit
    for key in morph_names:
        sk = obj.shape_key_add(name=key, from_mix=False)
        sk.slider_min, sk.slider_max = 0.0, 1.0
        sk.data.foreach_set("co", (neutral + part_delta[key]).astype(np.float32).ravel())
    for md in list(obj.modifiers):
        if md.type != 'ARMATURE':
            obj.modifiers.remove(md)
    obj.name = obj.data.name = name
    obj.data.materials.clear()
    print("BUILD asset %-16s %-12s verts %5d  faces %5d  MPFB snapshot diff %.1e m" % (name, pack_key, n, len(obj.data.polygons), err))
    return obj


def sphere_fit(p):
    """Least-squares sphere through points p (n, 3): returns (centre, radius)."""
    A = np.c_[2 * p, np.ones(len(p))]
    f = (p * p).sum(1)
    sol = np.linalg.lstsq(A, f, rcond=None)[0]
    c = sol[:3]
    return c, float(np.sqrt(sol[3] + c @ c))


def add_look_morphs(eyes):
    """Gaze morphs on the Eyes mesh: each eyeball (+ its cornea) rotated rigidly about its own centre.
    Centre = sphere fit of the sclera faces (material 0). Blender space: +Z up, the face looks along -Y,
    the character's left is +X. yaw > 0 turns the gaze to the character's left, pitch > 0 up."""
    me = eyes.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    sclera = np.zeros(n, bool)
    for poly in me.polygons:
        if poly.material_index == 0:
            sclera[list(poly.vertices)] = True
    side = co[:, 0] > 0
    centres = {}
    for s in (True, False):
        c, r = sphere_fit(co[sclera & (side == s)])
        centres[s] = c
        print("BUILD eye %s centre %s radius %.4f m" % ("left" if s else "right", np.round(c, 4).tolist(), r))
    kb = me.shape_keys.key_blocks
    for key, axis, deg in LOOK_MORPHS:
        a = np.radians(deg)
        ca, sa = np.cos(a), np.sin(a)
        if axis == "yaw":       # about +Z: (0,-1,0) -> (+sin a, -cos a, 0)
            R = np.array([[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]])
        else:                   # about +X with -a: (0,-1,0) -> (0, -cos a, +sin a)
            R = np.array([[1, 0, 0], [0, ca, sa], [0, -sa, ca]])
        out = co.copy()
        for s, c in centres.items():
            m = side == s
            out[m] = (co[m] - c) @ R.T + c
        kb[key].data.foreach_set("co", out.astype(np.float32).ravel())
    return centres


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def skin_region_masks(eye_centres, size=512):
    """UV-space masks of the body skin, derived from 3D landmarks of the neutral mesh (Blender space, face -Y):
    redfix (knees, elbows, eye surround), scalp (painted stubble -> skin), flush (cheeks, nose, ears),
    areola (runtime: toned down for male bodies), thin (ears, nose: runtime back-light transmission).
    Returns ({name: (size, size) mask}, forehead UV points)."""
    P = BASE_ARR
    nv = len(P)
    in_body = np.zeros(nv, bool)
    in_body[body_idx] = True
    hg = human.vertex_groups["head"].index
    head_w = np.zeros(nv)
    for v in human.data.vertices:
        for g in v.groups:
            if g.group == hg:
                head_w[v.index] = g.weight
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    el, er = eye_centres[True], eye_centres[False]
    xe, ye, ze = (abs(el[0]) + abs(er[0])) / 2, (el[1] + er[1]) / 2, (el[2] + er[2]) / 2
    g = lambda c, s: np.exp(-((P - np.asarray(c)) ** 2).sum(1) / (2 * s * s))
    H = {n: np.array(base_heads[n]) for n in ("calf_l", "calf_r", "lowerarm_l", "lowerarm_r", "upperarm_l")}
    headish = smoothstep(0.3, 0.7, head_w)
    knees = np.maximum(g(H["calf_l"], 0.045), g(H["calf_r"], 0.045))
    elbows = np.maximum(g(H["lowerarm_l"], 0.035), g(H["lowerarm_r"], 0.035))
    # eye surround: centred on the lids (1.2 cm in front of the eyeball centre, face -Y), not the eyeball
    lid = lambda c: (c[0], c[1] - 0.012, c[2])
    eyes_ = np.maximum(g(lid(el), 0.016), g(lid(er), 0.016)) * headish
    redfix = np.clip(np.maximum.reduce([knees, 0.8 * elbows, 0.9 * eyes_]), 0, 1)
    # scalp: above the forehead line, and the back of the head down to the nape hairline (the painted
    # stubble reaches ~10 cm below eye height at the back)
    # (weaker head-weight gate than headish: the nape stubble sits where the head weight already fades)
    scalp = smoothstep(0.05, 0.35, head_w) * np.maximum(
        smoothstep(ze + 0.035, ze + 0.06, z),
        smoothstep(ye + 0.055, ye + 0.09, y) * smoothstep(ze - 0.145, ze - 0.105, z))
    # ears: the laterally outermost head vertices at eye/ear height; nose tip: the most forward midline vertex
    hv = in_body & (head_w > 0.5)
    xmax = np.abs(x[hv & (np.abs(z - ze) < 0.04)]).max()
    ears = headish * smoothstep(xmax - 0.035, xmax - 0.012, np.abs(x)) * smoothstep(ze - 0.07, ze - 0.04, z) \
        * (1 - smoothstep(ze + 0.02, ze + 0.045, z))
    mid = hv & (np.abs(x) < 0.006) & (z < ze) & (z > ze - 0.06)
    nose_tip = P[mid][np.argmin(y[mid])]
    nose = g(nose_tip, 0.012) * headish
    cheeks = np.maximum(g((xe + 0.008, ye - 0.004, ze - 0.035), 0.017), g((-xe - 0.008, ye - 0.004, ze - 0.035), 0.017)) * headish
    flush = np.clip(np.maximum.reduce([0.8 * cheeks, 0.7 * nose, 0.6 * ears]), 0, 1)
    thin = np.clip(np.maximum(ears, 0.6 * nose), 0, 1)
    global SCALP_V
    SCALP_V = scalp                                   # per vertex, for the hairline attribute (add_hair_length_attr)
    sh = H["upperarm_l"][2]
    areola = np.zeros(nv)
    for sgn in (1, -1):
        chest = in_body & (sgn * x > 0.04) & (sgn * x < 0.16) & (z < sh - 0.06) & (z > sh - 0.3)
        tip = P[chest][np.argmin(y[chest])]
        areola = np.maximum(areola, g(tip, 0.017))
    print("BUILD skin landmarks eye y %.3f z %.3f, ear |x| %.3f, nose tip %s, shoulder z %.3f"
          % (ye, ze, xmax, np.round(nose_tip, 3).tolist(), sh))

    me = human.data
    nl = len(me.loops)
    uv = np.empty(nl * 2)
    me.uv_layers[0].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    lv = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get("vertex_index", lv)
    keep = in_body[lv]
    per_v = np.stack([redfix, scalp, flush, areola, thin], 1)
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    tl = np.empty(nt * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("loops", tl)
    tl = tl.reshape(-1, 3)
    tl = tl[keep[tl].all(1)]                         # body skin triangles only (no helper geometry)
    m = tex.raster(uv[tl], per_v[lv[tl]], size=size, radius=2)
    names = ["redfix", "scalp", "flush", "areola", "thin"]
    masks = {n: np.clip(m[..., i], 0, 1) for i, n in enumerate(names)}
    fh = in_body & (np.abs(x) < 0.025) & (z > ze + 0.02) & (z < ze + 0.04) & (y < ye)
    fh_loops = keep & fh[lv]
    return masks, uv[fh_loops]


def add_hair_length_attr(obj):
    """Per-vertex float attribute _CCHAIR = distance (m) of the neutral hair vertex from the nearest head/neck
    skin vertex. Exported as glTF attribute _CCHAIR (three.js: geometry.attributes._cchair); the viewer uses
    it for the root-to-tip colour gradient and to weight the shoulder collision.
    _CCEDGE = distance (m) from the nearest bare (non-scalp) head/neck skin vertex (forehead, temples, nape):
    small at the hairline, where the viewer fades the hair cards out for a soft hairline."""
    from mathutils.kdtree import KDTree
    hg = [human.vertex_groups[n].index for n in ("head", "neck_01") if n in human.vertex_groups]
    skin = [i for i in body_idx if any(g.group in hg and g.weight > 0.3 for g in human.data.vertices[i].groups)]
    n = len(obj.data.vertices)
    co = np.empty(n * 3)
    obj.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    bare = [i for i in skin if SCALP_V[i] < 0.25]
    out = {}
    for attr, verts in (("_CCHAIR", skin), ("_CCEDGE", bare)):
        kd = KDTree(len(verts))
        for k, i in enumerate(verts):
            kd.insert(BASE_ARR[i], k)
        kd.balance()
        dist = np.array([kd.find(p)[2] for p in co], np.float32)
        at = obj.data.attributes.new(attr, 'FLOAT', 'POINT')
        at.data.foreach_set("value", dist)
        out[attr] = dist
    print("BUILD hair %s attrs: length median %.3f max %.3f m, hairline (edge < 1.5 cm) %.1f%% of vertices"
          % (obj.name, float(np.median(out["_CCHAIR"])), float(out["_CCHAIR"].max()),
             100 * float((out["_CCEDGE"] < 0.015).mean())))


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
face_objs, hair_objs, CLOTH = [], {}, None
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
    tex.skin_normal(skin_src, os.path.join(T, "skin_normal.jpg"))
    check_license(EYE_TEX, A("eyes", "materials", EYE_TEX + ".mhmat"))
    iris_gain, eye_c, iris_r, ring_r = tex.eye(A("eyes", "materials", EYE_TEX + "_eye.png"), os.path.join(T, "eye.jpg"),
                                               iris_scale=1.1, sclera_redfix=0.8)
    brow_gain = tex.tintable_alpha(A("eyebrows", BROWS, BROWS + ".png"), os.path.join(T, "eyebrow.png"), 512, k=0.55)
    lash_gain = tex.tintable_alpha(A("eyelashes", LASHES, LASHES + ".png"), os.path.join(T, "eyelash.png"), 512, k=0.55)
    tex.plain(A("teeth", "teeth_base", "teeth.png"), os.path.join(T, "teeth.jpg"), 512)
    tex.plain(A("tongue", "tongue01", "tongue01_diffuse.png"), os.path.join(T, "tongue.jpg"), 512)
    print("BUILD textures iris gain %.3f eye centres %s brow %.3f lash %.3f"
          % (iris_gain, np.round(eye_c, 4).tolist(), brow_gain, lash_gain))

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
    EYE_CENTRES = add_look_morphs(eyes)

    # skin albedo with region fixes (knees/elbows/eye surround, scalp, flush) + runtime region mask texture
    rmasks, forehead_uv = skin_region_masks(EYE_CENTRES)
    skin_gain, skin_mean = tex.skin_albedo(skin_src, os.path.join(T, "skin_albedo.jpg"), fix=(rmasks, forehead_uv))
    tex.regions([rmasks["thin"], rmasks["areola"], rmasks["flush"]], os.path.join(T, "skin_regions.jpg"))
    tex.regions([rmasks["redfix"], rmasks["scalp"], rmasks["flush"]], os.path.join(T, "debug_skin_fixmasks.jpg"), 512)
    print("BUILD skin gain %.3f (mean lin %s), region masks %s" % (skin_gain, np.round(skin_mean, 3).tolist(),
          {k: round(float(v.mean()), 4) for k, v in rmasks.items()}))
    brows.data.materials.append(make_material("Eyebrow", os.path.join(T, "eyebrow.png"), alpha=True))
    lashes.data.materials.append(make_material("Eyelash", os.path.join(T, "eyelash.png"), alpha=True))
    teeth.data.materials.append(make_material("Teeth", os.path.join(T, "teeth.jpg")))
    tongue.data.materials.append(make_material("Tongue", os.path.join(T, "tongue.jpg")))

    MATERIALS.update({
        "Skin": tint_spec(DEFAULTS["skin"], skin_gain, roughness=0.52, metallic=0.0, normalScale=0.6, doubleSided=True,
                          extraTextures={"ccRegions": os.path.join(T, "skin_regions.jpg")}),
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
        gain = tex.tintable_alpha(A("hair", hid, src), os.path.join(T, "hair_%s.png" % hid), 1024, k=0.5,
                                  flatten=HAIR_FLATTEN.get(hid, HAIR_FLATTEN_DEFAULT))
        o.data.materials.append(make_material("Hair_" + hid, os.path.join(T, "hair_%s.png" % hid), alpha=True))
        MATERIALS["Hair_" + hid] = tint_spec(DEFAULTS["hair"], gain, alphaMode="MASK", alphaCutoff=0.35,
                                            roughness=0.62, metallic=0.0, doubleSided=True)
        add_hair_length_attr(o)
        hair_objs[hid] = o
    for o in face_objs:
        o["cc_export"] = "base"
    for o in hair_objs.values():
        o["cc_export"] = "hair"

    # --- clothing (blender/cc_clothing.py): one object per garment, exported to its own GLB below ---
    if not args.no_clothing:
        import cc_clothing
        from types import SimpleNamespace
        assert body_idx == list(range(len(body_idx))), "body vertices are expected to be 0..n-1"
        CLOTH = cc_clothing.Clothing(SimpleNamespace(
            human=human, N_BODY=len(body_idx), BASE_ARR=BASE_ARR, delta=delta, base_heads=base_heads, args=args,
            check_license=check_license, add_asset=add_asset, last_fit=lambda: _LAST_FIT[0], fit_keys=fit_keys,
            MORPH_KIND=MORPH_KIND, CORR_PARTS=CORR_PARTS, ZERO_BELOW=ZERO_BELOW, tex=tex,
            make_material=make_material, MATERIALS=MATERIALS, bone_names={b.name for b in rig.data.bones}))
        # generated underwear (layer 0) last: it never changes the other garments or their zone bits
        for _g in sorted(cc_clothing.GARMENTS, key=lambda g: (bool(g.get("gen")), g["layer"])):
            CLOTH.add(_g)
        CLOTH.finish_body()

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

MESH_EXTRAS = {"Body": {"ccJiggle": JIGGLE}}   # merged into the Body mesh extras (base + bake_clips.py)
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
    patch_mesh_extras(g, MESH_EXTRAS)
    b = embed_textures(g, b, MATERIALS)
    b = quantize_morphs(g, b)                  # KHR_mesh_quantization for the morph deltas (see glbutil.py)
    write_glb(path, g, b)
    print("BUILD exported %s  %d bytes  meshes %s  materials patched %s"
          % (os.path.basename(path), os.path.getsize(path), [m["name"] for m in g.get("meshes", [])], patched))


# base GLB: body + face assets (+ rig). Hair is exported separately (one small GLB per style, loaded on demand).
export(args.out, [human, rig] + face_objs, export_attributes=CLOTH is not None)   # attributes: Body _CCZONE

out_dir = os.path.dirname(args.out)
if CLOTH is not None:
    CLOTH.export_all(out_dir, export, rig, read_glb, write_glb)
if hair_objs:
    manifest = {"version": 1, "default": HAIR_DEFAULT, "defaultColor": DEFAULTS["hair"], "styles": []}
    for hid, labels in HAIR_STYLES:
        fn = "hair_%s.glb" % hid
        # hair morph normals are not worth the bytes (cards; the base normals are fine)
        export(os.path.join(out_dir, fn), [hair_objs[hid], rig], export_morph_normal=False, export_attributes=True)
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
bpy.context.scene["cc_mesh_extras"] = json.dumps(MESH_EXTRAS)   # ... and the same mesh extras (ccJiggle)
bpy.ops.wm.save_as_mainfile(filepath=args.blend)
print("BUILD done", args.out)
