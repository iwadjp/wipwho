'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VERSION, hash, norm, lines, lineHash, summary, inside } = require('./common.cjs');
const time = t => typeof t === 'number' ? t : Date.parse(t);
const PARSER_HASH=hash(fs.readFileSync(__filename)+fs.readFileSync(path.join(__dirname,'common.cjs')));
function substantiveRequest(text){return !!text&&!text.startsWith('<')&&!text.startsWith('# AGENTS.md')&&!/^.{0,16}[:：]$/.test(text)&&!/^(?:続けて|続行|はい|了解|お願いします|continue|go ahead|yes|proceed)[。.!\s]*$/i.test(text);}
function listLogs(root, since, result = []) {
  if (!fs.existsSync(root)) return result;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) listLogs(file, since, result);
    else if (e.name.endsWith('.jsonl') && fs.statSync(file).mtimeMs >= since) result.push(file);
  }
  return result;
}
// Only static strings actually passed to apply_patch are interpreted. Never eval
// a transcript, and never treat a patch merely quoted in a prompt as an edit.
function literals(src) {
  const found = [];
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[0];
    if (raw[0] === '`' && /(?<!\\)\$\{/.test(raw)) continue;
    let value;
    try {
      if (raw[0] === '"') value = JSON.parse(raw);
      else value = raw.slice(1, -1).replace(/\\(u[0-9a-f]{4}|x[0-9a-f]{2}|[nrtbfv0\\'"`$])/gi, (_, e) => {
        if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
        return ({ n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', 0:'\0' })[e] ?? e;
      });
    } catch { continue; }
    found.push({ start:m.index, end:re.lastIndex, value });
  }
  return found;
}
function extractPatches(src, tool) {
  if (/(?:^|__)apply_patch$/.test(tool)) return [String(src)];
  if (!['exec', 'js'].includes(tool)) return [];
  const strings = literals(src), found = [];
  const masked=src.split('');for(const s of strings)for(let i=s.start;i<s.end;i++)masked[i]=' ';
  const code=masked.join('').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,m=>' '.repeat(m.length));
  const call = /\btools\.apply_patch\s*\(\s*/g;
  let m;
  while ((m = call.exec(src))) {
    // Ignore apparent code inside another string literal.
    if (strings.some(s => m.index >= s.start && m.index < s.end)) continue;
    if(!code.slice(m.index,m.index+5).startsWith('tools'))continue; // comment
    const prefix=code.slice(0,m.index);
    // A completed wrapper is not proof that a conditional/deferred patch ran.
    if(!/\bawait\s*$/.test(prefix)||/\b(?:if|for|while|switch|function)\b|=>/.test(prefix))continue;
    let token = strings.find(s => s.start === call.lastIndex);
    if (!token) {
      const name = src.slice(call.lastIndex).match(/^([A-Za-z_$][\w$]*)\s*\)/)?.[1];
      if (name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const bindings = strings.filter(s => new RegExp('(?:const|let)\\s+' + escaped + '\\s*=\\s*$').test(src.slice(Math.max(0, s.start - 150), s.start)));
        // Multiple assignments are ambiguous; do not choose one by recency.
        const assignments=[...code.slice(0,m.index).matchAll(new RegExp('(?<![\\w$])'+escaped+'\\s*(?:=(?!=)|\\+=)','g'))];
        if (bindings.length === 1 && assignments.length===1 && bindings[0].start < m.index) token = bindings[0];
      }
    }
    if (token && token.value.includes('*** Begin Patch')) found.push(token.value);
  }
  return [...new Set(found)];
}
function parsePatch(text, cwd) {
  const edits = [];
  for (const m of text.matchAll(/\*\*\* Begin Patch([\s\S]*?)\*\*\* End Patch/g)) {
    let edit = null;
    for (const raw of m[1].split('\n')) {
      const line = raw.replace(/\r$/, '');
      const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
      if (header) {
        edit = { file:path.resolve(cwd, header[2].trim()), operation:header[1], added:[], removed:[], blocks:[] };
        edits.push(edit); continue;
      }
      if (!edit) continue;
      if (line.startsWith('*** Move to: ')) { edit.from = edit.file; edit.file = path.resolve(cwd, line.slice(13).trim()); continue; }
      if (line.startsWith('@@') || !edit.blocks.length) edit.blocks.push({ added:[], removed:[] });
      if (line[0] === '+') { edit.added.push(line.slice(1)); edit.blocks.at(-1).added.push(line.slice(1)); }
      if (line[0] === '-') { edit.removed.push(line.slice(1)); edit.blocks.at(-1).removed.push(line.slice(1)); }
    }
  }
  return edits;
}
function outputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(outputText).join('\n');
  if (value && typeof value === 'object') return [value.text, value.output, value.content,
    value.isError ? 'isError:true' : '', value.exit_code != null ? `exit_code:${value.exit_code}` : ''].filter(v => v !== undefined).map(outputText).join('\n');
  return '';
}
function completed(output) {
  const text = outputText(output);
  if (/isError["'\s:]+true|is_error["'\s:]+true|exit_code["'\s:]+[1-9]|Process exited with code [1-9]|Error:|Failed to|patch rejected/i.test(text)) return false;
  if (/Script running with cell ID|session_id["'\s:]+\d+/i.test(text) && !/Script completed/.test(text)) return false;
  return !!text.trim();
}
function parseLog(text, agent, file, repo, dirtyNorm) {
  const sessions = new Map(), edits = [], commands = [], pending = new Map();
  let native = null, cwd = repo, nativeStart = -Infinity, malformed = 0;
  const relative = name => {
    const abs = path.isAbsolute(name || '') ? name : path.resolve(cwd, name || '');
    if (!inside(repo, abs)) return null;
    return path.relative(repo,abs).replaceAll('\\','/');
  };
  function session(id, parent = null) {
    if (!sessions.has(id)) sessions.set(id, { id, agent, parent, prompts:[] });
    return sessions.get(id);
  }
  function addEdit(s, ts, callId, e, tool) {
    const rel = relative(e.file);
    const from = e.from ? relative(e.from) : null;
    if (!rel && !from) return;
    const event = { sid:s.id, ts, end:null, callId, tool, rel:rel || from, from,
      operation:e.operation, success:false,
      added:e.added.map(lineHash), removed:e.removed.map(lineHash),
      blocks:(e.blocks || [{added:e.added,removed:e.removed}]).map(b => ({added:b.added.map(lineHash),removed:b.removed.map(lineHash)})) };
    edits.push(event);
    if (!pending.has(callId)) pending.set(callId, []);
    pending.get(callId).push(event);
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    // Parse structured rows; whitespace and escaped strings must not change routing.
    let row; try { row = JSON.parse(raw); } catch { malformed++; continue; }
    const ts = time(row.timestamp);
    if (agent === 'claude') {
      if (!['user','assistant'].includes(row.type)) continue;
      if (row.cwd) cwd = row.cwd;
      const base = row.sessionId || path.basename(file, '.jsonl');
      const child = row.isSidechain || /(?:^|[\\/])subagents[\\/]/.test(file);
      const id = child ? `${base}/sub/${row.agentId || path.basename(file, '.jsonl')}` : base;
      const s = session(id, child ? base : null);
      const content = row.message?.content;
      const items = Array.isArray(content) ? content : [];
      if (row.type === 'user') {
        for (const x of items.filter(x => x.type === 'tool_result')) {
          for (const e of pending.get(x.tool_use_id) || []) { e.end = ts; e.success = x.is_error !== true && !/Error:|Failed to/.test(outputText(x.content)); }
        }
        const request = (typeof content === 'string' ? content : items.filter(x => x.type === 'text').map(x => x.text).join('\n')).trim();
        if (!row.isMeta && !row.isCompactSummary && substantiveRequest(request)) s.prompts.push({ts, summary:summary(request)});
      } else for (const x of items.filter(x => x.type === 'tool_use')) {
        const input = x.input || {};
        if (x.name === 'Write') addEdit(s,ts,x.id,{file:input.file_path,operation:'Write',added:lines(input.content || ''),removed:[]},x.name);
        if (x.name === 'Edit') addEdit(s,ts,x.id,{file:input.file_path,operation:'Edit',added:lines(input.new_string || ''),removed:lines(input.old_string || '')},x.name);
        if (x.name === 'MultiEdit') for (const e of input.edits || []) addEdit(s,ts,x.id,{file:input.file_path,operation:'Edit',added:lines(e.new_string || ''),removed:lines(e.old_string || '')},x.name);
        if (['Bash','PowerShell'].includes(x.name)) { const e={sid:s.id,ts,end:null,success:false};commands.push(e);pending.set(x.id,[e]); }
      }
      continue;
    }
    const p = row.payload || {};
    if (row.type === 'session_meta') {
      if (native) continue; // The first metadata owns the file, even with forked history.
      const spawn = p.source?.subagent?.thread_spawn || p.thread_source?.subagent?.thread_spawn;
      native = session(p.id || p.session_id || path.basename(file,'.jsonl'), spawn?.parent_thread_id || null);
      cwd = p.cwd || repo;
      nativeStart = native.parent ? time(row.timestamp || p.timestamp) : -Infinity;
      continue;
    }
    if (!native || ts < nativeStart) continue;
    if (row.type === 'turn_context') { cwd = p.cwd || cwd; continue; }
    if (row.type !== 'response_item') continue;
    if (p.type?.endsWith('call_output')) {
      for (const e of pending.get(p.call_id) || []) { e.end = ts; e.success = completed(p.output); }
      continue;
    }
    if (p.type === 'message' && p.role === 'user') {
      const request = (p.content || []).filter(x => x.type === 'input_text').map(x => x.text).join('\n').trim();
      if (substantiveRequest(request)) native.prompts.push({ts,summary:summary(request)});
      continue;
    }
    if (!['custom_tool_call','function_call'].includes(p.type)) continue;
    let source = p.input;
    if (source === undefined) {
      try { const a=JSON.parse(p.arguments || '{}'); source=a.patch ?? a.input ?? a.cmd ?? a.command ?? ''; }
      catch { source=''; }
    }
    if (typeof source !== 'string') continue;
    for (const patch of extractPatches(source,p.name)) for (const e of parsePatch(patch,cwd)) addEdit(native,ts,p.call_id,e,'apply_patch');
    if (['exec_command','shell_command','shell'].includes(p.name) || (['exec','js'].includes(p.name) && /tools\.exec_command\s*\(/.test(source))) {
      const e={sid:native.id,ts,end:null,success:false};commands.push(e);
      if (!pending.has(p.call_id)) pending.set(p.call_id,[]);pending.get(p.call_id).push(e);
    }
  }
  return { sessions:[...sessions.values()], edits, commands, malformed };
}
async function scan({repo, dirtyNorm, sinceMs, noCache=false, roots, cacheRoot}) {
  const started = performance.now();
  roots ||= { claude:path.join(os.homedir(),'.claude','projects'), codex:path.join(os.homedir(),'.codex','sessions') };
  cacheRoot ||= path.join(process.env.LOCALAPPDATA || os.tmpdir(),'wipwho','cache-v01');
  const scopeKey=hash(VERSION+'\0'+PARSER_HASH+'\0'+norm(repo));
  const sessions=new Map(), edits=[],commands=[];
  const stats={logs:0,bytes:0,cacheHits:0,cacheMisses:0,cacheCorrupt:0,malformed:0,sourceMoved:0,hashMs:0,parseMs:0};
  for (const [agent,root] of Object.entries(roots)) for (const file of listLogs(root,sinceMs).sort()) {
    stats.logs++;
    const begin=performance.now(), stat=fs.statSync(file), buf=fs.readFileSync(file);
    stats.bytes+=buf.length;
    const digest=hash(buf);stats.hashMs+=performance.now()-begin;
    // Content-addressed cache: every hit first hashes the current source bytes.
    // It contains only derived hashes, safe labels and identifiers, never raw log text.
    const location=path.join(cacheRoot,hash(scopeKey+'\0'+agent+'\0'+norm(file)+'\0'+digest)+'.json');
    let parsed=null;
    if (!noCache && fs.existsSync(location)) try {
      const envelope=JSON.parse(fs.readFileSync(location,'utf8'));
      if (envelope.version!==VERSION || envelope.digest!==digest || hash(JSON.stringify(envelope.data))!==envelope.checksum) throw Error();
      parsed=envelope.data;stats.cacheHits++;
    } catch {stats.cacheCorrupt++;}
    if (!parsed) {
      stats.cacheMisses++;const t=performance.now();
      parsed=parseLog(buf.toString('utf8'),agent,file,repo,dirtyNorm);stats.parseMs+=performance.now()-t;
      const after=fs.statSync(file);
      if (after.size!==stat.size || after.mtimeMs!==stat.mtimeMs) stats.sourceMoved++;
      if (!noCache && after.size===stat.size && after.mtimeMs===stat.mtimeMs && !fs.existsSync(location)) {
        try {fs.mkdirSync(cacheRoot,{recursive:true});fs.writeFileSync(location,JSON.stringify({version:VERSION,digest,checksum:hash(JSON.stringify(parsed)),data:parsed}),{flag:'wx'});} catch { /* cache is optional */ }
      }
    }
    stats.malformed+=parsed.malformed;
    for (const s of parsed.sessions) {
      if (!sessions.has(s.id)) sessions.set(s.id,{...s,prompts:[]});
      sessions.get(s.id).prompts.push(...s.prompts);
    }
    edits.push(...parsed.edits.filter(e=>e.ts>=sinceMs));commands.push(...parsed.commands.filter(e=>e.ts>=sinceMs));
  }
  for (const s of sessions.values()) s.prompts=[...new Map(s.prompts.map(p=>[p.ts+'|'+p.summary,p])).values()].sort((a,b)=>a.ts-b.ts);
  const scoped=edits.map(e=>({...e,rel:dirtyNorm.get(norm(e.rel))||null,from:e.from?(dirtyNorm.get(norm(e.from))||null):null})).filter(e=>e.rel||e.from);
  const unique=[...new Map(scoped.map(e=>[e.sid+'|'+e.callId+'|'+e.rel+'|'+hash(JSON.stringify([e.added,e.removed])),e])).values()];
  stats.elapsedMs=performance.now()-started;
  return {sessions,edits:unique,commands,stats};
}
module.exports={scan,parseLog,parsePatch,extractPatches,literals,completed};
