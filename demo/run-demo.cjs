#!/usr/bin/env node
'use strict';
// Public demo fixture for wipwho. Builds a throwaway git repo plus a throwaway
// HOME (so wipwho reads only fixture logs, never the real machine's Claude/Codex
// history), runs the real CLI against it, then runs split + independent
// reconstruction verification. Nothing here touches the real ~/.claude or
// ~/.codex directories: HOME/USERPROFILE are overridden for the child process
// only, for the lifetime of this script.
//
// Usage: node demo/run-demo.cjs [--keep]
//   --keep   do not delete the temporary fixture/output directories afterwards
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');

function sh(cmd, args, opts = {}) {
  const r = cp.spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function touch(file, ms) {
  const t = ms / 1000;
  fs.utimesSync(file, t, t);
}
function jsonl(rows) {
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wipwho-demo-'));
const repo = path.join(base, 'repo');
const home = path.join(base, 'home'); // fake HOME/USERPROFILE for this demo only
const outDir = path.join(base, 'split-out');
console.log('wipwho public demo');
console.log('fixture directory: ' + base + (KEEP ? ' (kept after run)' : ' (deleted on exit)'));
console.log('');

// ---- 1. repo with an initial commit ----------------------------------------
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
const before = {
  'src/total.js': "function total(items) {\n  return items.reduce((s, x) => s + x.price, 0);\n}\nmodule.exports = { total };\n",
  'src/format.js': "function formatUsd(n) {\n  return '$' + n.toFixed(2);\n}\nmodule.exports = { formatUsd };\n",
  'src/legacy.js': "function legacyDiscount(price) {\n  return price * 0.9;\n}\nmodule.exports = { legacyDiscount };\n",
  'notes.md': '# Notes\n',
};
for (const [rel, text] of Object.entries(before)) write(path.join(repo, rel), text);
sh('git', ['init', '-q', '-b', 'main'], { cwd: repo });
sh('git', ['-c', 'user.email=demo@example.invalid', '-c', 'user.name=wipwho demo', 'add', '-A'], { cwd: repo });
sh('git', ['-c', 'user.email=demo@example.invalid', '-c', 'user.name=wipwho demo', 'commit', '-q', '-m', 'Initial commit'], { cwd: repo });

// ---- 2. working-tree edits (the "uncommitted mess") ------------------------
const NOW = Date.now();
const A_TS = NOW - 3 * 3600e3;   // request A: real-format Claude Code edit
const B_TS = NOW - 2 * 3600e3;   // request B: controlled Codex-format fixture (see note below)
const MANUAL_TS = NOW - 30 * 60e3; // manual edit, no log entry anywhere
const C_TS = NOW - 90 * 60e3;    // request C: logged edit, but file mtime deliberately misaligned

const totalAfter = "function total(items) {\n  if (!Array.isArray(items)) throw new TypeError('items must be an array');\n  return items.reduce((s, x) => s + x.price, 0);\n}\nmodule.exports = { total };\n";
const formatAfter = "function formatUsd(n) {\n  return '$' + n.toFixed(2);\n}\n\nfunction formatYen(n) {\n  return '¥' + Math.round(n).toLocaleString('ja-JP');\n}\n\nmodule.exports = { formatUsd, formatYen };\n";
const legacyAfter = "function legacyDiscount(price) {\n  return price * 0.85;\n}\nmodule.exports = { legacyDiscount };\n";
const notesAfter = before['notes.md'] + '- remember to update pricing docs before release\n';

write(path.join(repo, 'src/total.js'), totalAfter);
touch(path.join(repo, 'src/total.js'), A_TS + 500); // inside [tool call, tool result] window -> aligned
write(path.join(repo, 'src/format.js'), formatAfter);
touch(path.join(repo, 'src/format.js'), B_TS + 500); // inside [tool call, tool result] window -> aligned
write(path.join(repo, 'notes.md'), notesAfter);
touch(path.join(repo, 'notes.md'), MANUAL_TS);
write(path.join(repo, 'src/legacy.js'), legacyAfter);
touch(path.join(repo, 'src/legacy.js'), NOW); // far outside the C_TS tool window -> AMBIGUOUS, not attributed

// ---- 3. fixture logs (fake HOME, read by wipwho instead of the real one) ---
// Request A: genuine Claude Code JSONL schema, synthetic session content.
const claudeSession = 'demo-claude-session-0001';
const claudeRows = [
  { sessionId: claudeSession, cwd: repo, timestamp: new Date(A_TS - 2000).toISOString(), type: 'user',
    message: { content: 'Add input validation to total() so it rejects non-array input.' } },
  { sessionId: claudeSession, cwd: repo, timestamp: new Date(A_TS).toISOString(), type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'call-a1', name: 'Edit', input: {
      file_path: path.join(repo, 'src/total.js'),
      old_string: before['src/total.js'].replace(/\n$/, ''),
      new_string: totalAfter.replace(/\n$/, ''),
    } }] } },
  { sessionId: claudeSession, cwd: repo, timestamp: new Date(A_TS + 800).toISOString(), type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call-a1', is_error: false, content: 'updated' }] } },
];
write(path.join(home, '.claude', 'projects', 'demo', claudeSession + '.jsonl'), jsonl(claudeRows));

