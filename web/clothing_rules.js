// Clothing rules without three.js (shared by web/clothing.js and the node tests): outfit resolution with the
// occupies / conflicts rules of output/clothing.json, and the body zone mask / triangle filter.

/** Resolves the outfit after putting `id` on top of `worn` (ids, in wear order). */
export function wearRules(catalog, worn, id) {
  const byId = new Map(catalog.items.map(i => [i.id, i]));
  const it = byId.get(id);
  if (!it) throw new Error(`unknown clothing item ${id}`);
  const occ = new Set(it.occupies ?? [it.slot]);
  const keep = worn.filter(w => {
    const o = byId.get(w);
    if (!o || w === id) return false;
    if ((o.occupies ?? [o.slot]).some(s => occ.has(s))) return false;
    if ((it.conflicts ?? []).includes(w) || (o.conflicts ?? []).includes(id)) return false;
    return true;
  });
  return [...keep, id];
}

/** Resolves a whole list (later items win), dropping unknown ids. */
export function resolveOutfit(catalog, ids) {
  const known = new Set(catalog.items.map(i => i.id));
  let out = [];
  for (const id of ids) if (known.has(id)) out = wearRules(catalog, out, id);
  return out;
}

/** Bitmask of the body zones hidden by the given items. */
export function hiddenZoneMask(catalog, ids) {
  let mask = 0;
  for (const id of ids) {
    const it = catalog.items.find(i => i.id === id);
    for (const z of it?.hidesBodyZones ?? []) mask |= catalog.bodyZones?.[z] ?? 0;
  }
  return mask;
}

/** Bitmask of the zones of the worn items in a higher layer than item `id` (they cover parts of it). */
export function coveringZoneMask(catalog, worn, id) {
  const layer = catalog.items.find(i => i.id === id)?.layer ?? 0;
  return hiddenZoneMask(catalog, worn.filter(w => (catalog.items.find(i => i.id === w)?.layer ?? 0) > layer));
}

/**
 * Whether a cloth garment worn over item `it` collides with it as a lower layer (web/cloth/layers.js). Everything
 * but skin-tight underwear (the body's own leg / hip skin is a layer, layers.js bodyLayerMask). Footwear too: in
 * run the shoe swings forward through the ankle-length coat hem, which the foot capsule alone does not stop
 * (tools/cloth_integrity.mjs trenchcoat:shoes); the shoe as a layer + the drawn-frame contacts (drawfix.js) do.
 */
export function collidesAsLayer(it) {
  if (it?.collidesAsLayer === false || it?.slot === 'underwear' || it?.slot === 'bra') return false;   // skin-tight underwear: the body is the collider
  return true;
}

/**
 * Bitmask of the body zones hidden by the worn items that are a cloth layer themselves (collidesAsLayer). The cloth
 * body layer (layers.js bodyLayerMask) uses the body index filtered with THIS mask, not the drawn one: the skin under
 * skin-tight underwear is hidden (the underwear is drawn instead) but must still hold the skirt / coat off, or the
 * free skirt swung in through the panties in run (review 2026-10-01). The underwear lies 2 mm outside that skin.
 */
export function layerHiddenZoneMask(catalog, worn) {
  return hiddenZoneMask(catalog, worn.filter(id => collidesAsLayer(catalog?.items?.find(i => i.id === id))));
}

/** Ids of the default underwear for sex 'male' | 'female' (catalog defaultUnderwear; [] without one). */
export function defaultUnderwear(catalog, sex) {
  const known = new Set(catalog?.items?.map(i => i.id) ?? []);
  return (catalog?.defaultUnderwear?.[sex] ?? []).filter(id => known.has(id));
}

/** True for an item of an underwear slot (catalog underwearSlots: 'underwear', 'bra'). */
export function isUnderwear(catalog, id) {
  const slots = catalog?.underwearSlots ?? ['underwear'];
  return slots.includes(catalog?.items?.find(i => i.id === id)?.slot);
}

/**
 * Outfit as requested through ?outfit= / __set('outfit') / init / reset: null (not given) = the catalog default plus
 * the default underwear; 'none', '' or an empty list = naked (explicit); a non-empty list without an underwear item
 * gets the default underwear of `sex` added (underwear is on by default), unless `underwear` is false. Returns ids
 * (rules applied). An explicit underwear id in the list is kept as it is.
 */
export function outfitWithUnderwear(catalog, ids, sex, underwear = true) {
  const list = ids == null ? null : (typeof ids === 'string' ? ids.split(',') : [...ids]).map(s => String(s).trim()).filter(Boolean);
  if (list && (list.length === 0 || list.includes('none'))) return [];
  const base = list ?? catalog?.default ?? [];
  const add = underwear && !base.some(id => isUnderwear(catalog, id)) ? defaultUnderwear(catalog, sex) : [];
  return resolveOutfit(catalog, [...add, ...base]);
}

/**
 * Underwear after a sex change: worn underwear made for the other sex (item.sex) is swapped for the new sex's
 * default; no underwear worn = nothing added (it was taken off on purpose). Returns the new outfit ids.
 */
export function swapUnderwearForSex(catalog, worn, sex) {
  const wrong = worn.filter(id => { const it = catalog?.items?.find(i => i.id === id); return isUnderwear(catalog, id) && it.sex && it.sex !== sex; });
  if (!wrong.length) return [...worn];
  return resolveOutfit(catalog, [...defaultUnderwear(catalog, sex), ...worn.filter(id => !wrong.includes(id))]);
}

/** Triangle index of `geometry` without the triangles whose three vertices are all hidden. */
export function filterIndex(fullIndex, zoneAttr, mask) {
  if (!mask || !zoneAttr) return fullIndex;
  const z = zoneAttr.array, out = new (fullIndex.constructor)(fullIndex.length);
  let n = 0;
  for (let i = 0; i < fullIndex.length; i += 3) {
    const a = fullIndex[i], b = fullIndex[i + 1], c = fullIndex[i + 2];
    if ((z[a] & mask) && (z[b] & mask) && (z[c] & mask)) continue;
    out[n++] = a; out[n++] = b; out[n++] = c;
  }
  return out.slice(0, n);
}
