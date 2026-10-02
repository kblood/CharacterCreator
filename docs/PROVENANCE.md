# Provenance: the macro-weight code (roadmap M3)

Not legal advice. This file records what was compared, how, and what the project concludes under its own rule
(LICENSE-NOTES.md: no MPFB/GPL code in the MIT repos; "when in doubt: clean-room rewrite from data and
documentation").

Checked 2026-10-02 against MPFB 2.0.17 as installed in Blender (`<mpfb>` below = the extension folder;
`blender_manifest.toml` says `license = ["SPDX:GPL-3.0-or-later"]`). The GPL source was read for the comparison;
nothing from it is copied into this file or into the repo.

## 1. Which files

| File | Repo | Role |
|---|---|---|
| `web/baseline_viewer/macros.js` (115 lines) | CharacterCreatorBaseline | macro values -> weights of the exported MPFB targets (viewer) |
| `web/compare/adapters/baseline_macros.js` (185 lines) | CharacterCreatorBaseline | same job for the compare page; served on the public site |
| `web/*.js` | CharacterCreator | **no macro arithmetic.** `web/character.js` blends linear morphs that `blender/build_base.py` baked by *calling* MPFB's API in Blender (`TargetService.reapply_macro_details`, `load_target`, `bake_targets`) |
| `web/**` | CharacterCreatorXR | no macro code (git grep: 0 files) |

The roadmap's "`macros.js`" is the first row. Both Baseline files must be treated together: the second one was
written later for the same job.

## 2. The header claims

- `macros.js`: "Written from the data in the manifest (macroModel = MakeHuman's CC0 macro.json ...). It reproduces
  the documented MakeHuman/MPFB rule".
- `baseline_macros.js`: "Same arithmetic as MPFB 2 (services/targetservice.py `_interpolate_macro_components` +
  `calculate_target_stack_from_macro_info_dict`)". It says openly that it follows the GPL functions.

## 3. Method

1. **Data vs CC0 `macro.json`** (`<mpfb>/data/targets/macrodetails/macro.json`, MakeHuman data, CC0): the
   `MACRO_PARTS` table in `baseline_macros.js` was compared field by field (node, `JSON.stringify` per macro) with
   `macrotargets.*.parts` (`lowest`, `highest`, `low`, `high`).
2. **Target families vs CC0 data**: `macro.json` also has a `combinations` key, and the target files on disk
   (`data/targets/macrodetails/**`, `data/targets/breast/*`, CC0) were counted.
3. **Verbatim overlap**: `node tools/check_no_gpl_paste.mjs <repo> --against <mpfb>` lists every non-trivial line
   (>= 30 chars, not an import, not a single Blender API statement) of our code files that also occurs in MPFB's
   `.py` files. Run on all three repos. A looser 20-char run was done by hand as well.
4. **Denylist** (same script without `--against`): MPFB-only identifiers, scaffolding and comment strings.
5. **Side by side, structure and names** (by reading; table in section 4).

## 4. Results

| Check | Result |
|---|---|
| `MACRO_PARTS` vs CC0 `macro.json` | identical for all 8 macros (0 differences) |
| Target families | the 5 families are listed in CC0 `macro.json` `combinations` (race-gender-age, gender-age-muscle-weight, + proportions, + height, + cupsize-firmness) |
| Exclusions | derivable from the CC0 files on disk: 216 `breast/female-*` targets, 0 `breast/male-*`, 0 baby breast, 0 `averagecup-averagefirmness`, 0 baby proportions (108 proportions files) |
| Verbatim lines (>= 30 chars) | CC 0, Baseline 0, XR 0 |
| Verbatim lines (>= 20 chars) | CC 2, Baseline 2, all Blender API one-liners (`scene = bpy.context.scene`, `obj.select_set(True)`) |
| Denylist hits | CC 0 (+1 allowlisted 5-word attributed quote in a `build_base.py` comment), Baseline 0, XR 0 |

Side by side (MPFB `targetservice.py` vs our JS):

