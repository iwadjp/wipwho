'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {T,temp,makeFile,codex,claude,scenario}=require('./helpers.cjs');
const {split}=require('../split.cjs');
const {git,hash}=require('../common.cjs');
const {readDirty}=require('../working.cjs');
const {analyze}=require('../attribution.cjs');
const cp=require('node:child_process');
function run(x,options={}){const out=path.join(temp(),'out');const plan=split(x.snapshot,x.analysis,out,{checkSource:false,...options});return{plan,out};}
test('new mixed-intent file: applies per request with no omitted/extra changed lines',()=>{
  const first='const firstFeature = true;',second='const secondFeature = true;';
  const x=scenario([makeFile('a.cjs',null,first+'\n'+second+'\n',T+20500)],r=>[['codex',codex(r,{events:[{added:[first],operation:'Add'},{added:[second],at:20000}]})]]);
  const {plan,out}=run(x);a.equal(plan.patches.length,2);a.equal(plan.applyFail,0);a.ok(plan.hashes.every(h=>h.match));a.equal(plan.extraLines,0);
  a.ok(!fs.readFileSync(path.join(out,plan.patches[0].name),'utf8').includes('+'+second));
  a.ok(!fs.existsSync(path.join(out,'commit-by-intent.ps1')));
});
test('separate replacement hunks in one file remain separate patches',()=>{
  const between=Array.from({length:10},(_,i)=>`const untouched${i} = ${i};`);
  const oldA='const initialFirst = 1;',newA='const revisedFirst = 2;',oldB='const initialLast = 3;',newB='const revisedLast = 4;';
  const x=scenario([makeFile('a.cjs',[oldA,...between,oldB].join('\n')+'\n',[newA,...between,newB].join('\n')+'\n',T+20500)],r=>[['codex',codex(r,{events:[{added:[newA],removed:[oldA]},{added:[newB],removed:[oldB],at:20000}]})]]);
  const {plan}=run(x);a.equal(plan.patches.length,2);a.equal(plan.hashes[0].match,true);
});
test('same-line replacement crossing requests is UNSAFE_TO_SPLIT before publishing',()=>{
  const old='const originalValue = 1;',mid='const intermediateValue = 2;',last='const finalValue = 3;';
  const x=scenario([makeFile('a.cjs',old+'\n',last+'\n',T+20500)],r=>[['claude',claude(r,{events:[{added:[mid],removed:[old]}]})],['codex',codex(r,{events:[{added:[last],removed:[mid],at:20000}]})]]);
  const out=path.join(temp(),'out');a.throws(()=>split(x.snapshot,x.analysis,out,{checkSource:false}),/UNSAFE_TO_SPLIT: mixed ownership/);a.equal(fs.existsSync(out),false);
});
test('CRLF/LF, empty file, blank file, and missing final newline preserve raw bytes',()=>{
  const specs=[['mixed.txt','first line\r\nsecond line\nthird line\r\n'],['empty.txt',''],['blank.txt','\n'],['no-eol.txt','last line without newline']];
  const x=scenario(specs.map(([p,t])=>makeFile(p,null,t)),[]);const {plan}=run(x);a.equal(plan.hashes.length,4);a.ok(plan.hashes.every(h=>h.match));
});
test('mixed EOL modification preserves the unchanged lines too',()=>{
  const x=scenario([makeFile('mixed.txt','old first\r\nunchanged second\nold third','new first\r\nunchanged second\nnew third')],[]);
  a.ok(run(x).plan.hashes.every(h=>h.match));
});
test('delete and rename-as-delete/add apply with exact final hashes',()=>{
  const x=scenario([makeFile('gone.txt','remove this file\n',null),makeFile('old name.txt','rename body\r\n',null),makeFile('new name.txt',null,'rename body\r\n')],[]);
  const {plan}=run(x);a.equal(plan.hashes.length,3);a.ok(plan.hashes.every(h=>h.match));a.equal(plan.hashes.filter(h=>h.actual===null).length,2);
});
test('quoted and regex-special filenames survive patch path translation',()=>{
  const x=scenario([makeFile('folder with space/name [1] (test).txt',null,'special filename body\n')],[]);
  a.equal(run(x).plan.hashes[0].match,true);
});
test('unsupported files stop default split; explicit text-only reports omissions',()=>{
  const x=scenario([makeFile('a.bin',null,Buffer.from([0,1])),makeFile('big.txt',null,'x'.repeat(4*1024*1024+1)),makeFile('small.txt',null,'small text body\n')],[]);
  a.throws(()=>run(x),/UNSAFE_TO_SPLIT: unsupported/);
  // The refusal must name what blocked it, so the user can fix those files or choose --text-only knowingly.
  a.throws(()=>run(x),/a\.bin: BINARY_OR_NON_UTF8/);a.throws(()=>run(x),/big\.txt: LARGE_FILE/);
  const {plan}=run(x,{textOnly:true});a.equal(plan.omitted.length,2);a.equal(plan.hashes.length,1);a.equal(plan.scope,'TEXT_ONLY');
});
test('independent final-byte oracle detects reconstruction drift, does not publish unsafe patches',()=>{
  const x=scenario([makeFile('a.txt',null,'original desired bytes\r\n')],[]);
  x.snapshot.files.get('a.txt').after=Buffer.from('different independently observed target\n');
  const out=path.join(temp(),'out');a.throws(()=>split(x.snapshot,x.analysis,out,{checkSource:false}),/final working content hash mismatch/);a.equal(fs.existsSync(out),false);
});
test('output cannot overwrite existing directories or enter source repo',()=>{
  const x=scenario([makeFile('a.txt',null,'fixture content\n')],[]);
  a.throws(()=>split(x.snapshot,x.analysis,path.join(x.snapshot.repo,'export'),{checkSource:false}),/outside/);
  a.throws(()=>split(x.snapshot,x.analysis,temp(),{checkSource:false}),/new output/);
});
test('offset experiment: application alone is not proof on a different base',()=>{
  const before=Array.from({length:12},(_,i)=>`context line ${i}`).join('\n')+'\n';
  const after=before.replace('context line 7','updated line seven');
  const x=scenario([makeFile('a.txt',before,after)],[]);const {plan,out}=run(x);
  const shifted=temp();git(shifted,['init','--quiet']);fs.writeFileSync(path.join(shifted,'a.txt'),'unrelated prefix\n'+before);
  const patch=path.join(out,plan.patches[0].name);git(shifted,['apply','--check',patch]);git(shifted,['apply',patch]);
  a.notEqual(hash(fs.readFileSync(path.join(shifted,'a.txt'))),plan.hashes[0].expected);
  a.ok(plan.limitations[0].includes('different base hashes are unsupported'));
});

