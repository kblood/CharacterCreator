// Build determinism check (ROADMAP M2): compares two build output folders file by file (sha256). For a GLB that
// differs it reports WHERE: the JSON chunk (first differing JSON paths) and / or the BIN chunk (differing byte count
// and the bufferViews / accessors / meshes that contain the differing bytes).
//   node tools/compare_builds.mjs <dirA> <dirB> [--json <file>]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const ji = args.indexOf('--json');
const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
const [A, B] = args;
if (!A || !B) { console.error('usage: node tools/compare_builds.mjs <dirA> <dirB> [--json <file>]'); process.exit(2); }

const sha = b => createHash('sha256').update(b).digest('hex');
function glbChunks(b) {
  const out = {};
  let o = 12;
  while (o + 8 <= b.length) {
    const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4);
    out[type === 0x4E4F534A ? 'json' : 'bin'] = { start: o + 8, data: b.subarray(o + 8, o + 8 + len) };
    o += 8 + len;
  }
  return out;
}
function jsonDiff(a, b, p = '', acc = []) {
  if (acc.length >= 20) return acc;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null || typeof a !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) acc.push({ path: p || '/', a: JSON.stringify(a)?.slice(0, 80), b: JSON.stringify(b)?.slice(0, 80) });
    return acc;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) jsonDiff(a[k], b[k], `${p}/${k}`, acc);
  return acc;
}
function compareGlb(ba, bb) {
  const ca = glbChunks(ba), cb = glbChunks(bb), r = {};
  const ja = JSON.parse(ca.json.data.toString('utf8')), jb = JSON.parse(cb.json.data.toString('utf8'));
  r.jsonDiffs = jsonDiff(ja, jb);
  if (!ca.bin || !cb.bin) return r;
  const x = ca.bin.data, y = cb.bin.data;
  r.binBytes = [x.length, y.length];
  if (x.length !== y.length) return r;
  let n = 0, maxAbs = 0;
  const views = new Map();
  (ja.bufferViews || []).forEach((v, i) => views.set(i, { i, start: v.byteOffset || 0, end: (v.byteOffset || 0) + v.byteLength, n: 0 }));
  for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) {
    n++;
    for (const v of views.values()) if (k >= v.start && k < v.end) { v.n++; break; }
  }
  r.binDiffBytes = n;
  const hit = [...views.values()].filter(v => v.n);
  // name the views: accessor -> mesh attribute / target / skin / animation
  const label = new Map();
  (ja.accessors || []).forEach((acc, ai) => { if (acc.bufferView !== undefined) label.set(acc.bufferView, (label.get(acc.bufferView) || []).concat(`accessor ${ai}`)); });
  (ja.meshes || []).forEach(m => m.primitives.forEach(pr => {
    for (const [att, ai] of Object.entries(pr.attributes)) { const bv = ja.accessors[ai].bufferView; label.set(bv, (label.get(bv) || []).concat(`${m.name}.${att}`)); }
    (pr.targets || []).forEach((t, ti) => { for (const [att, ai] of Object.entries(t)) { const bv = ja.accessors[ai].bufferView; label.set(bv, (label.get(bv) || []).concat(`${m.name}.target${ti}.${att}`)); } });
  }));
  (ja.images || []).forEach((im, ii) => { if (im.bufferView !== undefined) label.set(im.bufferView, (label.get(im.bufferView) || []).concat(`image ${ii} ${im.name || ''}`.trim())); });
  r.binViews = hit.slice(0, 30).map(v => ({ bufferView: v.i, diffBytes: v.n, of: v.end - v.start, what: (label.get(v.i) || []).filter(s => !s.startsWith('accessor')).slice(0, 4) }));
  r.binViewsDiffering = hit.length;
  return r;
}

const files = [...new Set([...fs.readdirSync(A), ...fs.readdirSync(B)])].filter(f => fs.statSync(path.join(fs.existsSync(path.join(A, f)) ? A : B, f)).isFile()).sort();
const rep = { a: A, b: B, identical: [], different: [], onlyA: [], onlyB: [] };
for (const f of files) {
  const pa = path.join(A, f), pb = path.join(B, f);
  if (!fs.existsSync(pb)) { rep.onlyA.push(f); continue; }
  if (!fs.existsSync(pa)) { rep.onlyB.push(f); continue; }
  const ba = fs.readFileSync(pa), bb = fs.readFileSync(pb);
  if (sha(ba) === sha(bb)) { rep.identical.push(f); continue; }
  const d = { file: f, bytes: [ba.length, bb.length], sha256: [sha(ba), sha(bb)] };
  if (f.endsWith('.glb')) Object.assign(d, compareGlb(ba, bb));
  else if (f.endsWith('.json')) { try { d.jsonDiffs = jsonDiff(JSON.parse(ba), JSON.parse(bb)); } catch { /* not JSON */ } }
  rep.different.push(d);
}
const s = JSON.stringify(rep, null, 1);
if (jsonOut) fs.writeFileSync(jsonOut, s);
console.log(`identical ${rep.identical.length}, different ${rep.different.length}, only in A ${rep.onlyA.length}, only in B ${rep.onlyB.length}`);
for (const d of rep.different) console.log(`DIFF ${d.file}: json ${d.jsonDiffs?.length ?? '-'} paths, bin ${d.binDiffBytes ?? '-'} bytes in ${d.binViewsDiffering ?? '-'} views`);
process.exitCode = rep.different.length || rep.onlyA.length || rep.onlyB.length ? 1 : 0;
