"""Bake the sampled humanoid clips (output/animations/*.json) onto the MPFB armature and export
output/base_body_anim.glb = the base body (Body + eye/brow/lash/teeth/tongue meshes, 12 morphs each, materials)
+ one glTF animation per clip. Hair is not included (separate hair_<id>.glb files).
Contract: docs/ANIMATION_PLAN.md section 4 D.

Run (project root, PowerShell), after `node tools/sample_clips.mjs`:
    C:\\Tools\\Blender\\blender.exe -b --python blender/bake_clips.py -- --blend <scratch>/base_body.blend
        [--anim-dir output/animations] [--out output/base_body_anim.glb]

--blend must be a FRESH build (blender/build_base.py -- <scratch>/base_body.glb --blend <scratch>/base_body.blend);
the .blend is opened read-only in spirit: it is never saved. Blender output is noisy: grep for "BAKE".
Verify: node tools/check_anim_glb.mjs output/base_body_anim.glb

Math (same as qToLocal in web/animation/qmath.js, in Blender space):
    JSON (glTF, Y-up) -> Blender (Z-up):  vector (x, y, z) -> (x, -z, y),  quat [x,y,z,w] -> (w, x, -z, y)
    Rrest = rotation of (armature.matrix_world @ bone.matrix_local)      bone rest orientation, world
    pose_bone.rotation_quaternion = Rrest^-1 @ q @ Rrest                  q = parent-relative character-frame delta
    Root pose_bone.location = Rrest_root^-1 @ v(pose.root)                the only translation track
Only rotations are keyed on joints (a position track would fight the per-morph skeleton offsets).
Every clip keys the union of joints used by any clip. Key i sits at frame i (not 1 + i as the plan
said): the exporter does not slide non-sampled actions to zero, and glTF time must be i / fps.
export_force_sampling=False on purpose: sampling bakes translation/rotation/scale for all 53 bones.
After export the rotation outputs are re-signed in place (align_rotation_signs): the exporter emits w >= 0,
which flips q -> -q mid-track on the thighs; check_anim_glb fails on any such flip.
"""
import argparse
import json
import os
import sys

import bpy
from mathutils import Quaternion, Vector

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="bake_clips.py")
    p.add_argument("--blend", required=True, help="fresh base_body.blend from build_base.py")
    p.add_argument("--anim-dir", default=os.path.join(PROJECT, "output", "animations"))
    p.add_argument("--out", default=os.path.join(PROJECT, "output", "base_body_anim.glb"))
    a = p.parse_args(argv)
    for k in ("blend", "anim_dir", "out"):
        setattr(a, k, os.path.abspath(getattr(a, k)))
    return a


def q_b(q):
    x, y, z, w = q
    return Quaternion((w, x, -z, y))


def v_b(v):
    x, y, z = v
    return Vector((x, -z, y))


args = parse_args()
print("BAKE blend", args.blend, "| anims", args.anim_dir, "| out", args.out)
bpy.ops.wm.open_mainfile(filepath=args.blend)

arm = bpy.data.objects.get("Armature")
body = bpy.data.objects.get("Body")
assert arm and arm.type == 'ARMATURE', "no object 'Armature' in the .blend"
assert body and body.type == 'MESH', "no mesh 'Body' in the .blend"
# export exactly what build_base.py put into base_body.glb: objects tagged cc_export == "base" (Body + eyes,
# eyebrows, eyelashes, teeth, tongue). Hair ("hair") lives in its own GLBs and is not exported here.
# Older .blend files without the tag: Body only.
parts = [o for o in bpy.data.objects if o.type == 'MESH' and o.get("cc_export") == "base"] or [body]
if body not in parts:
    parts.insert(0, body)
for o in list(bpy.data.objects):
    if o is not arm and o not in parts:
        print("BAKE note: object in .blend not exported:", o.name)
print("BAKE meshes", [o.name for o in parts])

with open(os.path.join(args.anim_dir, "index.json"), encoding="utf-8") as f:
    index = json.load(f)
clips = []
for name in index["clips"]:
    with open(os.path.join(args.anim_dir, name + ".json"), encoding="utf-8") as f:
        c = json.load(f)
    assert c.get("format") == "charactercreator.humanoid-clip" and c.get("version") == 1, name
    clips.append(c)
fps = {c["fps"] for c in clips}
assert len(fps) == 1, "all clips must share one fps, got %s" % fps
fps = fps.pop()
assert float(fps).is_integer(), "fps must be an integer for Blender"

scene = bpy.context.scene
scene.render.fps = int(fps)
scene.render.fps_base = 1.0

bpy.context.view_layer.objects.active = arm
mw_rot = arm.matrix_world.to_quaternion()
rrest = {}
for pb in arm.pose.bones:
    pb.rotation_mode = 'QUATERNION'
    pb.location = (0, 0, 0)
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.scale = (1, 1, 1)
    rrest[pb.name] = (arm.matrix_world @ pb.bone.matrix_local).to_quaternion()

all_joints = []
for c in clips:
    all_joints += [j for j in c["joints"] if j not in all_joints]

