"""Pack MPFB/MakeHuman CC0 data (base mesh + macro targets) into compact binaries for the web runtime.
Usage: python tools/export_data.py [MPFB_DIR] [OUT_DIR]
Output (web/data): mesh.bin, meta.json, macro.json, targets/<name>.bin
 targets/*.bin = uint16 count N, then N x uint16 vertex index, then N x 3 x int16 deltas (units of DELTA_STEP decimetres).
"""
import sys, os, gzip, json, struct, glob, shutil
import numpy as np

MPFB = sys.argv[1] if len(sys.argv) > 1 else os.path.expandvars(
    r"%APPDATA%\Blender Foundation\Blender\5.2\extensions\user_default\mpfb\data")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "web", "data")
DELTA_STEP = 0.0003            # decimetres per int16 step (max |delta| ~9.8 dm)
os.makedirs(os.path.join(OUT, "targets"), exist_ok=True)

# --- base mesh (body group only: vertices 0..NBODY-1) ---
groups = json.load(open(os.path.join(MPFB, "mesh_metadata", "basemesh_vertex_groups.json")))
NBODY = groups["body"][0][1] + 1
v, vt, faces = [], [], []
for line in open(os.path.join(MPFB, "3dobjs", "base.obj")):
    p = line.split()
    if not p: continue
    if p[0] == "v": v.append([float(x) for x in p[1:4]])
    elif p[0] == "vt": vt.append([float(x) for x in p[1:3]])
    elif p[0] == "f": faces.append([tuple(int(i) - 1 for i in c.split("/")[:2]) for c in p[1:]])
body = [f for f in faces if all(c[0] < NBODY for c in f)]
key = {}; orig = []; uv = []; idx = []
def vid(c):
    if c not in key:
        key[c] = len(orig); orig.append(c[0]); uv.append(vt[c[1]])
    return key[c]
for f in body:
    ids = [vid(c) for c in f]
    for tri in ([0, 1, 2], [0, 2, 3]) if len(ids) == 4 else ([0, 1, 2],):
        idx += [ids[t] for t in tri]
pos = np.array(v[:NBODY], dtype=np.float32)
with open(os.path.join(OUT, "mesh.bin"), "wb") as fh:
    fh.write(pos.tobytes()); fh.write(np.array(uv, np.float32).tobytes())
    fh.write(np.array(orig, np.uint32).tobytes()); fh.write(np.array(idx, np.uint32).tobytes())
meta = {"nBody": NBODY, "nVerts": len(orig), "nIdx": len(idx), "deltaStep": DELTA_STEP,
        "bbox": [pos.min(0).tolist(), pos.max(0).tolist()]}
print("mesh: body verts", NBODY, "render verts", len(orig), "tris", len(idx) // 3, "bbox", meta["bbox"])

# --- macro targets ---
shutil.copy(os.path.join(MPFB, "targets", "macrodetails", "macro.json"), os.path.join(OUT, "macro.json"))
names = []
for sub, pat in (("", "*.target.gz"), ("height", "*.target.gz"), ("proportions", "*.target.gz")):
    for path in glob.glob(os.path.join(MPFB, "targets", "macrodetails", sub, pat)):
        base = os.path.basename(path)[:-len(".target.gz")]
        name = ("macrodetails/" + (sub + "/" if sub else "") + base)
        idxs, dl = [], []
        for line in gzip.open(path, "rt"):
            p = line.split()
            if len(p) == 4 and not line.startswith("#"):
                i = int(p[0])
                if i < NBODY: idxs.append(i); dl.append([float(x) for x in p[1:]])
        q = np.clip(np.round(np.array(dl).reshape(-1, 3) / DELTA_STEP), -32767, 32767).astype("<i2")
        with open(os.path.join(OUT, "targets", name.replace("/", "__") + ".bin"), "wb") as fh:
            fh.write(struct.pack("<H", len(idxs))); fh.write(np.array(idxs, "<u2").tobytes()); fh.write(q.tobytes())
        names.append(name)
meta["targets"] = sorted(names)
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"))
tot = sum(os.path.getsize(f) for f in glob.glob(os.path.join(OUT, "targets", "*.bin")))
print("targets:", len(names), "total MB", round(tot / 1e6, 1))
