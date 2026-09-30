"""Clothing for build_base.py (runs inside Blender: bpy + numpy). See docs/BLENDER_WORKFLOW.md "Clothing" and
docs/CLOTH_SPEC.md.

Every garment becomes its own GLB (output/clothing_<id>.glb), skinned to the same 53-bone rig and carrying the
same 60 morph targets as the body, plus an entry in output/clothing.json (slot, layer, conflicts, body zones,
colour slots, license). Pipeline per garment (in layer order, inner garments first):

 1. license gate (pack index + the .mhclo and .mhmat headers must say CC0, like the hair);
 2. MHCLO fit on the neutral basemesh and on every morph sample (build_base.add_asset); then only the wanted
    connected components of the MakeHuman suit are kept (the CC0 pack only has whole outfits: T-shirt + jeans in
    one .obj, blouse + skirt, jacket + shirt + collar + jeans);
 3. trench coat only (project code, coat_skirt): the jacket is cut at the waist, a long skirt (waist to ~8 cm above
    the floor, open front, back vent) and a belt band over the seam are generated; the new vertices get a
    synthetic MHCLO-style binding (nearest body polygon + scaled offset), so they follow every morph with the
    same formula as the rest;
 4. clearance: every vertex near the skin is pushed PUSH m outward along the nearest body normal, then at the
    neutral shape, every macro extreme and every corrective corner the garment is pushed out of the body
    (>= EPS_BODY) and out of every garment of a lower layer (>= EPS_LAYER); corrections are smoothed over the
    mesh and written back into the Basis / morph deltas;
 5. weights: MPFB's interpolated weights; cloth garments (skirt, coat) blend their free part toward a smooth
    pelvis / thigh mix so the legs do not tear the fabric in walk / run;
 6. cloth-ready data (skirt, coat): vertex attribute _CLOTH_PIN (1 = follows the skin, 0 = free cloth) and mesh
    extras ccCloth (docs/CLOTH_SPEC.md); no simulation here;
 7. textures: the used part of the MakeHuman atlas is cropped and normalised to grey (primary and secondary region
    separately) for the runtime tint; a small mask texture (ccMask, R = secondary colour weight) marks the
    secondary region (T-shirt trim/logo, socks, coat collar);
 8. body zones: the body vertices the garment covers (MakeHuman delete_verts of the suit, restricted to the kept
    components) become one bit of the body attribute _CCZONE; the viewer drops body triangles whose three
    vertices all carry a hidden bit.
"""
import json
import os
import re

import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc
from mathutils.kdtree import KDTree

PUSH = 0.0015        # m, uniform outward push along the nearest body normal
EPS_BODY = 0.003     # m, minimum garment - skin clearance at every sampled shape
EPS_LAYER = 0.003    # m, minimum clearance over a garment of a lower layer
FIX_RANGE = 0.03     # m, vertices deeper than this inside a collider are assumed to be mis-associated (not moved)

SLOTS = ["top", "bottom", "shoes", "outerwear"]
SLOT_LABELS = {"top": {"da": "Overdel", "en": "Top"}, "bottom": {"da": "Underdel", "en": "Bottom"},
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
         source_part="skirt of female_elegantsuit01",
         cloth=dict(pinTop="pelvis+0.03", pinBottom="thigh_mid", legShare=0.8, shareWidth=0.05,
                    maxDistance=0.04, stretch=0.95, bend=0.3, damping=0.12, gravityScale=1.0, wind=0.3,
                    limit="arms,hips,thighs")),
    dict(id="tshirt", slot="top", layer=3, pack="male_casualsuit04", keep=[810], zone="torso",
         label={"da": "T-shirt", "en": "T-shirt"}, primary="#2f5f9e", secondary="#e08a2c",
         secondary_from="orange", roughness=0.9, source_part="T-shirt of male_casualsuit04"),
    # Long dark coat ("Syndicate" duster): the CC0 jacket is cut at the waist (drops its lower patch pockets), a
    # generated skirt runs from under the jacket down to ~8 cm above the floor (open front that opens a little
    # toward the hem, back vent), and a generated belt band covers the seam (coat_skirt).
    dict(id="trenchcoat", slot="outerwear", layer=4, pack="male_casualsuit05", keep=[1659, 277], zone="coat",
         label={"da": "Trenchcoat", "en": "Trench coat"}, primary="#2b2b30", secondary="#4a3f36",
         secondary_from="small_components", roughness=0.78,
         source_part="jacket + collar of male_casualsuit05, cut at the waist; long skirt and belt generated by this project",
         coat=dict(cut="spine_02", hem="floor+0.08", row=0.045, columns=36, top_overlap=0.02, tuck=0.003,
                   clearance=0.045, clearance_ramp=0.22, flare=0.07, max_slope=0.3, open_deg=7.0, open_width_deg=70.0,
                   vent="knee+0.04", vent_gap=0.002, belt=0.055, belt_offset=0.007,
                   uv=(0.01, 0.58, 0.01, 0.385), belt_uv=(0.01, 0.58, 0.395, 0.425)),
         cloth=dict(pinTop="spine_02-0.02", pinBottom="hip-0.06", legShare=0.5, legShareFront=0.8, shareWidth=0.06,
                    maxDistance=0.6, stretch=0.95, bend=0.35, bendVertical=0.7, damping=0.12, gravityScale=1.0,
                    wind=0.6, friction=0.3, thickness=0.02, limit="arms,hips")),
]
# occupies: slots an item fills (default: its own slot). A dress would be slot "top", occupies ["top", "bottom"],
# layer 3 -> it sits under the coat (layer 4). conflicts: item ids removed when this item is put on.
OCCUPIES = {}
CONFLICTS = {}
HIDES_EXTRA = {}


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


