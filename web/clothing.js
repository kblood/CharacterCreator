// Clothing: one small GLB per garment (output/clothing.json + clothing_<id>.glb, built by blender/cc_clothing.py),
// loaded on demand, bound to the body skeleton like the hair (so it follows sliders, applySkeleton and the
// animation), tinted at runtime (primary colour + optional secondary colour through a mask texture) and hiding
// the body skin it covers (body attribute _CCZONE: bitmask of zones; a body triangle is dropped when all three
// of its vertices lie in zones hidden by the worn garments).
//
// Rules (clothing.json "rules"): putting an item on removes every worn item that occupies one of its slots, and
// every worn item it conflicts with (either direction). Higher layer = outside.
import * as THREE from 'three';
import { characterMeshes, bindToSkeleton } from './character.js';

import { wearRules, resolveOutfit, hiddenZoneMask, coveringZoneMask, filterIndex, collidesAsLayer } from './clothing_rules.js';

export { wearRules, resolveOutfit, hiddenZoneMask, coveringZoneMask, filterIndex };

// Secondary colour: mask texture R (ccMask) blends the texel toward texel * ccSecondary. Material extras
// tint.lining (0..1, the coat): back faces (inside of the coat and of its collar) take the secondary colour too.
function upgradeCloth(m, maskTex) {
  const lining = Math.min(1, Math.max(0, Number(m.userData?.tint?.lining) || 0));
  const u = { ccSecondary: { value: new THREE.Color(1, 1, 1) }, ccMask: { value: maskTex }, ccLining: { value: lining } };
  m.userData.ccUniforms = u;
  if (maskTex) {
    maskTex.colorSpace = THREE.NoColorSpace;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, u);
      sh.fragmentShader = 'uniform vec3 ccSecondary;\nuniform sampler2D ccMask;\nuniform float ccLining;\n' + sh.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
#ifdef USE_MAP
  float ccM = texture2D( ccMask, vMapUv ).r;
  if ( ! gl_FrontFacing ) ccM = max( ccM, ccLining );
  diffuseColor.rgb = mix( diffuseColor.rgb, sampledDiffuseColor.rgb * ccSecondary, ccM );
#endif`);
    };
    m.customProgramCacheKey = () => 'ccClothMask';
  }
  m.side = THREE.DoubleSide;
  m.needsUpdate = true;
  return m;
}

function setTint(m, hex, which = 'primary') {
  const g = Number(m.userData?.tint?.gain) > 0 ? Number(m.userData.tint.gain) : 1;
  if (which === 'primary') { m.color.set(hex); m.color.multiplyScalar(g); } else m.userData.ccUniforms?.ccSecondary.value.set(hex).multiplyScalar(g);
}

/**
 * opts: { loader, getBody(), addPart(mesh), onChange(), setStatus(msg, isError), t(key), lang }
 * Returns the controller used by main.js (UI, hooks, reset).
 */