// Request B: Codex JSONL schema, but the session is a CONTROLLED fixture built for
// this demo, not a captured real Codex run. auditOrigin marks that explicitly, the
// way the shape (session_meta / response_item / apply_patch) matches real Codex logs.
const codexSession = 'demo-codex-session-0001';
const formatPatch = '*** Begin Patch\n*** Update File: src/format.js\n@@\n'
  + '-module.exports = { formatUsd };\n'
  + '+\n+function formatYen(n) {\n+  return \'¥\' + Math.round(n).toLocaleString(\'ja-JP\');\n+}\n+\n+module.exports = { formatUsd, formatYen };\n'
  + '*** End Patch';
const codexRows = [
  { timestamp: new Date(B_TS - 3000).toISOString(), type: 'session_meta',
    payload: { id: codexSession, cwd: repo, auditOrigin: 'CONTROLLED_REPLAY_NOT_AI_SESSION' } },
  { timestamp: new Date(B_TS - 2000).toISOString(), type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a formatYen helper next to formatUsd.' }] } },
  { timestamp: new Date(B_TS).toISOString(), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call-b1', input: formatPatch } },
  { timestamp: new Date(B_TS + 800).toISOString(), type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: 'call-b1', output: [{ type: 'text', text: 'Script completed\n{}' }] } },
];
write(path.join(home, '.codex', 'sessions', '2026', '09', '16', codexSession + '.jsonl'), jsonl(codexRows));

// Request C: logged like a normal Claude edit, but the on-disk mtime (set above,
// to NOW) is far outside the tool's start/end window. wipwho will not credit this
// to the request -> AMBIGUOUS/LOW, demonstrating that a log entry alone is not
// enough without an aligned on-disk timestamp.
const claudeSession2 = 'demo-claude-session-0002';
const claudeRows2 = [
  { sessionId: claudeSession2, cwd: repo, timestamp: new Date(C_TS - 2000).toISOString(), type: 'user',
    message: { content: 'Lower the legacy discount rate to 0.85.' } },
  { sessionId: claudeSession2, cwd: repo, timestamp: new Date(C_TS).toISOString(), type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'call-c1', name: 'Edit', input: {
      file_path: path.join(repo, 'src/legacy.js'),
      old_string: before['src/legacy.js'].replace(/\n$/, ''),
      new_string: legacyAfter.replace(/\n$/, ''),
    } }] } },
  { sessionId: claudeSession2, cwd: repo, timestamp: new Date(C_TS + 800).toISOString(), type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call-c1', is_error: false, content: 'updated' }] } },
];
write(path.join(home, '.claude', 'projects', 'demo', claudeSession2 + '.jsonl'), jsonl(claudeRows2));

// notes.md has no log entry anywhere -> NO_AGENT_TRACE.

// ---- 4. run the real CLI against the fixture -------------------------------
const wipwho = path.join(ROOT, 'wipwho.cjs');
const env = { ...process.env, HOME: home, USERPROFILE: home };
function run(args) {
  return cp.spawnSync(process.execPath, [wipwho, ...args], { cwd: repo, env, encoding: 'utf8', windowsHide: true });
}

console.log('--- wipwho --repo <fixture> --no-cache -----------------------------');
console.log(run(['--repo', repo, '--no-cache']).stdout.trimEnd());

console.log('\n--- wipwho why src/format.js:5 --no-cache --------------------------');
console.log(run(['--repo', repo, 'why', 'src/format.js:5', '--no-cache']).stdout.trimEnd());

console.log('\n--- wipwho why notes.md:2 --no-cache --------------------------------');
console.log(run(['--repo', repo, 'why', 'notes.md:2', '--no-cache']).stdout.trimEnd());

console.log('\n--- wipwho why src/legacy.js:2 --no-cache ---------------------------');
console.log(run(['--repo', repo, 'why', 'src/legacy.js:2', '--no-cache']).stdout.trimEnd());

console.log('\n--- wipwho split --out <dir> --no-cache -----------------------------');
const splitResult = run(['--repo', repo, 'split', '--out', outDir, '--no-cache']);
console.log(splitResult.stdout.trimEnd());
if (splitResult.status !== 0) { console.error(splitResult.stderr); process.exitCode = 1; }

// ---- 5. independent reconstruction verification ----------------------------
console.log('\n--- independent reconstruction verification (test/verify-export.cjs) ---');
const verify = cp.spawnSync(process.execPath, [path.join(ROOT, 'test', 'verify-export.cjs'), repo, outDir], { encoding: 'utf8', windowsHide: true });
console.log(verify.stdout.trimEnd());
if (verify.status !== 0) { console.error(verify.stderr); process.exitCode = 1; }

console.log('\nNote: file hash reconstruction match proves the split patches recompose the');
console.log('same working-tree bytes. It is not evidence for who actually wrote the lines;');
console.log('that judgment is the ESTIMATED / AMBIGUOUS / NO AGENT TRACE labels above.');

if (!KEEP) {
  fs.rmSync(base, { recursive: true, force: true });
} else {
  console.log('\nFixture and split output kept at: ' + base);
}
