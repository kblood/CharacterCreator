"""Diagnostic only (not part of the build): print MPFB's default macro dict, vertex/shape-key/
vertex-group info and the bbox of a freshly created human.

Run: <blender> -b --python blender/tools/probe.py
Grep the output for "PROBE".
"""
import bpy
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

d = TargetService.get_default_macro_info_dict()
print("PROBE macro", d)
h = HumanService.create_human(mask_helpers=False, detailed_helpers=False, extra_vertex_groups=False, feet_on_ground=True)
print("PROBE verts", len(h.data.vertices), "keys",
      [k.name for k in h.data.shape_keys.key_blocks][:20] if h.data.shape_keys else None)
print("PROBE groups", [g.name for g in h.vertex_groups][:40])
bb = [max(v.co[i] for v in h.data.vertices) - min(v.co[i] for v in h.data.vertices) for i in range(3)]
print("PROBE bbox", bb)
