// SPDX-License-Identifier: GPL-3.0-or-later
// Cloth integrity (tools/cloth_integrity.mjs): visible layer penetrations of layered outfits while the character
// idles, walks, runs and cross-fades idle -> run, with cloth physics as the viewer runs it (worker path, one frame
// latency). A reduced but representative matrix on a shortened timeline; the full matrix is
//   node tools/cloth_integrity.mjs            (table, exit code 1 above thresholds; --json for the report)
// docs/CLOTH_RUNTIME.md "Integrity harness" explains poke / sink and the baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadData, createCharacter } from '../tools/cloth_sim.mjs';
import { CONFIG, runCase, rows, table, outfitSurfaces } from '../tools/cloth_integrity.mjs';
import { hiddenZoneMask, coveringZoneMask } from '../web/clothing_rules.js';

// 0.5 s idle preroll, idle 0-0.5, walk 0.5-1.7, run 1.7-3.2, idle 3.2-3.8, idle -> run 3.8-4.6
const TIMELINE = [[-0.5, 'preroll', 'idle'], [0, 'idle', 'idle'], [0.5, 'walk', 'walk'], [1.7, 'run', 'run'],
  [3.2, 'idle', 'idle'], [3.8, 'idle>run', 'run']];
const CFG = { ...CONFIG, timeline: TIMELINE, duration: 4.6, every: 6 };

// outfit x body: every outfit of the full matrix once, bodies chosen where the problems were reported / seen
export const MATRIX = [
  ['tee+jeans+shoes', 'neutral'],
  ['tee+jeans+coat+shoes', 'female'],
  ['tee+skirt+shoes', 'female'],
  ['tee+skirt+coat', 'neutral'],
  ['jeans+coat', 'short'],
  ['tee+jeans+shoes', 'male'],
  // the default underwear alone (every outfit above is worn over the body sex's default underwear, CONFIG.underwear)
  ['underwear', 'muscular'],
  // review 2026-10-01 (the MATRIX ran no case that failed): the reported problems and the full matrix's failures
  ['coat', 'female'],             // coat over the underwear only (failed: trenchcoat:body)
  ['coat+shoes', 'neutral'],      // socks / shoes through the coat in run (failed: trenchcoat:socks 8 / 11.5 mm)
  ['tee+skirt+coat', 'female'],   // skirt through the coat, female coat stretch
  ['coat+shoes', 'old'],          // still fails: KNOWN_FAILING trenchcoat:socks
  ['tee+jeans+shoes', 'old'],     // still fails: KNOWN_FAILING tshirt:body
  // hoodie / long-sleeve shirt / shorts (docs/CLOTHING_GUIDE.md appendix): bodies where they were tightest
  ['hoodie+jeans+shoes', 'female'],
  ['shirt+shorts+shoes', 'muscular'],
  ['shirt+skirt', 'child'],       // the simulated skirt came out through the shirt hem (fixed: sim_layer_gap)
  ['hoodie+skirt', 'child'],
  ['shirt+jeans+coat', 'female'],
  // dress / jacket / boots (docs/CLOTHING_GUIDE.md appendix, second batch)
  ['dress+shoes', 'female'],
  ['dress+boots', 'short'],
  ['dress+shoes', 'tall'],        // the lifted thigh came through the pinned skirt top in the jump (fixed: zone_near_pinned)
  ['jacket+tee+jeans+shoes', 'heavy'],
  ['jacket+shirt+shorts+boots', 'muscular'],
  ['boots+jeans', 'male'],
  ['boots+shorts', 'child'],
  ['boots+skirt', 'female'],
];

/**
 * KNOWN FAILURES (baseline 2026-10-01). Each entry is a visible defect the harness measures today; it is allowed to
 * fail in this test. When a fix makes an entry pass, this test FAILS and asks for the entry to be removed - later
 * agents: delete the entries you fix (and never add one to hide a regression).
 * Fields: outfit (optional), pair 'outer:inner'; any body / clip of MATRIX.
 */
export const KNOWN_FAILING = [
  // Measured on this test's timeline, 2026-10-01 (the full matrix: docs/CLOTH_RUNTIME.md "Integrity harness").
  // old, run: the sock at the calf collar comes through the coat hem (5 vertices / 8.6 mm); the coat layer
  // thickness 0.015 fixed it on neutral / female / male but not here
  { outfit: 'coat+shoes', pair: 'trenchcoat:socks' },
  // old / child: the skinned (not simulated) T-shirt sinks into the belly (3-4 vertices, >= 24 mm), in every clip
  // since the T-shirt was fitted; not addressed by the review fixes
  { outfit: 'tee+jeans+shoes', pair: 'tshirt:body' },
];

const D = loadData();
const results = [];

