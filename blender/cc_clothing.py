"""Clothing for build_base.py (runs inside Blender: bpy + numpy). See docs/BLENDER_WORKFLOW.md "Clothing" and
docs/CLOTH_SPEC.md.

Every garment becomes its own GLB (output/clothing_<id>.glb), skinned to the same 53-bone rig and carrying the
same 60 morph targets as the body, plus an entry in output/clothing.json (slot, layer, conflicts, body zones,
colour slots, license). Pipeline per garment (in layer order, inner garments first):

 1. license gate (pack index + the .mhclo and .mhmat headers must say CC0, like the hair);
 2. MHCLO fit on the neutral basemesh and on every morph sample (build_base.add_asset); then only the wanted
    connected components of the MakeHuman suit are kept (the CC0 pack only has whole outfits: T-shirt + jeans in
    one .obj, blouse + skirt, jacket + shirt + collar + jeans);
 3. trench coat only: the jacket's hem is extended down to just above the knee (project code, extend_coat); the
    new vertices get a synthetic MHCLO-style binding (nearest body polygon + scaled offset), so they follow every
    morph with the same formula as the rest;
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
                    maxDistance=0.04, stretch=0.95, bend=0.3, damping=0.12, gravityScale=1.0, wind=0.3)),
    dict(id="tshirt", slot="top", layer=3, pack="male_casualsuit04", keep=[810], zone="torso",
         label={"da": "T-shirt", "en": "T-shirt"}, primary="#2f5f9e", secondary="#e08a2c",
         secondary_from="orange", roughness=0.9, source_part="T-shirt of male_casualsuit04"),
    dict(id="trenchcoat", slot="outerwear", layer=4, pack="male_casualsuit05", keep=[1659, 277], zone="coat",
         label={"da": "Trenchcoat", "en": "Trench coat"}, primary="#b39a70", secondary="#7a6444",
         secondary_from="small_components", roughness=0.85,
         source_part="jacket + collar of male_casualsuit05, lengthened to the knee by this project",
         extend=dict(bottom="knee+0.06", row=0.025, clearance=0.055, flare=0.12, uv=(0.01, 0.58, 0.01, 0.43)),
         cloth=dict(pinTop="spine_01", pinBottom="hip-0.14", legShare=0.7, legShareFront=1.0, shareWidth=0.06,
                    maxDistance=0.25, stretch=0.9, bend=0.15, damping=0.08, gravityScale=1.0, wind=0.6)),
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
        named = {"knee": h["calf_l"][2], "hip": h["thigh_l"][2], "thigh_mid": (h["thigh_l"][2] + h["calf_l"][2]) / 2}
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
        if g.get("extend"):
            rec["ext"] = self.extend_coat(obj, g, fit)
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

    # ---- trench coat: lengthen the jacket --------------------------------------------------------------
    def extend_coat(self, obj, g, fit):
        """Extrude the jacket's hem (the lowest, mostly horizontal run of its boundary loop) down to ex['bottom'].
        Rows every ~ex['row'] m. Each column keeps its angle around the pelvis axis; its radius is
        max(previous row + flare * row, body envelope at that height and angle + clearance), smoothed along the row,
        so the skirt of the coat drapes over hips and thighs without entering them. The bottom edge is level."""
        B = self.B
        ex = g["extend"]
        me = obj.data
        co, polys = mesh_arrays(obj)
        n0 = len(co)
        roots = components(n0, polys)
        jr = np.bincount(roots).argmax()                   # the jacket = largest part
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        adj = {}
        for e in bm.edges:
            if e.is_boundary and roots[e.verts[0].index] == jr:
                a, b = e.verts[0].index, e.verts[1].index
                adj.setdefault(a, []).append(b)
                adj.setdefault(b, []).append(a)
        low = min(adj, key=lambda i: co[i, 2])

        def walk(first):
            out, prev, cur = [], low, first
            while True:
                step = co[cur] - co[prev]
                if abs(step[2]) > 0.7 * np.hypot(step[0], step[1]) or len(out) > 200:   # turned up the front edge
                    break
                out.append(cur)
                nx = [k for k in adj[cur] if k != prev]
                if not nx:
                    break
                prev, cur = cur, nx[0]
            return out
        hem = walk(adj[low][0])[::-1] + [low] + walk(adj[low][1])
        H = co[hem]
        cy = float(self.heads["pelvis"][1])
        theta = np.arctan2(H[:, 1] - cy, H[:, 0])
        r_prev = np.hypot(H[:, 0], H[:, 1] - cy)
        z_bot = self.z_of(ex["bottom"])
        nrows = int(np.ceil((H[:, 2].mean() - z_bot) / ex["row"]))
        P = B.BASE_ARR[:B.N_BODY]
        legs = np.abs(P[:, 0]) < 0.28
        rows = []
        for k in range(1, nrows + 1):
            zk = H[:, 2] + (z_bot - H[:, 2]) * (k / nrows)
            env = np.zeros(len(hem))
            for j in range(len(hem)):
                sl = legs & (np.abs(P[:, 2] - zk[j]) < 0.012)
                d = P[sl, :2] - np.array([0.0, cy])
                dth = np.abs((np.arctan2(d[:, 1], d[:, 0]) - theta[j] + np.pi) % (2 * np.pi) - np.pi)
                near = dth < np.radians(15)
                if near.any():
                    env[j] = np.hypot(d[near, 0], d[near, 1]).max()
            r = np.maximum(r_prev + ex["flare"] * ex["row"], env + ex["clearance"])
            for _ in range(4):                               # smooth along the row (ends fixed), never shrink
                r[1:-1] = np.maximum(r[1:-1], 0.25 * r[:-2] + 0.5 * r[1:-1] + 0.25 * r[2:])
            rows.append(np.c_[r * np.cos(theta), cy + r * np.sin(theta), zk])
            r_prev = r
        new_pos = np.concatenate(rows)                      # row-major, (nrows * len(hem), 3)
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
        # UVs: free rectangle of the atlas (the suit's jeans area); v span chosen for roughly square texels
        u0, u1, v0, v1 = ex["uv"]
        arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(rows[len(rows) // 2][:, :2], axis=0), axis=1))]
        height = float(H[:, 2].mean() - z_bot)
        v1 = min(v1, v0 + (u1 - u0) * height / arc[-1])
        uu = u0 + (u1 - u0) * arc / arc[-1]
        uvl = bm.loops.layers.uv.active
        sec = bm.verts.layers.int.get("cc_sec")
        dl = bm.verts.layers.deform.verify()
        jacket_faces = [f for f in bm.faces if roots[f.verts[0].index] == jr]
        grid = [[bm.verts[i] for i in hem]]
        where = {v: (0, j) for j, v in enumerate(grid[0])}
        for rk in range(nrows):
            vs = []
            for j in range(len(hem)):
                v = bm.verts.new(Vector(new_pos[rk * len(hem) + j]))
                for gi, wt in grid[0][j][dl].items():         # start from the hem vertex weights
                    v[dl][gi] = wt
                if sec:
                    v[sec] = 0
                where[v] = (rk + 1, j)
                vs.append(v)
            grid.append(vs)
        new_faces = []
        for rk in range(nrows):
            for j in range(len(hem) - 1):
                f = bm.faces.new((grid[rk][j], grid[rk][j + 1], grid[rk + 1][j + 1], grid[rk + 1][j]))
                f.smooth = True
                new_faces.append(f)
                for lp in f.loops:
                    rr, col = where[lp.vert]
                    lp[uvl].uv = (uu[col], v1 - (v1 - v0) * rr / nrows)
        # consistent winding with the jacket (orient_outward decides the side afterwards)
        bmesh.ops.recalc_face_normals(bm, faces=jacket_faces + new_faces)
        for layer in bm.verts.layers.shape.values():        # placeholder = neutral; exact keys written below
            for row in grid[1:]:
                for v in row:
                    v[layer] = v.co
        bm.to_mesh(me)
        bm.free()
        me.update()
        n = len(me.vertices)
        assert n == n0 + nn
        for blk in me.shape_keys.key_blocks:
            arr = np.empty(n * 3, np.float32)
            blk.data.foreach_get("co", arr)
            arr = arr.reshape(-1, 3)
            arr[n0:] = neutral + (deltas[blk.name] if blk.name in deltas else 0.0)
            blk.data.foreach_set("co", arr.ravel())
        rb = np.hypot(rows[-1][:, 0], rows[-1][:, 1] - cy)
        print("BUILD coat hem %d verts z %.3f..%.3f -> %d rows to z %.3f, bottom radius %.3f..%.3f m, uv v %.3f..%.3f"
              % (len(hem), H[:, 2].min(), H[:, 2].max(), nrows, z_bot, rb.min(), rb.max(), v0, v1))
        return dict(verts=nn, rows=nrows, hem=len(hem), uv=(u0, u1, v0, v1), z_bottom=z_bot, n0=n0,
                    hem_z=float(H[:, 2].max()))

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
                "colliders": "body_colliders.json", "units": "metres, glTF Y-up"}

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
        if rec.get("ext"):                      # jacket vertices up to 12 cm above the hem: fabric reference
            co_, _ = mesh_arrays(obj)
            n0 = rec["ext"]["n0"]
            ref_v[:n0] = (co_[:n0, 2] < rec["ext"]["hem_z"] + 0.12) & (sec_v[:n0] < 0.5)
        info = tex_cloth(B.tex, diffuse, normal, out, uv[tl], np.stack([sec_v[lv[tl]], ref_v[lv[tl]]], -1), (lo, hi),
                         g.get("secondary_from"), fill_rect=rec.get("ext", {}).get("uv"))
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
            if g.get("extend"):
                item["license"] = "CC0 source + project-original extension"
                item["projectOriginal"] = ("skirt below the jacket hem (%d vertices, %d rows) generated by "
                                           "blender/cc_clothing.py extend_coat" % (rec["ext"]["verts"], rec["ext"]["rows"]))
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


def tex_cloth(tex, src, normal_src, out_prefix, tri_uv, tri_sec, crop, sec_rule, fill_rect=None, k=0.5,
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
        if fill_rect is not None:
            nh, nw = nm.shape[:2]
            nm[int(fv0 * nh):int(fv1 * nh), int(fu0 * nw):int(fu1 * nw)] = (0.5, 0.5, 1.0)
        res["normal"] = tex.save(nm, out_prefix + "_normal.jpg", quality=85)
    if sec_b.any():
        f2 = max(1, max(h, w) // mask_size)
        mh, mw = (h // f2) * f2, (w // f2) * f2
        mk = sec[:mh, :mw].reshape(mh // f2, f2, mw // f2, f2).mean((1, 3))
        res["mask"] = tex.save(np.stack([mk, mk, mk], -1), out_prefix + "_mask.jpg", quality=92)
    return res
