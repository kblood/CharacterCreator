// Engine-agnostic slider model -> glTF morph target influences (works on any glTF loader).
// Bipolar sliders map -1..1 onto a pair of morph targets; unipolar map 0..1 onto one.
export const SLIDERS = [
  { id: 'gender',      label: 'Køn (K ↔ M)',      neg: 'gender_female',    pos: 'gender_male' },
  { id: 'age',         label: 'Alder (barn ↔ gammel)', neg: 'age_child',   pos: 'age_old' },
  { id: 'height',      label: 'Højde',            neg: 'height_short',     pos: 'height_tall' },
  { id: 'weight',      label: 'Vægt',             neg: 'weight_min',       pos: 'weight_max' },
  { id: 'muscle',      label: 'Muskler',          neg: 'muscle_min',       pos: 'muscle_max' },
  { id: 'proportions', label: 'Proportioner',     neg: 'proportions_uncommon', pos: 'proportions_ideal' },
];
export function applySliders(mesh, values) {
  const idx = mesh.morphTargetDictionary, inf = mesh.morphTargetInfluences;
  inf.fill(0);
  for (const s of SLIDERS) {
    const v = values[s.id] ?? 0;
    if (v < 0) inf[idx[s.neg]] = -v; else inf[idx[s.pos]] = v;
  }
}
export function applySkinColor(mesh, hex) { mesh.material.color.set(hex); }