test('integrity: hidden geometry is not tested (body zones hidden by the outfit, garment parts under a higher layer)', () => {
  const outfit = CFG.outfits['tee+jeans+coat+shoes'];
  const ch = createCharacter(D, {});
  const S = outfitSurfaces(D, ch, outfit, CFG);
  const hid = (id, zone, mask) => { const x = S.find(s => s.id === id); let bad = 0; for (let t = 0; t < x.tris.length; t += 3) if ([0, 1, 2].every(k => zone[x.tris[t + k]] & mask)) bad++; return { bad, tris: x.tris.length / 3 }; };
  const body = hid('body', D.body.zone, hiddenZoneMask(D.catalog, outfit));
  const tee = hid('tshirt', D.garments.tshirt.zone, coveringZoneMask(D.catalog, outfit, 'tshirt'));
  console.log(`# drawn triangles fully in hidden zones: body ${body.bad} of ${body.tris}, tee ${tee.bad} of ${tee.tris}; surfaces ${S.map(s => `${s.id}(${s.layer})`).join(' ')}`);
  assert.equal(body.bad, 0);
  assert.equal(tee.bad, 0);
  assert.ok(body.tris < D.body.index.length / 3 && tee.tris < D.garments.tshirt.index.length / 3);
  assert.ok(S.some(s => s.id === 'socks' && s.layer < S.find(x => x.id === 'shoes').layer), 'socks split off inside the shoes');
});
for (const [outfit, body] of MATRIX) {
  test(`integrity: ${outfit} / ${body}`, () => {
    const r = runCase(D, CFG.outfits[outfit], CFG.bodies[body], { cfg: CFG });
    r.name = outfit; r.bodyName = body;
    results.push(r);
    const rs = rows([r], CFG);
    console.log(table(rs) + `\n# ${outfit} / ${body}: ${r.measured} frames, ${(r.ms / 1000).toFixed(1)} s`);
    const known = rs.filter(x => x.fail && KNOWN_FAILING.some(k => (k.outfit == null || k.outfit === x.outfit) && k.pair === x.pair));
    const unknown = rs.filter(x => x.fail && !known.includes(x));
    for (const x of known) console.log(`# known failing: ${x.outfit} ${x.body} ${x.clip} ${x.pair} poke ${x.poke.n}/${x.poke.mm} mm, sink ${x.sink.n}/${x.sink.mm} mm (limit ${x.limit.n} vertices / ${x.limit.mm} mm)`);
    assert.deepEqual(unknown.map(x => `${x.outfit} ${x.body} ${x.clip} ${x.pair} poke ${x.poke.n}/${x.poke.mm} sink ${x.sink.n}/${x.sink.mm}`), [],
      'new visible penetrations above CONFIG.thresholds');
  });
}

// Regression (shoes): the sock skinned like the shoe around it (blender/cc_clothing.py sock_weights) and the jeans
// fitted over every part of the shoe (clearance: one collider per connected part, the sock no longer hides the
// tongue; wrap: the shoe's own vertices may not come out through the middle of a jeans face). Bodies the MATRIX does not cover; no shoes:socks / jeans:shoes case above the thresholds.
// The viewer's default body is male (gender 1); CONFIG.bodies are gender 0 apart from male / female, so the wide
// bodies are also run as their male variant (m-heavy, m-child: where the sock showed through the shoe).
const shoeBody = b => (b.startsWith('m-') ? { gender: 1, ...CFG.bodies[b.slice(2)] } : CFG.bodies[b]);
for (const body of ['child', 'heavy', 'tall', 'old', 'm-heavy', 'm-child']) {
  test(`integrity: shoes on ${body}: no sock through the shoe, no shoe through the jeans hem`, () => {
    const r = runCase(D, CFG.outfits['tee+jeans+shoes'], shoeBody(body), { cfg: CFG });
    r.name = 'tee+jeans+shoes'; r.bodyName = body;
    const rs = rows([r], CFG).filter(x => x.pair === 'shoes:socks' || x.pair === 'jeans:shoes');
    console.log(table(rs));
    assert.deepEqual(rs.filter(x => x.fail).map(x => `${x.clip} ${x.pair} poke ${x.poke.n}/${x.poke.mm} sink ${x.sink.n}/${x.sink.mm}`), []);
  });
}

