// Garment checker: one command that tells whether a garment (a catalog id of output/clothing.json, or a GLB path)
// follows the rules of docs/CLOTHING_GUIDE.md. Static checks (GLB structure, morphs, skin, budgets, catalog entry,
// licence, tint, zones, cloth data), clearance against the skin and the lower layers on the 8 slider bodies + male
// (tools/cloth_check.mjs), and for cloth garments the solver numbers (tools/cloth_sim.mjs) and the visible-layer
// integrity (tools/cloth_integrity.mjs).
//
//   node tools/check_garment.mjs <garment-id|path.glb> [--bodies quick|all] [--json] [--no-sim] [--dir output]
//
//   --bodies quick (default): clearance on all 9 bodies, sim + integrity on CONFIG.quickBodies (shortened timeline)
//   --bodies all:             + every morph extreme / corrective corner / breast extreme, sim + integrity on all 9
//                             bodies, full 10 s timeline
//   path.glb: when the GLB's folder holds a clothing.json that lists it (a scratch build), that folder is checked
//             like output/; otherwise only the GLB-level checks run (catalog / sim rows are SKIP).
//
// Exit code 1 when any row is FAIL. KNOWN rows are measured defects listed in CONFIG.knownExceptions with a reason;
// they do not fail the exit code, and a KNOWN entry that no longer fails is reported as FAIL ("fixed: remove the
// exception"), so the list cannot silently go stale. tests/check_garment.test.mjs runs this on every catalog item.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, meshParts, jointNames } from './glb.mjs';
import * as C from './cloth_check.mjs';
import { sliderInfluences } from '../web/character.js';
import { buildClothModel } from '../web/cloth/model.js';
import { isUnderwear, collidesAsLayer } from '../web/clothing_rules.js';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(PROJECT, 'output');

// ---------------------------------------------------------------------------------------------------------------
// Every number below is a rule of docs/CLOTHING_GUIDE.md. Per-garment deviations carry a reason.
export const CONFIG = {
  morphCount: 92,
  rigJoints: 53,
  maxInfluences: 4,
  weightSumTol: 0.01,
  ibmTol: 1e-4,                 // inverse bind matrices == base_body.glb's (same bind pose)
  // budgets per slot: GLB bytes, vertices, triangles, largest texture side (px)
  budgets: {
    underwear: { bytes: 0.3e6, vertices: 800, triangles: 1400, texture: 1024 },
    bra: { bytes: 0.3e6, vertices: 800, triangles: 1400, texture: 1024 },
    top: { bytes: 1.0e6, vertices: 2000, triangles: 3600, texture: 1024 },
    bottom: { bytes: 1.0e6, vertices: 2000, triangles: 3600, texture: 1024 },
    shoes: { bytes: 1.0e6, vertices: 2000, triangles: 3600, texture: 1024 },
    outerwear: { bytes: 1.5e6, vertices: 3000, triangles: 5200, texture: 1024 },
    '*': { bytes: 1.0e6, vertices: 2000, triangles: 3600, texture: 1024 },
  },
  degenerateArea: 1e-10,        // m^2: a triangle smaller than this is degenerate
  normalTol: 0.05,              // |normal| within 1 +- this
  zeroMorphKinds: ['expr', 'look'],   // these must not move clothes (max delta < zeroMorphTol)
  zeroMorphTol: 1e-4,
  // garments over the chest carry the dyn_breast_* motion morphs and need a BREAST_SUPPORT entry (web/main.js)
  chestZones: ['torso', 'coat', 'bra', 'shirt', 'hoodie', 'dress', 'jacket'],
  tint: { gainMin: 1, gainMax: 4 },
  // clearance: garment vertices > tol inside the visible skin / the drawn lower layers (tools/cloth_check.mjs)
  clearance: {
    skin: 5,                    // tests/clothing.test.mjs MAX_SKIN
    layers: 0,
    // per garment: { skin, layers, shapes: { shapeName: skinLimit }, reason }
    garments: {
      jeans: { layers: 5, reason: 'jeans hems sit inside the shoe tops at some shapes (2 + 2 vertices, the shoe is outside)' },
      trenchcoat: { layers: 35, reason: 'open front edges of the coat over tee + jeans at gender_female + weight_max (up to ~20 of 2472)' },
      panties: { skin: 8, reason: 'edge vertices at concave creases (leg line) at weight extremes' },
      bra: { skin: 12, shapes: { 'gender_female+breast_cup_max+age_old+breast_firm_min': 35, 'gender_female+breast_cup_max+dyn_breast_back': 22 },
        reason: 'the sagging breast folds over the underbust band (the skin covers the band; no fabric pokes out) / full physics deflection' },
    },
  },
  // lower layers a garment is checked over (clearance, sim, integrity). Missing = every lower-layer item that
  // collides as a layer, one per slot (catalog order), the body sex's default underwear is added by integrity.
  under: { shoes: [], jeans: ['shoes'], skirt: [], tshirt: ['jeans'], trenchcoat: ['tshirt', 'jeans'],
    shorts: [], shirt: ['jeans'], hoodie: ['jeans'], dress: [], jacket: ['tshirt', 'jeans'], boots: [] },
  // holes: hidden body triangles not covered by the garment (C.holes); default 0
  holes: {
    shoes: { max: 40, reason: 'the foot soles face the ground under the shoe sole (never visible)' },
    boots: { max: 4, reason: 'as shoes, the foot soles face the ground under the boot sole; measured 0 (spec wrap_body)' },
    tshirt: { max: 4, reason: 'armpit triangles hidden by the torso zone behind the sleeve opening' },
    jeans: { max: 4, reason: 'crotch / waist triangles at the zone border' },
  },
  // cloth parameters: safe ranges (web/cloth/solver.js DEFAULTS are inside them)
  clothRanges: {
    maxDistance: [0.01, 0.6], 'stiffness.stretch': [0.8, 1], 'stiffness.bend': [0.1, 0.8], bendVertical: [0.1, 0.9],
    damping: [0.05, 0.3], gravityScale: [0.5, 1.5], wind: [0, 1], friction: [0, 0.6], thickness: [0.005, 0.03],
    layerThickness: [0.008, 0.025], limitSlack: [0, 0.05], limitSlackPinned: [0, 0.02],
  },
  clothRequired: ['version', 'pinAttribute', 'pinMeaning', 'maxDistance', 'stiffness', 'damping', 'gravityScale', 'wind', 'colliders', 'units'],
  limitGroups: ['arms', 'hips', 'thighs'],
  particles: { max: 1200, minFree: 10 },
  // solver numbers (tools/cloth_sim.mjs runTimeline): default = the long coat's targets (docs/CLOTH_RUNTIME.md)
  sim: {
    stretchP99: 1.65, stretchP99Mean: 1.3, bodyPen: 6, bodyPenMm: 25, floorBelow: 0, crossed: 0,
    msPerStep: 2.5,             // node, one garment; timing depends on the machine and load: WARN, not FAIL
    garments: {
      skirt: { stretchP99: 2.4, stretchP99Mean: null, bodyPen: 12, bodyPenMm: null, stretchBelowSkinned: true,
        reason: 'short, tightly pinned skirt: its few free rows stretch more between the running thighs (cloth off is worse: stretch < skinned is checked); tests/cloth.test.mjs limits' },
    },
  },
  bodies: null,                 // filled below: tools/cloth_sim.mjs BODIES + male
  quickBodies: ['neutral', 'female'],
  // shortened integrity timeline for --bodies quick (tests/integrity.test.mjs); 'all' uses CONFIG of cloth_integrity
  quickTimeline: { timeline: [[-0.5, 'preroll', 'idle'], [0, 'idle', 'idle'], [0.5, 'walk', 'walk'], [1.7, 'run', 'run'],
    [3.2, 'idle', 'idle'], [3.8, 'idle>run', 'run']], duration: 4.6, every: 6 },
  quickSimSeconds: 10,
  integrityOutfits: { trenchcoat: ['tshirt', 'jeans', 'shoes', 'trenchcoat'], skirt: ['tshirt', 'skirt', 'shoes'],
    dress: ['dress', 'shoes'], jacket: ['tshirt', 'jeans', 'shoes', 'jacket'], boots: ['tshirt', 'jeans', 'boots'] },
  // KNOWN EXCEPTIONS: measured defects of existing garments that are allowed to fail. Fields: id, check (row name
  // prefix), body (optional), detail (optional, substring of the row value), reason. Delete an entry when it is
  // fixed (the checker then reports the stale entry as FAIL). Never add one to hide a regression.
  // 2026-10-01: empty. The coat's lapel sliver and its child-run trenchcoat:jeans case passed after the hoodie /
  // shirt / shorts build (removed). The coat's other known integrity failures are in outfits this checker does not
  // run: coat+shoes / old trenchcoat:socks is tests/integrity.test.mjs KNOWN_FAILING; the full list is
  // docs/CLOTH_RUNTIME.md.
  knownExceptions: [],
};

