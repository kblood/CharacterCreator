// Trench coat standing collar + lapels (blender/cc_clothing.py coat_collar) and covered lower layers (hide_lower):
// size budget, pinning, skinning, clearance to neck / jaw / ears at every morph extreme + face / gaze morphs,
// short hair styles clear of the collar, T-shirt triangles hidden under the pinned coat.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jointNames, readGlb, meshParts } from '../tools/glb.mjs';
import * as C from '../tools/cloth_check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = f => path.join(root, 'output', f);
const D = C.loadAll();
const coat = D.garments.trenchcoat, P = coat.prim.pos, I = coat.prim.indices;
const item = D.catalog.items.find(i => i.id === 'trenchcoat');
const flag = coat.prim.attr('_CCCOLLAR');
const isCollar = flag ? P.map((_, i) => flag[i] > 0.5) : [];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const ix = n => D.names.indexOf(n);
const mapW = (w, tn) => { const o = {}; for (const [t, x] of Object.entries(w)) { const j = tn.indexOf(D.names[t]); if (j >= 0) o[j] = x; } return o; };

function closestOnTri(p, a, b, c) {       // Ericson, Real-Time Collision Detection 5.1.5
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]; }
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}
function segTri(p, q, a, b, c) {
  const n = cross(sub(b, a), sub(c, a)), dp = dot(sub(p, a), n), dq = dot(sub(q, a), n);
  if (dp * dq > 0 || dp === dq) return false;
  const t = dp / (dp - dq), x = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
  const s1 = dot(cross(sub(b, a), sub(x, a)), n), s2 = dot(cross(sub(c, b), sub(x, b)), n), s3 = dot(cross(sub(a, c), sub(x, c)), n);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

// shapes: macro extremes + corrective corners, every face / gaze morph alone, and big-jaw/chin/ear faces with
// each gaze direction on the extreme bodies (gaze morphs at weight 1 = 30 deg, beyond the 24 deg look-at clamp)
const SHAPES = [...C.shapes(D.names)];
for (const n of D.names.filter(n => /^face_|^look_/.test(n))) SHAPES.push({ name: n, w: { [ix(n)]: 1 } });
for (const m of ['neutral', 'weight_max', 'muscle_max', 'age_child', 'age_old', 'gender_female', 'height_short', 'height_tall'])
  for (const look of ['look_left', 'look_right', 'look_down', 'look_up']) {
    const w = m === 'neutral' ? {} : { [ix(m)]: 1 };
    w[ix(look)] = 1;
    for (const f of ['face_jaw_width_incr', 'face_chin_incr', 'face_ear_size_incr', 'face_cheekbones_incr']) w[ix(f)] = 1;
    SHAPES.push({ name: `${m}+face+${look}`, w });
  }

test('collar: _CCCOLLAR attribute, vertex budget, coat size, catalog tint slots', () => {
  assert.ok(flag, 'coat carries _CCCOLLAR');
  const n = isCollar.filter(Boolean).length;
  // budget: _CCCOLLAR marks the standing collar only (125 GLB vertices; the lapels are 2 x 80 more). The whole
  // generated collar + lapels is 285 build vertices (57 columns x 5 rows, catalog projectOriginal), at most 400.
  assert.ok(n >= 60 && n <= 200, `standing collar vertices ${n}`);
  const built = +item.projectOriginal.match(/standing collar and lapels \((\d+) vertices/)[1];
  assert.ok(built >= 150 && built <= 400, `collar + lapel build vertices ${built}`);
  const top = Math.max(...P.filter((_, i) => isCollar[i]).map(p => p[1]));
  const neck = JSON.parse(fs.readFileSync(out('base_body.joints.json'), 'utf8')).bones.neck_01;
  assert.ok(top - neck[1] > 0.03, `collar top ${top.toFixed(3)} above the neck joint ${neck[1].toFixed(3)}`);
  assert.ok(item.bytes < 1.6e6, `coat ${item.bytes} bytes`);
  assert.match(item.projectOriginal, /coat_collar/);
  assert.ok(item.colors.primary && item.colors.secondary, 'primary + secondary tint');
  const mat = coat.glb.json.materials[0];
  assert.ok(mat.extras?.tint?.lining > 0, 'material extras tint.lining (back faces take the secondary colour)');
});

test('collar: fully pinned, skinned to neck / spine / clavicles (never the head), no cloth particles added', () => {
  const jn = jointNames(coat.glb);
  for (let i = 0; i < P.length; i++) {
    if (!isCollar[i]) continue;
    assert.equal(coat.pin[i], 1, `collar vertex ${i} _CLOTH_PIN`);
    coat.prim.joints[i].forEach((j, k) => {
      if (coat.prim.weights[i][k] > 0) assert.ok(/^(neck_01|spine_0[1-5]|clavicle_[lr]|pelvis|upperarm_[lr])$/.test(jn[j]), `collar vertex ${i}: joint ${jn[j]}`);
    });
  }
});

test('collar clearance: >= 5 mm from neck, >= 12 mm from jaw, >= 25 mm from ears at every shape + face/gaze morph', () => {
  const body = D.body, bj = jointNames(D.G), jH = bj.indexOf('head'), jN = bj.indexOf('neck_01');
  const region = body.pos.map((p, i) => {
    let best = -1, bw = 0;
    body.joints[i].forEach((j, k) => { if (body.weights[i][k] > bw) { bw = body.weights[i][k]; best = j; } });
    if (best === jN) return 'neck';
    if (best === jH) return Math.abs(p[0]) > 0.062 && p[1] > 1.5 && p[1] < 1.64 && p[2] < 0.06 ? 'ear' : p[1] < 1.56 ? 'jaw' : null;
    return null;
  });
  const tris = { neck: [], jaw: [], ear: [] }, bi = body.indices;
  for (let t = 0; t < bi.length; t += 3) for (const r of Object.keys(tris)) if ([0, 1, 2].some(k => region[bi[t + k]] === r)) tris[r].push([bi[t], bi[t + 1], bi[t + 2]]);
  const LIM = { neck: 0.005, jaw: 0.012, ear: 0.025 }, worst = { neck: 1, jaw: 1, ear: 1 };
  const ci = P.map((_, i) => i).filter(i => isCollar[i]);
  for (const sh of SHAPES) {
    const bp = C.morphed(body, sh.w), cp = C.morphed(coat.prim, mapW(sh.w, coat.targetNames));
    for (const r of Object.keys(tris)) {
      let m = Infinity;
      for (const i of ci) for (const [a, b, c] of tris[r]) {
        if (Math.abs(bp[a][1] - cp[i][1]) > m + 0.05) continue;
        const d = Math.hypot(...sub(cp[i], closestOnTri(cp[i], bp[a], bp[b], bp[c])));
        if (d < m) m = d;
      }
      worst[r] = Math.min(worst[r], m);
      assert.ok(m >= LIM[r], `${sh.name}: collar ${(m * 1000).toFixed(1)} mm from ${r}`);
    }
  }
  console.log('collar min distance (mm):', Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +(v * 1000).toFixed(1)])));
});

