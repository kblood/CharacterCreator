# SPDX-License-Identifier: GPL-3.0-or-later
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


_NP = {5120: "<i1", 5121: "<u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _read_accessor(gltf, b, i):
    """Float array (count, n) of an accessor incl. sparse and normalized ints (numpy)."""
    import numpy as np
    a = gltf["accessors"][i]
    n, dt = _NC[a["type"]], np.dtype(_NP[a["componentType"]])

    def dense(bv_i, off, count, comps, dtype):
        if not count:
            return np.zeros((0, comps))
        bv = gltf["bufferViews"][bv_i]
        stride = bv.get("byteStride") or comps * dtype.itemsize
        start = bv.get("byteOffset", 0) + (off or 0)
        raw = bytes(b[start:start + (count - 1) * stride + comps * dtype.itemsize])
        return np.ndarray((count, comps), dtype, raw, 0, (stride, dtype.itemsize)).astype(np.float64)

    out = dense(a["bufferView"], a.get("byteOffset"), a["count"], n, dt) if "bufferView" in a \
        else np.zeros((a["count"], n))
    if "sparse" in a:
        s = a["sparse"]
        idx = dense(s["indices"]["bufferView"], s["indices"].get("byteOffset"), s["count"], 1,
                    np.dtype(_NP[s["indices"]["componentType"]]))[:, 0].astype(np.int64)
        out[idx] = dense(s["values"]["bufferView"], s["values"].get("byteOffset"), s["count"], n, dt)
    if a.get("normalized"):
        out = np.maximum(out / {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}[a["componentType"]], -1.0)
    return out


def quantize_morphs(gltf, b):
    """KHR_mesh_quantization for morph targets: POSITION deltas -> normalized int16 (1/32767 m = 0.03 mm steps,
    |delta| must stay < 1 m), NORMAL deltas -> normalized int8. Each target is written sparse when that is
    smaller (indices uint16/uint32), otherwise dense with a 4-byte aligned stride. The BIN chunk is rebuilt
    (unreferenced data dropped). Base attributes, skins, animations and images are copied unchanged."""
    import numpy as np
    new_views, chunks = [], []
    size = [0]

    def put(data, stride=None, target=None):
        pad = (-size[0]) % 4
        if pad:
            chunks.append(b"\0" * pad)
            size[0] += pad
        v = {"buffer": 0, "byteOffset": size[0], "byteLength": len(data)}
        if stride:
            v["byteStride"] = stride
        if target:
            v["target"] = target
        chunks.append(data)
        size[0] += len(data)
        new_views.append(v)
        return len(new_views) - 1

    # 1) copy every buffer view that is still referenced by a non-morph user
    morph_acc = {}
    for m in gltf.get("meshes", []):
        for p in m["primitives"]:
            for t in p.get("targets", []):
                for attr, ai in t.items():
                    assert attr in ("POSITION", "NORMAL"), "morph attribute %s not supported" % attr
                    morph_acc[ai] = attr
    remap = {}

    def keep(vi):
        if vi not in remap:
            v = gltf["bufferViews"][vi]
            o = v.get("byteOffset", 0)
            remap[vi] = put(b[o:o + v["byteLength"]], v.get("byteStride"), v.get("target"))
        return remap[vi]

    old_views = gltf["bufferViews"]
    for i, a in enumerate(gltf.get("accessors", [])):
        if i in morph_acc:
            continue
        if "bufferView" in a:
            a["bufferView"] = keep(a["bufferView"])
        if "sparse" in a:
            a["sparse"]["indices"]["bufferView"] = keep(a["sparse"]["indices"]["bufferView"])
            a["sparse"]["values"]["bufferView"] = keep(a["sparse"]["values"]["bufferView"])
    for im in gltf.get("images", []):
        if "bufferView" in im:
            im["bufferView"] = keep(im["bufferView"])
    # 2) re-encode morph accessors
    for i in sorted(morph_acc):
        gltf["bufferViews"] = old_views               # morph accessors still point at the old views
        f = _read_accessor(gltf, b, i)
        is_pos = morph_acc[i] == "POSITION"
        ct, scale, dtype, esize = (5122, 32767.0, "<i2", 2) if is_pos else (5120, 127.0, "<i1", 1)
        if is_pos:
            assert np.abs(f).max() < 1.0, "morph delta >= 1 m cannot be stored as normalized int16"
        q = np.clip(np.round(f * scale), -scale, scale).astype(dtype)
        nz = np.nonzero(np.any(q != 0, axis=1))[0]
        count = len(f)
        dense_stride = 4 * ((3 * esize + 3) // 4)
        idx_t, idx_size = (5123, 2) if count <= 65535 else (5125, 4)
        new = {"componentType": ct, "normalized": True, "count": count, "type": "VEC3"}
        if len(nz) == 0:
            pass                                        # all zero: accessor without data (spec: zeros)
        elif len(nz) * (idx_size + 3 * esize) + 64 < count * dense_stride:
            iv = put(nz.astype("<u2" if idx_size == 2 else "<u4").tobytes())
            vv = put(q[nz].tobytes())
            new["sparse"] = {"count": int(len(nz)), "indices": {"bufferView": iv, "componentType": idx_t},
                             "values": {"bufferView": vv}}
        else:
            buf = np.zeros((count, dense_stride), np.uint8)
            buf[:, :3 * esize] = q.view(np.uint8).reshape(count, 3 * esize)
            new["bufferView"] = put(buf.tobytes(), stride=dense_stride, target=34962)
        if is_pos:
            new["min"] = q.min(0).astype(int).tolist() if count else [0, 0, 0]
            new["max"] = q.max(0).astype(int).tolist() if count else [0, 0, 0]
        gltf["accessors"][i] = new
    gltf["bufferViews"] = new_views
    out = b"".join(chunks)
    gltf["buffers"][0]["byteLength"] = len(out)
    for key in ("extensionsUsed", "extensionsRequired"):
        lst = gltf.setdefault(key, [])
        if "KHR_mesh_quantization" not in lst:
            lst.append("KHR_mesh_quantization")
    return out


def embed_textures(gltf, b, spec):
    """For every material named in spec with "extraTextures": {key: image path}, append the image to the BIN
    chunk (new bufferView + image + texture, sampler-less = linear/repeat) and store the texture index in the
    material extras as {key: {"index": i}} (three.js: parser.getDependency('texture', i)). Returns the new BIN."""
    b = bytearray(b)
    cache = {}
    for m in gltf.get("materials", []):
        extra = (spec.get(m.get("name")) or {}).get("extraTextures") or {}
        for key, path in extra.items():
            if path not in cache:
                with open(path, "rb") as f:
                    data = f.read()
                b += b"\0" * ((4 - len(b) % 4) % 4)
                gltf.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": len(b), "byteLength": len(data)})
                b += data
                mime = "image/png" if path.lower().endswith(".png") else "image/jpeg"
                gltf.setdefault("images", []).append({"bufferView": len(gltf["bufferViews"]) - 1, "mimeType": mime,
                                                      "name": key})
                gltf.setdefault("textures", []).append({"source": len(gltf["images"]) - 1})
                cache[path] = len(gltf["textures"]) - 1
            m.setdefault("extras", {})[key] = {"index": cache[path]}
    if cache:
        gltf["buffers"][0]["byteLength"] = len(b)
    return bytes(b)


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


def patch_mesh_extras(gltf, spec):
    """Merge extras into the mesh of every node named in spec ({node name: {key: value}}); the exporter's own mesh
    extras (targetNames) are kept. Returns the node names that were patched."""
    done = []
    for n in gltf.get("nodes", []):
        s = spec.get(n.get("name"))
        if s is None or "mesh" not in n:
            continue
        gltf["meshes"][n["mesh"]].setdefault("extras", {}).update(s)
        done.append(n["name"])
    return done
