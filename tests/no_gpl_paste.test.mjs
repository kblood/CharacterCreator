// SPDX-License-Identifier: GPL-3.0-or-later
// No-MPFB-paste tripwire (roadmap M3, docs/PROVENANCE.md): the denylist catches MPFB-only identifiers and comment
// strings, lets our own wording (and our own SPDX GPL-3.0-or-later header) through, and this repo is clean. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanText, scanRepo, sharedLines, significantLines, DENYLIST, ALLOWLIST } from '../tools/check_no_gpl_paste.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ids = text => scanText(text).map(h => h.id);

test('every denylist rule fires on an MPFB-shaped line', () => {
  // synthetic one-liners in MPFB's style (written for this test, not copied)
  const samples = {
    'mpfb-logger': '_LOG = LogService.get_logger("services.example")',
    'mpfb-log-calls': '    _LOG.enter()',
    'mpfb-profiler': 'profiler = PrimitiveProfiler("Example")',
    'mpfb-classmanager': 'ClassManager.add_class(MPFB_OT_Example)',
    'mpfb-operator': 'class MPFB_OT_Example(MpfbOperator):',
    'mpfb-context': 'class MpfbContext:',
    'mpfb-macro-defs': 'function interpolateMacroComponents(name, value) {',
    'mpfb-shapekey-table': '_SHAPEKEY_ENCODING = [',
    'mpfb-macro-locals': 'const positionPct = position / hlrange;',
    'mpfb-comment': '// Excluding forbidden breast modifier combination',
    'gpl-header': '# SPDX-License-Identifier: GPL-2.0-only',
  };
  for (const d of DENYLIST) {
    assert.ok(samples[d.id], `test sample missing for ${d.id}`);
    assert.ok(ids(samples[d.id]).includes(d.id), `${d.id} did not fire on: ${samples[d.id]}`);
  }
});

test('our own wording and API calls pass', () => {
  const clean = [
    "from bl_ext.user_default.mpfb.services.targetservice import TargetService",
    'TargetService.reapply_macro_details(human)',
    'TargetService.load_target(human, full, weight=1.0, name=n)',
    '// MPFB 2 (services/targetservice.py _interpolate_macro_components): same arithmetic, see PROVENANCE.md',
    'export function macroComponents(parts, value) {',
    "const LOG = console; LOG.debug('x');",
    'const lowest = Math.min(...zs), highest = Math.max(...zs);',
    '// MIT License',
    '// SPDX-License-Identifier: GPL-3.0-or-later',
    '# SPDX-License-Identifier: GPL-3.0-or-later',
  ];
  for (const l of clean) assert.deepEqual(ids(l), [], l);
});

test('allowlist entries are specific (file + rule + line text) and give a reason', () => {
  for (const a of ALLOWLIST) {
    assert.ok(a.file && a.id && a.contains && a.contains.length >= 20 && a.reason, JSON.stringify(a));
    assert.ok(DENYLIST.some(d => d.id === a.id), `unknown rule ${a.id}`);
  }
});

test('scanRepo flags a pasted file and respects the allowlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nogpl-'));
  try {
    mkdirSync(join(dir, 'blender'));
    writeFileSync(join(dir, 'blender', 'pasted.py'), 'x = 1\n_LOG = LogService.get_logger("x")\n');
    writeFileSync(join(dir, 'notes.md'), 'MPFB uses LogService.get_logger( in every module\n');   // docs not scanned
    const r = scanRepo(dir);
    assert.deepEqual(r.hits.map(h => [h.file, h.line, h.id, h.allowed]), [['blender/pasted.py', 2, 'mpfb-logger', false]]);
    const r2 = scanRepo(dir, { allow: [{ file: 'blender/pasted.py', id: 'mpfb-logger', contains: 'LogService.get_logger', reason: 't' }] });
    assert.equal(r2.hits[0].allowed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared-line check finds verbatim lines and ignores Blender API one-liners', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nogpl-'));
  try {
    mkdirSync(join(dir, 'ref')); mkdirSync(join(dir, 'ours'));
    const own = 'weights_by_family = compute_family_weights(model, values)';
    writeFileSync(join(dir, 'ref', 'a.py'), `${own}\nbpy.ops.object.mode_set(mode='EDIT')\n`);
    writeFileSync(join(dir, 'ours', 'b.py'), `    ${own}\nbpy.ops.object.mode_set(mode='EDIT')\nsomething_else_entirely = 42 + 17\n`);
    const s = sharedLines(join(dir, 'ours'), join(dir, 'ref'));
    assert.deepEqual(s.shared.map(x => x.text), [own]);
    assert.equal(significantLines("bm.verts.ensure_lookup_table()").size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('this repo has no unallowlisted MPFB/GPL paste markers', () => {
  const r = scanRepo(ROOT);
  assert.ok(r.files > 20, `only ${r.files} code files scanned`);
  const bad = r.hits.filter(h => !h.allowed);
  assert.deepEqual(bad, [], bad.map(h => `${h.file}:${h.line} [${h.id}] ${h.text}`).join('\n'));
  for (const a of ALLOWLIST) assert.ok(r.hits.some(h => h.allowed && h.file === a.file), `stale allowlist entry ${a.file}`);
});
