#!/usr/bin/env node
// No-GPL-paste tripwire (roadmap M3). This repo is MIT; MPFB 2 is GPL-3.0-or-later. Our build scripts may CALL
// MPFB's API inside Blender (import + call), but no MPFB source may be copied or mechanically ported in here.
//
// The check scans the tracked code files of a repo for identifiers, plumbing and comments that only exist in
// MPFB's own source (its logger/profiler/operator scaffolding, the private helpers of its macro code, verbatim
// comment and log strings). A hit means "a human must look": it is a tripwire, not proof either way. A clean run
// does not prove that nothing was copied (a renamed port passes); see docs/PROVENANCE.md for the method.
//
// Usage:
//   node tools/check_no_gpl_paste.mjs [repoDir]                 exit 1 on any hit that is not allowlisted
//   node tools/check_no_gpl_paste.mjs [repoDir] --against <dir> also list non-trivial source lines shared
//                                                               verbatim with a local MPFB checkout (<dir>);
//                                                               shared lines fail the run as well
//   --json   machine-readable output
// Not legal advice; the denylist only encodes the project rule in LICENSE-NOTES.md.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Code files that are scanned (docs are not: they may name MPFB functions when citing them). */
export const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.html', '.glsl', '.gd', '.cs', '.sh', '.ps1']);

/**
 * Denylist. Every pattern was checked to occur in MPFB 2.0.17's own .py files and in none of this project's
 * code (except the allowlisted quote below). Patterns are matched per line.
 */
export const DENYLIST = [
  { id: 'mpfb-logger', re: /\bLogService\.get_logger\s*\(/, why: 'MPFB logging service (module-level logger setup)' },
  { id: 'mpfb-log-calls', re: /\b_LOG\.(enter|leave|dump|trace|crash|reset)\s*\(/, why: 'MPFB logger call style' },
  { id: 'mpfb-profiler', re: /\bPrimitiveProfiler\b/, why: 'MPFB profiler helper' },
  { id: 'mpfb-classmanager', re: /\bClassManager\.add_class\s*\(/, why: 'MPFB operator/panel registration' },
  { id: 'mpfb-operator', re: /\(\s*MpfbOperator\s*\)|\bdef\s+hardened_execute\b/, why: 'MPFB operator base class' },
  { id: 'mpfb-context', re: /\bclass\s+MpfbContext\b/, why: 'MPFB context class' },
  {
    id: 'mpfb-macro-defs',
    re: /\b(def|function)\s+(_?interpolate_macro_components|calculate_target_stack_from_macro_info_dict|get_default_macro_info_dict|_?interpolateMacroComponents|calculateTargetStackFromMacroInfoDict|getDefaultMacroInfoDict)\b/,
    why: 'definition of an MPFB TargetService macro helper (or its mechanical camelCase port)',
  },
  { id: 'mpfb-shapekey-table', re: /\b_SHAPEKEY_ENCODING\s*=/, why: 'MPFB private shape-key encoding table' },
  { id: 'mpfb-macro-locals', re: /\b(hlrange|_MACLOG|position_pct|positionPct)\b/, why: 'local names of MPFB macro code' },
  {
    id: 'mpfb-comment',
    re: /Excluding forbidden (breast|proportions) modifier combination|complementary targets|There are no baby proportions targets on disk|This is very annoying, but the maximum length of a shape key name/,
    why: 'verbatim MPFB comment or log string',
  },
  { id: 'gpl-header', re: /SPDX-License-Identifier:\s*(A|L)?GPL|GNU (Affero |Lesser )?General Public License/, why: 'GPL licence header in a code file' },
];

/**
 * Reviewed exceptions: file + rule + a substring of the exact line. Keep this list short and give a reason.
 */
export const ALLOWLIST = [
  {
    file: 'blender/build_base.py',
    id: 'mpfb-comment',
    contains: 'complementary targets"), so the delta sampled',
    reason: 'five-word attributed quote describing MPFB behaviour in our own comment; no code',
  },
];

/** Files that contain the patterns on purpose. */
const SELF = new Set(['tools/check_no_gpl_paste.mjs', 'tests/no_gpl_paste.test.mjs']);

const posix = p => p.split(sep).join('/');

/** Scan one text: [{ line, id, why, text }]. */
export function scanText(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const d of DENYLIST) if (d.re.test(lines[i])) hits.push({ line: i + 1, id: d.id, why: d.why, text: lines[i].trim().slice(0, 160) });
  }
  return hits;
}

export function allowEntry(file, hit, allow = ALLOWLIST) {
  return allow.find(a => a.file === file && a.id === hit.id && hit.text.includes(a.contains));
}

function listFiles(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    const out = [];
    const walk = d => {
      for (const n of readdirSync(d)) {
        if (n === 'node_modules' || n === '.git') continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p); else out.push(posix(relative(dir, p)));
      }
    };
    walk(dir);
    return out;
  }
}