ad = arm.animation_data_create()
for c in clips:
    name, n = c["name"], c["frames"]
    root_bone = c.get("rootBone", "Root")
    bone_of = c["boneMap"]
    tracks = []
    # every clip keys the UNION of joints used by any clip (identity where this clip has none), so an
    # engine that does not reset bones between clips never keeps a stale rotation from another clip
    for joint in all_joints:
        keys = c["joints"].get(joint) or [[0.0, 0.0, 0.0, 1.0]] * (n + 1)
        bname = bone_of.get(joint)
        if not bname or bname not in arm.pose.bones:
            print("BAKE warn: %s: joint %s -> bone %s missing, skipped" % (name, joint, bname))
            continue
        assert len(keys) == n + 1, "%s/%s: %d keys, expected %d" % (name, joint, len(keys), n + 1)
        tracks.append((arm.pose.bones[bname], keys))
    root_pb = arm.pose.bones.get(root_bone)
    assert root_pb is not None, "root bone %s missing" % root_bone
    assert len(c["root"]) == n + 1

    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad.action = act                      # slotted actions (4.4+): assign first, keyframe_insert makes slot/channelbag
    r_root_inv = rrest[root_bone].inverted()
    for i in range(n + 1):
        frame = i        # glTF time = frame / fps; the exporter does not slide non-sampled actions to 0
        for pb, keys in tracks:
            r = rrest[pb.name]
            pb.rotation_quaternion = r.inverted() @ q_b(keys[i]) @ r
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        root_pb.location = r_root_inv @ v_b(c["root"][i])
        root_pb.keyframe_insert("location", frame=frame)
    # LINEAR interpolation between the (already densely sampled) keys; hemisphere is aligned in the JSON
    # and the sandwich with a fixed Rrest keeps it aligned.
    fcurves = []
    if hasattr(act, "fcurves") and len(getattr(act, "fcurves", [])):
        fcurves = list(act.fcurves)
    else:
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    fcurves.extend(cb.fcurves)
    for fc in fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
    act.use_frame_range = True
    act.frame_start, act.frame_end = 0, n
    act.use_cyclic = bool(c.get("loop", True))
    # stash on its own NLA track (muted so it doesn't affect the rest pose / other clips)
    slot = ad.action_slot if hasattr(ad, "action_slot") else None
    ad.action = None
    track = ad.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, act)
    if slot is not None and hasattr(strip, "action_slot"):
        strip.action_slot = slot
    track.mute = True
    print("BAKE clip %-5s frames %d (%.4f s) bones %d fcurves %d" % (name, n, n / fps, len(tracks), len(fcurves)))

# back to rest for the export (export_reset_pose_bones also does it)
for pb in arm.pose.bones:
    pb.location = (0, 0, 0)
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.scale = (1, 1, 1)
ad.action = None
scene.frame_set(0)

os.makedirs(os.path.dirname(args.out), exist_ok=True)
bpy.ops.object.select_all(action='DESELECT')
for o in parts + [arm]:
    o.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(
    filepath=args.out, export_format='GLB', use_selection=True,
    export_morph=True, export_skins=True, export_apply=False, export_yup=True,       # as build_base.py
    export_animations=True, export_animation_mode='ACTIONS',
    export_force_sampling=False,   # True bakes T/R/S for all 53 bones; we want rotation + Root translation only
    export_sampling_interpolation_fallback='LINEAR', export_frame_step=1,
    export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
    export_reset_pose_bones=True, export_anim_slide_to_zero=True, export_negative_frame='SLIDE',
    export_morph_animation=False, export_bake_animation=False, export_anim_single_armature=True,
    export_def_bones=False, export_leaf_bone=False, export_rest_position_armature=True, export_image_format='AUTO')


def align_rotation_signs(path):
    """The exporter writes bone rotations via matrices (w >= 0), so a track whose w crosses 0 (the thighs,
    rest w ~0.17) gets q -> -q jumps between keys. glTF says slerp, but engines/importers that interpolate
    quaternion components (or convert to Euler) spin there. Re-align every rotation output in place
    (same bytes, only signs change) so consecutive keys stay on one hemisphere."""
    import struct
    with open(path, "rb") as f:
        data = bytearray(f.read())
    jlen = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + jlen].decode("utf-8"))
    bin0 = 20 + jlen + 8
    fixed = 0
    for an in gltf.get("animations", []):
        for ch in an["channels"]:
            if ch["target"].get("path") != "rotation":
                continue
            acc = gltf["accessors"][an["samplers"][ch["sampler"]]["output"]]
            assert acc["componentType"] == 5126 and acc["type"] == "VEC4", "rotation output must be float VEC4"
            bv = gltf["bufferViews"][acc["bufferView"]]
            stride = bv.get("byteStride", 16)
            off = bin0 + bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
            prev = None
            for k in range(acc["count"]):
                q = struct.unpack_from("<4f", data, off + k * stride)
                if prev is not None and sum(a * b for a, b in zip(prev, q)) < 0:
                    q = tuple(-v for v in q)
                    struct.pack_into("<4f", data, off + k * stride, *q)
                    fixed += 1
                prev = q
    with open(path, "wb") as f:
        f.write(data)
    return fixed


print("BAKE sign-aligned %d rotation keys" % align_rotation_signs(args.out))

# same glTF material patch as base_body.glb (factors, alpha modes, tint extras); build_base.py stores it in the .blend
spec = json.loads(scene.get("cc_materials", "{}"))
if spec:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    from glbutil import read_glb, write_glb, patch_materials
    g, b = read_glb(args.out)
    print("BAKE materials patched", patch_materials(g, spec))
    write_glb(args.out, g, b)
print("BAKE exported", args.out, "%d bytes" % os.path.getsize(args.out))
print("BAKE done (the .blend is not saved)")
