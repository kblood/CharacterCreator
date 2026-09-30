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
from mathutils import Vector
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.locationservice import LocationService
from bl_ext.user_default.mpfb.entities.objectproperties import HumanObjectProperties
from bl_ext.user_default.mpfb.entities.rig import Rig

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


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="build_base.py")
    p.add_argument("out", nargs="?", default=os.environ.get("CC_OUT_GLB",
                   os.path.join(PROJECT, "output", "base_body.glb")))
    p.add_argument("--blend", default=os.environ.get("CC_BLEND",
                   os.path.join(PROJECT, "build", "blend", "base_body.blend")))
    p.add_argument("--no-ground-fix", action="store_true")
    a = p.parse_args(argv)
    a.out = os.path.abspath(a.out)
    a.blend = os.path.abspath(a.blend)
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

samples, offsets = {}, {}
for key, prop, val in MACRO_MORPHS:
    set_macro(prop, val)
    c = coords()
    heads = fit_heads(c)
    lo, hi = body_extent(c)
    dz = (base_lo - lo) if not args.no_ground_fix else 0.0
    shift = Vector((0.0, 0.0, dz))
    samples[key] = [p + shift for p in c]
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

# simple PBR skin material (baseColor tinted at runtime)
mat = bpy.data.materials.new("Skin"); mat.use_nodes = True
b = mat.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.8, 0.6, 0.5, 1); b.inputs["Roughness"].default_value = 0.6
human.data.materials.clear(); human.data.materials.append(mat)
human.name = "Body"; rig.name = "Armature"

bpy.ops.object.select_all(action='DESELECT')
for o in (human, rig): o.select_set(True)
bpy.ops.export_scene.gltf(filepath=args.out, export_format='GLB', use_selection=True,
    export_morph=True, export_skins=True, export_animations=False, export_apply=False, export_yup=True)

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

bpy.ops.wm.save_as_mainfile(filepath=args.blend)
print("BUILD done", args.out)
