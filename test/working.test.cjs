'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs');
const {readDirty}=require('../working.cjs');
const {git,hash}=require('../common.cjs');
let repo;try{repo=git(__dirname,['rev-parse','--show-toplevel']).trim();}catch{}
test('actual Git batch input returns the same HEAD bytes without changing the index',{skip:!repo},()=>{
  const index=path.resolve(repo,git(repo,['rev-parse','--git-path','index']).trim());
  const beforeIndex=fs.existsSync(index)?hash(fs.readFileSync(index)):null;
  const snapshot=readDirty(repo);
  for(const f of snapshot.files.values())if(f.before&&!f.omitted){
    assert.equal(f.headBlobHash,hash(git(repo,['cat-file','blob',`${snapshot.head}:${f.rel}`],{encoding:null})));
    let expected=git(repo,['cat-file','--filters',`${snapshot.head}:${f.rel}`],{encoding:null,sourceConfig:true});
    if(f.after?.includes(10)&&!f.after.includes(13))expected=Buffer.from(expected.toString('utf8').replace(/\r\n/g,'\n'));
    assert.equal(hash(f.before),hash(expected));
  }
  const afterIndex=fs.existsSync(index)?hash(fs.readFileSync(index)):null;
  assert.equal(afterIndex,beforeIndex);
});