let BODIES_CACHE = null;
async function bodies() {
  if (!BODIES_CACHE) {
    const { BODIES } = await import('./cloth_sim.mjs');
    BODIES_CACHE = { ...BODIES, male: { gender: 1 } };
  }
  return BODIES_CACHE;
}

// ---------------------------------------------------------------------------------------------------------------
const KIND = C.kindOf;
const finite = a => a.every(Number.isFinite);
const fmt = v => (typeof v === 'number' ? +v.toFixed(4) : v);

/** Image size (px) of an embedded PNG / JPEG buffer, or null. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1], len = buf.readUInt16BE(o + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(o + 7), buf.readUInt16BE(o + 5)];
      o += 2 + len;
    }
  }
  return null;
}

/** Garment of a GLB: { g, part, prim (cloth_check style), mesh, targetNames, pin, zone, nodeName }. */
function loadGarmentGlb(file) {
  const g = readGlb(file);
  const parts = Object.values(meshParts(g));
  const part = parts[0];
  return { g, parts, part, prim: part?.prims[0], mesh: part ? g.json.meshes[part.nodeDef.mesh] : null, targetNames: part?.targetNames ?? [],
    nodeName: part?.nodeDef.name, pin: part?.prims[0].attr('_CLOTH_PIN'), zone: part?.prims[0].attr('_CCZONE') };
}

/** Slider body -> morph weights { targetIndex: w } of `names`. */
function bodyWeights(names, values) {
  const infl = sliderInfluences(values), w = {};
  names.forEach((n, t) => { if (infl[n]) w[t] = infl[n]; });
  return w;
}

/** Clearance of garment prim gp (morph weights w) over the skin and the drawn lower layers `under`. */
function clearanceAt(D, id, gp, under, w) {
  const idx = D.bodyIdx, mask = C.hiddenMask(D.catalog, [id, ...under]);
  const keep = D.zone ? D.zone.map(z => (z & mask) === 0) : null;
  const body = C.morphed(D.body, w), bn = C.vertexNormals(body, idx);
  const pts = C.morphed(gp, w);
  const s = C.countInside(pts, body, bn, keep, C.TOL, null, idx);
  let layers = 0;
  for (const u of under) {
    const ug = D.garments[u], up = C.morphed(ug.prim, w);
    layers += C.countInside(pts, up, C.vertexNormals(up, ug.prim.indices), null, C.TOL, C.drawnMask(D, u, [id, ...under]), ug.prim.indices).n;
  }
  return { skin: s.n, mm: +(-s.worst * 1000).toFixed(1), layers };
}