test('collar vs hair: short styles never cross the collar (long styles: see docs/STATUS.md)', () => {
  const hairCat = JSON.parse(fs.readFileSync(out('hair.json'), 'utf8'));
  const ctri = [];
  for (let t = 0; t < I.length; t += 3) if (isCollar[I[t]]) ctri.push([I[t], I[t + 1], I[t + 2]]);
  const res = {};
  for (const id of ['short02', 'short04', 'afro01']) {
    const s = hairCat.styles.find(x => x.id === id);
    const part = Object.values(meshParts(readGlb(out(s.file))))[0], h = part.prims[0], hi = h.indices;
    let crossings = 0;
    for (const sh of SHAPES) {
      const cp = C.morphed(coat.prim, mapW(sh.w, coat.targetNames)), hp = C.morphed(h, mapW(sh.w, part.targetNames));
      const ct = ctri.map(t => t.map(i => cp[i]));
      const lo = [0, 1, 2].map(c => Math.min(...ct.flat().map(p => p[c])) - 0.02), hiB = [0, 1, 2].map(c => Math.max(...ct.flat().map(p => p[c])) + 0.02);
      const near = hp.map(p => p.every((v, c) => v > lo[c] && v < hiB[c]));
      for (let t = 0; t < hi.length; t += 3) for (const [a, b] of [[hi[t], hi[t + 1]], [hi[t + 1], hi[t + 2]], [hi[t + 2], hi[t]]]) {
        if (!near[a] && !near[b]) continue;
        if (ct.some(([x, y, z]) => segTri(hp[a], hp[b], x, y, z))) crossings++;
      }
    }
    res[id] = crossings;
    assert.equal(crossings, 0, `${id}: hair edges crossing the collar`);
  }
  console.log('hair edges crossing the collar:', res);
});