| Aspect | MPFB | `macros.js` | `baseline_macros.js` |
|---|---|---|---|
| knot interpolation | loop over parts, open interval test, `round(.., 4)`, skip empty knot names | same 8-line logic (`knotWeights`) | same logic (`macroComponents`) |
| target stack | 5 separate nested-loop blocks that *build file names* by string concatenation, with logging/profiling | one generator (`targetStack`) emitting `{family, components}` objects; height / proportions / breast nested in the universal loop | no stack: *decodes* each exported target name into components and multiplies (`targetWeight`) |
| breast | gender weight not applied, female only, exclusions by substring test on the name | same rules, as boolean guards | same rules |
| race | threshold `> 0.0001` | same constant | same constant |
| cutoff | `> 0.01` | same | same |
| shape-key name codes | 16-pair table `_SHAPEKEY_ENCODING` | not used | `ENCODING`: the same 16 pairs in the same order |
| names | `components`, `complete_name`, `position_pct`, `hlrange`, `_LOG`, profiler | own names (`knot`, `pct`, `push`, `keyOf`), no logging | own names; references the MPFB function names in comments only |
| additive substitution for missing targets | not in MPFB | project-original | not present |

## 5. Conclusion

- **Data: CONFIRMED.** The macro table and the target families are MakeHuman's CC0 `macro.json`; the exclusions
  follow from which CC0 target files exist.
- **No copied expression found: CONFIRMED** within what the checks can see (0 verbatim lines, 0 denylist hits,
  different structure, no shared comments or local names).
- **The header claim "written from the CC0 data" is REFUTED as stated.** Several rules are in neither the data nor
  any independent documentation we know of: the breast targets ignore the gender weight, the race threshold
  `0.0001`, rounding to 4 decimals, the strict open interval. They match MPFB's GPL code exactly, and
  `baseline_macros.js` names that code as its source. The 16-pair `ENCODING` table is taken from MPFB's source
  (it is interoperability data that the names MPFB writes into Blender require, but it was read from GPL code).
- **Verdict: CLEAN-ROOM NEEDED** (the roadmap rule "when in doubt"). Whether a re-expression of a short algorithm
  is a derivative work is a legal question this project does not answer; the clean-room route removes the doubt
  at low cost. Until it is done the two files are marked here as *pending clean-room*. They live in the
  Baseline repo, and `baseline_macros.js` is served by the public compare page, so this should be closed before
  the Baseline repo goes public (decision 15) and before M7a/M8.

## 6. Clean-room recipe (for whoever does it)

The implementer must be an agent or person that has **not** read MPFB's `targetservice.py` (this file's author
has, so cannot). Allowed inputs:

1. CC0 data: `macro.json` (`macrotargets`, `combinations`) and the list of target files on disk.
2. Black-box behaviour of MPFB, observed by running it in Blender, never by reading it: the target stack MPFB
   computes for given macro values. The Baseline already has such fixtures (`tests/fixtures/baseline_macros.json`,
   14 bodies, generated by running MPFB). Shape-key name codes may be read from the names MPFB writes into a
   built `.blend`/GLB.
3. This behavioural spec (written from observation, contains no code):
   - each macro value v in 0..1 lies in at most one part of its macro whose interval (lowest, highest) contains
     it strictly; that part gives `low` the weight 1 - t and `high` the weight t, t = (v - lowest)/(highest - lowest),
     both rounded to 4 decimals; an empty knot name gives no weight;
   - for each family in `combinations`, a target exists for each combination of active knots whose file exists on
     disk; its weight is the product of the knot weights, with the race weight in place of a race knot;
   - the breast family's weight does not include the gender knot weight;
   - races with weight <= 0.0001 contribute nothing; targets with weight <= 0.01 are dropped.
4. Acceptance: the existing Baseline tests against the MPFB fixtures pass unchanged, and
   `node tools/check_no_gpl_paste.mjs` reports 0 hits.

The new file's header then states: "clean-room from CC0 macro.json + black-box MPFB fixtures; see
CharacterCreator docs/PROVENANCE.md".

## 7. Re-running the checks

```
node tools/check_no_gpl_paste.mjs                      # this repo, denylist only (CI)
node tools/check_no_gpl_paste.mjs <repo> --against <mpfb>   # + verbatim overlap with a local MPFB copy
node --test tests/no_gpl_paste.test.mjs
```