// Static (bind pose, every body and its male variant): no sock triangle lies outside the shoe. The harness above
// tests vertices; the sock came out through the shoe's sides between its vertices (triangle interiors) on the wide
// male bodies, already standing still (blender/cc_clothing.py clearance keep_inside). A sock triangle fails when
// a ray from its centre against its normal hits the shoe within 3 cm and the ray along its normal hits nothing.
test('integrity: sock triangles stay inside the shoe at every body (bind pose)', () => {
  const tri = (S, t) => {
    const P = S.base, T = S.tris, a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2], s = S.sign[t / 3];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [s * (u[1] * v[2] - u[2] * v[1]), s * (u[2] * v[0] - u[0] * v[2]), s * (u[0] * v[1] - u[1] * v[0])];
    const l = Math.hypot(...n) || 1;
    return { a, b, c, P, u, v, n: n.map(x => x / l) };
  };
  const hits = (o, d, S, maxT) => {                                 // Moller-Trumbore against every triangle of S
    for (let t = 0; t < S.tris.length; t += 3) {
      const { a, P, u: e1, v: e2 } = tri(S, t);
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-14) continue;
      const s = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]];
      const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (tt > 0 && tt <= maxT) return true;
    }
    return false;
  };
  const bad = [];
  // boots: the shaft (shoes03's sock) inside the boot, same rule
  for (const [item, inner] of [['shoes', 'socks'], ['boots', 'shaft']]) {
    for (const [name, sl] of Object.entries(CFG.bodies).flatMap(([k, v]) => [[k, v], ['m-' + k, { gender: 1, ...v }]])) {
      const S = outfitSurfaces(D, createCharacter(D, sl), [item], CFG);
      const sock = S.find(s => s.id === inner), shoe = S.find(s => s.id === item);
      let n = 0;
      for (let t = 0; t < sock.tris.length; t += 3) {
        const { a, b, c, P, n: nn } = tri(sock, t);
        const o = [0, 1, 2].map(k => (P[a + k] + P[b + k] + P[c + k]) / 3);
        if (hits(o, nn.map(x => -x), shoe, 0.03) && !hits(o, nn, shoe, 0.03)) n++;
      }
      if (n) bad.push(`${item} ${name}: ${n}`);
    }
  }
  assert.deepEqual(bad, [], 'sock / shaft triangles outside the shoe / boot');
});

// Static (bind pose, both sexes): no see-through hole where underwear is culled. The body skin under the underwear is
// hidden by the underwear's own zone; an underwear triangle dropped as "covered" (its _CCZONE, blender/cc_clothing.py
// underwear_cover) must lie over skin the covering garment itself hides. Review 2026-10-01: under the T-shirt hem
// the briefs / panties were dropped over skin hidden only by the underwear -> stepped holes through the body.
// Every body triangle hidden ONLY thanks to the underwear zones must have a drawn surface over it (ray from its centre
// along its normal hits a drawn garment / underwear triangle within 8 cm, the reach of underwear_cover).
test('integrity: no hole through the body where covered underwear is culled (bind pose, male / female)', () => {
  const hit = (o, d, S, maxT) => {
    const P = S.base, T = S.tris;
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-14) continue;
      const s = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]];
      const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (tt > -0.002 && tt <= maxT) return true;
    }
    return false;
  };
  const bad = [];
  let tested = 0;
  for (const [sex, uw, gender] of [['male', ['briefs'], 1], ['female', ['panties', 'bra'], -1]]) {
    const ch = createCharacter(D, { gender });
    for (const top of [['tshirt'], ['jeans'], ['skirt'], ['trenchcoat'], ['tshirt', 'jeans'], ['tshirt', 'skirt'], ['shoes'],
      ['dress'], ['tshirt', 'jeans', 'jacket'], ['shorts', 'boots']]) {
      const outfit = [...uw, ...top];
      const S = outfitSurfaces(D, ch, outfit, CFG).filter(s => s.id !== 'body');
      const all = hiddenZoneMask(D.catalog, outfit), noUw = hiddenZoneMask(D.catalog, top);
      const z = D.body.zone, I = D.body.index, N = D.body.normals;
      const B = outfitSurfaces(D, ch, [], CFG).find(s => s.id === 'body').base;
      let n = 0;
      for (let t = 0; t < I.length; t += 3) {
        const v = [I[t], I[t + 1], I[t + 2]];
        if (!v.every(i => z[i] & all) || v.every(i => z[i] & noUw)) continue;   // drawn, or hidden by the garments
        tested++;
        const o = [0, 1, 2].map(k => (B[3 * v[0] + k] + B[3 * v[1] + k] + B[3 * v[2] + k]) / 3);
        const d = [0, 1, 2].map(k => N[3 * v[0] + k] + N[3 * v[1] + k] + N[3 * v[2] + k]), l = Math.hypot(...d) || 1;
        if (!S.some(s => hit(o, d.map(x => x / l), s, 0.08))) n++;
      }
      if (n) bad.push(`${sex} ${top.join('+')}: ${n} body triangles open`);
    }
  }
  console.log(`# body triangles hidden only by the underwear zones, tested: ${tested}`);
  assert.ok(tested > 500);
  assert.deepEqual(bad, [], 'holes through the body where culled underwear left skin hidden');
});

test('integrity: every KNOWN_FAILING entry still fails (remove the entries that are fixed)', () => {
  const rs = rows(results, CFG);
  const fixed = KNOWN_FAILING.filter(k => !rs.some(x => x.fail && (k.outfit == null || k.outfit === x.outfit) && k.pair === x.pair)
    && results.some(r => k.outfit == null || r.name === k.outfit));
  assert.deepEqual(fixed, [], 'these KNOWN_FAILING entries pass now: delete them from tests/integrity.test.mjs');
});
