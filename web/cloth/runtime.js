// Cloth runtime for the viewer (three.js glue; docs/CLOTH_RUNTIME.md). For every worn garment with cloth data
// (vertex attribute _CLOTH_PIN + mesh extras ccCloth, blender/cc_clothing.py) it
//   1. morphs the bind positions with the garment's current slider influences (only when they change: new rest
//      lengths for the solver),
//   2. CPU-skins all vertices with the live skeleton (same matrices three.js uses for the SkinnedMesh),
//   3. advances the XPBD solver (web/cloth/solver.js) at a fixed 60 Hz with an accumulator (max 4 steps per
//      frame, the rest of a long frame is dropped), in a module worker when possible (one job in flight, the
//      result is one frame late) or synchronously (fallback, ?clothWorker=0, deterministic manual mode),
//   4. writes world-space positions/normals into a plain THREE.Mesh "proxy" that shares the garment's index, UVs
//      and materials, and hides the SkinnedMesh from the camera (layers, so its .visible still means "worn").
// Free particles are drawn at x_sim + (A_now - A_ref): the skinned motion since the positions were computed is
// added, so neither the fixed-step remainder nor the worker latency makes the cloth lag behind the body. A worker
// job is solved against its inputs (anchors, capsules, layer points) extrapolated one frame ahead, the frame its
// result is drawn in, and the drawn positions are projected out of this frame's capsules / layers (drawfix.js).
import { buildClothModel, PIN_FIXED } from './model.js';
import { createSolver, clothParams, advance } from './solver.js';
import { morphBase, skinPositions, skinNormals, triNormals } from './skin.js';
import { clothColliderDefs, evalColliders, limitFlags } from './colliders.js';
import { windVelocity } from './wind.js';
import { createLayerSet, selectLayerVertices, bodyLayerMask, LAYER_PARTS, LAYER_STRIDE } from './layers.js';
import { createDrawFix } from './drawfix.js';

const HZ = 60, MAX_STEPS = 4, SETTLE = 20, STATS_EVERY = 30;

// view = true: a plain attribute's own array is returned (read only, no copy: layer sources, the body's morphs)
function readAttr(attr, Ctor = Float32Array, view = false) {
  if (!attr.isInterleavedBufferAttribute && attr.array instanceof Ctor && attr.array.length === attr.count * attr.itemSize) return view ? attr.array : attr.array.slice();
  const out = new Ctor(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i++) for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent(i, c);
  return out;
}

/**
 * Per-frame morph set (dyn_* targets): the union of the vertices any of them moves, and each target's deltas on that
 * list (dense, 3 floats per listed vertex). null when the garment has no non-zero dyn target.
 * Returns { keys, list, deltas, cur: Float32Array(len) (= base + dyn, maintained by dynBase), last, on }.
 */
export function buildDyn(targets, keys, len) {
  keys = keys.filter(k => targets[k]?.some(v => v !== 0));
  if (!keys.length) return null;
  const hit = new Uint8Array(len / 3);
  for (const k of keys) { const t = targets[k]; for (let v = 0; v < hit.length; v++) if (t[3 * v] || t[3 * v + 1] || t[3 * v + 2]) hit[v] = 1; }
  const list = Int32Array.from(hit.reduce((a, h, v) => (h && a.push(v), a), []));
  const deltas = keys.map(k => { const t = targets[k], d = new Float32Array(list.length * 3); list.forEach((v, i) => d.set(t.subarray(3 * v, 3 * v + 3), 3 * i)); return d; });
  return { keys, list, deltas, cur: new Float32Array(len), last: new Float32Array(keys.length), on: false };
}

/** base (static rest shape) + the current dyn influences, sparse over dyn.list. Returns the array to skin from. */
export function dynBase(dyn, base, inf) {
  if (!dyn) return base;
  if (dyn.baseRef !== base) { dyn.cur.set(base); dyn.baseRef = base; dyn.on = false; }   // first call / new base array
  let any = false, same = dyn.on;
  for (let j = 0; j < dyn.keys.length; j++) {
    const w = inf[dyn.keys[j]] || 0;
    if (w) any = true;
    if (Math.abs(w - dyn.last[j]) > 1e-7) same = false;
  }
  if (!any && !dyn.on) return base;                 // idle: no copy at all
  if (same) return dyn.cur;
  const { list, deltas } = dyn;
  for (let i = 0; i < list.length; i++) {
    const o = 3 * list[i];
    let x = base[o], y = base[o + 1], z = base[o + 2];
    for (let j = 0; j < deltas.length; j++) {
      const w = inf[dyn.keys[j]] || 0;
      if (!w) continue;
      const d = deltas[j];
      x += w * d[3 * i]; y += w * d[3 * i + 1]; z += w * d[3 * i + 2];
    }
    dyn.cur[o] = x; dyn.cur[o + 1] = y; dyn.cur[o + 2] = z;
  }
  for (let j = 0; j < dyn.keys.length; j++) dyn.last[j] = inf[dyn.keys[j]] || 0;
  dyn.on = any;
  return any ? dyn.cur : base;
}

