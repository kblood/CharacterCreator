// GLB post-processing of the export (pure JS, no three.js / DOM; also used by node tests):
//   * morph target deltas -> sparse accessors where that is smaller (core glTF 2.0), all-zero targets -> accessors
//     without a bufferView (zeros by definition); optionally int16 normalised values (KHR_mesh_quantization, only
//     when every delta fits into -1..1 m) - three.js' GLTFExporter writes every target densely as float32
//     (the body alone would be ~32 MB with its 92 targets x POSITION + NORMAL);
//   * identical target accessors are shared;
//   * the binary chunk is rebuilt (only referenced bufferViews, 4-byte aligned).
// glTF min/max of POSITION accessors are kept exact (validator ACCESSOR_MIN/MAX_MISMATCH).

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const FLOAT = 5126, SHORT = 5122, USHORT = 5123, UINT = 5125;
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const CSIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export function parseGlb(ab) {
  const buf = ab instanceof ArrayBuffer ? ab : ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB');
  let off = 12, json = null, bin = new Uint8Array(0);
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const data = new Uint8Array(buf, off + 8, len);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === CHUNK_BIN) bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error('GLB without JSON chunk');
  return { json, bin };
}

export function buildGlb(json, bin) {
  const pad4 = n => (n + 3) & ~3;
  const jb = new TextEncoder().encode(JSON.stringify(json));
  const jlen = pad4(jb.length), blen = pad4(bin.length);
  const total = 12 + 8 + jlen + (bin.length ? 8 + blen : 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jlen, true); dv.setUint32(16, CHUNK_JSON, true);
  out.set(jb, 20); out.fill(0x20, 20 + jb.length, 20 + jlen);
  if (bin.length) {
    const o = 20 + jlen;
    dv.setUint32(o, blen, true); dv.setUint32(o + 4, CHUNK_BIN, true);
    out.set(bin, o + 8);
  }
  return out.buffer;
}

/** Dense float data of a FLOAT accessor (honours byteStride and sparse). */
export function readFloatAccessor(json, bin, ai) {
  const a = json.accessors[ai], n = NCOMP[a.type], out = new Float32Array(a.count * n);
  if (a.componentType !== FLOAT) throw new Error(`accessor ${ai}: not FLOAT`);
  if (a.bufferView !== undefined) {
    const bv = json.bufferViews[a.bufferView], stride = bv.byteStride || n * 4;
    const dv = new DataView(bin.buffer, bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0));
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = dv.getFloat32(i * stride + c * 4, true);
  }
  if (a.sparse) {
    const s = a.sparse, iv = json.bufferViews[s.indices.bufferView], vv = json.bufferViews[s.values.bufferView];
    const idv = new DataView(bin.buffer, bin.byteOffset + (iv.byteOffset || 0) + (s.indices.byteOffset || 0));
    const vdv = new DataView(bin.buffer, bin.byteOffset + (vv.byteOffset || 0) + (s.values.byteOffset || 0));
    const isz = CSIZE[s.indices.componentType];
    for (let k = 0; k < s.count; k++) {
      const i = isz === 1 ? idv.getUint8(k) : isz === 2 ? idv.getUint16(k * 2, true) : idv.getUint32(k * 4, true);
      for (let c = 0; c < n; c++) out[i * n + c] = vdv.getFloat32((k * n + c) * 4, true);
    }
  }
  return out;
}

/**
 * Re-encodes morph target accessors. opts: { quantize (bool), sparse (default true) }.
 * Returns { json, bin, stats: { targets, sparse, dense, zero, quantized, shared } }.
 */
