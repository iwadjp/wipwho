'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {T,temp,makeFile,codex,claude,scenario}=require('./helpers.cjs');
const {split}=require('../split.cjs');
const {git,hash}=require('../common.cjs');
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
  a.throws(()=>run(x),/UNSAFE_TO_SPLIT: unsupported/);const {plan}=run(x,{textOnly:true});a.equal(plan.omitted.length,2);a.equal(plan.hashes.length,1);a.equal(plan.scope,'TEXT_ONLY');
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