/** Scan a repo: { files, hits: [{file, line, id, why, text, allowed, reason}] }. */
export function scanRepo(dir, { allow = ALLOWLIST } = {}) {
  const files = listFiles(dir).filter(f => CODE_EXT.has(extname(f).toLowerCase()) && !SELF.has(f));
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const h of scanText(text)) {
      const a = allowEntry(f, h, allow);
      hits.push({ file: f, ...h, allowed: !!a, reason: a?.reason });
    }
  }
  return { files: files.length, hits };
}

/** Normalised, non-trivial lines (>= minLen chars, not imports/comments-only punctuation). */
export function significantLines(text, minLen = 30) {
  const out = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim().replace(/\s+/g, ' ');
    if (l.length < minLen) continue;
    if (/^(import |from \S+ import |export \{|#!)/.test(l)) continue;
    // a single Blender API statement (bpy.ops.object.mode_set(mode='EDIT'), bm.verts.ensure_lookup_table(), ...)
    // is dictated by Blender's API, not MPFB's expression
    if (/^(bpy|bm|bmesh)\.[\w.]+(\s*=\s*[\w.]+|\([^()]*\))?$/.test(l)) continue;
    if (!/[A-Za-z]{3}/.test(l)) continue;
    out.add(l);
  }
  return out;
}

/** Lines of our code files that also occur verbatim in a reference tree (e.g. an MPFB checkout). */
export function sharedLines(dir, refDir, minLen = 30) {
  const ref = new Set();
  const walk = d => {
    for (const n of readdirSync(d)) {
      if (n === '__pycache__' || n === '.git' || n === 'data') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.py$/.test(n)) for (const l of significantLines(readFileSync(p, 'utf8'), minLen)) ref.add(l);
    }
  };
  walk(refDir);
  const out = [];
  for (const f of listFiles(dir)) {
    if (!CODE_EXT.has(extname(f).toLowerCase()) || SELF.has(f)) continue;
    let text;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const l of significantLines(text, minLen)) if (ref.has(l)) out.push({ file: f, text: l.slice(0, 160) });
  }
  return { refLines: ref.size, shared: out };
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const ai = args.indexOf('--against');
  const against = ai >= 0 ? args[ai + 1] : null;
  const pos = args.filter((a, i) => !a.startsWith('--') && !(ai >= 0 && i === ai + 1));
  const dir = resolve(pos[0] || '.');
  const res = scanRepo(dir);
  const bad = res.hits.filter(h => !h.allowed);
  const shared = against ? sharedLines(dir, resolve(against)) : null;
  if (json) {
    console.log(JSON.stringify({ files: res.files, hits: res.hits, shared }, null, 1));
  } else {
    for (const h of res.hits) console.log(`${h.allowed ? 'allowed' : 'HIT    '} ${h.file}:${h.line} [${h.id}] ${h.text}${h.allowed ? `  (${h.reason})` : ''}`);
    if (shared) {
      for (const s of shared.shared) console.log(`SHARED  ${s.file}: ${s.text}`);
      console.log(`shared-line check: ${shared.shared.length} line(s) of ours occur verbatim in ${shared.refLines} reference lines`);
    }
    console.log(`no-gpl-paste: ${res.files} code files, ${bad.length} hit(s), ${res.hits.length - bad.length} allowlisted`);
  }
  return bad.length || (shared && shared.shared.length) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv);
