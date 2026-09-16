'use strict';
const {lineHash,significant,hash,displayPath,resume,sessionLabel}=require('./common.cjs');
const WINDOW=3000;
function containsBlock(haystack,needle) {
  if(!needle.length)return false;
  outer:for(let i=0;i<=haystack.length-needle.length;i++) {
    for(let j=0;j<needle.length;j++)if(haystack[i+j]!==needle[j])continue outer;
    return true;
  }
  return false;
}
function localBlockAt(reference,block,digest,lineIndex){
  for(let i=0;i<block.length;i++)if(block[i]===digest){
    const start=Math.max(0,i-2),end=Math.min(block.length,i+3),at=lineIndex-(i-start);
    if(at<0||at+end-start>reference.length)continue;
    let same=true;for(let j=start;j<end;j++)if(reference[at+j-start]!==block[j]){same=false;break;}
    if(same)return true;
  }
  return false;
}
function analyze(snapshot,scan) {
  const intents=new Map(), groups=new Map(), records=[];
  function intentFor(e) {
    const session=scan.sessions.get(e.sid);
    const prompt=session?.prompts.filter(p=>p.ts<=e.ts).at(-1);
    if(!prompt)return null;
    const id='request-'+hash(e.sid+'@'+prompt.ts).slice(0,12);
    if(!intents.has(id))intents.set(id,{id,session,requestAt:prompt.ts,title:prompt.summary});
    return intents.get(id);
  }
  function record(f,l,decision) {
    const r={file:f.rel,line:l?.line||null,side:l?.t==='-'?'old':'new',...decision};
    records.push(r);
    const id=r.intent?.id || (r.attribution==='AMBIGUOUS'?'ambiguous':'none');
    if(!groups.has(id))groups.set(id,{id,intent:r.intent||null,confidence:r.confidence,attribution:r.attribution,records:[]});
    groups.get(id).records.push(r);
    return r;
  }
  for(const f of snapshot.files.values()) {
    const events=scan.edits.filter(e=>e.rel===f.rel||e.from===f.rel);
    const before=(f.beforeLines||[]).map(lineHash),after=(f.afterLines||[]).map(lineHash);
    const confirmed=events.filter(e=>e.success&&Number.isFinite(e.ts)&&Number.isFinite(e.end)&&e.end>=e.ts&&e.end<=Date.now()&&intentFor(e));
    const latest=confirmed.reduce((a,e)=>!a||e.end>a.end?e:a,null);
    const compatible=latest&&(f.after===null?latest.operation==='Delete':latest.operation!=='Delete');
    const aligned=!!compatible && latest.end-latest.ts<=60000 && (f.after===null || (f.mtime>=latest.ts&&f.mtime<=latest.end));
    const shellNearby=f.mtime==null?0:scan.commands.filter(c=>c.success&&c.end>=c.ts&&f.mtime>=c.ts-WINDOW&&f.mtime<=c.end+WINDOW).length;
    function decide(l) {
      const digest=lineHash(l.s);
      const matches=events.filter(e=>{
        if(e.operation==='Delete'&&l.t==='-'&&f.after===null)return true;
        if(e.from&&e.from===f.rel&&f.after===null)return false; // no postimage proof for the source side of a move
        if((l.t==='+'?e.added:e.removed).includes(digest))return true;
        return l.t==='-'&&['Write','Add'].includes(e.operation)&&after.length===e.added.length&&after.every((x,i)=>x===e.added[i]);
      });
      const evidence={content:matches.length?'EXACT_LINE_CANDIDATE':'NO_MATCH',session:'UNRESOLVED',command:shellNearby?'TIME_ONLY_NOT_ATTRIBUTION':'NONE',temporal:aligned?'LATEST_FILE_EDIT_ALIGNED':'UNCONFIRMED_OR_LATER_SAVE',toolResult:'UNCONFIRMED'};
      if(!matches.length)return {attribution:'NO_AGENT_TRACE',confidence:'NONE',intent:null,event:null,candidates:[],evidence};
      const ids=new Map();
      for(const e of matches) {const it=intentFor(e);if(it)ids.set(it.id,it);}
      const good=matches.filter(e=>e.success&&Number.isFinite(e.end)&&e.end>=e.ts&&intentFor(e));
      const strong=good.filter(e=> {
        if(e.operation==='Delete'&&f.after===null)return true;
        if(l.t==='-'&&['Write','Add'].includes(e.operation))return after.length===e.added.length&&after.every((x,i)=>x===e.added[i]);
        return e.blocks.some(b=>localBlockAt(l.t==='+'?after:before,l.t==='+'?b.added:b.removed,digest,l.line-1));
      });
      // Recency and hunk majority are never tie breakers between requests.
      if(ids.size!==1||!strong.length||!aligned||!significant(l.s))return {attribution:'AMBIGUOUS',confidence:'LOW',intent:null,event:null,candidates:[...ids.values()],evidence};
      const e=strong.at(-1),intent=intentFor(e);
      evidence.session='REQUEST_PRECEDES_TOOL';evidence.toolResult='SUCCESS_RECORDED';evidence.content=e.operation==='Delete'?'EXPLICIT_DELETE_AND_CURRENT_ABSENCE':'EXACT_LINE_AND_LOCAL_BLOCK';
      evidence.tool=e.tool;evidence.causality='IDENTICAL_REWRITE_NOT_OBSERVABLE';
      return {attribution:'ESTIMATED',confidence:'MEDIUM',intent,event:{ts:e.ts,end:e.end,tool:e.tool,callId:e.callId},candidates:[],evidence};
    }
    for(const h of f.hunks) {
      let decisions=h.lines.map(decide);
      const substantive=decisions.filter((d,i)=>significant(h.lines[i].s));
      const ids=new Set(substantive.map(d=>d.intent?.id||d.attribution));
      // Punctuation belongs only when one successful event covers the entire
      // changed block, including punctuation. Never inherit unmatched removals.
      if(ids.size===1&&substantive.length&&substantive[0].intent) {
        const it=substantive[0].intent;
        const all=confirmed.find(e=>intentFor(e)?.id===it.id&&h.lines.every(l=>{
          const list=l.t==='+'?e.added:e.removed;
          return list.includes(lineHash(l.s))||(l.t==='-'&&e.operation==='Delete');
        }));
        if(all)decisions=decisions.map((d,i)=>!significant(h.lines[i].s)?{...substantive[0],evidence:{...substantive[0].evidence,content:'WHOLE_CHANGED_BLOCK_IN_ONE_TOOL'}}:d);
      }
      h.records=decisions.map((d,i)=>record(f,h.lines[i],d));
    }
    if(!f.hunks.some(h=>h.lines.length))record(f,null,{attribution:'NO_AGENT_TRACE',confidence:'NONE',intent:null,event:null,candidates:[],evidence:{content:f.omitted||'EMPTY_OR_MODE_ONLY',session:'UNRESOLVED',temporal:'NOT_USED',command:'NOT_USED',toolResult:'UNCONFIRMED'}});
  }
  return {intents,groups:[...groups.values()].sort((a,b)=>(a.intent?.requestAt||Infinity)-(b.intent?.requestAt||Infinity)),records};
}
function publicRecord(r) {
  return {file:displayPath(r.file),line:r.line,side:r.side,attribution:r.attribution,confidence:r.confidence,
    agent:r.intent?.session.agent||null,session:sessionLabel(r.intent?.session.id),parentSession:sessionLabel(r.intent?.session.parent),
    intent:r.intent?.id||null,requestSummary:r.intent?.title||null,requestAt:r.intent?new Date(r.intent.requestAt).toISOString():null,
    timestamp:r.event?new Date(r.event.ts).toISOString():null,evidence:r.evidence,resume:r.intent?resume(r.intent.session):null,
    candidates:r.candidates.map(it=>({intent:it.id,agent:it.session.agent,summary:it.title}))};
}
module.exports={analyze,publicRecord,containsBlock,WINDOW};
