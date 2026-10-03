// SPDX-License-Identifier: GPL-3.0-or-later
// Clean CPU timing (node): neutral body, each solver x n repeated R times; reports the best (lowest) median
// and mean ms/frame of the repeats, to damp noise from other processes. Run with nothing else busy.
//   node timing.mjs [--solvers=xpbd,rapier,jolt,springbone] [--n=500,2000] [--repeats=3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOne } from './lib/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'data/bodies.json'), 'utf8'));
const SOLVERS = (args.solvers || 'xpbd,rapier,jolt,springbone').split(',');
const NS = (args.n || '500,2000').split(',').map(Number);
const R = Number(args.repeats || 3);
const rows = [];
for (const s of SOLVERS) {
  const mod = await import(`./lib/solvers/${s}.mjs`);
  await mod.init?.();
  for (const n of NS) {
    const runs = [];
    for (let k = 0; k < R; k++) runs.push(await runOne(mod, data.bodies.neutral, n));
    const row = { solver: s, particles: runs[0].particles, msMedian: Math.min(...runs.map(r => r.msMedian)),
      msMean: Math.min(...runs.map(r => r.msMean)), msP95: Math.min(...runs.map(r => r.msP95)), initMs: Math.min(...runs.map(r => r.initMs)) };
    rows.push(row);
    console.log(s.padEnd(10), String(row.particles).padStart(5), `median ${row.msMedian} mean ${row.msMean} p95 ${row.msP95} init ${row.initMs} ms`);
  }
}
const cpu = os.cpus()[0]?.model?.trim() || 'unknown CPU';
fs.writeFileSync(path.join(HERE, 'results/timing.json'), JSON.stringify({ node: process.version, cpu, repeats: R, rows }, null, 1));
console.log('wrote results/timing.json');
