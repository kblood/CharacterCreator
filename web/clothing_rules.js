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
 * Whether a cloth garment worn over item `it` collides with it as a lower layer (web/cloth/layers.js). Footwear
 * (hides only the feet) does not: the coat hem only reaches it on short bodies, where pushing the hem out over
 * the shoe fights the floor and the shoe kicks through it (tools/cloth_sim.mjs --under ... shoes).
 */
export function collidesAsLayer(it) {
  const z = it?.hidesBodyZones ?? [];
  return !(z.length === 1 && z[0] === 'feet');
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
