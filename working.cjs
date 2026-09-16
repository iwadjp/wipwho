'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {isUtf8}=require('node:buffer');
const {git,hash,lines,safeRelative,noLinks}=require('./common.cjs');
const LIMIT=4*1024*1024;
function hunksFromDiff(diff,before,after) {
  const hunks=[];let h=null,old=0,next=0;
  for(const row of diff.split('\n')) {
    const m=row.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if(m){h={oldStart:+m[1],oldCount:m[2]===undefined?1:+m[2],newStart:+m[3],newCount:m[4]===undefined?1:+m[4],lines:[]};hunks.push(h);old=h.oldStart-1;next=h.newStart-1;continue;}
    if(!h)continue;
    if(row[0]==='-')h.lines.push({t:'-',s:before[old],line:++old});
    if(row[0]==='+')h.lines.push({t:'+',s:after[next],line:++next});
  }
  if(hunks.some(h=>h.lines.some(l=>l.s===undefined)))throw Error('DIFF_COORDINATE_MISMATCH');
  return hunks;
}
function readDirty(repo) {
  repo=fs.realpathSync(path.resolve(repo));
  const started=performance.now();let head;
  try {head=git(repo,['rev-parse','--verify','HEAD']).trim();}catch {throw Error('A committed HEAD is required; unborn repositories are not supported.');}
  const names=git(repo,['diff','--name-status','-z','--no-renames',head,'--'],{sourceConfig:true}).split('\0');
  const statuses=new Map();
  for(let i=0;i<names.length-1;i+=2)if(names[i+1])statuses.set(names[i+1],names[i]);
  for(const rel of git(repo,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean))statuses.set(rel,'?');
  const tree=new Map();
  for(const row of git(repo,['ls-tree','-rlz',head]).split('\0')){
    const m=row.match(/^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/);
    if(m&&statuses.has(m[5]))tree.set(m[5],{mode:m[1],type:m[2],oid:m[3],size:+m[4]});
  }
  const wanted=[...new Set([...tree.values()].filter(e=>e.type==='blob'&&e.size<=LIMIT&&e.mode.startsWith('100')).map(e=>e.oid))];
  const blobs=new Map();
  if(wanted.length){
    const output=git(repo,['cat-file','--batch'],{input:wanted.join('\n')+'\n',encoding:null});let at=0;
    while(at<output.length){const end=output.indexOf(10,at);if(end<0)throw Error('BASE_BATCH_INVALID');const parts=output.subarray(at,end).toString().split(' ');const size=+parts[2];if(!Number.isFinite(size))throw Error('BASE_BATCH_INVALID');blobs.set(parts[0],output.subarray(end+1,end+1+size));at=end+size+2;}
  }
  const files=new Map();
  for(const [rel,status] of statuses) {
    const f={rel,status,hunks:[],before:null,after:null,mtime:null,omitted:null};files.set(rel,f);
    const abs=path.join(repo,rel);
    // A staged deletion plus an untracked recreation at the same HEAD path is
    // not an ordinary new file. Never export an Add patch against an existing blob.
    if(status==='?'&&tree.has(rel)){f.omitted='INDEX_WORKTREE_OVERLAP';continue;}
    if(status.includes('U')){f.omitted='UNMERGED_INDEX';continue;}
    if(/(^|\/)(?:\.claude|\.codex)(?:\/|$)/i.test(rel)){f.omitted='PRIVATE_AGENT_STATE';continue;}
    if(!safeRelative(rel)||!noLinks(repo,abs)){f.omitted='UNSUPPORTED_PATH_OR_LINK';continue;}
    let stat;
    try {stat=fs.lstatSync(abs);if(!stat.isFile()){f.omitted='NOT_REGULAR_FILE';continue;}f.mtime=stat.mtimeMs;}catch(e){if(e.code!=='ENOENT')throw Error('WORKTREE_READ_FAILED');}
    if(stat?.size>LIMIT){f.omitted='LARGE_FILE';continue;}
    if(status!=='?'&&status!=='A') {
      const info=tree.get(rel);
      if(!info){f.omitted='BASE_UNAVAILABLE';continue;}
      if(!['100644','100755'].includes(info.mode)){f.omitted='UNSUPPORTED_MODE';continue;}
      f.mode=info.mode;
      if(info.size>LIMIT){f.omitted='LARGE_FILE';continue;}
      f.before=blobs.get(info.oid);
      f.headBlobHash=hash(f.before);
      // Obtain Git's EOL checkout representation, not a hand-written guess
      // about autocrlf/eol/text=auto precedence. Do not invoke smudge programs.
      const attrs=git(repo,['check-attr','-z','filter','ident','working-tree-encoding','--',rel],{sourceConfig:true}).split('\0');
      if(attrs.some((v,i)=>i%3===2&&!['unspecified','unset'].includes(v))){f.omitted='UNSUPPORTED_CHECKOUT_FILTER';continue;}
      const checkout=git(repo,['cat-file','--filters',`${head}:${rel}`],{sourceConfig:true,encoding:null});
      if(!checkout.equals(f.before)){
        const text=f.before.toString('utf8');
        if(checkout.equals(Buffer.from(text.replace(/\r?\n/g,'\r\n'))))f.beforeTransform='CRLF';
        else if(checkout.equals(Buffer.from(text.replace(/\r\n/g,'\n'))))f.beforeTransform='LF';
        else {f.omitted='UNSUPPORTED_CHECKOUT_TRANSFORM';continue;}
        f.before=checkout;
      }
    }
    if(stat)f.after=fs.readFileSync(abs);
    if([f.before,f.after].some(b=>b&&(b.includes(0)||!isUtf8(b)))){f.omitted='BINARY_OR_NON_UTF8';f.before=null;f.after=null;continue;}
    // Editors may keep an LF file under autocrlf=true. Git still normalizes it;
    // use its observed LF representation rather than introducing CRLF bytes.
    if(f.beforeTransform==='CRLF'&&f.after?.includes(10)&&!f.after.includes(13)){
      f.before=Buffer.from(f.before.toString('utf8').replace(/\r\n/g,'\n'));
      f.beforeTransform=hash(f.before)===f.headBlobHash?'NONE':'LF';
    }
    f.beforeLines=lines(f.before?.toString('utf8')||'');f.afterLines=lines(f.after?.toString('utf8')||'');
    f.beforeHash=f.before===null?null:hash(f.before);f.afterHash=f.after===null?null:hash(f.after);
    if(f.before===null)f.hunks=[{oldStart:0,oldCount:0,newStart:1,newCount:f.afterLines.length,lines:f.afterLines.map((s,i)=>({t:'+',s,line:i+1}))}];
    else if(f.after===null)f.hunks=[{oldStart:1,oldCount:f.beforeLines.length,newStart:0,newCount:0,lines:f.beforeLines.map((s,i)=>({t:'-',s,line:i+1}))}];
  }
  const tracked=[...files.values()].filter(f=>!f.omitted&&f.before!==null&&f.after!==null);
  if(tracked.length){
    const combined=git(repo,['diff',head,'--no-ext-diff','--no-textconv','--no-renames','--no-color','-U0','--',...tracked.map(f=>f.rel)],{sourceConfig:true});
    for(const block of combined.split(/(?=^diff --git )/m).filter(Boolean)){
      const header=block.split('\n').find(l=>l.startsWith('+++ '));if(!header)continue;
      let name=header.slice(4);if(name.startsWith('"'))name=JSON.parse(name);name=name.replace(/^b\//,'');
      const f=files.get(name);if(!f)throw Error('DIFF_PATH_MISMATCH');
      if(/^old mode |^new mode /m.test(block)){f.omitted='UNSUPPORTED_MODE_CHANGE';continue;}
      f.hunks=hunksFromDiff(block,f.beforeLines,f.afterLines);
    }
    for(const f of tracked)if(!f.hunks.length&&f.beforeHash!==f.afterHash)f.omitted='FILTER_OR_MODE_CHANGE';
  }
  return {repo,head,files,elapsedMs:performance.now()-started};
}
function sourceUnchanged(snapshot) {
  const now=readDirty(snapshot.repo);
  if(now.head!==snapshot.head || now.files.size!==snapshot.files.size)return false;
  for(const [name,f] of snapshot.files) {
    const other=now.files.get(name);
    if(!other||other.status!==f.status||other.beforeHash!==f.beforeHash||other.afterHash!==f.afterHash||other.omitted!==f.omitted)return false;
  }
  return true;
}
module.exports={readDirty,hunksFromDiff,sourceUnchanged,LIMIT};