export function createClothing(opts) {
  const { loader, getBody, addPart, onChange, setStatus, t, lang } = opts;
  let catalog = null, token = 0, pending = null, bodyIndex = null;
  const cache = new Map();                          // id -> { meshes, materials }
  const worn = [];
  const colors = {};                                // id -> { primary, secondary }
  const ui = { selects: {}, primary: {}, secondary: {}, rows: [] };

  const item = id => catalog?.items.find(i => i.id === id);
  const defaultColors = it => ({ primary: it.colors.primary, secondary: it.colors.secondary ?? null });

  async function load(id) {
    if (cache.has(id)) return cache.get(id);
    const it = item(id);
    if (!it) throw new Error(`unknown clothing item ${id}`);
    const body = getBody();
    const g = await loader.loadAsync(`./${it.file}`);
    const ms = characterMeshes(g.scene);
    if (!ms.length) throw new Error(`${it.file}: no skinned mesh`);
    const materials = [];
    for (const m of ms) {
      m.removeFromParent();
      m.position.copy(body.position); m.quaternion.copy(body.quaternion); m.scale.copy(body.scale);
      body.parent.add(m);
      const r = bindToSkeleton(m, body.skeleton, body.bindMatrix);
      if (r.missing.length) throw new Error(`${it.file}: bones missing in the body skeleton`);
      m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; m.visible = false;
      m.userData.ccClothing = id;
      m.userData.ccLayer = it.layer ?? 0;             // cloth runtime: garments with a lower layer are collided with
      m.userData.ccLayerCollide = collidesAsLayer(it);  // ... unless footwear (clothing_rules.js)
      for (const mat of [].concat(m.material)) {
        const mi = mat.userData?.ccMask?.index;
        const tex = mi !== undefined ? await g.parser.getDependency('texture', mi).catch(() => null) : null;
        materials.push(upgradeCloth(mat, tex));
      }
    }
    const rec = { meshes: ms, materials };
    cache.set(id, rec);
    return rec;
  }

  function applyColors(id) {
    const rec = cache.get(id), c = colors[id];
    if (!rec || !c) return;
    for (const m of rec.materials) {
      setTint(m, c.primary, 'primary');
      if (c.secondary) setTint(m, c.secondary, 'secondary');
    }
  }

  function applyZones() {
    const body = getBody();
    if (!body || !catalog) return;
    const geo = body.geometry, attr = geo.attributes[(catalog.bodyZoneAttribute || '_CCZONE').toLowerCase()];
    if (!geo.index || !attr) return;
    if (!bodyIndex) bodyIndex = geo.index.array.slice();
    const arr = filterIndex(bodyIndex, attr, hiddenZoneMask(catalog, worn));
    geo.setIndex(new THREE.BufferAttribute(arr, 1));
    // garments under a worn higher layer (T-shirt under the coat) drop the triangles it fully covers
    // (vertex attribute _CCZONE of the garment; skinning differences would otherwise poke through)
    for (const id of worn) {
      for (const m of cache.get(id)?.meshes ?? []) {
        const g = m.geometry, za = g.attributes._cczone;
        if (!za || !g.index) continue;
        if (!m.userData.ccIndex) m.userData.ccIndex = g.index.array.slice();
        g.setIndex(new THREE.BufferAttribute(filterIndex(m.userData.ccIndex, za, coveringZoneMask(catalog, worn, id)), 1));
      }
    }
  }

  function syncUI() {
    if (!catalog) return;
    for (const s of catalog.slots) {
      const id = worn.find(w => item(w)?.slot === s) ?? '';
      ui.selects[s].value = id;
      const it = item(id);
      ui.primary[s].input.value = it ? colors[id].primary : '#808080';
      ui.primary[s].input.disabled = !it;
      const hasSec = !!it?.colors.secondary;
      ui.secondary[s].input.value = hasSec ? colors[id].secondary : '#808080';
      ui.secondary[s].label.hidden = ui.secondary[s].input.hidden = !hasSec;
    }
  }

  /** Sets the whole outfit (rules applied, later items win). Returns a promise. */
  function setOutfit(ids) {
    if (!catalog) return Promise.resolve();
    const list = ids == null ? [] : (typeof ids === 'string' ? ids.split(',') : [...ids]).map(s => String(s).trim()).filter(Boolean);
    const want = resolveOutfit(catalog, list.filter(x => x !== 'none'));
    worn.splice(0, worn.length, ...want);
    syncUI();
    const my = ++token;
    const missing = want.filter(id => !cache.has(id));
    if (missing.length) setStatus(t('clothLoading'));
    pending = Promise.all(want.map(load)).then(() => {
      if (my !== token) return;
      for (const [id, rec] of cache) {
        const on = worn.includes(id);
        for (const m of rec.meshes) { m.visible = on; if (on) addPart(m); }
        if (on) applyColors(id);
      }
      applyZones();
      onChange();
      if (statusEl() === t('clothLoading')) setStatus('');
    }).catch(e => {
      console.error('[viewer] clothing load failed', e);
      if (my === token) setStatus(`${t('clothError')}: ${e?.message || e}`, true);
    }).finally(() => { if (my === token) pending = null; });
    return pending;
  }
  const statusEl = () => document.getElementById('status')?.textContent ?? '';

  function wear(id) { return setOutfit(wearRules(catalog, worn, id)); }
  function takeOff(slot) { return setOutfit(worn.filter(w => item(w)?.slot !== slot)); }

  function setColor(id, which, hex) {
    if (!colors[id]) return;
    colors[id][which] = hex;
    applyColors(id);
    syncUI();
  }

  function buildUI(sectionEl) {
    for (const s of catalog.slots) {
      const items = catalog.items.filter(i => i.slot === s);
      if (!items.length) continue;
      const label = catalog.slotLabels?.[s]?.[lang] ?? catalog.slotLabels?.[s]?.da ?? s;
      const l = document.createElement('label'); l.textContent = label;
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', label);
      sel.dataset.slot = s;
      sel.append(new Option(t('clothNone'), ''));
      for (const i of items) sel.append(new Option(i.label?.[lang] ?? i.label?.da ?? i.id, i.id));
      sel.onchange = () => (sel.value ? wear(sel.value) : takeOff(s));
      const row = document.createElement('div'); row.className = 'colors';
      const mk = which => {
        const cl = Object.assign(document.createElement('label'), { className: 'inline', textContent: t(which === 'primary' ? 'clothPrimary' : 'clothSecondary') });
        const c = Object.assign(document.createElement('input'), { type: 'color', value: '#808080' });
        c.setAttribute('aria-label', `${label}: ${cl.textContent}`);
        c.dataset.slot = s; c.dataset.color = which;
        c.oninput = () => { const id = worn.find(w => item(w)?.slot === s); if (id) setColor(id, which, c.value); };
        row.append(cl, c);
        return { label: cl, input: c };
      };
      ui.primary[s] = mk('primary');
      ui.secondary[s] = mk('secondary');
      ui.selects[s] = sel;
      sectionEl.append(l, sel, row);
    }
    syncUI();
  }

  return {
    /** catalogPromise resolves to clothing.json (or null: no clothing UI). */
    async init(catalogPromise, sectionEl, initial) {
      catalog = await catalogPromise;
      if (!catalog?.items?.length) { catalog = null; sectionEl.hidden = true; return; }
      for (const it of catalog.items) colors[it.id] = defaultColors(it);
      buildUI(sectionEl);
      await setOutfit(initial ?? catalog.default ?? []);
    },
    setOutfit, wear, takeOff, setColor,
    reset() {
      if (!catalog) return Promise.resolve();
      for (const it of catalog.items) { colors[it.id] = defaultColors(it); applyColors(it.id); }
      return setOutfit(catalog.default ?? []);
    },
    state() {
      const body = getBody();
      return {
        outfit: [...worn], pending: !!pending, loaded: [...cache.keys()], items: catalog?.items.map(i => i.id) ?? [],
        colors: JSON.parse(JSON.stringify(colors)),
        hiddenZones: catalog ? Object.keys(catalog.bodyZones).filter(z => hiddenZoneMask(catalog, worn) & catalog.bodyZones[z]) : [],
        bodyTriangles: body?.geometry.index ? body.geometry.index.count / 3 : null,
        bodyTrianglesFull: bodyIndex ? bodyIndex.length / 3 : (body?.geometry.index ? body.geometry.index.count / 3 : null),
        visibleMeshes: [...cache.values()].flatMap(r => r.meshes).filter(m => m.visible).map(m => m.name),
        garmentTriangles: Object.fromEntries(worn.map(id => [id, (cache.get(id)?.meshes ?? []).reduce((n, m) => n + (m.geometry.index?.count ?? 0) / 3, 0)])),
      };
    },
    get catalog() { return catalog; },
  };
}
