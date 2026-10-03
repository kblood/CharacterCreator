// SPDX-License-Identifier: GPL-3.0-or-later
// Parameter sweep helper: node tune.mjs <solver> <n> <body> '<json params>' ['<json params>' ...]
import fs from 'node:fs';
import { runOne } from './lib/run.mjs';
const [solver, n, bodyId, ...sets] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(new URL('./data/bodies.json', import.meta.url), 'utf8'));
const mod = await import(`./lib/solvers/${solver}.mjs`);
await mod.init?.();
for (const s of sets.length ? sets : ['{}']) {
  const r = await runOne(mod, data.bodies[bodyId || 'neutral'], Number(n || 500), { params: JSON.parse(s) });
  console.log(s.padEnd(60), `ms ${r.msMean} p95 ${r.msP95} | pen ${r.penEvents} deep ${r.deepEvents} max ${r.maxDepthMm}mm near ${r.nearPerFrame}/f | stretch max ${r.maxStretch} ring ${r.maxRingStretch} mean ${r.meanStretch} | jit ${r.idleJitterMm} | hemLag ${r.hemLagRunMm} rise ${r.hemRiseMaxMm} flip ${r.flipFrames} | ${r.exploded ? 'EXPLODED' : 'ok'} ${JSON.stringify(r.perCapsule)}`);
}
