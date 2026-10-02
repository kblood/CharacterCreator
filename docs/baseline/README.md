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
