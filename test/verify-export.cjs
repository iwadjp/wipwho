'use strict';
// Independent dogfood verifier. Only writes to a new temporary, local clone.
// No staging, commits, checkout commands, cleanup, or changes to the source.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {git,hash,safeRelative}=require('../common.cjs');
function verify(source,exportDir){
  source=fs.realpathSync(source);exportDir=fs.realpathSync(exportDir);
  const plan=JSON.parse(fs.readFileSync(path.join(exportDir,'commit-plan.json'),'utf8'));
  if(!/^[0-9a-f]{40,64}$/.test(plan.baseHead))throw Error('Invalid base');
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'wipwho-clone-')),clone=path.join(parent,'work');
  git(parent,['clone','--shared','--no-checkout','--',source,clone]);
  if(git(clone,['rev-parse','HEAD']).trim()!==plan.baseHead)throw Error('Source HEAD changed');
  for(const item of plan.hashes){
    if(!safeRelative(item.file))throw Error('Invalid manifest path');
    if(item.before!==null){
      let bytes=git(clone,['cat-file','blob',`${plan.baseHead}:${item.file}`],{encoding:null});
      if(item.headBlob&&hash(bytes)!==item.headBlob)throw Error('HEAD blob hash mismatch');
      if(item.beforeTransform==='CRLF')bytes=Buffer.from(bytes.toString('utf8').replace(/\r?\n/g,'\r\n'));
      else if(item.beforeTransform==='LF')bytes=Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'));
      else if(item.beforeTransform&&item.beforeTransform!=='NONE')throw Error('Unsupported base transform');
      if(hash(bytes)!==item.before)throw Error('Base hash mismatch');
      const target=path.join(clone,item.file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});
    }
  }
  const applied=[];
  for(const item of plan.patches){
    if(!safeRelative(item.name))throw Error('Invalid patch path');
    const file=path.join(exportDir,item.name);if(hash(fs.readFileSync(file))!==item.sha256)throw Error('Patch changed since export');
    git(clone,['apply','--check','--whitespace=nowarn',file]);git(clone,['apply','--whitespace=nowarn',file]);applied.push({patch:item.name,apply:'PASS'});
  }
  const hashes=plan.hashes.map(item=>{const file=path.join(clone,item.file);const actual=fs.existsSync(file)?hash(fs.readFileSync(file)):null;return{file:item.file,expected:item.expected,actual,match:actual===item.expected};});
  if(hashes.some(h=>!h.match))throw Error('Final clone hash mismatch');
  const actualNames=git(clone,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).sort();
  const expectedNames=plan.hashes.filter(x=>x.expected!==null).map(x=>x.file).sort();
  if(JSON.stringify(actualNames)!==JSON.stringify(expectedNames))throw Error('Extra or omitted files');
  return{verifier:'independent local clone; HEAD blobs populated without staging',patches:applied,hashes,extraFiles:0,omittedIncludedFiles:0,omittedUnsupportedFiles:plan.omitted.length,cloneRetained:true};
}
if(require.main===module){try{console.log(JSON.stringify(verify(process.argv[2],process.argv[3]),null,2));}catch(e){console.error('Independent verification failed: '+e.message);process.exitCode=1;}}
module.exports={verify};
