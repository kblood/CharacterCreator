// SPDX-License-Identifier: GPL-3.0-or-later
// Prints the markdown tables used in docs/CLOTH_SOLVER_REPORT.md from results/*.json.
//   node summarize.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = f => { const p = path.join(HERE, 'results', f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const bench = R('bench_xpbd-rapier-jolt-springbone.json');
const timing = R('timing.json');
const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);
const max = (a, k) => Math.max(...a.map(r => r[k] || 0));

if (bench) {
  console.log(`\n### Skirt, 6 bodies x 10 s (node ${bench.node}, animation fingerprint ${bench.animHash})\n`);
  console.log('| solver | particles | pen. events (sum 6 bodies) | deep >20 mm | max depth mm | max down stretch | max ring stretch | idle jitter mm (max) | hem rise max mm | flipped frames (sum) | exploded | deterministic |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of ['xpbd', 'rapier', 'jolt', 'springbone']) for (const n of [500, 2000]) {
    const rows = bench.rows.filter(r => r.solver === s && r.n === n);
    if (!rows.length) continue;
    const det = rows.find(r => r.deterministic !== null)?.deterministic;
    console.log(`| ${s} | ${rows[0].particles} | ${sum(rows, 'penEvents')} | ${sum(rows, 'deepEvents')} | ${max(rows, 'maxDepthMm')} | ${max(rows, 'maxStretch')} | ${max(rows, 'maxRingStretch')} | ${max(rows, 'idleJitterMm')} | ${max(rows, 'hemRiseMaxMm')} | ${sum(rows, 'flipFrames')} | ${rows.filter(r => r.exploded).map(r => r.body).join(', ') || 'none'} | ${det} |`);
  }
  console.log('\nPer body (pen events / hem rise mm / flipped frames):\n');
  const bodies = [...new Set(bench.rows.map(r => r.body))];
  console.log(`| solver | n | ${bodies.join(' | ')} |`); console.log(`|---|---|${bodies.map(() => '---').join('|')}|`);
  for (const s of ['xpbd', 'rapier', 'jolt', 'springbone']) for (const n of [500, 2000]) {
    const rows = bench.rows.filter(r => r.solver === s && r.n === n);
    if (rows.length) console.log(`| ${s} | ${rows[0].particles} | ${bodies.map(b => { const r = rows.find(x => x.body === b); return r ? `${r.penEvents} / ${r.hemRiseMaxMm} / ${r.flipFrames}${r.exploded ? ' X' : ''}` : '-'; }).join(' | ')} |`);
  }
}
if (timing) {
  console.log(`\n### CPU timing, neutral body, best of ${timing.repeats} (node ${timing.node}, ${timing.cpu})\n`);
  console.log('| solver | particles | median ms/frame | mean | p95 | init ms |'); console.log('|---|---|---|---|---|---|');
  for (const r of timing.rows) console.log(`| ${r.solver} | ${r.particles} | ${r.msMedian} | ${r.msMean} | ${r.msP95} | ${r.initMs} |`);
}
for (const [f, label] of [['hair.json', 'short hair'], ['hair_long.json', 'long hair']]) {
  const h = R(f); if (!h) continue;
  console.log(`\n### Hair (${label}: ${h.strands} strands x ${h.jointsPerStrand} joints, segment ${h.segment} m), 6 bodies\n`);
  console.log('| solver | joints | ms/frame (mean of bodies) | pen events (sum) | deep | max depth mm | max stretch | tip swing mm (max) | idle jitter mm (max) | deterministic |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const s of ['springbone', 'xpbd']) {
    const rows = h.rows.filter(r => r.solver === s); if (!rows.length) continue;
    console.log(`| ${s} | ${rows[0].joints} | ${(sum(rows, 'msMean') / rows.length).toFixed(3)} | ${sum(rows, 'penEvents')} | ${sum(rows, 'deepEvents')} | ${max(rows, 'maxDepthMm')} | ${max(rows, 'maxStretch')} | ${max(rows, 'tipSwingMm')} | ${max(rows, 'idleJitterMm')} | ${rows.find(r => r.deterministic !== null)?.deterministic} |`);
  }
}
for (const f of fs.readdirSync(path.join(HERE, 'results')).filter(f => f.startsWith('browser_'))) {
  const b = R(f);
  console.log(`\n### ${f}\n`);
  console.log('| solver | n | body | ms/frame | extra | pen | deep | max mm | stretch | ring | jitter | rise | flip | hash |'); console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of b.rows) console.log(`| ${r.solver} | ${r.particles ?? r.n} | ${r.body} | ${r.msMean} | ${r.throughputMs != null ? 'no-readback ' + r.throughputMs : ''} | ${r.penEvents} | ${r.deepEvents} | ${r.maxDepthMm} | ${r.maxStretch} | ${r.maxRingStretch} | ${r.idleJitterMm} | ${r.hemRiseMaxMm ?? ''} | ${r.flipFrames ?? ''} | ${r.hash} |`);
}