/** Signed gap (mm) of garment vertices to the nearest skin vertex within 3 cm, neutral: { p05, median, n }. */
function gapStats(D, gp) {
  const P = D.body.pos, N = C.vertexNormals(P, D.bodyIdx), near = C.grid(P, 0.02), g = [];
  for (const p of gp.pos) {
    const i = near(p);
    if (i < 0) continue;
    g.push(((p[0] - P[i][0]) * N[i][0] + (p[1] - P[i][1]) * N[i][1] + (p[2] - P[i][2]) * N[i][2]) * 1000);
  }
  g.sort((a, b) => a - b);
  const q = f => (g.length ? +g[Math.min(g.length - 1, Math.floor(f * g.length))].toFixed(1) : null);
  return { p05: q(0.05), median: q(0.5), near: g.length, of: gp.pos.length };
}

/** Lower layers garment `id` is checked over (CONFIG.under or: one collidesAsLayer item per lower slot). */
export function underFor(catalog, id, cfg = CONFIG) {
  if (cfg.under[id]) return cfg.under[id].filter(u => catalog.items.some(i => i.id === u));
  const it = catalog.items.find(i => i.id === id);
  if (!it || isUnderwear(catalog, id)) return [];
  const out = [], slots = new Set(it.occupies ?? [it.slot]);
  for (const u of catalog.items) {
    if (u.id === id || (u.layer ?? 0) >= (it.layer ?? 0) || !collidesAsLayer(u) || isUnderwear(catalog, u.id)) continue;
    if (slots.has(u.slot) || (u.sex && it.sex && u.sex !== it.sex)) continue;
    slots.add(u.slot); out.push(u.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Runs every check. target = catalog id or GLB path. opts: { bodies: 'quick'|'all', sim: true, dir }.
 * Returns { id, file, mode, rows: [{ check, status: OK|FAIL|KNOWN|WARN|SKIP|INFO, value, limit, note }], fail }.
 */
export async function checkGarment(target, opts = {}) {
  const cfg = { ...CONFIG, ...opts.cfg };
  const mode = opts.bodies === 'all' ? 'all' : 'quick';
  const rows = [];
  const row = (check, ok, value, limit = '', note = '') => rows.push({ check, status: ok === null ? 'SKIP' : ok === 'info' ? 'INFO' : ok === 'warn' ? 'WARN' : ok ? 'OK' : 'FAIL', value: fmt(value), limit, note });

  // ---- resolve target ----
  let dir = opts.dir ? path.resolve(opts.dir) : OUT, id = target, file;
  if (/\.glb$/i.test(target)) {
    file = path.resolve(target);
    const d = path.dirname(file), cat = path.join(d, 'clothing.json');
    const item = fs.existsSync(cat) ? JSON.parse(fs.readFileSync(cat, 'utf8')).items.find(i => i.file === path.basename(file)) : null;
    if (item && fs.existsSync(path.join(d, 'base_body.glb'))) { dir = d; id = item.id; } else id = null;
  }
  const catalog = fs.existsSync(path.join(dir, 'clothing.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'clothing.json'), 'utf8')) : null;
  const item = id ? catalog?.items.find(i => i.id === id) : null;
  if (id && !item) { row('catalog: entry', false, `no item "${id}" in ${path.relative(PROJECT, path.join(dir, 'clothing.json'))}`); return finish(); }
  file ??= path.join(dir, item.file);
  const name = id ?? path.basename(file);

  // ---- base ----
  const baseFile = fs.existsSync(path.join(dir, 'base_body.glb')) ? path.join(dir, 'base_body.glb') : path.join(OUT, 'base_body.glb');
  const BG = readGlb(baseFile), body = meshParts(BG).Body;
  const baseNames = body.targetNames, baseJoints = jointNames(BG);
  const baseIbm = Object.fromEntries(BG.accessor(BG.json.skins[0].inverseBindMatrices).map((m, j) => [baseJoints[j], m]));

  // ---- 1. load ----
  let G;
  try { G = loadGarmentGlb(file); } catch (e) { row('glb: loads', false, e.message); return finish(); }
  row('glb: loads', true, `${(fs.statSync(file).size / 1e6).toFixed(3)} MB`);
  row('glb: one mesh, one primitive', G.parts.length === 1 && G.part.prims.length === 1, `${G.parts.length} mesh / ${G.part?.prims.length ?? 0} prim`, '1 / 1');
  const pj = G.mesh.primitives[0], attrs = Object.keys(pj.attributes);
  const need = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
  row('glb: attributes', need.every(a => attrs.includes(a)) && pj.indices !== undefined, attrs.join(','), need.join(',') + ' + indices');
  const pos = G.prim.pos, idx = G.prim.indices, nv = pos.length, nt = idx.length / 3;
  const nrm = G.prim.attr('NORMAL') ?? [], uv = G.prim.attr('TEXCOORD_0') ?? [];

  // ---- 2. morphs ----
  const sameNames = G.targetNames.length === baseNames.length && G.targetNames.every((n, k) => n === baseNames[k]);
  row('morphs: names == base_body.glb (order too)', sameNames && G.prim.targets.length === baseNames.length,
    `${G.targetNames.length} names, ${G.prim.targets.length} targets`, `${baseNames.length} (${cfg.morphCount})`,
    sameNames ? '' : `missing ${baseNames.filter(n => !G.targetNames.includes(n)).slice(0, 4).join(',')} extra ${G.targetNames.filter(n => !baseNames.includes(n)).slice(0, 4).join(',')}`);
  row('morphs: count', baseNames.length === cfg.morphCount, baseNames.length, cfg.morphCount, 'base_body.glb itself');
  if (sameNames) {
    const bad = [];
    G.targetNames.forEach((n, t) => {
      if (!cfg.zeroMorphKinds.includes(KIND(n))) return;
      const m = Math.max(...G.prim.targets[t].map(v => Math.hypot(...v)));
      if (m >= cfg.zeroMorphTol) bad.push(`${n} ${(m * 1000).toFixed(2)} mm`);
    });
    row('morphs: face expression / look deltas zero', !bad.length, bad.length ? bad.slice(0, 3).join(', ') : 'all < 0.1 mm', '< 0.1 mm');
    const dynMax = Math.max(0, ...G.targetNames.map((n, t) => (KIND(n) === 'dyn' ? Math.max(...G.prim.targets[t].map(v => Math.hypot(...v))) : 0)));
    const chest = (item?.hidesBodyZones ?? []).some(z => cfg.chestZones.includes(z));
    row('morphs: dyn_breast_* carried over the chest', chest ? dynMax > 0.005 : 'info', `max ${(dynMax * 1000).toFixed(1)} mm`, chest ? '> 5 mm' : '(not a chest garment)');
  }
  const targetsFinite = G.prim.targets.every(t => t.every(finite));
  row('morphs: deltas finite', targetsFinite, targetsFinite ? 'yes' : 'NaN / Inf');

  // ---- 3. skin ----
  const gj = jointNames(G.g);
  const unknown = gj.filter(n => !baseJoints.includes(n));
  row('skin: joints within the rig', !unknown.length && baseJoints.length === cfg.rigJoints, `${gj.length} joints, ${unknown.length} unknown`, `subset of ${cfg.rigJoints}`, unknown.slice(0, 4).join(','));
  row('skin: <= 4 influences (no JOINTS_1)', !attrs.includes('JOINTS_1') && !attrs.includes('WEIGHTS_1'), attrs.includes('JOINTS_1') ? 'JOINTS_1 present' : 'JOINTS_0 only', cfg.maxInfluences);
  const W = G.prim.weights ?? [];
  let wBad = 0, wNeg = 0;
  for (const w of W) { if (Math.abs(w.reduce((s, x) => s + x, 0) - 1) > cfg.weightSumTol) wBad++; if (w.some(x => x < 0 || !Number.isFinite(x))) wNeg++; }
  row('skin: weights sum to 1', wBad === 0 && wNeg === 0 && W.length === nv, `${wBad} off, ${wNeg} negative/NaN`, `|sum - 1| <= ${cfg.weightSumTol}`);
  const gIbm = G.g.accessor(G.g.json.skins[0].inverseBindMatrices);
  let ibmErr = 0;
  gj.forEach((n, j) => { if (baseIbm[n]) ibmErr = Math.max(ibmErr, ...gIbm[j].map((x, k) => Math.abs(x - baseIbm[n][k]))); });
  row('skin: bind pose == base_body.glb', ibmErr < cfg.ibmTol, ibmErr.toExponential(1), `< ${cfg.ibmTol}`);

  // ---- 4. geometry integrity ----
  const posFinite = pos.every(finite) && nrm.every(finite) && uv.every(finite);
  row('geometry: no NaN / Inf (position, normal, uv)', posFinite, posFinite ? 'finite' : 'NaN / Inf');
  let degen = 0, oor = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a >= nv || b >= nv || c >= nv) { oor++; continue; }
    if (a === b || b === c || a === c) { degen++; continue; }
    const A = pos[a], B = pos[b], Cc = pos[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [Cc[0] - A[0], Cc[1] - A[1], Cc[2] - A[2]];
    const area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (!(area >= cfg.degenerateArea)) degen++;
  }
  row('geometry: no degenerate / out-of-range triangles', degen === 0 && oor === 0, `${degen} degenerate, ${oor} out of range`, `area >= ${cfg.degenerateArea} m^2`);
  const badN = nrm.filter(n => Math.abs(Math.hypot(...n) - 1) > cfg.normalTol).length;
  row('geometry: unit normals', badN === 0, `${badN} of ${nrm.length} off`, `|n| = 1 +- ${cfg.normalTol}`);
  const uvOut = uv.filter(t => t[0] < -0.01 || t[0] > 1.01 || t[1] < -0.01 || t[1] > 1.01).length;
  row('geometry: UVs in [0, 1]', uvOut === 0 ? true : 'warn', `${uvOut} outside`, '[0, 1] (+-0.01)');

  // ---- 5. budgets ----
  const bud = cfg.budgets[item?.slot] ?? cfg.budgets['*'];
  const bytes = fs.statSync(file).size;
  row('budget: bytes', bytes < bud.bytes, bytes, `< ${bud.bytes} (${item?.slot ?? '*'})`);
  row('budget: vertices', nv <= bud.vertices, nv, `<= ${bud.vertices}`);
  row('budget: triangles', nt <= bud.triangles, nt, `<= ${bud.triangles}`);
  const imgs = (G.g.json.images ?? []).map(im => {
    const bv = G.g.json.bufferViews[im.bufferView];
    return { mime: im.mimeType, size: bv ? imageSize(G.g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)) : null };
  });
  const maxSide = Math.max(0, ...imgs.map(i => Math.max(...(i.size ?? [0]))));
  row('budget: textures embedded, largest side', imgs.length > 0 && imgs.every(i => i.size) && maxSide <= bud.texture,
    `${imgs.length} images, max ${maxSide} px`, `<= ${bud.texture} px`, imgs.map(i => `${i.mime?.split('/')[1]} ${i.size?.join('x')}`).join(' '));

  // ---- 6. material / tint ----
  const mat = G.g.json.materials?.[G.mesh.primitives[0].material ?? 0], tint = mat?.extras?.tint;
  row('material: tint extras', !!tint && tint.gain > cfg.tint.gainMin && tint.gain < cfg.tint.gainMax && /^#[0-9a-f]{6}$/.test(tint.default ?? ''),
    tint ? `gain ${tint.gain}, default ${tint.default}` : 'missing', `gain in (${cfg.tint.gainMin}, ${cfg.tint.gainMax}), #rrggbb default`);
  if (item) {
    row('material: tint default == catalog primary', tint?.default === item.colors?.primary, tint?.default, item.colors?.primary);
    if (item.colors?.secondary) {
      row('material: secondary colour + ccMask texture', tint?.secondaryDefault === item.colors.secondary && Number.isInteger(mat?.extras?.ccMask?.index),
        `${tint?.secondaryDefault} / ccMask ${mat?.extras?.ccMask?.index}`, item.colors.secondary);
    }
  }

  // ---- 7. catalog entry ----
  let D = null;
  if (!item) {
    row('catalog: entry', null, 'GLB only (no clothing.json lists it)');
  } else {
    const hex = /^#[0-9a-f]{6}$/;
    const ids = new Set(catalog.items.map(i => i.id));
    const errs = [];
    if (item.file !== `clothing_${id}.glb`) errs.push(`file ${item.file}`);
    if (item.mesh !== `Cloth_${id}` || G.mesh.name !== item.mesh || G.nodeName !== item.mesh) errs.push(`mesh ${item.mesh} / glb ${G.mesh.name} / node ${G.nodeName}`);
    if (!catalog.slots.includes(item.slot) || !item.occupies?.includes(item.slot)) errs.push(`slot ${item.slot} / occupies ${item.occupies}`);
    if (!(item.occupies ?? []).every(s => catalog.slots.includes(s))) errs.push('occupies unknown slot');
    if (!Number.isInteger(item.layer) || (isUnderwear(catalog, id) ? item.layer !== 0 : item.layer <= 0)) errs.push(`layer ${item.layer}`);
    if (!item.label?.da || !item.label?.en) errs.push('label da/en');
    if (!catalog.slotLabels?.[item.slot]?.da || !catalog.slotLabels?.[item.slot]?.en) errs.push('slot label da/en');
    if (!hex.test(item.colors?.primary ?? '') || (item.colors?.secondary && !hex.test(item.colors.secondary))) errs.push('colours #rrggbb');
    if (!item.hidesBodyZones?.length || !item.hidesBodyZones.every(z => catalog.bodyZones[z])) errs.push(`zones ${item.hidesBodyZones}`);
    for (const c of item.conflicts ?? []) if (!ids.has(c) || c === id) errs.push(`conflict ${c}`);
    for (const k of Object.keys(item.hidesLowerVertices ?? {})) if (!ids.has(k)) errs.push(`hidesLowerVertices ${k}`);
    for (const k of Object.keys(item.coveredBy ?? {})) if (!ids.has(k)) errs.push(`coveredBy ${k}`);
    if (item.sex && !['male', 'female'].includes(item.sex)) errs.push(`sex ${item.sex}`);
    if (catalog.items.filter(i => i.id === id).length !== 1) errs.push('duplicate id');
    row('catalog: fields, slot/layer, labels da+en, colours, zones, conflicts', !errs.length, errs.length ? errs.join('; ') : 'valid');
    row('catalog: bytes == file size', item.bytes === bytes, item.bytes, bytes);
    // catalog `vertices` = Blender's vertex count = unique positions (the GLB splits vertices at UV seams / sharp normals)
    const welded = new Set(pos.map(p => p.map(x => x.toFixed(5)).join(','))).size;
    row('catalog: vertices == GLB unique positions', item.vertices === welded, item.vertices, `${welded} (${nv} GLB vertices)`);
    // mutually exclusive = a shared occupied slot or a conflict either way (the hoodie and the coat share layer 4)
    const exclusive = i => (i.occupies ?? []).some(s => item.occupies.includes(s)) || (i.conflicts ?? []).includes(id) || (item.conflicts ?? []).includes(i.id);
    const layerSame = catalog.items.filter(i => i.id !== id && i.layer === item.layer && !isUnderwear(catalog, i.id) && !isUnderwear(catalog, id) && !exclusive(i));
    row('catalog: layer unique among wearable-together items', layerSame.length === 0 ? true : 'warn', layerSame.map(i => i.id).join(',') || 'unique',
      '', layerSame.length ? 'same layer and not mutually exclusive: who is outside is undefined' : '');
    // licence (tests/clothing.test.mjs rules)
    const notes = fs.readFileSync(path.join(PROJECT, 'LICENSE-NOTES.md'), 'utf8');
    if (item.license === 'project-original') {
      const ok = /add_generated/.test(item.projectOriginal ?? '') && !/clothes\//.test(item.source ?? '') && notes.includes(`clothing_${id}.glb`);
      row('licence: project-original documented', ok, item.license, 'projectOriginal names the generator; LICENSE-NOTES lists the file');
    } else {
      const pack = item.source?.match(/clothes\/(\w+)/)?.[1];
      const licFile = [path.join(PROJECT, 'build', 'blend', 'asset_licenses.json'), path.join(dir, 'asset_licenses.json')].find(f => fs.existsSync(f));
      const rec = licFile ? JSON.parse(fs.readFileSync(licFile, 'utf8')).filter(r => r.asset === pack && r.type === 'clothes') : null;
      const ok = item.license?.startsWith('CC0') && pack && notes.includes(pack) && (!rec || (rec.length >= 2 && rec.every(r => r.license === 'CC0' && r.author === 'makehuman_system')))
        && (item.license === 'CC0' || /project-original/.test(item.license) === !!item.projectOriginal);
      row('licence: CC0 pack in LICENSE-NOTES + asset_licenses', ok, `${item.license} (${pack})`, 'CC0, mhclo + mhmat rows',
        rec ? `${rec.length} rows in ${path.relative(PROJECT, licFile)}` : 'asset_licenses.json not found');
    }
    // breast support (chest garments)
    if ((item.hidesBodyZones ?? []).some(z => cfg.chestZones.includes(z))) {
      const src = fs.readFileSync(path.join(PROJECT, 'web', 'main.js'), 'utf8').match(/BREAST_SUPPORT\s*=\s*\{([^}]*)\}/)?.[1] ?? '';
      row('ui: BREAST_SUPPORT entry (web/main.js)', new RegExp(`\\b${id}\\s*:`).test(src) ? true : 'warn', src.trim(), `${id}: 0..1`);
    }

    // zones: _CCZONE only holds known bits; a garment hidden by a higher layer needs it
    const allBits = Object.values(catalog.bodyZones).reduce((a, b) => a | b, 0);
    if (G.zone) row('zones: _CCZONE values are known bits', G.zone.every(z => Number.isInteger(z) && (z & ~allBits) === 0), 'ok');
    const coveredByHigher = catalog.items.some(i => i.hidesLowerVertices?.[id]) || item.coveredBy;
    if (coveredByHigher) row('zones: _CCZONE present (covered by a higher layer)', !!G.zone, G.zone ? 'present' : 'missing');

    // ---- the data of the whole catalog (cloth_check) ----
    D = C.loadAll(dir);
    if (D.garments[id]) {
      const lim = cfg.holes[id] ?? { max: 0 };
      const h = C.holes(D, [id]);
      row('zones: hidden skin is covered (holes)', h.hidden > 100 && h.bad <= lim.max, `${h.bad} of ${h.hidden} hidden tris uncovered`, `<= ${lim.max}`, lim.reason ?? '');
    }
  }

  // ---- 8. cloth data ----
  const extras = G.mesh.extras?.ccCloth ?? null, ccl = item?.cloth ?? extras;
  if (!ccl && !G.pin) row('cloth: (not a cloth garment)', 'info', 'skinned only');
  else {
    row('cloth: _CLOTH_PIN + ccCloth extras + catalog cloth', !!G.pin && !!extras && (!item || !!item.cloth),
      `pin ${!!G.pin}, extras ${!!extras}, catalog ${!!item?.cloth}`, 'all three');
    if (item?.cloth && extras) row('cloth: ccCloth == catalog cloth', JSON.stringify(extras) === JSON.stringify(item.cloth), 'compared');
    if (G.pin) {
      const ys = pos.map(p => p[1]), top = Math.max(...ys), bot = Math.min(...ys);
      const band = (lo, hi) => G.pin.filter((_, i) => ys[i] >= lo && ys[i] <= hi);
      const mean = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
      const inRange = G.pin.every(p => p >= 0 && p <= 1);
      const grad = G.pin.filter(p => p > 0.05 && p < 0.95).length;
      row('cloth: pin mask in [0,1], top pinned, hem free, smooth gradient',
        inRange && mean(band(top - 0.05, top)) > 0.99 && mean(band(bot, bot + 0.05)) < 0.01 && grad > 10,
        `top ${mean(band(top - 0.05, top)).toFixed(3)}, hem ${mean(band(bot, bot + 0.05)).toFixed(3)}, ${grad} gradient verts`, 'top > 0.99, hem < 0.01, > 10');
      const model = buildClothModel({ positions: Float32Array.from(pos.flat()), index: Uint32Array.from(idx), pin: Float32Array.from(G.pin) });
      const free = Array.from(model.sim.pin).filter(p => p < 0.999).length;
      row('cloth: simulated particles', model.sim.count <= cfg.particles.max && free >= cfg.particles.minFree,
        `${model.sim.count} simulated, ${free} free (${model.particleCount} welded)`, `<= ${cfg.particles.max}, >= ${cfg.particles.minFree} free`);
    }
    if (ccl) {
      const errs = [];
      for (const k of cfg.clothRequired) if (ccl[k] === undefined) errs.push(`missing ${k}`);
      if (ccl.pinAttribute !== '_CLOTH_PIN') errs.push(`pinAttribute ${ccl.pinAttribute}`);
      if (ccl.colliders && !fs.existsSync(path.join(dir, ccl.colliders))) errs.push(`colliders ${ccl.colliders} not found`);
      for (const [k, [lo, hi]] of Object.entries(cfg.clothRanges)) {
        const v = k.includes('.') ? ccl[k.split('.')[0]]?.[k.split('.')[1]] : ccl[k];
        if (v === undefined) continue;
        if (!(typeof v === 'number' && v >= lo && v <= hi)) errs.push(`${k} ${v} not in [${lo}, ${hi}]`);
      }
      if (ccl.limit !== undefined && !String(ccl.limit).split(',').every(s => cfg.limitGroups.includes(s.trim()))) errs.push(`limit ${ccl.limit}`);
      const known = new Set([...cfg.clothRequired, ...Object.keys(cfg.clothRanges).map(k => k.split('.')[0]), 'limit', 'floor']);
      const extra = Object.keys(ccl).filter(k => !known.has(k));
      row('cloth: extras valid, parameters in safe ranges', !errs.length, errs.join('; ') || 'ok', 'CONFIG.clothRanges', extra.length ? `unknown keys: ${extra.join(',')}` : '');
    }
  }

  // ---- 9. clearance on the bodies (and every morph extreme with --bodies all) ----
  const allBodies = await bodies();
  const bodyList = Object.entries(allBodies).filter(([b]) => !item?.sex || (item.sex === 'male' ? b !== 'female' : true))
    // a female-only item is checked on the female variant of every body (gender -1; neutral / male = female)
    .filter(([b]) => !(item?.sex === 'female' && (b === 'neutral' || b === 'male')))
    .map(([b, v]) => [item?.sex === 'female' && b !== 'female' ? `${b}F` : b, item?.sex === 'female' ? { ...v, gender: -1 } : v]);
  if (sameNames) {
    const Dc = D ?? (() => { const d = C.loadAll(dir); return d; })();
    const gp = G.prim, under = item ? underFor(catalog, id, cfg) : [];
    const lim = { skin: cfg.clearance.skin, layers: cfg.clearance.layers, ...(cfg.clearance.garments[id] ?? {}) };
    const gid = id ?? '__glb__';
    if (!item) Dc.catalog = { ...Dc.catalog, items: [...Dc.catalog.items, { id: gid, layer: 99, hidesBodyZones: [] }] };
    const gs = gapStats(Dc, gp);
    row('clearance: gap to skin at neutral (mm)', 'info', `p05 ${gs.p05}, median ${gs.median}`, '', `${gs.near} of ${gs.of} vertices within 3 cm of the skin`);
    const res = bodyList.map(([b, v]) => ({ b, ...clearanceAt(Dc, gid, gp, under, bodyWeights(Dc.names, v)) }));
    const worst = res.reduce((a, r) => (r.skin > a.skin ? r : a), res[0]);
    row(`clearance: skin, ${res.length} bodies`, res.every(r => r.skin <= lim.skin), res.map(r => `${r.b} ${r.skin}`).join(' '), `<= ${lim.skin} verts > 2 mm inside`,
      `worst ${worst.b} ${worst.mm} mm${lim.reason && lim.skin !== cfg.clearance.skin ? ` (limit: ${lim.reason})` : ''}`);
    if (under.length) row(`clearance: lower layers (${under.join('+')}), ${res.length} bodies`, res.every(r => r.layers <= lim.layers),
      res.map(r => `${r.b} ${r.layers}`).join(' '), `<= ${lim.layers}`, lim.layers !== cfg.clearance.layers ? lim.reason ?? '' : '');
    if (mode === 'all') {
      const shapes = C.shapes(Dc.names).filter(s => !item?.sex || (item.sex === 'female' ? s.name.includes('gender_female') || !s.name.includes('gender_male') : !s.name.includes('gender_female')));
      const rs = shapes.map(s => ({ s: s.name, ...clearanceAt(Dc, gid, gp, under, s.w) }));
      const badS = rs.filter(r => r.skin > (lim.shapes?.[r.s] ?? lim.skin)), badL = rs.filter(r => r.layers > lim.layers);
      row(`clearance: skin, ${rs.length} morph extremes`, !badS.length, `max ${Math.max(...rs.map(r => r.skin))}`, `<= ${lim.skin}${lim.shapes ? ' (+ per-shape limits)' : ''}`,
        badS.slice(0, 3).map(r => `${r.s} ${r.skin}`).join(', ') || (lim.shapes ? lim.reason : ''));
      if (under.length) row(`clearance: lower layers, ${rs.length} morph extremes`, !badL.length, `max ${Math.max(...rs.map(r => r.layers))}`, `<= ${lim.layers}`, badL.slice(0, 3).map(r => `${r.s} ${r.layers}`).join(', '));
    }
  } else row('clearance', null, 'skipped: morph names differ from the base');

  // ---- 10. cloth simulation + integrity (cloth garments of a catalog) ----
  const isCloth = item?.cloth && G.pin && opts.sim !== false;
  if (!isCloth) row('sim / integrity', null, item?.cloth ? 'skipped (--no-sim)' : 'not a cloth garment');
  else await simRows(dir, id, item, catalog, cfg, mode, allBodies, row, rows);

  return finish();

  function finish() {
    // known exceptions: FAIL rows that match become KNOWN; entries matching no failing row are stale -> FAIL
    const ex = cfg.knownExceptions.filter(e => e.id === id);
    for (const e of ex) {
      const hit = rows.filter(r => r.status === 'FAIL' && r.check.startsWith(e.check) && (!e.body || r.check.includes(`, ${e.body}`) || r.check.endsWith(` ${e.body}`))
        && (!e.detail || String(r.value).includes(e.detail) || r.note.includes(e.detail)));
      for (const r of hit) { r.status = 'KNOWN'; r.note = `${r.note ? r.note + '; ' : ''}known: ${e.reason}`; }
      const ran = rows.some(r => r.check.startsWith(e.check) && (!e.body || r.check.includes(e.body)));
      if (ran && !hit.length) rows.push({ check: `known exception ${e.check}${e.body ? ' ' + e.body : ''}`, status: 'FAIL', value: 'passes now', limit: '', note: `fixed: remove it from CONFIG.knownExceptions (${e.reason})` });
    }
    return { id: id ?? null, file: path.relative(PROJECT, file ?? target), mode, rows, fail: rows.some(r => r.status === 'FAIL') };
  }
}

async function simRows(dir, id, item, catalog, cfg, mode, allBodies, row, rows) {
  const { loadData, runTimeline } = await import('./cloth_sim.mjs');
  const I = await import('./cloth_integrity.mjs');
  const D = loadData(dir);
  const L = { ...cfg.sim, ...(cfg.sim.garments[id] ?? {}) }, reason = cfg.sim.garments[id]?.reason;
  const names = mode === 'all' ? Object.keys(allBodies) : cfg.quickBodies;
  const sexOk = b => !item.sex || (item.sex === 'female') === ((allBodies[b].gender ?? 0) < 0);
  const under = underFor(catalog, id, cfg).filter(u => collidesAsLayer(catalog.items.find(i => i.id === u)));
  for (const b of names.filter(sexOk)) {
    const r = runTimeline(D, [id], allBodies[b], { measureEvery: 6, duration: mode === 'all' ? 10 : cfg.quickSimSeconds, under: under.length ? under : undefined })[id];
    const errs = [];
    const chk = (k, v, lim, cmp = (a, l) => a <= l) => { if (lim !== null && lim !== undefined && !cmp(v, lim)) errs.push(`${k} ${v} > ${lim}`); };
    chk('stretchP99', r.stretchP99, L.stretchP99); chk('stretchP99Mean', r.stretchP99Mean, L.stretchP99Mean);
    chk('bodyPen', r.bodyPen, L.bodyPen); chk('bodyPenMm', r.bodyPenMm, L.bodyPenMm);
    chk('floorBelow', r.floorBelow, L.floorBelow); chk('crossed', r.crossed, L.crossed);
    if (r.bodyPen > r.skinPen) errs.push(`bodyPen ${r.bodyPen} > cloth off ${r.skinPen}`);
    if (r.hemMinY < 0) errs.push(`hem below the floor ${r.hemMinY}`);
    if (cfg.sim.garments[id]?.stretchBelowSkinned) if (!(r.stretchP99 < r.skinStretchP99)) errs.push(`stretch ${r.stretchP99} >= cloth off ${r.skinStretchP99}`);
    row(`sim: ${b}`, !errs.length, `p99 ${r.stretchP99} mean ${r.stretchP99Mean} pen ${r.bodyPen}/${r.bodyPenMm}mm (off ${r.skinPen}) floor ${r.floorBelow} crossed ${r.crossed}`,
      `p99 <= ${L.stretchP99}${L.stretchP99Mean ? `, mean <= ${L.stretchP99Mean}` : ''}, pen <= ${L.bodyPen}${L.bodyPenMm ? `/${L.bodyPenMm}mm` : ''}`,
      errs.join('; ') + (reason ? `${errs.length ? '; ' : ''}limits: ${reason}` : ''));
    row(`sim: solver cost, ${b}`, r.msPerStep <= L.msPerStep ? true : 'warn', `${r.msPerStep} ms/step, ${r.particles} particles (${r.free} free)`, `<= ${L.msPerStep} ms/step (node)`);
  }
  // integrity: the garment over its lower layers (+ the default underwear of the body's sex), pairs involving it
  const outfit = cfg.integrityOutfits[id] ?? [...under, ...catalog.items.filter(i => i.slot === 'shoes' && i.id !== id && !under.includes(i.id)).map(i => i.id).slice(0, 1), id];
  const icfg = mode === 'all' ? { ...I.CONFIG } : { ...I.CONFIG, ...cfg.quickTimeline };
  const results = [];
  for (const b of names.filter(sexOk)) {
    const r = I.runCase(D, outfit, allBodies[b], { cfg: icfg });
    r.name = outfit.join('+'); r.bodyName = b;
    results.push(r);
  }
  const mine = I.rows(results, icfg).filter(r => r.pair.split(':').some(s => s === id || (I.CONFIG.split[id] ?? []).some(p => p.id === s)));
  for (const b of names.filter(sexOk)) {
    const rs = mine.filter(r => r.body === b), bad = rs.filter(r => r.fail);
    const worst = (k) => rs.reduce((a, r) => (r[k].n > a.n ? { n: r[k].n, mm: r[k].mm, at: `${r.pair} ${r.clip}` } : a), { n: 0, mm: 0, at: '' });
    const wp = worst('poke'), ws = worst('sink');
    row(`integrity: ${outfit.join('+')}, ${b}`, !bad.length,
      bad.length ? bad.map(r => `${r.pair} ${r.clip} poke ${r.poke.n}/${r.poke.mm}mm sink ${r.sink.n}/${r.sink.mm}mm`).join('; ')
        : `max poke ${wp.n}/${wp.mm}mm, sink ${ws.n}/${ws.mm}mm`,
      `> ${I.CONFIG.thresholds[0].n} verts AND > ${I.CONFIG.thresholds[0].mm} mm fails`, mode === 'all' ? 'full timeline' : 'shortened timeline');
  }
}

// ---- CLI ---------------------------------------------------------------------------------------------------------
export function table(rep) {
  const W = [58, 6], lines = [`${rep.id ?? rep.file} (${rep.file}, bodies ${rep.mode})`];
  for (const r of rep.rows) {
    const v = `${r.value}${r.limit !== '' ? `  [${r.limit}]` : ''}${r.note ? `  ${r.note}` : ''}`;
    lines.push(`${r.check.padEnd(W[0])} ${r.status.padEnd(W[1])} ${v}`);
  }
  const n = s => rep.rows.filter(r => r.status === s).length;
  lines.push(`=> ${rep.fail ? 'FAIL' : 'OK'}: ${n('OK')} ok, ${n('FAIL')} fail, ${n('KNOWN')} known, ${n('WARN')} warn, ${n('SKIP')} skip`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : ''; };
  const b = opt('--bodies'), json = opt('--json') !== null, nosim = opt('--no-sim') !== null, dir = opt('--dir');
  if (!args.length) { console.error('usage: node tools/check_garment.mjs <garment-id|path.glb> [--bodies quick|all] [--json] [--no-sim] [--dir output]'); process.exit(2); }
  let fail = false;
  const reps = [];
  for (const t of args) {
    const rep = await checkGarment(t, { bodies: b || 'quick', sim: !nosim, dir: dir || undefined });
    fail ||= rep.fail;
    reps.push(rep);
    if (!json) console.log(table(rep) + '\n');
  }
  if (json) console.log(JSON.stringify(reps.length === 1 ? reps[0] : reps, null, 1));
  process.exitCode = fail ? 1 : 0;
}
