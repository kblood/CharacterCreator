# CharacterCreator - agent rules

The character system (`character-system/` is the product; XR and the compare
page are demo hosts). Plan: `docs/ROADMAP.md`. Status/todo: `docs/STATUS.md`.
Read `docs/BLENDER_WORKFLOW.md` before touching `blender/`.
Sister repos: CharacterCreatorXR and CharacterCreatorBaseline (vanilla MPFB
baseline + the live compare site).

Placeholders used in all committed files: `<scratch>` = the local scratch/work
directory, `<blender>` = the Blender executable, `<tools>` = local tool installs.
Never commit real machine paths, host names, IPs, users or key paths. Local,
machine-specific notes go in `AGENTS.local.md` (git-ignored).

## Git: one worktree per agent

- Never work in, `git checkout`/`git switch` in, or commit from the shared main
  working directory. Each agent gets its own worktree under `<scratch>`:
  `git worktree add <scratch>/wt/<name> -b <branch> master`
  and removes it (`git worktree remove`) when done.
- Never commit to `master`. Work on a named branch (`phase<N>/<milestone>`,
  `spike/<name>`). This repo's clothing spike is `spike/clothing-standard-cc`
  (not to be confused with Baseline's `spike/clothing-standard`).
- Never `git add -A` / `git add .`; stage exact paths.
- Never change or delete a ref someone else made without a backup tag on its
  SHA first (`backup/<context>/<name>-<sha7>`). Never `git reset --hard` or
  `git clean` in a main working directory. Never delete untracked files before
  `git diff --no-index` against the committed version shows they are identical.
- Do not touch other agents' worktrees.

## Deploy

- Do NOT deploy to `webxr/charactercreator/` from this repo. This repo's
  `deploy.ps1` (git-ignored) must not target `charactercreator`: that path is
  the live compare site and is written ONLY by CharacterCreatorBaseline's
  `deploy.ps1`.
- Rule for the local `deploy.ps1` (it is git-ignored, so this file is where the
  rule is recorded; re-apply it if the script is ever recreated from an old
  copy):
  - `-Name` has no default and is required.
  - The target `charactercreator` is refused (case-insensitively) in every mode,
    including `-DryRun`, `-StageOnly` and `-VerifyOnly`, with exit code 3.
  - Check (PowerShell): `.\deploy.ps1 -Name charactercreator -DryRun` must print
    `REFUSED: ...` and give `$LASTEXITCODE` 3.
- The live compare site is built from CharacterCreatorBaseline
  (`web/compare` + `build/baseline`) and deployed with that repo's
  `deploy.ps1` (`-DryRun`, `-VerifyOnly`, `-Rollback [-DryRun]`). Its server
  notes (vhost snippet for `.glb` MIME type, gzip and Cache-Control) are in
  CharacterCreatorBaseline `docs/SERVER_NOTES.md`.
- Agents never deploy anywhere. A deploy or server change happens only after
  the owner says yes to that specific action. Dry runs are fine (use
  PowerShell, not Git Bash, which rewrites Linux paths).

## Nothing public without the owner's yes

No push, fork, issue, comment, PR, release, tag push or deploy without the
owner's explicit yes for that action. Agents make drafts, local branches and
local tags only. MPFB contributions are written in a separate clone under
`<scratch>`. This repo is GPL-3.0-or-later (LICENSE, LICENSE-NOTES.md); new
source files start with `SPDX-License-Identifier: GPL-3.0-or-later`. MPFB code
still stays out of the plugin/runtime (architecture rule, ROADMAP section 3).

## Images

Agents produce images/screenshots and measure numerically; agents running on
Opus do not view them. Visual review is done by Luna (and the owner). An
agent's acceptance criterion is always numeric; visual review is a separate gate.

## Commands

- Build: `<blender> -b --python blender/build_base.py -- output/base_body.glb`
- Scratch files go in `<scratch>`, finished assets in `output/`.
- Long runs (> ~2 min) go in the background with a log under `<scratch>`.