/** cur + (cur - prev) on the first `cols` of every `stride` floats (positions; normals / radii / part ids kept). */
export function extrapolate(out, cur, prev, stride, cols = stride) {
  out.set(cur);
  if (prev && prev.length === cur.length) for (let i = 0; i < cur.length; i += stride) for (let c = 0; c < cols; c++) out[i + c] = 2 * cur[i + c] - prev[i + c];
  return out;
}

/** Does this (garment) mesh carry cloth data? */
export function hasClothData(mesh) {
  return !!(mesh?.isSkinnedMesh && mesh.geometry?.getAttribute('_cloth_pin') && mesh.geometry.index);
}

/**
 * opts: { THREE, scene, colliders (body_colliders.json or null), getInfluences() -> { morph: w },
 *         getRootSpeed() -> m/s, useWorker (default true) }
 */
export function createClothRuntime(opts) {
  const { THREE, scene } = opts;
  const defs = opts.colliders ? clothColliderDefs(opts.colliders) : [];
  const caps = new Float32Array(defs.length * 7);
  const garments = new Map();                       // SkinnedMesh -> garment state
  const st = { enabled: true, wind: 0, sync: opts.useWorker === false, time: 0, acc: 0 };
  const perf = { frame: [], solve: [], steps: [], frames: 0 };
  let worker = null, workerState = 'off', seq = 0, bones = null;
  const _m = new THREE.Matrix4(), _pre = new THREE.Matrix4();

  // ---- worker (optional) ----
  function startWorker() {
    if (st.sync || worker || workerState === 'failed' || typeof Worker === 'undefined') return;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      workerState = 'starting';
      worker.onmessage = e => onWorker(e.data);
      worker.onerror = e => failWorker(e?.message || 'worker error');
    } catch (e) { failWorker(e?.message || String(e)); }
  }
  function failWorker(why) {
    console.warn('[cloth] worker unavailable, solving on the main thread:', why);
    try { worker?.terminate(); } catch { /* ignore */ }
    worker = null; workerState = 'failed';
    for (const g of garments.values()) { g.remote = false; g.inFlight = false; g.needReset = true; }
  }
  function onWorker(msg) {
    if (msg.type === 'ready') { workerState = 'ready'; return; }
    if (msg.type === 'error') { failWorker(msg.message); return; }
    if (msg.type !== 'done') return;
    const g = [...garments.values()].find(q => q.key === msg.key);
    if (!g || msg.seq !== g.seq) return;             // stale (garment rebuilt / reset meanwhile)
    g.inFlight = false; g.sentAt = 0;
    g.X = msg.x; g.Aref = msg.A1ref;
    g.fix.setRef(msg.x, msg.C1ref, msg.L1ref);
    g.steps = msg.steps; g.resets = msg.resets;
    if (msg.n) perf.solve.push(msg.ms / (msg.n + (msg.settle || 0)));
    if (msg.stats) g.stats = msg.stats;
  }

  // ---- garment setup ----
  function build(mesh) {
    const geo = mesh.geometry;
    const positions = readAttr(geo.getAttribute('position'));
    const pin = readAttr(geo.getAttribute('_cloth_pin'));
    const index = geo.index.array;
    const model = buildClothModel({ positions, index, pin });
    const sim = model.sim;
    const n = positions.length / 3;
    const targets = (geo.morphAttributes.position || []).map(a => readAttr(a));
    // per-frame morphs (breast motion dyn_*, docs/BREAST_PHYSICS.md) are kept out of the rest shape: they would
    // re-morph the whole garment and reset the solver's rest lengths every frame. They are added to the skinned
    // base per frame over their few vertices only (dynBase).
    const dynSet = new Set(Object.entries(mesh.morphTargetDictionary || {}).filter(([nm]) => nm.startsWith('dyn_')).map(([, k]) => k));
    const active = targets.map((t, k) => (!dynSet.has(k) && t.some(v => v !== 0) ? k : -1)).filter(k => k >= 0);
    const dyn = buildDyn(targets, [...dynSet], positions.length);
    const extras = mesh.userData?.ccCloth || null;
    const params = clothParams(extras);
    const reps = Int32Array.from(sim.particles, p => model.rep[p]);
    const simOf = new Int32Array(model.particleCount).fill(-1);
    sim.particles.forEach((p, s) => { simOf[p] = s; });
    // proxy mesh in world space
    const pg = new THREE.BufferGeometry();
    pg.setIndex(geo.index);
    for (const name of Object.keys(geo.attributes)) if (/^uv\d?$/.test(name)) pg.setAttribute(name, geo.attributes[name]);
    const posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const nrmAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    pg.setAttribute('position', posAttr); pg.setAttribute('normal', nrmAttr);
    for (const gr of geo.groups) pg.addGroup(gr.start, gr.count, gr.materialIndex);
    pg.boundingSphere = new THREE.Sphere(); pg.boundingBox = new THREE.Box3();
    const proxy = new THREE.Mesh(pg, mesh.material);
    proxy.name = `${mesh.name}_cloth`;
    proxy.matrixAutoUpdate = false; proxy.frustumCulled = true;
    proxy.castShadow = mesh.castShadow; proxy.receiveShadow = mesh.receiveShadow;
    proxy.visible = false;
    proxy.userData.ccClothProxy = mesh.userData.ccClothing ?? mesh.name;
    scene.add(proxy);
    // normal orientation: welded (triangle) normals vs the exported normals at rest
    const bindN = geo.getAttribute('normal') ? readAttr(geo.getAttribute('normal')) : null;
    const PX = new Float32Array(model.particleCount * 3);
    for (let p = 0; p < model.particleCount; p++) { const v = model.rep[p]; PX.set(positions.subarray(3 * v, 3 * v + 3), 3 * p); }
    const PN = triNormals(new Float32Array(PX.length), PX, model.tris);
    const nsign = new Float32Array(n).fill(1);
    if (bindN) {
      for (let v = 0; v < n; v++) {
        const p = model.vmap[v];
        if (PN[3 * p] * bindN[3 * v] + PN[3 * p + 1] * bindN[3 * v + 1] + PN[3 * p + 2] * bindN[3 * v + 2] < 0) nsign[v] = -1;
      }
    }
    const limit = limitFlags(defs, params.limit);
    const g = {
      key: `${mesh.userData.ccClothing ?? mesh.name}#${++seq}`, id: mesh.userData.ccClothing ?? mesh.name, mesh, proxy,
      model, sim, params, reps, simOf, limit, targets, active, dyn, positions, bindN, nsign,
      fix: createDrawFix(sim, params, limit), D: new Float32Array(sim.count * 3), act: null, drawn: -1,
      skinIndex: readAttr(geo.getAttribute('skinIndex'), Uint16Array), skinWeight: readAttr(geo.getAttribute('skinWeight')),
      base: new Float32Array(positions.length), lastInfl: null, restX: new Float32Array(sim.count * 3),
      mats: new Float32Array(16 * mesh.skeleton.bones.length),
      skin: new Float32Array(n * 3), skinN: new Float32Array(n * 3), A: new Float32Array(sim.count * 3),
      lastA: null, lastC: null, X: null, Aref: null, PX, PN,
      solver: null, remote: false, inFlight: false, seq: 0, sentAt: 0, needReset: true, owed: 0,
      steps: 0, resets: 0, stats: null, statsDue: 0,
    };
    updateBase(g, true);
    return g;
  }

  function updateBase(g, force = false) {
    const inf = g.mesh.morphTargetInfluences || [];
    let changed = force || !g.lastInfl;
    if (!changed) for (const k of g.active) if (Math.abs((inf[k] || 0) - g.lastInfl[k]) > 1e-6) { changed = true; break; }
    if (!changed) return false;
    g.lastInfl = Float32Array.from(g.targets, (_, k) => (g.dyn?.keys.includes(k) ? 0 : inf[k] || 0));
    morphBase(g.base, g.positions, g.targets.map((t, k) => (g.lastInfl[k] ? t : null)), g.lastInfl);
    if (g.dyn) { g.dyn.cur.set(g.base); g.dyn.on = false; }
    g.reps.forEach((v, s) => { g.restX[3 * s] = g.base[3 * v]; g.restX[3 * s + 1] = g.base[3 * v + 1]; g.restX[3 * s + 2] = g.base[3 * v + 2]; });
    if (g.solver) g.solver.setRest(g.restX);
    if (g.remote) worker.postMessage({ type: 'rest', key: g.key, restX: g.restX });
    return true;
  }

  /** false while the worker is still starting (the garment is drawn skinned meanwhile). */
  function ensureSolver(g) {
    if (!st.sync && workerState === 'starting') return false;
    const wantRemote = !st.sync && workerState === 'ready';
    if (wantRemote && !g.remote) {
      worker.postMessage({ type: 'init', key: g.key, sim: g.sim, restX: g.restX, params: g.params });
      g.remote = true; g.solver = null; g.needReset = true; g.inFlight = false;
    } else if (!wantRemote && (g.remote || !g.solver)) {
      if (g.remote && worker) worker.postMessage({ type: 'drop', key: g.key });
      g.remote = false; g.solver = createSolver(g.sim, g.restX, g.params); g.needReset = true; g.inFlight = false;
    }
    return true;
  }

  // ---- per frame ----
  function jointPos(name) {
    const b = bones?.get(name);
    if (!b) return null;
    const e = b.matrixWorld.elements;
    return [e[12], e[13], e[14]];
  }

  function skinMats(g) { skinMatsOf(g.mesh, g.mats); }
  function skinMatsOf(m, out) {
    const sk = m.skeleton;
    _pre.copy(m.matrixWorld).multiply(m.bindMatrixInverse);
    for (let i = 0; i < sk.bones.length; i++) {
      _m.multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]).premultiply(_pre).multiply(m.bindMatrix);
      out.set(_m.elements, 16 * i);
    }
    return out;
  }

  // Lower layers (web/cloth/layers.js): the worn garments with a lower catalog layer (userData.ccLayer) than g,
  // except skin-tight underwear (userData.ccLayerCollide false, clothing_rules.js collidesAsLayer), and the body's
  // drawn leg / hip skin (last part; bodyLayerMask on the zone-filtered index, where skin hidden only by skin-tight
  // underwear still counts: body.userData.ccLayerIndex). Their vertices near g's free
  // particles (bind space) become collision points, rebuilt when that set (or the body's zones) changes. At most
  // LAYER_PARTS parts are collided with (solver.js); more garments are not worn at once in the catalog.
  let idxSeq = 0;
  const idxIds = new WeakMap();
  function syncLayers(g, meshes, body) {
    const my = g.mesh.userData.ccLayer ?? 0;
    const useBody = !!(body?.isSkinnedMesh && body.geometry.index && body.geometry.getAttribute('normal'));
    const lower = meshes.filter(m => m !== g.mesh && m.isSkinnedMesh && m.visible && m.userData.ccClothing != null
      && (m.userData.ccLayer ?? 0) < my && m.userData.ccLayerCollide !== false && m.geometry.getAttribute('normal'))
      .slice(0, LAYER_PARTS - (useBody ? 1 : 0));
    const bIdx = useBody ? body.geometry.index : null;
    if (bIdx && !idxIds.has(bIdx)) idxIds.set(bIdx, ++idxSeq);
    const key = lower.map(m => m.uuid).join(',') + (bIdx ? `|${body.uuid}:${idxIds.get(bIdx)}` : '');
    if (g.layers && g.layers.key === key) return g.layers;
    if (!g.freeBind) {
      const fb = [];
      for (let p = 0; p < g.model.particleCount; p++) if (g.model.pin[p] < PIN_FIXED) { const v = g.model.rep[p]; fb.push(g.positions[3 * v], g.positions[3 * v + 1], g.positions[3 * v + 2]); }
      g.freeBind = Float32Array.from(fb);
    }
    // (read only: createLayerSet copies the selected vertices)
    const part = (m, mask = null) => {
      const geo = m.geometry, positions = readAttr(geo.getAttribute('position'), Float32Array, true);
      const skinIndex = readAttr(geo.getAttribute('skinIndex'), Uint16Array, true), skinWeight = readAttr(geo.getAttribute('skinWeight'), Float32Array, true);
      const sel = mask ? mask(skinIndex, skinWeight, positions.length / 3) : null;
      return { positions, normals: readAttr(geo.getAttribute('normal'), Float32Array, true), skinIndex, skinWeight,
        targets: (geo.morphAttributes.position || []).map(a => readAttr(a, Float32Array, true)), list: selectLayerVertices(positions, g.freeBind, undefined, sel) };
    };
    const parts = lower.map(m => part(m));
    const ms = [...lower];
    if (useBody) {
      const names = body.skeleton.bones.map(b => b.name);
      // the skin under skin-tight underwear counts too (clothing.js applyZones sets ccLayerIndex with the index)
      const lIdx = body.userData.ccLayerIndex ?? bIdx.array;
      parts.push(part(body, (si, sw, n) => bodyLayerMask(lIdx, si, sw, names, n)));
      ms.push(body);
    }
    const set = ms.length ? createLayerSet(parts) : null;
    g.layers = { key, meshes: ms, set, mats: ms.map(m => new Float32Array(16 * m.skeleton.bones.length)) };
    g.lastL = null; g.needReset = true;
    return g.layers;
  }

  // L = this frame's layer points (or null)
  function writeProxy(g, L) {
    const n = g.positions.length / 3, pos = g.proxy.geometry.attributes.position.array, nrm = g.proxy.geometry.attributes.normal.array;
    const { model, simOf, sim } = g;
    const X = g.X, Aref = g.Aref, A = g.A, D = g.D;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    if (X) {
      // drawn = solved + skinned motion since, then out of this frame's capsules / layers (drawfix.js)
      for (let q = 0; q < D.length; q++) D[q] = X[q] + A[q] - Aref[q];
      g.fix.apply(D, A, caps, L);
    }
    // particle positions (welded) -> normals across UV seams
    for (let p = 0; p < model.particleCount; p++) {
      const s = simOf[p], v = model.rep[p], o = 3 * p;
      if (X && s >= 0 && sim.pin[s] < PIN_FIXED) {
        const q = 3 * s;
        g.PX[o] = D[q]; g.PX[o + 1] = D[q + 1]; g.PX[o + 2] = D[q + 2];
      } else { g.PX[o] = g.skin[3 * v]; g.PX[o + 1] = g.skin[3 * v + 1]; g.PX[o + 2] = g.skin[3 * v + 2]; }
    }
    triNormals(g.PN, g.PX, model.tris);
    for (let v = 0; v < n; v++) {
      const p = model.vmap[v], o = 3 * v, q = 3 * p, w = model.pin[p];
      const x = g.PX[q], y = g.PX[q + 1], z = g.PX[q + 2];
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
      if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
      if (w >= PIN_FIXED || !g.bindN) { nrm[o] = g.skinN[o]; nrm[o + 1] = g.skinN[o + 1]; nrm[o + 2] = g.skinN[o + 2]; continue; }
      const sg = g.nsign[v] * (1 - w);
      const nx = g.PN[q] * sg + g.skinN[o] * w, ny = g.PN[q + 1] * sg + g.skinN[o + 1] * w, nz = g.PN[q + 2] * sg + g.skinN[o + 2] * w;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[o] = nx / l; nrm[o + 1] = ny / l; nrm[o + 2] = nz / l;
    }
    const geo = g.proxy.geometry;
    geo.attributes.position.needsUpdate = true; geo.attributes.normal.needsUpdate = true;
    geo.boundingBox.min.set(x0, y0, z0); geo.boundingBox.max.set(x1, y1, z1);
    geo.boundingBox.getBoundingSphere(geo.boundingSphere);
  }

  function setShown(g, on) {
    g.proxy.visible = on;
    if (on) g.mesh.layers.disable(0); else g.mesh.layers.enable(0);
  }

  /** dt: frame time (s). meshes: the character's parts (garments are picked by their cloth data). */
  function update(dt, meshes) {
    const t0 = performance.now();
    const body = opts.getBody?.();
    if (body && !bones) bones = new Map(body.skeleton.bones.map(b => [b.name, b]));
    const live = new Set();
    for (const m of meshes) {
      if (!hasClothData(m)) continue;
      let g = garments.get(m);
      const on = st.enabled && m.visible;
      if (!on) { if (g) { setShown(g, false); g.needReset = true; } continue; }
      if (!g) { g = build(m); garments.set(m, g); }
      live.add(g);
    }
    for (const g of garments.values()) if (!meshes.includes(g.mesh)) setShown(g, false);
    if (!live.size) { st.acc = 0; return; }
    startWorker();
    // fixed steps due this frame (shared by all garments)
    st.acc += Math.min(Math.max(dt, 0), MAX_STEPS / HZ);
    let n = Math.floor(st.acc * HZ + 1e-6);
    if (n > MAX_STEPS) n = MAX_STEPS;
    st.acc = Math.max(0, st.acc - n / HZ);
    if (st.acc >= 1 / HZ) st.acc %= 1 / HZ;
    st.time += n / HZ;
    // frame inputs shared by the garments
    evalColliders(caps, defs, jointPos, opts.getInfluences?.() || {}, 1);
    const L = jointPos('thigh_l'), R = jointPos('thigh_r');
    let lat = [1, 0, 0];
    if (L && R) { const d = [L[0] - R[0], L[1] - R[1], L[2] - R[2]], l = Math.hypot(...d) || 1; lat = d.map(c => c / l); }
    const fwd = opts.getForward?.() || [0, 0, 1];
    const speed = opts.getRootSpeed?.() || 0;
    let solveMs = 0, statsNow = ++perf.frames % STATS_EVERY === 0;
    // inner garments first: a simulated lower garment (the skirt) is a layer of the coat in its DRAWN shape
    const order = [...live].sort((a, b) => (a.mesh.userData.ccLayer ?? 0) - (b.mesh.userData.ccLayer ?? 0));
    const drawnOf = m => {
      const q = garments.get(m);
      if (!q || q.drawn !== perf.frames) return null;
      const a = q.proxy.geometry.attributes;
      return { positions: a.position.array, normals: a.normal.array };
    };
    for (const g of order) {
      updateBase(g);
      const ready = ensureSolver(g);
      skinMats(g);
      skinPositions(g.skin, dynBase(g.dyn, g.base, g.mesh.morphTargetInfluences || []), g.skinIndex, g.skinWeight, g.mats);
      if (g.bindN) skinNormals(g.skinN, g.bindN, g.skinIndex, g.skinWeight, g.mats);
      g.reps.forEach((v, s) => { g.A[3 * s] = g.skin[3 * v]; g.A[3 * s + 1] = g.skin[3 * v + 1]; g.A[3 * s + 2] = g.skin[3 * v + 2]; });
      const wv = windVelocity(st.wind * g.params.wind, st.time);
      const air = [wv[0] - speed * fwd[0], wv[1] - speed * fwd[1], wv[2] - speed * fwd[2]];
      const lay = syncLayers(g, meshes, body);
      const L = lay.set ? lay.set.update(k => skinMatsOf(lay.meshes[k], lay.mats[k]), k => lay.meshes[k].morphTargetInfluences, k => drawnOf(lay.meshes[k])) : null;
      // worker jobs are solved one frame ahead: this frame's inputs + their motion since the previous frame
      const act = g.act ??= { A: null, C: null, L: null, pA: new Float32Array(g.A.length), pC: new Float32Array(caps.length), pL: null };
      const reset = g.needReset;
      const job = { n: reset ? Math.max(n, 0) : n, A0: reset ? null : g.lastA, A1: g.A, C0: reset ? null : g.lastC, C1: caps,
        L0: reset ? null : g.lastL, L1: L, floorY: 0, lateral: lat, air, limit: g.limit, reset, settle: reset ? SETTLE : 0 };
      if (!ready) { g.X = null; }
      else if (!g.remote) {
        if (n > 0 || reset) {
          const s0 = performance.now();
          g.X = advance(g.solver, job);
          if (n) { solveMs += performance.now() - s0; perf.solve.push((performance.now() - s0) / Math.max(1, n + job.settle)); }
          g.Aref = Float32Array.from(g.A);
          g.lastA = Float32Array.from(g.A); g.lastC = Float32Array.from(caps); g.lastL = L ? Float32Array.from(L) : null;
          g.fix.setRef(g.X, g.lastC, g.lastL);
          g.steps = g.solver.steps; g.resets = g.solver.resets;
          if (statsNow) g.stats = { stretch: g.solver.stretch(), pen: g.solver.penetrations(caps, 0, 0.002, g.limit) };
        }
        g.needReset = false;
      } else {
        g.owed = Math.min(MAX_STEPS, g.owed + n);
        if (g.inFlight && g.sentAt && performance.now() - g.sentAt > 1500) failWorker('no answer for 1.5 s');
        else if (!g.inFlight && (g.owed > 0 || reset)) {
          job.n = g.owed;
          g.seq++;
          const pred = !reset && act.A;
          if (act.pC.length !== caps.length) act.pC = new Float32Array(caps.length);
          if (L && act.pL?.length !== L.length) act.pL = new Float32Array(L.length);
          const A1 = Float32Array.from(pred ? extrapolate(act.pA, g.A, act.A, 3) : g.A);
          const C1 = Float32Array.from(pred ? extrapolate(act.pC, caps, act.C, 7, 6) : caps);
          const L1 = L ? Float32Array.from(pred ? extrapolate(act.pL, L, act.L, LAYER_STRIDE, 3) : L) : null;
          worker.postMessage({ type: 'job', key: g.key, seq: g.seq, job: { ...job, A1, C1, L1 }, stats: statsNow || g.statsDue > 0 });
          g.statsDue = statsNow ? 0 : g.statsDue;
          g.inFlight = true; g.sentAt = performance.now(); g.owed = 0; g.needReset = false;
          g.lastA = A1; g.lastC = C1; g.lastL = L1;
          if (reset) { g.X = null; g.Aref = null; }
        } else if (statsNow) g.statsDue = 1;
      }
      // this frame's actual inputs (the next job's extrapolation base)
      act.A = act.A?.length === g.A.length ? (act.A.set(g.A), act.A) : Float32Array.from(g.A);
      act.C = act.C?.length === caps.length ? (act.C.set(caps), act.C) : Float32Array.from(caps);
      act.L = L ? (act.L?.length === L.length ? (act.L.set(L), act.L) : Float32Array.from(L)) : null;
      writeProxy(g, L);
      setShown(g, true);
      g.drawn = perf.frames;
    }
    perf.steps.push(n);
    perf.frame.push(performance.now() - t0);
    for (const k of ['frame', 'solve', 'steps']) if (perf[k].length > 120) perf[k].splice(0, perf[k].length - 120);
    return solveMs;
  }

  const avg = a => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
  return {
    update,
    /** Restart every garment from its skinned pose (outfit change, Reset, seek). */
    reset() { for (const g of garments.values()) { g.needReset = true; g.owed = 0; } st.acc = 0; },
    setEnabled(on) {
      st.enabled = !!on;
      for (const g of garments.values()) { g.needReset = true; if (!on) setShown(g, false); }
    },
    setWind(s) { st.wind = Math.min(1, Math.max(0, +s || 0)); },
    /** true: solve on the main thread (deterministic; manual stepping and tests). */
    setSync(on) { st.sync = !!on; for (const g of garments.values()) g.needReset = true; },
    get enabled() { return st.enabled; },
    stats() {
      const gs = [...garments.values()].filter(g => g.proxy.visible);
      return {
        enabled: st.enabled, wind: st.wind,
        mode: !gs.length ? 'idle' : gs.some(g => g.remote) ? 'worker' : 'sync', worker: workerState,
        msPerFrame: +avg(perf.frame).toFixed(3), solverMsPerStep: +avg(perf.solve).toFixed(3),
        stepsPerFrame: +avg(perf.steps).toFixed(2), frames: perf.frames, time: +st.time.toFixed(3),
        garments: gs.map(g => ({
          id: g.id, particles: g.sim.count, free: Array.from(g.sim.pin).filter(p => p < PIN_FIXED).length, steps: g.steps,
          resets: g.resets, stretchP99: g.stats ? +g.stats.stretch.p99.toFixed(3) : null,
          stretchMax: g.stats ? +g.stats.stretch.max.toFixed(3) : null,
          penetrations: g.stats ? g.stats.pen.count : null, penetrationMm: g.stats ? g.stats.pen.worstMm : null,
          belowFloor: g.stats ? g.stats.pen.belowFloor : null,
          layers: g.layers ? g.layers.meshes.map(m => m.userData.ccClothing) : [], layerPoints: g.layers?.set?.count ?? 0,
        })),
      };
    },
    garments: () => [...garments.values()],
    dispose() {
      for (const g of garments.values()) { setShown(g, false); g.proxy.removeFromParent(); g.proxy.geometry.dispose(); }
      garments.clear(); worker?.terminate(); worker = null;
    },
  };
}
