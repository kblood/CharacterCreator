// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the measured baseline (ROADMAP M2) as small, diffable JSON files under docs/baseline/ from the raw outputs
// of the long runs. Later milestones compare against these files ("not worse than the M2 baseline").
//   node tools/baseline_summary.mjs --out docs/baseline [--tests <npm test log>] [--check-garment <json>]
//        [--integrity default=<json>,moves=<json>,land=<json>] [--determinism <json>] [--commit <sha>]
// Raw inputs come from (run in the background, they take long):
//   npm test > tests.log 2>&1
//   node tools/check_garment.mjs <every catalog id> --bodies all --json > check_garment.json
//   node tools/cloth_integrity.mjs --timeline default|moves|land --json <file>
// glb_sizes.json is always written from output/ (bytes + sha256 per file).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const outDir = path.resolve(opt('--out') || path.join(PROJECT, 'docs', 'baseline'));
const commit = opt('--commit');
fs.mkdirSync(outDir, { recursive: true });
const write = (name, obj) => {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(obj, null, 1) + '\n');
  console.log(`wrote ${path.relative(PROJECT, path.join(outDir, name)).replace(/\\/g, '/')}`);
};
const meta = { commit, node: process.version, measured: new Date().toISOString().slice(0, 10) };

// ---- GLB / JSON sizes of output/ ----
{
  const dir = path.join(PROJECT, 'output'), files = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile() || !/\.(glb|json)$/.test(f)) continue;
    const b = fs.readFileSync(p);
    files[f] = { bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
  }
  const glb = Object.entries(files).filter(([f]) => f.endsWith('.glb'));
  write('glb_sizes.json', { ...meta, totalGlbBytes: glb.reduce((a, [, v]) => a + v.bytes, 0), files });
}

// ---- test suite (node --test spec reporter output) ----
const testsLog = opt('--tests');
if (testsLog) {
  const s = fs.readFileSync(testsLog, 'utf8').replace(/\r/g, '');
  const num = k => { const m = s.match(new RegExp(`^ℹ ${k} (\\d+(?:\\.\\d+)?)$`, 'm')); return m ? +m[1] : null; };
  const failSection = s.split('✖ failing tests:')[1] ?? '';
  const failing = [...new Set([...failSection.matchAll(/^✖ (.+?) \(\d+(?:\.\d+)?ms\)$/gm)].map(m => m[1]))].filter(n => !/\.test\.mjs$/.test(n));
  const reports = [...s.matchAll(/^# (coat layers female summary): (.*?) {2}\(tolerance/gm)].map(m => ({ name: m[1], value: JSON.parse(m[2]) }));
  write('tests.json', { ...meta, command: 'npm test', tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'),
    todo: num('todo'), durationMs: num('duration_ms'), failing, reports });
}

// ---- check_garment --bodies all ----
const cg = opt('--check-garment');
if (cg) {
  const reps = [].concat(JSON.parse(fs.readFileSync(cg, 'utf8')));
  const garments = {};
  for (const r of reps) {
    const count = {};
    for (const row of r.rows) count[row.status] = (count[row.status] || 0) + 1;
    garments[r.id ?? r.file] = { fail: r.fail, ...count, failing: r.rows.filter(x => x.status === 'FAIL').map(x => `${x.check}: ${x.value} (limit ${x.limit})`),
      known: r.rows.filter(x => x.status === 'KNOWN').map(x => `${x.check}: ${x.value}`) };
  }
  write('check_garment.json', { ...meta, command: 'node tools/check_garment.mjs <all catalog ids> --bodies all --json',
    garments: Object.keys(garments).length, failingGarments: Object.entries(garments).filter(([, v]) => v.fail).map(([k]) => k), perGarment: garments });
}

// ---- cloth integrity matrix ----
const integ = opt('--integrity');
if (integ) {
  for (const kv of integ.split(',')) {
    const [tl, file] = kv.split('=');
    const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hit = rep.rows.filter(r => r.poke.n || r.sink.n);
    write(`integrity_${tl}.json`, { ...meta, command: `node tools/cloth_integrity.mjs --timeline ${tl} --json <file>`, timeline: tl,
      cases: rep.rows.length, failing: rep.failing, casesWithAnyHit: hit.length, summary: rep.summary,
      failingRows: rep.rows.filter(r => r.fail), hitRows: hit.filter(r => !r.fail) });
  }
}

// ---- build determinism ----
const det = opt('--determinism');
if (det) write('determinism.json', { ...meta, ...JSON.parse(fs.readFileSync(det, 'utf8')) });