class Clothing:
    def __init__(self, B):
        """B: namespace with the build_base state (see the call in build_base.py)."""
        self.B = B
        self.done = {}                                   # id -> record
        self.zone_bits = {}
        self.body_zone = np.zeros(B.N_BODY, np.int64)
        self.body_polys = [tuple(p.vertices) for p in B.human.data.polygons if max(p.vertices) < B.N_BODY]
        self.bvh0 = self.body_bvh(B.BASE_ARR)
        self.heads = {k: np.array(tuple(v)) for k, v in B.base_heads.items()}

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
        B = self.B
        rel = "clothes/%s/%s.mhclo" % (g["pack"], g["pack"])
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
        rec = dict(obj=obj, spec=g, bit=1 << len(self.zone_bits))
        if g.get("coat"):
            rec["ext"] = self.coat_skirt(obj, g, fit)
        self.orient_outward(obj)
        self.clearance(obj, g, rec)
        if not g.get("closed"):          # a shoe encloses the foot: keep its whole delete list
            dv = self.covered(obj, dv)
        bit = rec["bit"]
        self.zone_bits[g["zone"]] = bit
        self.body_zone[dv] |= bit
        rec["hidden"] = int(len(dv))
        if g.get("cloth"):
            self.cloth_weights_and_pin(obj, g, rec)
        self.textures_and_material(obj, g, rec)
        obj["cc_export"] = "cloth"
        self.done[g["id"]] = rec
        print("BUILD cloth %-10s verts %5d faces %5d hides %4d body verts (zone %s, bit %d)"
              % (g["id"], len(obj.data.vertices), len(obj.data.polygons), len(dv), g["zone"], bit))
        return obj

    def covered(self, obj, dv, reach=0.2, near=0.02, edge=0.035):
        """Body vertices the fitted garment hides (its body zone):
        - of the MakeHuman delete_verts (made for the complete suit) only those the garment really covers: a ray from
          the body vertex along its normal must hit the garment within `reach` m (drops skin just above a waistband /
          below a hem, which would show up as holes, and self-occluded spots like armpit and crotch);
        - plus skin the delete list misses but the garment clearly covers: garment within `near` m, ray hit, and more
          than `edge` m from any garment boundary (skin under a sleeve that the arm pushes through in walk / run)."""
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
            loc = bvh.find_nearest(p, near)[0]
            if loc is None or not hit(i):
                continue
            if bnd and kd.find(p)[2] < edge:
                continue
            extra.append(i)
        out = np.array(sorted(set(dv[ok].tolist()) | set(extra)), dtype=np.int64)
        print("BUILD cloth %s zone: %d of %d delete_verts covered along the skin normal, + %d covered skin verts -> %d"
              % (obj.name, int(ok.sum()), len(dv), len(extra), len(out)))
        return out

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

        # front edges: jacket boundary vertices just above the belt line, in front of the body, near x = 0
        bmj = bmesh.new()
        bmj.from_mesh(me)
        bnd = np.array(sorted({v.index for e in bmj.edges if e.is_boundary for v in e.verts}), dtype=np.int64)
        bmj.free()
        bnd = bnd[(roots[bnd] == jr) & (co[bnd, 2] > z_cut) & (co[bnd, 2] < z_cut + 0.12) & (co[bnd, 1] < cy - 0.05)
                  & (np.abs(co[bnd, 0]) < 0.12)]
        alpha0 = float(np.median(np.arctan2(np.abs(co[bnd, 0]), cy - co[bnd, 1]))) if len(bnd) else np.radians(8)
        M = int(ex["columns"]) // 2 * 2
        alphas = alpha0 + (2 * np.pi - 2 * alpha0) * np.arange(M + 1) / M
        z_top = z_cut + ex["top_overlap"]
        z_hem = self.z_of(ex["hem"])
        R = int(np.ceil((z_top - z_hem) / ex["row"]))
        zs = z_top - (z_top - z_hem) * np.arange(R + 1) / R
        z_vent = self.z_of(ex["vent"])
        # envelope = body + every lower-layer garment (the skirt's hem would otherwise leave a step in the coat)
        P = np.concatenate([B.BASE_ARR[:B.N_BODY]] + [get_shapes(r["obj"])["Basis"] for r in self.done.values()
                                                      if r["spec"]["layer"] < g["layer"]])
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
        kv = int(np.argmax(zs <= z_vent))
        vent_rows = list(range(kv + 1, R + 1))
        mid = M // 2
        vent_pos = grid_pos[vent_rows, mid].copy()
        grid_pos[vent_rows, mid, 0] += ex["vent_gap"] / 2      # left edge (x > 0 = character's left)
        vent_pos[:, 0] -= ex["vent_gap"] / 2                   # right edge

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

        skirt_list = grid_pos.reshape(-1, 3)
        new_pos = np.concatenate([skirt_list, vent_pos, belt_pos.reshape(-1, 3)])
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
        G = [[vnew(grid_pos[k, j], j) for j in range(M + 1)] for k in range(R + 1)]
        V = {k: vnew(p, mid) for k, p in zip(vent_rows, vent_pos)}
        BL = [[vnew(belt_pos[i, j], j) for j in range(M + 1)] for i in range(3)]
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
        new_verts = [v for row in G for v in row] + [V[k] for k in vent_rows] + [v for row in BL for v in row]
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
                 3 * (M + 1), v0, v1))
        return dict(verts=nn, skirt=(n0, n0 + ns), belt=(n0 + ns, n), rows=R + 1, cols=M + 1, n0=n0,
                    uv=(u0, u1, v0, v1), belt_uv=(bu0, bu1, bv0, bv1), z_cut=z_cut, hem_z=z_cut, z_hem=z_hem)

    # ---- clearance -----------------------------------------------------------------------------------
    def clearance(self, obj, g, rec):
        B = self.B
        me = obj.data
        S = get_shapes(obj)
        base = S["Basis"]
        d = {k: S[k] - base for k in S if k != "Basis"}
        _, polys = mesh_arrays(obj)
        nb = neighbours(len(base), polys)
        lo_z, hi_z = base[:, 2].min() - 0.1, base[:, 2].max() + 0.1
        lower = []
        for r in sorted(self.done.values(), key=lambda r: r["spec"]["layer"]):
            if r["spec"]["layer"] >= g["layer"]:
                continue
            sh = get_shapes(r["obj"])
            if sh["Basis"][:, 2].max() < lo_z or sh["Basis"][:, 2].min() > hi_z:
                continue                                   # far apart (coat vs shoes)
            lower.append((r["spec"]["id"], sh, mesh_arrays(r["obj"])[1]))

        def colliders(combo):
            """combo: morph keys at weight 1 (corrective corners: both macros + the corrective)."""
            body = B.BASE_ARR.copy()
            for k in combo:
                body = body + B.delta[k]
            cs = [(self.body_bvh(body), EPS_BODY)]
            for _, sh, pl in lower:
                X = sh["Basis"].copy()
                for k in combo:
                    X += sh[k] - sh["Basis"]
                cs.append((BVHTree.FromPolygons([Vector(p) for p in X], pl), EPS_LAYER))
            return cs

        def push(X, cs):
            X = X.copy()
            moved = np.zeros(len(X), bool)
            for i in range(len(X)):
                p = Vector(X[i])
                for bvh, eps in cs:
                    loc, nrm, _, dist = bvh.find_nearest(p, eps + FIX_RANGE)
                    if loc is None:
                        continue
                    sd = (p - loc).dot(nrm)
                    if -FIX_RANGE < sd < eps:
                        p = p + nrm * (eps - sd)
                        moved[i] = True
                X[i] = p[:]
            return X, moved

        def fix(X, cs):
            Y, moved = push(X, cs)
            if not moved.any():
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
            return Y, int(moved.sum())

        pushed = base.copy()
        for i in range(len(base)):
            loc, nrm, _, dist = self.bvh0.find_nearest(Vector(base[i]), 0.03)
            if loc is not None:
                pushed[i] = base[i] + np.array(nrm) * PUSH
        new_base, m0 = fix(pushed, colliders([]))
        report = {"neutral": m0}
        new = {}
        for k in d:
            if B.MORPH_KIND[k] == "macro":
                Y, report[k] = fix(new_base + d[k], colliders([k]))
                new[k] = Y - new_base
        for k in d:
            if B.MORPH_KIND[k] == "corr":
                a, b = B.CORR_PARTS[k]
                Y, report[k] = fix(new_base + new[a] + new[b] + d[k], colliders([a, b, k]))
                new[k] = Y - new_base - new[a] - new[b]
                new[k][np.linalg.norm(new[k], axis=1) < B.ZERO_BELOW["corr"]] = 0.0
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
        rec["clearance"] = {"fixedNeutral": m0, "worst": [[k, v] for v, k in worst]}
        print("BUILD cloth %s clearance vs body%s: verts pushed at neutral %d, worst %s"
              % (g["id"], "".join(" + " + x[0] for x in lower), m0, worst))

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
                k: c[k] for k in ("bendVertical", "friction", "thickness", "floor", "limit") if k in c}

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
        lo = np.floor(np.clip(uv.min(0) - 0.01, 0, 1) * 32) / 32
        hi = np.ceil(np.clip(uv.max(0) + 0.01, 0, 1) * 32) / 32
        out = os.path.join(B.args.textures, "cloth_%s" % g["id"])
        ref_v = np.zeros(len(me.vertices))
        if rec.get("ext"):                      # jacket vertices up to 12 cm above the cut: fabric reference
            co_, _ = mesh_arrays(obj)
            n0 = rec["ext"]["n0"]
            ref_v[:n0] = (co_[:n0, 2] < rec["ext"]["hem_z"] + 0.12) & (sec_v[:n0] < 0.5)
        info = tex_cloth(B.tex, diffuse, normal, out, uv[tl], np.stack([sec_v[lv[tl]], ref_v[lv[tl]]], -1), (lo, hi),
                         g.get("secondary_from"), fill_rect=rec.get("ext", {}).get("uv"),
                         belt_rect=rec.get("ext", {}).get("belt_uv"))
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
                    "source": "MakeHuman system assets: clothes/%s (%s)" % (g["pack"], g["source_part"])}
            if g.get("coat"):
                item["license"] = "CC0 source + project-original extension"
                item["projectOriginal"] = ("long skirt below the waist and belt (%d vertices, %d rows x %d columns) "
                                           "generated by blender/cc_clothing.py coat_skirt"
                                           % (rec["ext"]["verts"], rec["ext"]["rows"], rec["ext"]["cols"]))
            if ce:
                item["cloth"] = ce
            items.append(item)
        cat = {"version": 1, "slots": SLOTS, "slotLabels": SLOT_LABELS, "bodyZones": self.zone_bits,
               "bodyZoneAttribute": "_CCZONE", "default": [], "items": items,
               "rules": {"occupies": "putting an item on removes every worn item that occupies one of its slots",
                         "conflicts": "putting an item on also removes the worn items listed in its conflicts "
                                      "(and items that list it)",
                         "layer": "higher layer = outside; each item was fitted over every lower-layer item"}}
        with open(os.path.join(out_dir, "clothing.json"), "w", encoding="utf-8") as f:
            json.dump(cat, f, indent=1, ensure_ascii=False)
        print("BUILD clothing catalog", [(i["id"], i["bytes"]) for i in items])
        return cat


def tex_cloth(tex, src, normal_src, out_prefix, tri_uv, tri_sec, crop, sec_rule, fill_rect=None, belt_rect=None, k=0.5,
              max_size=1024, normal_size=512, mask_size=256):
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
    out = np.full_like(L, k)
    sec_b = sec >= 0.5
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
        if belt_rect is not None:
            nm[int(bv0 * nh):max(int(bv1 * nh), int(bv0 * nh) + 1), int(bu0 * nw):int(bu1 * nw)] = (0.5, 0.5, 1.0)
        res["normal"] = tex.save(nm, out_prefix + "_normal.jpg", quality=85)
    if sec_b.any():
        f2 = max(1, max(h, w) // mask_size)
        mh, mw = (h // f2) * f2, (w // f2) * f2
        mk = sec[:mh, :mw].reshape(mh // f2, f2, mw // f2, f2).mean((1, 3))
        res["mask"] = tex.save(np.stack([mk, mk, mk], -1), out_prefix + "_mask.jpg", quality=92)
    return res