function modeFixture(rel,body,executable){
  const repo=temp();git(repo,['init','--quiet']);git(repo,['config','core.filemode','false']);
  fs.writeFileSync(path.join(repo,rel),body);fs.writeFileSync(path.join(repo,'notes.txt'),'base\n');
  git(repo,['add','.']);git(repo,['update-index','--chmod='+(executable?'+x':'-x'),'--',rel]);
  git(repo,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','base']);
  git(repo,['update-index','--chmod='+(executable?'-x':'+x'),'--',rel]);
  return repo;
}
function gitState(repo){
  return {
    head:git(repo,['rev-parse','HEAD']),index:git(repo,['ls-files','--stage','-z']),
    indexHash:hash(fs.readFileSync(path.join(repo,'.git','index'))),
    status:git(repo,['status','--porcelain=v1','-z']),
    staged:git(repo,['diff','--cached','--raw','--no-renames']),unstaged:git(repo,['diff','--raw','--no-renames']),
    worktree:fs.readdirSync(repo).filter(n=>n!=='.git').sort().map(n=>({path:n,hash:hash(fs.readFileSync(path.join(repo,n))),mode:fs.statSync(path.join(repo,n)).mode})),
  };
}
for(const [rel,body,executable,mixed]of [['実行 script.sh','#!/bin/sh\necho hello\n',false,true],['empty mode.txt','',true,false]]){
  test(`mode-only ${executable?'-x':'+x'} change is refused without publishing or modifying source (${rel})`,()=>{
    const repo=modeFixture(rel,body,executable),out=path.join(temp(),'out'),home=temp();
    if(mixed)fs.appendFileSync(path.join(repo,'notes.txt'),'unstaged edit\n');
    const before=gitState(repo);
    a.match(before.staged,/100644 100755|100755 100644/);
    // Mode-only patches have no +++ path header. The old parser skipped the
    // mode guard and claimed success based only on equal content hashes.
    a.doesNotMatch(git(repo,['diff','HEAD','--',rel]),/^\+\+\+ /m);
    const result=cp.spawnSync(process.execPath,[path.join(__dirname,'..','wipwho.cjs'),'--repo',repo,'split','--out',out,'--no-cache'],{
      encoding:'utf8',windowsHide:true,env:{...process.env,HOME:home,USERPROFILE:home},
    });
    a.deepEqual(gitState(repo),before);
    a.equal(result.status,3,result.stdout+result.stderr);
    a.match(result.stderr,/UNSAFE_TO_SPLIT:.*UNSUPPORTED_MODE_CHANGE/);
    a.ok(result.stderr.includes(rel));a.equal(fs.existsSync(out),false);
    const snapshot=readDirty(repo),analysis=analyze(snapshot,{sessions:new Map(),edits:[],commands:[]});
    a.equal(snapshot.files.get(rel).omitted,'UNSUPPORTED_MODE_CHANGE');
    // Explicit text-only export may skip it, but must disclose the omission.
    const plan=split(snapshot,analysis,out,{textOnly:true});
    a.deepEqual(plan.omitted,[{file:rel,reason:'UNSUPPORTED_MODE_CHANGE'}]);
    a.equal(plan.scope,'TEXT_ONLY');a.equal(plan.hashes.length,mixed?1:0);
    a.ok(!plan.patches.some(p=>p.files.includes(rel)));
    a.deepEqual(gitState(repo),before);
  });
}
