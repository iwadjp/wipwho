'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {hash,lines,git,norm}=require('../common.cjs');
const {hunksFromDiff}=require('../working.cjs');
const {parseLog}=require('../transcripts.cjs');
const {analyze}=require('../attribution.cjs');
const T=Date.parse('2026-09-15T01:00:00Z');
const stamp=n=>new Date(T+n).toISOString();
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wipwho-fixture-'));
function makeFile(rel,before,after,mtime=T+10500){
  const b=before===null?null:Buffer.from(before),a=after===null?null:Buffer.from(after);
  const f={rel,status:b===null?'?':a===null?'D':'M',before:b,after:a,mtime,omitted:null,
    beforeHash:b===null?null:hash(b),afterHash:a===null?null:hash(a),beforeLines:lines(b?.toString()||''),afterLines:lines(a?.toString()||''),hunks:[]};
  if(a&&a.length>4*1024*1024){f.omitted='LARGE_FILE';return f;}
  if([a,b].some(x=>x?.includes(0))){f.omitted='BINARY_OR_NON_UTF8';return f;}
  if(b===null)f.hunks=[{oldStart:0,oldCount:0,newStart:1,newCount:f.afterLines.length,lines:f.afterLines.map((s,i)=>({t:'+',s,line:i+1}))}];
  else if(a===null)f.hunks=[{oldStart:1,oldCount:f.beforeLines.length,newStart:0,newCount:0,lines:f.beforeLines.map((s,i)=>({t:'-',s,line:i+1}))}];
  else{const dir=temp();fs.writeFileSync(path.join(dir,'a'),b);fs.writeFileSync(path.join(dir,'b'),a);let diff='';try{diff=git(dir,['diff','--no-index','--no-color','-U0','a','b']);}catch(e){if(e.status!==1)throw e;diff=e.stdout.toString();}f.hunks=hunksFromDiff(diff,f.beforeLines,f.afterLines);}
  return f;
}
function patch(rel,added,removed=[],operation='Update'){
  return `*** Begin Patch\n*** ${operation} File: ${rel}\n`+(operation==='Update'?'@@\n':'')+removed.map(s=>'-'+s+'\n').join('')+added.map(s=>'+'+s+'\n').join('')+'*** End Patch';
}
function codex(repo,{id='cx-session',parent=null,metaTime=0,events=[],fork=[]}={}){
  const rows=[{timestamp:stamp(metaTime),type:'session_meta',payload:{id,cwd:repo,source:parent?{subagent:{thread_spawn:{parent_thread_id:parent}}}:undefined}},...fork];
  for(const [i,e]of events.entries()){
    const n=e.at??10000,cid=e.callId||'call-'+i;
    if(e.prompt!==false)rows.push({timestamp:stamp(n-1000),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:e.prompt||'Fix regression tests'}]}});
    const name=e.tool||'apply_patch';
    rows.push({timestamp:stamp(n),type:'response_item',payload:{type:'custom_tool_call',name,call_id:cid,input:e.source??patch(path.join(repo,e.file||'a.cjs'),e.added||[],e.removed||[],e.operation||'Update')}});
    if(!e.pending)rows.push({timestamp:stamp(n+1000),type:'response_item',payload:{type:'custom_tool_call_output',call_id:cid,output:[{type:'text',text:e.failed?'Error: patch rejected':'Script completed\n{}'}]}});
  }
  return rows;
}
function claude(repo,{id='cc-session',child=false,events=[]}={}){
  const rows=[];
  for(const [i,e]of events.entries()){
    const n=e.at??10000,base={sessionId:id,cwd:repo,isSidechain:child,agentId:child?'child-1':undefined};
    if(e.prompt!==false)rows.push({...base,timestamp:stamp(n-1000),type:'user',message:{content:e.prompt||'Fix regression tests'}});
    const name=e.tool||'Edit',input=name==='Write'?{file_path:path.join(repo,e.file||'a.cjs'),content:e.added.join('\n')+'\n'}:{file_path:path.join(repo,e.file||'a.cjs'),old_string:(e.removed||[]).join('\n'),new_string:(e.added||[]).join('\n')};
    rows.push({...base,timestamp:stamp(n),type:'assistant',message:{content:[{type:'tool_use',id:'cc-call-'+i,name,input}]}});
    if(!e.pending)rows.push({...base,timestamp:stamp(n+1000),type:'user',message:{content:[{type:'tool_result',tool_use_id:'cc-call-'+i,is_error:!!e.failed,content:e.failed?'Error: rejected':'updated'}]}});
  }
  return rows;
}
function scenario(fileSpecs,logs){
  const repo=temp(),files=new Map(fileSpecs.map(f=>[f.rel,f])),sessions=new Map(),edits=[],commands=[];
  const actualLogs=typeof logs==='function'?logs(repo):logs;
  for(const [agent,rows]of actualLogs){const parsed=parseLog(rows.map(r=>JSON.stringify(r)).join('\n'),agent,agent+'.jsonl',repo,new Map([...files.keys()].map(n=>[norm(n),n])));for(const s of parsed.sessions){if(!sessions.has(s.id))sessions.set(s.id,{...s,prompts:[]});sessions.get(s.id).prompts.push(...s.prompts);}edits.push(...parsed.edits);commands.push(...parsed.commands);}
  for(const s of sessions.values())s.prompts.sort((a,b)=>a.ts-b.ts);
  const snapshot={repo,head:'fixture-head',files},scan={sessions,edits,commands,stats:{}};
  return {snapshot,scan,analysis:analyze(snapshot,scan)};
}
module.exports={T,stamp,temp,makeFile,patch,codex,claude,scenario};
