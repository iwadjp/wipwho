'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {git,hash,inside,safeRelative,noLinks,displayPath,jsonNew}=require('./common.cjs');
const {sourceUnchanged}=require('./working.cjs');
// Unresolved lines share a quarantine patch; never pretend their two diagnostic
// labels (ambiguous / no trace) are two known requests inside a replacement.
const owner=r=>r.intent?.id||'unresolved';
function build(f,allowed,metadataOwner) {
  const base=f.beforeLines||[], out=[];let at=0,touched=false;
  let eol=f.before?.toString('utf8').endsWith('\n')||false;
  for(const h of f.hunks) {
    const begin=h.oldCount===0?h.oldStart:h.oldStart-1;
    if(begin<at||begin>base.length)throw Error('UNSAFE_TO_SPLIT: invalid hunk coordinate');
    out.push(...base.slice(at,begin));
    h.lines.forEach((l,i)=>{const on=allowed.has(owner(h.records[i]));if(l.t==='-'&&!on)out.push(l.s);if(l.t==='+'&&on)out.push(l.s);if(on)touched=true;});
    at=begin+h.oldCount;
    if(at===base.length&&h.records.every(r=>allowed.has(owner(r))))eol=f.after?.toString('utf8').endsWith('\n')||false;
    else if(f.before===null&&touched)eol=true;
  }
  out.push(...base.slice(at));
  const all=f.hunks.every(h=>h.records.every(r=>allowed.has(owner(r))));
  const metadataSelected=allowed.has(metadataOwner);
  const exists=f.after===null?!all:(f.before!==null||touched||metadataSelected);
  return exists?Buffer.from(out.join('\n')+(eol&&out.length?'\n':''),'utf8'):null;
}
function writeTree(root,states) {
  fs.mkdirSync(root,{recursive:true});
  for(const [rel,buffer]of states){if(buffer===null)continue;if(!safeRelative(rel))throw Error('UNSAFE_TO_SPLIT: path');const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,buffer,{flag:'wx'});}
}
function patchBetween(temp,index,before,after) {
  const a=`before-${index}`,b=`after-${index}`;writeTree(path.join(temp,a),before);writeTree(path.join(temp,b),after);
  let patch;
  try {patch=git(temp,['diff','--no-index','--no-ext-diff','--no-textconv','--no-renames','--no-color','--binary','-U3',a,b]);}
  catch(e){if(e.status!==1)throw Error('UNSAFE_TO_SPLIT: diff generation failed');patch=e.stdout.toString();}
  return patch.split('\n').map(line=>{
    if(!/^(diff --git |--- |\+\+\+ )/.test(line))return line;
    return line.replaceAll(`a/${a}/`,'a/').replaceAll(`b/${b}/`,'b/').replaceAll(`a/${b}/`,'a/').replaceAll(`b/${a}/`,'b/');
  }).join('\n');
}
function changes(patch) {
  const list=[];let inHunk=false;
  for(const line of patch.split('\n')){
    if(line.startsWith('diff --git ')){inHunk=false;continue;}
    if(line.startsWith('@@')){inHunk=true;continue;}
    if(inHunk&&(line[0]==='+'||line[0]==='-'))list.push(line[0]+hash(line.slice(1)));
  }
  return list.sort();
}
function split(snapshot,analysis,out,options={}) {
  out=path.resolve(out);
  if(inside(snapshot.repo,out)||inside(out,snapshot.repo))throw Error('UNSAFE_TO_SPLIT: output must be outside the source repository');
  let ancestor=out;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
  if(inside(snapshot.repo,fs.realpathSync(ancestor))||!noLinks(path.parse(out).root,ancestor))throw Error('UNSAFE_TO_SPLIT: output parent is a link or inside the repository');
  if(fs.existsSync(out))throw Error('UNSAFE_TO_SPLIT: choose a new output directory; existing output is never overwritten');
  const omitted=[...snapshot.files.values()].filter(f=>f.omitted).map(f=>({file:displayPath(f.rel),reason:f.omitted}));
  if(omitted.length&&!options.textOnly)throw Error('UNSAFE_TO_SPLIT: unsupported files present; --text-only explicitly excludes them');
  const selected=[...snapshot.files.values()].filter(f=>!f.omitted);
  for(const f of selected)for(const h of f.hunks){
    if(h.lines.some(l=>l.t==='-')&&new Set(h.records.map(owner)).size>1)throw Error(`UNSAFE_TO_SPLIT: mixed ownership inside replacement/deletion hunk (${displayPath(f.rel)})`);
  }
  if(options.checkSource!==false&&!sourceUnchanged(snapshot))throw Error('UNSAFE_TO_SPLIT: working state moved during analysis');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wipwho-verify-'));
  const initial=new Map(selected.map(f=>[f.rel,f.before]));
  const verify=path.join(temp,'verification');writeTree(verify,initial);git(verify,['init','--quiet']);
  const allowed=new Set(),plans=[];let state=initial;
  const relevant=analysis.groups.filter(g=>g.records.some(r=>selected.some(f=>f.rel===r.file)));
  const sourceGroups=relevant.filter(g=>g.intent);
  const unresolved=relevant.filter(g=>!g.intent).flatMap(g=>g.records);
  if(unresolved.length)sourceGroups.push({id:'unresolved',intent:null,confidence:unresolved.some(r=>r.confidence==='LOW')?'LOW':'NONE',records:unresolved});
  for(const group of sourceGroups) {
    allowed.add(group.id);
    const next=new Map(selected.map(f=>[f.rel,build(f,allowed,owner(analysis.records.find(r=>r.file===f.rel)))]));
    const changed=[...next.keys()].filter(n=>hash(next.get(n)||'NULL')!==hash(state.get(n)||'NULL')||(next.get(n)===null)!==(state.get(n)===null));
    if(!changed.length){state=next;continue;}
    const index=plans.length+1;
    const patch=patchBetween(temp,index,new Map(changed.map(n=>[n,state.get(n)])),new Map(changed.map(n=>[n,next.get(n)])));
    const expected=selected.flatMap(f=>f.hunks.flatMap(h=>h.lines.filter((l,i)=>owner(h.records[i])===group.id).map(l=>l.t+hash(l.s)))).sort();
    const actual=changes(patch);
    if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('UNSAFE_TO_SPLIT: patch contains omitted or extra changed lines');
    const patchPath=path.join(temp,`${index}.patch`);fs.writeFileSync(patchPath,patch,{flag:'wx'});
    try {git(verify,['apply','--check','--whitespace=nowarn',patchPath]);git(verify,['apply','--whitespace=nowarn',patchPath]);}
    catch{throw Error('UNSAFE_TO_SPLIT: independent temporary-repository application failed');}
    for(const [rel,wanted]of next){const full=path.join(verify,rel);const got=fs.existsSync(full)?fs.readFileSync(full):null;if((got===null)!==(wanted===null)||(got&&hash(got)!==hash(wanted)))throw Error('UNSAFE_TO_SPLIT: intermediate hash mismatch');}
    const label=group.intent?.title||'Unresolved (AMBIGUOUS / NO AGENT TRACE)';
    plans.push({name:`${String(index).padStart(2,'0')}-${group.id}.patch`,intent:group.intent?.id||null,title:label,
      files:changed.map(displayPath),confidence:group.confidence,warning:group.intent?'Estimated provenance; review before committing.':'Unresolved group; do not treat as a known request.',
      suggestedCommitSubject:group.intent?`chore: ${label.toLowerCase()}`:'chore: review unresolved working changes',sha256:hash(patch),patch,apply:'PASS',omittedLines:0,extraLines:0});
    state=next;
  }
  const hashes=[];
  for(const f of selected){const full=path.join(verify,f.rel),actual=fs.existsSync(full)?fs.readFileSync(full):null;
    const match=(actual===null)===(f.after===null)&&(!actual||hash(actual)===hash(f.after));
    hashes.push({file:displayPath(f.rel),before:f.beforeHash,headBlob:f.headBlobHash,beforeTransform:f.beforeTransform||'NONE',expected:f.afterHash,actual:actual===null?null:hash(actual),match});
    if(!match)throw Error('UNSAFE_TO_SPLIT: final working content hash mismatch');
  }
  if(options.checkSource!==false&&!sourceUnchanged(snapshot))throw Error('UNSAFE_TO_SPLIT: source moved while patches were verified');
  const plan={version:'0.1.0',baseHead:snapshot.head,scope:omitted.length?'TEXT_ONLY':'ALL_SUPPORTED_DIRTY_FILES',
    sequential:true,base:'HEAD contents with recorded EOL checkout transforms, not the current index',applySuccess:plans.length,applyFail:0,hashes,
    omitted,omittedLines:0,extraLines:0,lineCountScope:'included files only; omitted-file line counts are unknown',patches:plans.map(({patch,...p})=>p),
    limitations:['Patches require this base and this order; unrelated offsets or different base hashes are unsupported.','Base bytes include each file\'s recorded beforeTransform; raw HEAD blobs or a differently configured checkout may not match.','Context lines may mention other changes; changed +/- lines are checked per group.','Intermediate code may not build. No commit or staging script is generated.']};
  fs.mkdirSync(out,{recursive:true});
  for(const p of plans)fs.writeFileSync(path.join(out,p.name),p.patch,{flag:'wx'});
  jsonNew(path.join(out,'commit-plan.json'),plan);
  fs.writeFileSync(path.join(out,'commit-plan.md'),['# Review-only commit plan','',`Base HEAD: ${snapshot.head}`,
    'Apply patches only to the documented base, in this order. Match the per-file before hashes and beforeTransform EOL rules in commit-plan.json. Inspect each patch; no commands have been run on the source repository.','',
    ...plans.flatMap(p=>[`## ${p.name}`,`- Intent: ${p.title}`,`- Confidence: ${p.confidence}`,`- Files: ${p.files.join(', ')}`,`- Warning: ${p.warning}`,`- Suggested subject: ${p.suggestedCommitSubject}`,'']),
    `Omitted files: ${omitted.length}. Successful applies: ${plans.length}. Exact file hashes: ${hashes.filter(h=>h.match).length}/${hashes.length}.`,
    'Patch files contain source code and can contain secrets. Keep this directory private.',''].join('\n'),{flag:'wx'});
  return plan;
}
module.exports={split,build,changes};
