"""Build the base body GLB: MPFB human + game_engine rig + linearised macro morph targets.
Run: blender -b --python blender/build_base.py -- <out.glb>
"""
import sys, bpy, bmesh
from mathutils import Vector
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.entities.objectproperties import HumanObjectProperties

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else r"C:\Tools\BlenderWorkTemp\export\base.glb"
RIG = "game_engine"

# (morph name, macro property, value). Neutral = 0.5 for all, age child = 0.1875 in MakeHuman.
MACRO_MORPHS = [
    ("gender_female", "gender", 0.0), ("gender_male", "gender", 1.0),
    ("age_child", "age", 0.1875), ("age_old", "age", 1.0),
    ("weight_min", "weight", 0.0), ("weight_max", "weight", 1.0),
    ("muscle_min", "muscle", 0.0), ("muscle_max", "muscle", 1.0),
    ("height_short", "height", 0.0), ("height_tall", "height", 1.0),
    ("proportions_ideal", "proportions", 1.0), ("proportions_uncommon", "proportions", 0.0),
]

human = HumanService.create_human(mask_helpers=False, detailed_helpers=False, extra_vertex_groups=False, feet_on_ground=True)
dg = lambda: bpy.context.evaluated_depsgraph_get()

def coords():
    dg().update()
    ev = human.evaluated_get(dg())
    m = ev.to_mesh()
    c = [v.co.copy() for v in m.vertices]
    ev.to_mesh_clear()
    return c

def set_macro(name, value):
    HumanObjectProperties.set_value(name, value, entity_reference=human)
    TargetService.reapply_macro_details(human)

base = coords()
print("BUILD base verts", len(base))
samples = {}
for key, prop, val in MACRO_MORPHS:
    set_macro(prop, val)
    samples[key] = coords()
    set_macro(prop, 0.5)

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
print("BUILD morphs", [k.name for k in human.data.shape_keys.key_blocks])

# rig with weights on the full mesh (weights are indexed on the complete basemesh)
bpy.context.view_layer.objects.active = human
rig = HumanService.add_builtin_rig(human, RIG, import_weights=True)
print("BUILD rig", rig.name, len(rig.data.bones), "bones")

# strip helper geometry: keep only the 'body' vertex group
bpy.ops.object.select_all(action='DESELECT')
human.select_set(True); bpy.context.view_layer.objects.active = human
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(human.data)
gi = human.vertex_groups["body"].index
dl = bm.verts.layers.deform.verify()
bpy.ops.mesh.select_all(action='DESELECT')
for v in bm.verts:
    v.select = gi not in v[dl]
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
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True,
    export_morph=True, export_skins=True, export_animations=False, export_apply=False, export_yup=True)
bpy.ops.wm.save_as_mainfile(filepath=r"C:\Tools\BlenderWorkTemp\blend\base_body.blend")
print("BUILD done", out)