export function compactMorphTargets(json, bin, { quantize = false, sparse = true } = {}) {
  json = JSON.parse(JSON.stringify(json));
  const targetAcc = new Set();
  for (const m of json.meshes || []) for (const p of m.primitives) for (const t of p.targets || []) for (const k in t) targetAcc.add(t[k]);
  const stats = { targets: targetAcc.size, sparse: 0, dense: 0, zero: 0, quantized: 0, shared: 0 };
  if (!targetAcc.size) { dedupeSkins(json, bin); return repack(json, bin, [], stats); }

  // new payloads: [{ bytes, target? , stride? }] appended after the kept bufferViews
  const extra = [];
  const addView = (bytes, viewProps = {}) => { extra.push({ bytes, ...viewProps }); return -extra.length; };   // negative = new
  const replaced = new Map();             // old accessor -> new accessor def
  const byHash = new Map();               // content hash -> accessor index (sharing)
  const remapAcc = new Map();

  for (const ai of targetAcc) {
    const a = json.accessors[ai];
    if (a.componentType !== FLOAT || a.type !== 'VEC3') continue;
    const data = readFloatAccessor(json, bin, ai), n = a.count;
    const key = hashFloats(data);
    if (byHash.has(key) && sameFloats(byHash.get(key).data, data)) { remapAcc.set(ai, byHash.get(key).ai); stats.shared++; continue; }
    byHash.set(key, { ai, data });
    let maxAbs = 0;
    for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > maxAbs) maxAbs = v; }
    const q = quantize && maxAbs <= 1;
    // values as they will be stored (quantised ints or float32)
    const stored = q ? Int16Array.from(data, v => Math.round(Math.max(-1, Math.min(1, v)) * 32767)) : data;
    const nz = [];
    for (let i = 0; i < n; i++) if (stored[3 * i] || stored[3 * i + 1] || stored[3 * i + 2]) nz.push(i);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { const v = stored[3 * i + c]; if (v < min[c]) min[c] = v; if (v > max[c]) max[c] = v; }
    const def = { componentType: q ? SHORT : FLOAT, count: n, type: 'VEC3', min, max };
    if (q) { def.normalized = true; stats.quantized++; }
    if (a.name) def.name = a.name;
    const elem = q ? 6 : 12, denseBytes = n * (q ? 8 : 12);
    const idxSize = n < 65536 ? 2 : 4, sparseBytes = nz.length * (idxSize + elem);
    if (!nz.length) { stats.zero++; def.min = [0, 0, 0]; def.max = [0, 0, 0]; }
    else if (sparse && sparseBytes < denseBytes) {
      const ib = new Uint8Array(nz.length * idxSize), idv = new DataView(ib.buffer);
      nz.forEach((v, k) => (idxSize === 2 ? idv.setUint16(k * 2, v, true) : idv.setUint32(k * 4, v, true)));
      const vb = new Uint8Array(nz.length * elem), vdv = new DataView(vb.buffer);
      nz.forEach((v, k) => { for (let c = 0; c < 3; c++) { if (q) vdv.setInt16((k * 3 + c) * 2, stored[3 * v + c], true); else vdv.setFloat32((k * 3 + c) * 4, stored[3 * v + c], true); } });
      def.sparse = { count: nz.length, indices: { bufferView: addView(ib), componentType: idxSize === 2 ? USHORT : UINT }, values: { bufferView: addView(vb) } };
      stats.sparse++;
    } else {
      const stride = q ? 8 : 12, b = new Uint8Array(n * stride), dv = new DataView(b.buffer);
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { if (q) dv.setInt16(i * stride + c * 2, stored[3 * i + c], true); else dv.setFloat32(i * stride + c * 4, stored[3 * i + c], true); }
      def.bufferView = addView(b, { target: 34962, byteStride: stride });
      stats.dense++;
    }
    replaced.set(ai, def);
  }
  for (const [ai, def] of replaced) json.accessors[ai] = def;
  dedupeSkins(json, bin);
  for (const m of json.meshes || []) for (const p of m.primitives) for (const t of p.targets || []) for (const k in t) if (remapAcc.has(t[k])) t[k] = remapAcc.get(t[k]);
  if (stats.quantized) {
    json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'KHR_mesh_quantization'])];
    json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), 'KHR_mesh_quantization'])];
  }
  return repack(json, bin, extra, stats);
}

