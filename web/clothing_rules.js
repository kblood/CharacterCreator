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
