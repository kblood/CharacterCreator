// Known visual faults as numeric checks (ROADMAP M2b, tools/visual_probes.mjs). A test that documents a fault that
// is still in the build is an EXPECTED FAILURE: it runs, but is marked `todo` with the fault and the milestone that
// should fix it, so `npm test` / CI stay green while the TODO line keeps the fault visible in every run. When the
// fault is fixed the todo test passes; then remove the `todo` so it guards against a regression.
// The full numbers (all bodies, poses, cloth on / off) are in docs/baseline/visual_probes.json:
//   node tools/visual_probes.mjs --json docs/baseline/visual_probes.json   (about 30 min, run it in the background)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../tools/cloth_sim.mjs';
import { CASES, PROBE_BODIES, dressCoatRules, probeAnimZone, probeJaw } from '../tools/visual_probes.mjs';
import { outfitWithUnderwear } from '../web/clothing_rules.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const D = loadData();
const report = (name, v) => console.log(`# ${name}: ${JSON.stringify(v)}`);

// Where each still-open fault is meant to be fixed. The roadmap has no milestone that names these faults yet; the
// pointer is the milestone whose scope covers the code (owner to confirm or assign another).
const FIX = {
  animZone: 'KNOWN FAULT (ROADMAP section 2 "Kendte fejl", probe M2b): base_body_anim.glb has no Body _CCZONE. Fix: blender/bake_clips.py; roadmap scope M10 (zone bits -> named zones), not named there yet',
  jaw: 'KNOWN FAULT (ROADMAP section 2 "Kendte fejl", probe M2b): the jacket hides jaw-underside skin that no garment covers (red fragment under the jaw). Fix: blender/cc_clothing.py zones; roadmap scope M11 (clothing core), not named there yet',
};

test('dress + trench coat: the outfit rules never give the pair (it is only reachable by forcing it)', () => {
  const r = dressCoatRules(D.catalog);
  report('dress+coat rules', r.orders.map(o => ({ order: o.order.join('>'), resolved: o.resolveOutfit.join('+') })));
  assert.equal(r.pairReachable, false);
  // the viewer's entry point (?outfit= / __set('outfit')) with the default underwear of both sexes
  for (const sex of ['male', 'female']) for (const list of ['dress,trenchcoat', 'trenchcoat,dress']) {
    const w = outfitWithUnderwear(D.catalog, list, sex);
    assert.ok(!(w.includes('dress') && w.includes('trenchcoat')), `${sex} ${list} -> ${w.join('+')}`);
  }
});

test('base_body_anim.glb keeps the body _CCZONE attribute (hidden-skin zones)', { todo: FIX.animZone }, () => {
  const z = probeAnimZone();
  report('anim zone', { base: z.baseBodyHasZone, anim: z.animBodyHasZone });
  assert.equal(z.baseBodyHasZone, true, 'base_body.glb Body _CCZONE (precondition)');
  assert.equal(z.animBodyHasZone, true, 'base_body_anim.glb Body _CCZONE');
});

test('jaw / neck: no hidden skin the jacket leaves uncovered, no mouth interior visible from below (bind pose, 9 bodies)', { todo: FIX.jaw }, () => {
  const j = probeJaw(D, { bodies: Object.keys(PROBE_BODIES), outfits: ['jacket+tee+jeans+shoes'], bindOnly: true });
  for (const r of j.rows) report(`jaw ${r.body}`, { uncovered: r.uncoveredHiddenTris, teeth: r.teethVisibleBelow, tongue: r.tongueVisibleBelow, aboveTop: r.hiddenAboveTopVerts });
  for (const r of j.rows) {
    assert.equal(r.hiddenAboveTopVerts, 0, `${r.body}: hidden skin above the garment top`);
    assert.equal(r.teethVisibleBelow + r.tongueVisibleBelow, 0, `${r.body}: teeth / tongue visible from below`);
    assert.equal(r.uncoveredHiddenTris, 0, `${r.body}: ${r.uncoveredHiddenTris} hidden jaw / neck triangles not covered within 5 cm`);
  }
});

test('jaw probe control: no clothes = nothing hidden, nothing visible through the skin', () => {
  const j = probeJaw(D, { bodies: ['male', 'female'], outfits: ['naked'], bindOnly: true });
  for (const r of j.rows) {
    assert.equal(r.hiddenJawNeckTris, 0);
    assert.equal(r.teethVisibleBelow + r.tongueVisibleBelow + r.uncoveredHiddenTris, 0, JSON.stringify(r.worst));
  }
});

test('visual probe baseline: docs/baseline/visual_probes.json holds every case', () => {
  const f = path.join(root, 'docs', 'baseline', 'visual_probes.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(j.tool, 'visual_probes');
  assert.equal(j.quick, false, 'the committed baseline is a full run');
  for (const k of CASES) assert.ok(j.cases[k], `case ${k}`);
  assert.equal(j.cases.dresscoat.rules.pairReachable, false);
});