/** Drops unreferenced accessors / bufferViews and rebuilds the binary chunk (new views: negative indices). */
function repack(json, bin, extra, stats) {
  // accessors still referenced
  const usedAcc = new Set();
  const markAcc = i => { if (i !== undefined) usedAcc.add(i); };
  for (const m of json.meshes || []) for (const p of m.primitives) {
    Object.values(p.attributes).forEach(markAcc); markAcc(p.indices);
    for (const t of p.targets || []) Object.values(t).forEach(markAcc);
  }
  for (const s of json.skins || []) markAcc(s.inverseBindMatrices);
  for (const an of json.animations || []) for (const s of an.samplers) { markAcc(s.input); markAcc(s.output); }
  const accMap = new Map(), accessors = [];
  (json.accessors || []).forEach((a, i) => { if (usedAcc.has(i)) { accMap.set(i, accessors.length); accessors.push(a); } });
  const ra = i => accMap.get(i);
  for (const m of json.meshes || []) for (const p of m.primitives) {
    for (const k in p.attributes) p.attributes[k] = ra(p.attributes[k]);
    if (p.indices !== undefined) p.indices = ra(p.indices);
    for (const t of p.targets || []) for (const k in t) t[k] = ra(t[k]);
  }
  for (const s of json.skins || []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = ra(s.inverseBindMatrices);
  for (const an of json.animations || []) for (const s of an.samplers) { s.input = ra(s.input); s.output = ra(s.output); }
  json.accessors = accessors;

  // bufferViews referenced by accessors (incl. sparse) and images
  const refs = [];
  for (const a of accessors) {
    if (a.bufferView !== undefined) refs.push([a, 'bufferView']);
    if (a.sparse) { refs.push([a.sparse.indices, 'bufferView']); refs.push([a.sparse.values, 'bufferView']); }
  }
  for (const im of json.images || []) if (im.bufferView !== undefined) refs.push([im, 'bufferView']);
  const views = [], chunks = [], viewMap = new Map();
  let off = 0;
  const place = (bytes, props) => {
    const pad = (4 - (off % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); off += pad; }
    const v = { buffer: 0, byteOffset: off, byteLength: bytes.length, ...props };
    chunks.push(bytes); off += bytes.length;
    views.push(v);
    return views.length - 1;
  };
  for (const [obj, key] of refs) {
    const old = obj[key];
    if (viewMap.has(old)) { obj[key] = viewMap.get(old); continue; }
    let idx;
    if (old < 0) {
      const e = extra[-old - 1], props = {};
      if (e.target) props.target = e.target;
      if (e.byteStride) props.byteStride = e.byteStride;
      idx = place(e.bytes, props);
    } else {
      const bv = json.bufferViews[old], props = {};
      for (const k of ['byteStride', 'target', 'name', 'extras']) if (bv[k] !== undefined) props[k] = bv[k];
      idx = place(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), props);
    }
    viewMap.set(old, idx);
    obj[key] = idx;
  }
  const pad = (4 - (off % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); off += pad; }
  const out = new Uint8Array(off);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  json.bufferViews = views;
  json.buffers = off ? [{ byteLength: off }] : [];
  if (!off) delete json.buffers;
  return { json, bin: out, stats };
}

/** Skins with the same joints and the same inverse bind matrices (one per skinned mesh from GLTFExporter) -> one. */
export function dedupeSkins(json, bin) {
  if (!json.skins || json.skins.length < 2) return json;
  const keyOf = s => `${s.joints.join(',')}|${s.skeleton}|${s.inverseBindMatrices === undefined ? '' : hashFloats(readFloatAccessor(json, bin, s.inverseBindMatrices))}`;
  const first = new Map(), remap = [], skins = [];
  json.skins.forEach((s, i) => {
    const k = keyOf(s);
    if (!first.has(k)) { first.set(k, skins.length); skins.push(s); }
    remap[i] = first.get(k);
  });
  for (const nd of json.nodes || []) if (nd.skin !== undefined) nd.skin = remap[nd.skin];
  json.skins = skins;
  return json;
}

function hashFloats(f) {
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  return `${f.length}:${h}`;
}
function sameFloats(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(a[i] === 0 && b[i] === 0)) return false;
  return true;
}

/**
 * Final metadata: asset.generator / copyright, root + scene extras, per-animation extras (by name), per-node
 * extras merged (by node name). Returns the json (mutated).
 */
export function applyMetadata(json, { generator, copyright, extras, sceneExtras, animationExtras = {}, nodeExtras = {}, meshExtras = {} } = {}) {
  json.asset = { ...(json.asset || {}), version: '2.0' };
  if (generator) json.asset.generator = generator;
  if (copyright) json.asset.copyright = copyright;
  if (extras) json.extras = { ...(json.extras || {}), ...extras };
  if (sceneExtras && json.scenes?.[json.scene ?? 0]) {
    const s = json.scenes[json.scene ?? 0];
    s.extras = { ...(s.extras || {}), ...sceneExtras };
  }
  for (const a of json.animations || []) if (animationExtras[a.name]) a.extras = { ...(a.extras || {}), ...animationExtras[a.name] };
  for (const nd of json.nodes || []) {
    if (nodeExtras[nd.name]) nd.extras = { ...(nd.extras || {}), ...nodeExtras[nd.name] };
    const me = meshExtras[nd.name], mesh = nd.mesh !== undefined ? json.meshes?.[nd.mesh] : null;
    if (mesh && !mesh.name && nd.name) mesh.name = nd.name;
    if (me && mesh) mesh.extras = { ...(mesh.extras || {}), ...me };
  }
  return json;
}

/** Whole post-process: GLB ArrayBuffer -> GLB ArrayBuffer (+ stats). */
export function postProcessGlb(ab, { quantize = false, metadata = null } = {}) {
  const { json, bin } = parseGlb(ab);
  const r = compactMorphTargets(json, bin, { quantize });
  if (metadata) applyMetadata(r.json, metadata);
  return { glb: buildGlb(r.json, r.bin), stats: r.stats, json: r.json };
}
