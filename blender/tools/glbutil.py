"""Minimal GLB read/write for post-export patches (plain Python 3, also importable inside Blender).

read_glb(path)  -> (gltf_json_dict, bin_bytes)
write_glb(path, gltf, bin_bytes)       re-pads both chunks; the BIN chunk is written unchanged
patch_materials(gltf, spec)            spec = {material name: {...}} (see build_base.py MATERIALS)
"""
import json
import struct


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "%s: not a GLB" % path
    jlen, jtype = struct.unpack_from("<II", data, 12)
    assert jtype == 0x4E4F534A
    gltf = json.loads(data[20:20 + jlen].decode("utf-8"))
    off = 20 + jlen
    b = b""
    if off < len(data):
        blen, btype = struct.unpack_from("<II", data, off)
        assert btype == 0x004E4942
        b = data[off + 8:off + 8 + blen]
    return gltf, b


def write_glb(path, gltf, b):
    j = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    j += b" " * ((4 - len(j) % 4) % 4)
    b = bytes(b) + b"\0" * ((4 - len(b) % 4) % 4)
    total = 12 + 8 + len(j) + (8 + len(b) if b else 0)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(j), 0x4E4F534A))
        f.write(j)
        if b:
            f.write(struct.pack("<II", len(b), 0x004E4942))
            f.write(b)


def patch_materials(gltf, spec):
    """Overwrite glTF material properties by material name. Keys per material (all optional):
    baseColorFactor [r,g,b,a] (linear), roughness, metallic, alphaMode, alphaCutoff, doubleSided,
    normalScale, extras (dict, merged). Returns the names that were patched."""
    done = []
    for m in gltf.get("materials", []):
        s = spec.get(m.get("name"))
        if s is None:
            continue
        pbr = m.setdefault("pbrMetallicRoughness", {})
        if "baseColorFactor" in s:
            pbr["baseColorFactor"] = [round(float(v), 5) for v in s["baseColorFactor"]]
        if "roughness" in s:
            pbr["roughnessFactor"] = float(s["roughness"])
        if "metallic" in s:
            pbr["metallicFactor"] = float(s["metallic"])
        if "alphaMode" in s:
            m["alphaMode"] = s["alphaMode"]
            if s["alphaMode"] == "MASK":
                m["alphaCutoff"] = float(s.get("alphaCutoff", 0.5))
            else:
                m.pop("alphaCutoff", None)
        if "doubleSided" in s:
            if s["doubleSided"]:
                m["doubleSided"] = True
            else:
                m.pop("doubleSided", None)
        if "normalScale" in s and "normalTexture" in m:
            m["normalTexture"]["scale"] = float(s["normalScale"])
        if "extras" in s:
            m.setdefault("extras", {}).update(s["extras"])
        done.append(m["name"])
    return done
