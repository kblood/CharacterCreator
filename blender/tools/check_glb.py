# SPDX-License-Identifier: GPL-3.0-or-later
"""Sanity-check a built GLB and its joints sidecar (plain Python 3, no Blender needed).

Run: python blender/tools/check_glb.py [output/base_body.glb]

Checks: morph target names/count, skin joint count, that every sidecar bone is a joint node in the
GLB, that the sidecar bind positions equal the GLB's joint world positions (rest TRS chain), and
prints per-morph offset magnitudes (head / foot) for a plausibility glance. Exit code 1 on failure.
"""
import json
import math
import os
import struct
import sys


def quat_rot(q, v):
    x, y, z, w = q
    # v' = v + 2w(q x v) + 2 q x (q x v)
    cx, cy, cz = y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]
    cx2, cy2, cz2 = y * cz - z * cy, z * cx - x * cz, x * cy - y * cx
    return [v[0] + 2 * (w * cx + cx2), v[1] + 2 * (w * cy + cy2), v[2] + 2 * (w * cz + cz2)]


def quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]


def main():
    glb = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "output", "base_body.glb")
    side = os.path.splitext(glb)[0] + ".joints.json"
    with open(glb, "rb") as f:
        data = f.read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not a GLB"
    clen, _ = struct.unpack_from("<II", data, 12)
    gj = json.loads(data[20:20 + clen])
    nodes = gj["nodes"]
    ok = True

    body = next((n for n in nodes if n.get("name") == "Body" and "mesh" in n), None)
    mesh = gj["meshes"][body["mesh"] if body else 0]
    names = mesh.get("extras", {}).get("targetNames", [])
    print("CHECK morph targets", len(mesh["primitives"][0].get("targets", [])), names)
    skin = gj["skins"][0]
    print("CHECK skin joints", len(skin["joints"]))
    base_joints = {nodes[j]["name"] for j in skin["joints"]}

    def check_meshes(g, label):
        good = True
        for n in g["nodes"]:
            if "mesh" not in n:
                continue
            m = g["meshes"][n["mesh"]]
            tn = m.get("extras", {}).get("targetNames", [])
            nt = [len(p.get("targets", [])) for p in m["primitives"]]
            mats = [g["materials"][p["material"]]["name"] for p in m["primitives"] if "material" in p]
            fine = tn == names and all(k == len(names) for k in nt) and n.get("skin") == 0
            good &= fine
            print("CHECK %s %-12s %s targets %s materials %s" % (label, n["name"], "ok  " if fine else "FAIL", nt, mats))
        return good

    ok &= check_meshes(gj, "mesh")
    # separate hair GLBs listed in hair.json next to the base GLB
    manifest = os.path.join(os.path.dirname(glb), "hair.json")
    if os.path.isfile(manifest):
        hj = json.load(open(manifest, encoding="utf-8"))
        for s in hj["styles"]:
            p = os.path.join(os.path.dirname(glb), s["file"])
            if not os.path.isfile(p):
                ok = False
                print("CHECK FAIL hair file missing", s["file"])
                continue
            with open(p, "rb") as f:
                hd = f.read()
            hl, _ = struct.unpack_from("<II", hd, 12)
            hg = json.loads(hd[20:20 + hl])
            hjoints = {hg["nodes"][j]["name"] for j in hg["skins"][0]["joints"]}
            if not hjoints <= base_joints:
                ok = False
                print("CHECK FAIL hair %s joints not in base: %s" % (s["id"], sorted(hjoints - base_joints)))
            ok &= check_meshes(hg, "hair " + s["id"])
            print("CHECK hair %-10s %8d bytes (%s)" % (s["id"], len(hd), s.get("license")))

    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def world(i):
        t, r = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]
        chain = []
        while i is not None:
            chain.append(i)
            i = parent.get(i)
        for j in reversed(chain):  # root first
            n = nodes[j]
            assert "matrix" not in n and all(abs(s - 1) < 1e-4 for s in n.get("scale", [1, 1, 1])), \
                "scale/matrix nodes not supported by this checker"
            lt = n.get("translation", [0, 0, 0])
            rt = quat_rot(r, lt)
            t = [t[k] + rt[k] for k in range(3)]
            r = quat_mul(r, n.get("rotation", [0, 0, 0, 1]))
        return t

    joint_nodes = {nodes[j]["name"]: j for j in skin["joints"]}
    if not os.path.isfile(side):
        print("CHECK FAIL no sidecar", side)
        return 1
    sc = json.load(open(side, encoding="utf-8"))
    missing = sorted(set(sc["bones"]) - set(joint_nodes))
    if missing:
        ok = False
        print("CHECK FAIL sidecar bones not in GLB:", missing)
    err = max(math.dist(world(joint_nodes[b]), p) for b, p in sc["bones"].items() if b in joint_nodes)
    print("CHECK bind sidecar vs GLB world max error %.2e m" % err)
    ok &= err < 1e-3
    unknown = sorted(set(sc["morphs"]) - set(names))
    if unknown:
        ok = False
        print("CHECK FAIL sidecar morphs not in GLB:", unknown)
    for m, offs in sc["morphs"].items():
        if not offs:                       # face / expression morphs move no joint
            print("CHECK %-20s (no joint offsets)" % m)
            continue
        mx = max(offs.items(), key=lambda kv: math.hypot(*kv[1]))
        h = offs.get("head", [0, 0, 0])
        print("CHECK %-20s head dY %+.3f  max |d| %.3f (%s)" % (m, h[1], math.hypot(*mx[1]), mx[0]))
    print("CHECK", "OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
