// SPDX-License-Identifier: GPL-3.0-or-later
// Hair / loose parts test (node): K strands x M joints hanging from the back of the head, simulated by
//   springbone  (E, @pixiv/three-vrm-springbone, one VRM joint chain per strand)
//   xpbd        (D, the same lib/solvers/xpbd.mjs, strands = distance chains + skip-one bending, no cross links)
// over the same 10 s walk/run/idle->run timeline and 6 bodies. Colliders: head sphere (short capsule),
// neck, chest, shoulders (data/hair_colliders.json from prep_hair.mjs). Root joint of each strand is rigid on the head.
//   node hair.mjs [--solvers=springbone,xpbd] [--bodies=...] [--strands=24] [--joints=7]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frames, HZ } from './lib/drive.mjs';
import { qRotate } from '../../web/animation/qmath.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'data/bodies.json'), 'utf8'));
const hairData = JSON.parse(fs.readFileSync(path.join(HERE, 'data/hair_colliders.json'), 'utf8'));
const SOLVERS = (args.solvers || 'springbone,xpbd').split(',');
const BODY_IDS = (args.bodies || Object.keys(data.bodies).join(',')).split(',');
const K = Number(args.strands || 24), M = Number(args.joints || 7), SEG = 0.04;
const TOL = 0.005, DEEP = 0.02;

/** strands as a "garment": around = K strands, rows = M joints, vertex v = j*K + i; row 0 pinned. */
function buildHair(body, hc) {
  const C = hc.headSphere.c, R = hc.headSphere.r, N = K * M;
  const pos = new Float32Array(N * 3), mask = new Float32Array(N), row = new Uint16Array(N);
  for (let i = 0; i < K; i++) {
    const az = Math.PI * (100 + (160 * i) / (K - 1)) / 180, el = (i % 2 ? 5 : 15) * Math.PI / 180;
    const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    const out = [dir[0], 0, dir[2]], L = Math.hypot(out[0], out[2]);
    for (let j = 0; j < M; j++) {
      const v = j * K + i;
      // root on the scalp, then down and slightly outwards, kept outside the head sphere (+1 cm)
      let p = [C[0] + dir[0] * R, C[1] + dir[1] * R - j * SEG * 0.95, C[2] + dir[2] * R];
      p[0] += (out[0] / L) * j * SEG * 0.3; p[2] += (out[2] / L) * j * SEG * 0.3;
      const d = [p[0] - C[0], p[1] - C[1], p[2] - C[2]], dl = Math.hypot(...d);
      if (j > 0 && dl < R + 0.01) p = d.map((x, k) => C[k] + x * (R + 0.01) / dl);
      pos.set(p, 3 * v); mask[v] = j === 0 ? 1 : 0; row[v] = j;
    }
  }
  const edges = [], bends = [];
  for (let i = 0; i < K; i++) for (let j = 0; j < M; j++) {
    if (j + 1 < M) edges.push(j * K + i, (j + 1) * K + i);
    if (j + 2 < M) bends.push(j * K + i, (j + 2) * K + i);
  }
  const len = (a, b) => Math.hypot(pos[3 * a] - pos[3 * b], pos[3 * a + 1] - pos[3 * b + 1], pos[3 * a + 2] - pos[3 * b + 2]);
  const rest = arr => Float32Array.from({ length: arr.length / 2 }, (_, k) => len(arr[2 * k], arr[2 * k + 1]));
  return { around: K, rows: M, count: N, pos, mask, row, edges: Uint32Array.from(edges), edgeRest: rest(edges),
    shear: new Uint32Array(0), shearRest: new Float32Array(0), bends: Uint32Array.from(bends), bendRest: rest(bends), tris: new Uint32Array(0) };
}

/** frame adapter: the solvers attach pinned rows to frame.hipsPos/hipsQ with body.heads.hips as rest -> use the head. */
function hairFrame(f, body, hc) {
  const H = body.heads.head;
  const toWorld = p => { const r = qRotate(f.headQ, [p[0] - H[0], p[1] - H[1], p[2] - H[2]]); return [f.P.head[0] + r[0], f.P.head[1] + r[1], f.P.head[2] + r[2]]; };
  const c = hc.headSphere.c;
  const capsules = [{ name: 'head', a: toWorld([c[0], c[1] - 0.01, c[2]]), b: toWorld([c[0], c[1] + 0.01, c[2]]), r: hc.headSphere.r }];
  for (const [name, k] of Object.entries(hc.capsules)) capsules.push({ name, a: f.P[k.a], b: f.P[k.b], r: k.r });
  return { ...f, hipsPos: f.P.head, hipsQ: f.headQ, capsules, toWorld };
}

import { poseToWorld } from '../../web/animation/canonical.js';
function* hairFrames(body, hc) {
  for (const f of frames(body)) { f.headQ = poseToWorld(f.pose.joints).head; yield hairFrame(f, body, hc); }
}

function segDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-12)));
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
}

async function runHair(mod, bodyId) {
  const body = data.bodies[bodyId], hc = hairData.bodies[bodyId];
  const g = buildHair(body, hc);
  const pseudoBody = { ...body, heads: { ...body.heads, hips: body.heads.head } };
  let solver = null, near = 0, swing = 0, tipRest = null, pen = 0, deep = 0, maxDepth = 0, maxStretch = 1, hash = 0x811c9dc5, nan = false;
  const ms = [], idle = [];
  for (const f of hairFrames(body, hc)) {
    const pin = new Float32Array(g.count * 3);
    for (let v = 0; v < g.count; v++) pin.set(f.toWorld([g.pos[3 * v], g.pos[3 * v + 1], g.pos[3 * v + 2]]), 3 * v);
    if (!solver) { solver = await mod.createSolver(g, pseudoBody, f, pin, {}); continue; }
    const t0 = performance.now();
    await solver.step(f, pin, 1 / HZ);
    const P = solver.positions();
    ms.push(performance.now() - t0);
    if (!f.measured) continue;
    for (let v = K; v < g.count; v++) {
      const p = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
      if (!Number.isFinite(p[0])) nan = true;
      for (const c of f.capsules) {
        const d = c.r - segDist(p, c.a, c.b);
        if (d > -0.01) near++;
        if (d > TOL) { pen++; if (d > DEEP) deep++; maxDepth = Math.max(maxDepth, d); }
      }
    }
    for (let k = 0; k < g.edges.length / 2; k++) {
      const a = g.edges[2 * k], b = g.edges[2 * k + 1];
      maxStretch = Math.max(maxStretch, Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]) / g.edgeRest[k]);
    }
    const inv = [-f.headQ[0], -f.headQ[1], -f.headQ[2], f.headQ[3]], loc = [];   // tips in head-local space
    for (let i = 0; i < K; i++) { const v = (M - 1) * K + i; loc.push(...qRotate(inv, [P[3 * v] - f.P.head[0], P[3 * v + 1] - f.P.head[1], P[3 * v + 2] - f.P.head[2]])); }
    if (!tipRest) tipRest = loc;
    for (let k = 0; k < loc.length; k += 3) swing = Math.max(swing, Math.hypot(loc[k] - tipRest[k], loc[k + 1] - tipRest[k + 1], loc[k + 2] - tipRest[k + 2]));
    if (f.t >= 6.5 && f.t < 7.5) idle.push(loc);
    for (let i = 0; i < P.length; i++) hash = Math.imul(hash ^ (Math.round(P[i] * 1e5) & 0xffffffff), 16777619) >>> 0;
  }
  let jit = 0, cnt = 0;
  for (let s = 2; s < idle.length; s++) for (let k = 0; k < idle[s].length; k++) { jit += (idle[s][k] - 2 * idle[s - 1][k] + idle[s - 2][k]) ** 2; cnt++; }
  const meas = ms.slice(HZ), sorted = [...meas].sort((a, b) => a - b);
  return { joints: g.count, strands: K, msMean: +(meas.reduce((a, b) => a + b, 0) / meas.length).toFixed(3), msMedian: +sorted[sorted.length >> 1].toFixed(3),
    nearPerFrame: +(near / 601).toFixed(1), tipSwingMm: +(swing * 1000).toFixed(0), penEvents: pen, deepEvents: deep, maxDepthMm: +(maxDepth * 1000).toFixed(1), maxStretch: +maxStretch.toFixed(3),
    idleJitterMm: +(Math.sqrt(jit / Math.max(1, cnt)) * 1000).toFixed(3), nan, hash: hash.toString(16) };
}

const rows = [];
for (const s of SOLVERS) {
  const mod = await import(`./lib/solvers/${s}.mjs`);
  await mod.init?.();
  for (const b of BODY_IDS) {
    const r = await runHair(mod, b);
    const det = b === 'neutral' ? (await runHair(mod, b)).hash === r.hash : null;
    rows.push({ solver: s, body: b, ...r, deterministic: det });
    console.log(s.padEnd(10), b.padEnd(8), `joints ${r.joints}`, `ms ${r.msMean} (med ${r.msMedian})`, `pen ${r.penEvents} deep ${r.deepEvents} max ${r.maxDepthMm}mm`,
      `stretch ${r.maxStretch}`, `near ${r.nearPerFrame}/f swing ${r.tipSwingMm}mm`, `jit ${r.idleJitterMm}mm`, r.nan ? 'NaN' : '', det === null ? '' : `det=${det}`);
  }
}
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results/hair.json'), JSON.stringify({ node: process.version, strands: K, jointsPerStrand: M, segment: SEG, rows }, null, 1));
console.log('wrote results/hair.json');