test('covered lower layers: T-shirt vertices under the pinned coat carry the coat zone bit and are dropped', () => {
  const tee = D.garments.tshirt, z = tee.prim.attr('_CCZONE');
  assert.ok(z, 'tshirt _CCZONE');
  const bit = D.catalog.bodyZones[item.hidesBodyZones[0]];
  const n = [...z].filter(v => v & bit).length;
  assert.ok(n > 200 && n < tee.prim.pos.length * 0.7, `tee GLB vertices covered by the coat: ${n} of ${tee.prim.pos.length}`);
  assert.ok(item.hidesLowerVertices?.tshirt > 200, 'catalog records the (build vertex) count');
  const drawn = C.drawnMask(D, 'tshirt', ['tshirt', 'jeans', 'trenchcoat']), alone = C.drawnMask(D, 'tshirt', ['tshirt', 'jeans']);
  assert.ok(drawn.filter(Boolean).length < alone.filter(Boolean).length, 'fewer tee vertices drawn under the coat');
  assert.ok(alone.every(Boolean), 'tee alone: nothing dropped');
  const dropped = drawn.map((d, i) => !d && i).filter(i => i !== false);
  assert.ok(dropped.length > 100);
  // shoulders / upper arms were where the tee showed through the coat
  assert.ok(dropped.some(i => Math.abs(tee.prim.pos[i][0]) > 0.19 && tee.prim.pos[i][1] > 1.2), 'upper arm / shoulder tee hidden');
});

// The back of the coat collar is not fitted over the shirt collar (pushing it out moved single top-edge vertices
// up to 19 mm into short hair); that part of the shirt collar carries the coat bit instead (blender/cc_clothing.py
// coat_collar own_collar_deg, hide_lower edge_collar). Toward the front, seen through the open gorge, it stays drawn.
test('shirt collar under the coat collar: hidden at the back, drawn at the front', () => {
  const sh = D.garments.shirt, SP = sh.prim.pos, z = sh.prim.attr('_CCZONE');
  assert.ok(z, 'shirt _CCZONE');
  const bit = D.catalog.bodyZones[item.hidesBodyZones[0]];
  const top = Math.max(...SP.map(p => p[1]));
  const col = SP.map((_, i) => i).filter(i => SP[i][1] > top - 0.05);          // the collar band
  const cz = col.reduce((a, i) => a + SP[i][2], 0) / col.length;
  const ang = i => Math.atan2(Math.abs(SP[i][0]), cz - SP[i][2]) * 180 / Math.PI;   // 0 = back, 180 = front
  const frac = (lo, hi) => { const s = col.filter(i => ang(i) >= lo && ang(i) < hi); return { n: s.length, hid: s.filter(i => z[i] & bit).length }; };
  const back = frac(0, 75), front = frac(100, 181);
  console.log('shirt collar vertices hidden by the coat: back', back, 'front', front);
  assert.ok(back.n > 30 && back.hid >= 0.5 * back.n, 'back of the shirt collar hidden under the coat collar');
  assert.ok(front.n > 30 && front.hid <= 0.05 * front.n, 'front of the shirt collar drawn');
});
