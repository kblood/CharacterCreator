# Measured baseline (ROADMAP M2)

Numbers of the final build at commit 87bd0d7 (the committed `output/`), measured 2026-10-02 on one Windows machine
with Node 24. Later milestones compare against these files: "not worse than the M2 baseline" means the same command
on the same machine gives no new failing case and no higher count. The cloth cases are chaotic, so compare
before / after on the same machine, never against a number from another machine.

| File | What | Command (raw output, then `tools/baseline_summary.mjs`) |
|---|---|---|
| `tests.json` | test suite counts and the failing tests | `npm test` |
| `check_garment.json` | per garment OK / INFO / SKIP / FAIL rows, all 9 bodies + morph extremes | `node tools/check_garment.mjs <every catalog id> --bodies all --json` |
| `integrity_default.json`, `integrity_moves.json`, `integrity_land.json` | full cloth integrity matrix: per outfit summary, every failing case, every case with a hit below the threshold | `node tools/cloth_integrity.mjs --timeline default\|moves\|land --json <file>` (30-90 min each, run in the background) |
| `glb_sizes.json` | bytes + sha256 of every GLB / JSON in `output/` | written by `tools/baseline_summary.mjs` |
| `determinism.json` | two clean builds of the same commit compared byte for byte | `tools/compare_builds.mjs` |

Regenerate the summaries:

```
node tools/baseline_summary.mjs --out docs/baseline --commit <sha> --tests <npm test log> --check-garment <json> \
  --integrity default=<json>,moves=<json>,land=<json> --determinism <json>
```

The chaotic coat test (`tests/cloth.test.mjs`, `COAT_CHAOTIC`) asserts a PROVISIONAL threshold (>= 6 of 8 fixed
perturbations, ROADMAP decision 3). On this build it measures 5 of 8, so `npm test` has 1 failing test; that is
the baseline, not a regression.

## Visual probes (ROADMAP M2b)

`visual_probes.json`: the known visual faults as numbers, so a fix can be shown without screenshots. Command:
`node tools/visual_probes.mjs --json <file> --commit <sha>` (about 30-60 min, run it in the background;
`--only jaw,dresscoat,dressstep,hair,integrity,animzone` for a subset, `--quick` for a smoke run). Every case carries
its own `what`, `metrics` (the definition of each number) and `target`.

| Case | Fault | Main numbers |
|---|---|---|
| `jaw` | red fragment under the jaw (jacket) | per body x outfit: `uncoveredHiddenTris` (hidden jaw / neck skin with no garment within 5 cm), `teethVisibleBelow` / `tongueVisibleBelow` (mouth interior seen through hidden skin), `hiddenAboveTopVerts`, `garmentVertsInsideJawNeck`. Target 0 |
| `dresscoat` | dress + trench coat in a crouch (jump / land) | `rules.pairReachable` (false: the outfit rules never give the pair), then the pair FORCED: coat:dress / dress:body poke + sink (vertices, mm), edge stretch p99 / max per garment, a dress-alone reference |
| `dressstep` | step in the dress skirt at the hips | male / female x cloth on / off x idle / walk / run: max dihedral angle and ring height jump in the hip band, absolute and above bind, for the whole band and the hip sides |
| `hair` | hair against the collar / hood | 8 styles x jacket / hoodie / coat x male / female x viewer hair push off / on x idle / walk: `edgesCrossing` (hair through the collar / hood), `hairInside` (hair between collar and neck) |
| `integrity` | the existing integrity numbers | copied from `integrity_*.json`: bra under dress / jacket in idle_fidget, fingers through the coat in walk, coat:jeans in jump |
| `animzone` | `base_body_anim.glb` without `_CCZONE` | per mesh, both body GLBs |

The faults that are still in the build are `todo` tests in `tests/visual_probes.test.mjs` (expected failures: `npm test`
stays green, the TODO line names the fault and the milestone that should fix it).
