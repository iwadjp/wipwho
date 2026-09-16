'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const VERSION = '0.1.0-schema-1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const norm = value => String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const lines = text => text === '' ? [] : String(text).replace(/\n$/, '').split('\n');
const lineHash = text => hash(String(text).replace(/\r$/, ''));
const significant = text => text.trim().length >= 8 && /[\p{L}\p{N}]/u.test(text);
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
function git(repo, args, options = {}) {
  const {sourceConfig=false,...execOptions}=options;
  // Source discovery follows the repository's checkout rules. Temporary patch
  // generation/application remains byte-preserving, without implicit conversion.
  const conversion=sourceConfig?[]:['-c','core.autocrlf=false','-c','core.safecrlf=false'];
  return cp.execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...conversion, ...args], { cwd: repo, encoding: 'utf8', windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, ...execOptions });
}
function safeRelative(name) {
  return !!name && !path.isAbsolute(name) && !name.split(/[\\/]/).some(p => p === '..' || p.toLowerCase() === '.git') && !/[\0\r\n]/.test(name);
}
function noLinks(root, target) {
  root=path.resolve(root);
  let cur = path.resolve(target);
  if (!inside(root, cur)) return false;
  while (norm(cur) !== norm(root)) {
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) return false;
    const parent=path.dirname(cur);if(parent===cur)return false;cur=parent;
  }
  return true;
}
// Output never contains raw request text or command text. This is an allowlist
// classification, not a blacklist pretending to detect every possible secret.
function summary(text) {
  const first = String(text || '').split(/\r?\n/).map(s => s.replace(/^[#>*\-\s]+/, '').trim())
    .filter(s => s && !/^.{0,16}[:：]$/.test(s) && !/^(?:[A-Z]:[\\/]|\/)/i.test(s)).slice(0,5).join(' ').slice(0,1200);
  const verbs = [['修正|直す|fix|repair|bug','Fix'],['検証|確認|test|verify|audit','Verify'],['追加|実装|作成|add|implement|build|create','Implement'],['改善|整理|refactor|improve|harden','Improve']];
  const topics = [['test|テスト|検証','tests'],['patch|diff|パッチ|差分','patches'],['parse|parser|解析|ログ形式','parsing'],['privacy|secret|credential|プライバシ|秘密','privacy'],['cache|performance|高速|性能','performance'],['regression|回帰','regression'],['backup|バックアップ','backup'],['migration|移行','migration'],['worktree|lock|ロック','worktree'],['provenance|attribution|wipwho|帰属','provenance'],['README|document|ドキュメント','documentation'],['Windows|PowerShell','Windows'],['Android|adb','Android'],['Git|commit|コミット','Git']];
  const action = verbs.find(([re]) => new RegExp(re, 'i').test(first))?.[1] || 'Request';
  const labels = topics.filter(([re]) => new RegExp(re, 'i').test(first)).slice(0, 3).map(x => x[1]);
  return action + (labels.length ? ': ' + labels.join(', ') : ' (summary withheld)');
}
function displayPath(name) {
  let s = String(name).replaceAll('\\', '/').replace(/[\x00-\x1f\x7f\x1b]/g, '?');
  const user = os.userInfo().username;
  if (user) s = s.split(user).join('[user]');
  return s.replace(/(?:[A-Za-z]:\/|\/Users\/|\/home\/)[^\s]*/g, '[local path]')
    .replace(/(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}/g, '[redacted]');
}
function resume(session) {
  const id = session?.parent || session?.id;
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) return null;
  return session.agent === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`;
}
function sessionLabel(id){return id&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\/sub\/[A-Za-z0-9_-]{1,100})?$/.test(id)?id:id?'session-'+hash(id).slice(0,12):null;}
function jsonNew(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
module.exports = { VERSION, hash, norm, lines, lineHash, significant, inside, git, safeRelative, noLinks, summary, displayPath, resume, sessionLabel, jsonNew };
