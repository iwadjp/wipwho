'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {readDirty}=require('../working.cjs'),{analyze}=require('../attribution.cjs'),{split}=require('../split.cjs');
const {parseLog}=require('../transcripts.cjs'),{hash}=require('../common.cjs'),{verify}=require('./verify-export.cjs');
const bundle=path.join(__dirname,'fixtures','public-eol-base.bundle');
function rawGit(repo,args,bytes=false){return cp.execFileSync('git',['--no-optional-locks','-C',repo,...args],{encoding:bytes?null:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']});}
function fixture(autocrlf,attr,checkoutCrlf=attr?attr==='crlf':autocrlf){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wipwho-eol-test-')),repo=path.join(root,'repo');
  rawGit(root,['clone','--config','core.autocrlf='+checkoutCrlf,'--',bundle,repo]);
  if(attr)fs.writeFileSync(path.join(repo,'.gitattributes'),'* text eol='+attr+'\n');
  for(const [key,value]of [['core.autocrlf',autocrlf],['core.eol','native'],['core.safecrlf',false]])rawGit(repo,['config','--local',key,String(value)]);
  return {root,repo};
}
for(const [name,auto,attr,checkout]of [['LF',false,null,false],['autocrlf CRLF',true,null,true],['attributes LF',true,'lf',false],['attributes CRLF',false,'crlf',true],['LF editor under autocrlf',true,null,false]])test(name+': Git-selected files only, exact split reconstruction',()=>{
  const {root,repo}=fixture(auto,attr,checkout),expected=attr?['.gitattributes','index.js']:['index.js'];
  assert.equal(rawGit(repo,['ls-files','-z']).split('\0').filter(Boolean).length,21);
  assert.deepEqual([...readDirty(repo).files.keys()],attr?['.gitattributes']:[]);
  assert.equal(rawGit(repo,['diff','HEAD','--name-only']),'');
  const target=path.join(repo,'index.js'),before=fs.readFileSync(target,'utf8');
  assert.equal(before.includes('\r\n'),checkout);
  fs.writeFileSync(target,before.replace('var toString = {}.toString;','var toString = Object.prototype.toString;'));
  const index=path.join(repo,'.git','index'),indexHash=hash(fs.readFileSync(index)),status=rawGit(repo,['status','--porcelain']);
  const snapshot=readDirty(repo);assert.deepEqual([...snapshot.files.keys()].sort(),expected);
  assert.equal(rawGit(repo,['diff','HEAD','--numstat']).trim(),'1\t1\tindex.js');
  const plan=split(snapshot,analyze(snapshot,{sessions:new Map(),edits:[],commands:[]}),path.join(root,'patches'));
  assert.equal(plan.hashes.length,expected.length);assert.equal(plan.omitted.length,0);assert.ok(plan.hashes.every(h=>h.match));
  const independent=verify(repo,path.join(root,'patches'));assert.ok(independent.hashes.every(h=>h.match));
  assert.equal(hash(fs.readFileSync(index)),indexHash);assert.equal(rawGit(repo,['status','--porcelain']),status);
  assert.equal(hash(fs.readFileSync(target)),plan.hashes.find(h=>h.file==='index.js').expected);
});
test('CRLF attributed edits in separate hunks remain separate review patches',()=>{
  const {root,repo}=fixture(true,null),target=path.join(repo,'index.js'),now=Date.now()-100;
  const before=fs.readFileSync(target,'utf8'),oldA='var toString = {}.toString;',newA='var toString = Object.prototype.toString;',oldB="  return toString.call(arr) === '[object Array]';",newB="  return '[object Array]' === toString.call(arr);";
  fs.writeFileSync(target,before.replace(oldA,newA).replace(oldB,newB));
  const end=Date.now()+1,rows=[{timestamp:new Date(now-10).toISOString(),type:'session_meta',payload:{id:'public-eol-fixture',cwd:repo}}];
  for(const [i,oldText,newText]of [[0,oldA,newA],[1,oldB,newB]]){
    const stamp=n=>new Date(n).toISOString(),id='edit-'+i;
    rows.push({timestamp:stamp(now+i*10),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:i?'Improve array comparison':'Improve prototype lookup'}]}});
    rows.push({timestamp:stamp(now+i*10+1),type:'response_item',payload:{type:'custom_tool_call',name:'apply_patch',call_id:id,input:'*** Begin Patch\n*** Update File: index.js\n@@\n-'+oldText+'\n+'+newText+'\n*** End Patch'}});
    rows.push({timestamp:stamp(end),type:'response_item',payload:{type:'custom_tool_call_output',call_id:id,output:'Success'}});
  }
  // Ensure completion timestamps are in the past without manipulating file mtimes.
  while(Date.now()<=end){}
  const parsed=parseLog(rows.map(r=>JSON.stringify(r)).join('\n'),'codex','controlled.jsonl',repo,new Map([['index.js','index.js']]));
  const snapshot=readDirty(repo),analysis=analyze(snapshot,{sessions:new Map(parsed.sessions.map(s=>[s.id,s])),edits:parsed.edits,commands:[]});
  const plan=split(snapshot,analysis,path.join(root,'patches'));
  assert.equal(plan.patches.length,2);assert.ok(plan.patches.every(p=>p.intent));assert.equal(plan.hashes[0].beforeTransform,'CRLF');
  assert.ok(verify(repo,path.join(root,'patches')).hashes.every(h=>h.match));
});
