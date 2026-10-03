// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal GLB reader for node tools/tests (no dependencies).
// readGlb(file) -> { json, bin, size, accessor(i) -> array of numbers or arrays, byName, parent }
import fs from 'node:fs';

const COMP = {
  5120: [1, (b, o) => b.readInt8(o), 127], 5121: [1, (b, o) => b.readUInt8(o), 255],
  5122: [2, (b, o) => b.readInt16LE(o), 32767], 5123: [2, (b, o) => b.readUInt16LE(o), 65535],
  5125: [4, (b, o) => b.readUInt32LE(o), 0], 5126: [4, (b, o) => b.readFloatLE(o), 0],
};
const N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGlb(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jlen = b.readUInt32LE(12), json = JSON.parse(b.subarray(20, 20 + jlen).toString());
  const binStart = 20 + jlen + 8, bin = b.subarray(binStart, binStart + b.readUInt32LE(20 + jlen));
  // dense read of `count` elements from a buffer view
  const dense = (bvi, byteOffset, count, n, componentType, normalized) => {
    const [size, read, norm] = COMP[componentType], bv = json.bufferViews[bvi];
    const stride = bv.byteStride || n * size, off = (bv.byteOffset || 0) + (byteOffset || 0), out = [];
    for (let k = 0; k < count; k++) {
      const e = [];
      for (let c = 0; c < n; c++) {
        let v = read(bin, off + k * stride + c * size);
        if (normalized && norm) v /= norm;
        e.push(v);
      }
      out.push(n === 1 ? e[0] : e);
    }
    return out;
  };
  // accessor with glTF sparse support (Blender writes sparse morph targets when that is smaller)
  const accessor = i => {
    const a = json.accessors[i], n = N[a.type];
    const out = a.bufferView === undefined
      ? Array.from({ length: a.count }, () => (n === 1 ? 0 : new Array(n).fill(0)))
      : dense(a.bufferView, a.byteOffset, a.count, n, a.componentType, a.normalized);
    if (a.sparse) {
      const { count, indices, values } = a.sparse;
      const idx = dense(indices.bufferView, indices.byteOffset, count, 1, indices.componentType, false);
      const val = dense(values.bufferView, values.byteOffset, count, n, a.componentType, a.normalized);
      idx.forEach((k, j) => { out[k] = val[j]; });
    }
    return out;
  };
  const parent = {};
  json.nodes.forEach((nd, i) => (nd.children || []).forEach(c => { parent[c] = i; }));
  const byName = Object.fromEntries(json.nodes.map((nd, i) => [nd.name, i]));
  return { json, bin, size: b.length, accessor, parent, byName };
}

/** Mesh parts by NODE name: { name: { node, mesh, prims: [{ pos, targets: [[dx,dy,dz]...], joints, weights, material,
 *  indices (flat, or null), attr(name) -> custom attribute (e.g. '_CCZONE') or null }] } } */
export function meshParts(g, { withSkin = true } = {}) {
  const out = {};
  g.json.nodes.forEach((nd, i) => {
    if (nd.mesh === undefined) return;
    const mesh = g.json.meshes[nd.mesh];
    out[nd.name] = {
      node: i, nodeDef: nd, mesh, targetNames: mesh.extras?.targetNames || [],
      prims: mesh.primitives.map(p => ({
        material: p.material !== undefined ? g.json.materials[p.material].name : null,
        pos: g.accessor(p.attributes.POSITION),
        targets: (p.targets || []).map(t => g.accessor(t.POSITION)),
        joints: withSkin && p.attributes.JOINTS_0 !== undefined ? g.accessor(p.attributes.JOINTS_0) : null,
        weights: withSkin && p.attributes.WEIGHTS_0 !== undefined ? g.accessor(p.attributes.WEIGHTS_0) : null,
        get indices() { return p.indices !== undefined ? g.accessor(p.indices) : null; },
        attr: n => (p.attributes[n] !== undefined ? g.accessor(p.attributes[n]) : null),
      })),
    };
  });
  return out;
}

/** Skin joint names of skin 0. */
export const jointNames = g => g.json.skins[0].joints.map(i => g.json.nodes[i].name);
