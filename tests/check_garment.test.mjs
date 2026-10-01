// Garment checker (tools/check_garment.mjs, docs/CLOTHING_GUIDE.md): every catalog garment passes it with
// --bodies quick (static checks, clearance on the 9 bodies, cloth sim + integrity on CONFIG.quickBodies).
// Measured defects that are accepted are listed with a reason in tools/check_garment.mjs CONFIG.knownExceptions;
// the checker turns an exception that no longer fails into a FAIL, so the list stays current.
// Full matrix: node tools/check_garment.mjs <id> --bodies all
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGarment, table, CONFIG } from '../tools/check_garment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'output', 'clothing.json'), 'utf8'));

for (const it of catalog.items) {
  test(`check_garment ${it.id}: no failing check`, async () => {
    const rep = await checkGarment(it.id, { bodies: 'quick' });
    const bad = rep.rows.filter(r => r.status === 'FAIL');
    const known = rep.rows.filter(r => r.status === 'KNOWN');
    if (known.length) console.log(`# ${it.id}: ${known.length} known exception(s): ${known.map(r => r.check).join('; ')}`);
    assert.equal(bad.length, 0, table(rep));
    // the checks really ran
    for (const c of ['glb: loads', 'morphs: names', 'skin: weights', 'budget: bytes', 'catalog: fields', 'clearance: skin']) {
      assert.ok(rep.rows.some(r => r.check.startsWith(c) && r.status !== 'SKIP'), `${it.id}: ${c} ran`);
    }
    if (it.cloth) assert.ok(rep.rows.some(r => r.check.startsWith('sim: ') && r.status === 'OK'), `${it.id}: cloth sim ran`);
  });
}

test('check_garment: conflicting items may share a layer; chest tops need dyn_breast + BREAST_SUPPORT', { skip: !catalog.items.some(i => i.id === 'hoodie') }, async () => {
  const rep = await checkGarment('hoodie', { bodies: 'quick', sim: false });
  const row = c => rep.rows.find(r => r.check.startsWith(c));
  // the hoodie and the coat are both layer 4 but conflict (never worn together): not a layering ambiguity
  assert.equal(row('catalog: layer unique').status, 'OK', row('catalog: layer unique').value);
  for (const id of ['hoodie', 'shirt']) {
    const r = id === 'hoodie' ? rep : await checkGarment(id, { bodies: 'quick', sim: false });
    assert.equal(r.rows.find(x => x.check.startsWith('morphs: dyn_breast')).status, 'OK', `${id}: chest garment`);
    assert.equal(r.rows.find(x => x.check.startsWith('ui: BREAST_SUPPORT')).status, 'OK', `${id}: BREAST_SUPPORT`);
  }
});

test('check_garment: second batch - dress (top + bottom, cloth, chest), jacket (outerwear over the tops), boots (shoes slot)', { skip: !['dress', 'jacket', 'boots'].every(id => catalog.items.some(i => i.id === id)) }, async () => {
  const items = Object.fromEntries(catalog.items.map(i => [i.id, i]));
  assert.deepEqual(items.dress.occupies, ['top', 'bottom']);
  assert.ok(items.dress.cloth && !items.jacket.cloth && !items.boots.cloth, 'dress simulated, jacket / boots skinned');
  for (const c of ['trenchcoat', 'hoodie', 'dress']) assert.ok(items.jacket.conflicts.includes(c), `jacket conflicts with ${c}`);
  // the coat is built before the dress and never fitted over it (13 failing integrity cases worn together)
  assert.ok(items.dress.conflicts.includes('trenchcoat'), 'dress conflicts with the trench coat');
  assert.equal(items.boots.slot, 'shoes');
  for (const id of ['dress', 'jacket']) {
    const r = await checkGarment(id, { bodies: 'quick', sim: false });
    assert.equal(r.rows.find(x => x.check.startsWith('morphs: dyn_breast')).status, 'OK', `${id}: chest garment`);
    assert.equal(r.rows.find(x => x.check.startsWith('ui: BREAST_SUPPORT')).status, 'OK', `${id}: BREAST_SUPPORT`);
  }
  for (const [id, under] of [['jacket', ['tshirt', 'jeans']], ['boots', []]]) assert.deepEqual(CONFIG.under[id], under, `${id}: checked over ${under}`);
});

test('check_garment: every known exception names a catalog garment and gives a reason', () => {
  for (const e of CONFIG.knownExceptions) {
    assert.ok(catalog.items.some(i => i.id === e.id), `exception for unknown garment ${e.id}`);
    assert.ok(e.check && e.reason && e.reason.length > 20, `${e.id} ${e.check}: reason`);
  }
});

test('check_garment: a broken catalog entry and a missing garment fail', async () => {
  const rep = await checkGarment('no_such_garment');
  assert.ok(rep.fail);
  // a GLB outside a catalog folder: GLB-level checks only, catalog rows skipped
  const glb = await checkGarment(path.join(root, 'output', 'clothing_briefs.glb'));
  assert.equal(glb.id, 'briefs', 'a GLB listed by its folder clothing.json is checked as that item');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgarment-'));
  try {
    fs.copyFileSync(path.join(root, 'output', 'clothing_briefs.glb'), path.join(tmp, 'new_garment.glb'));
    const lone = await checkGarment(path.join(tmp, 'new_garment.glb'), { sim: false });
    assert.equal(lone.id, null);
    assert.ok(lone.rows.some(r => r.check === 'catalog: entry' && r.status === 'SKIP'), 'catalog rows skipped');
    assert.ok(lone.rows.some(r => r.check.startsWith('clearance: skin') && r.status === 'OK'), 'clearance still runs');
    assert.ok(!lone.fail, table(lone));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
