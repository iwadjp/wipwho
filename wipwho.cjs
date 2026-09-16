#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {git,norm,displayPath,resume,sessionLabel}=require('./common.cjs');
const {readDirty}=require('./working.cjs');
const {scan}=require('./transcripts.cjs');
const {analyze,publicRecord}=require('./attribution.cjs');
const {split}=require('./split.cjs');
function parseArgs(argv) {
  const options={days:14};
  const positional=[];
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(['--all','--json','--no-cache','--profile','--text-only','--old','--help','-h'].includes(arg)){options[arg.replace(/^--?/,'')]=true;continue;}
    if(['--repo','--days','--out'].includes(arg)){
      const value=argv[++i];if(!value||value.startsWith('--'))throw Error('Missing option value');
      options[arg.slice(2)]=value;continue;
    }
    if(arg.startsWith('--'))throw Error('Unknown option');
    positional.push(arg);
  }
  options.days=Number(options.days);
  if(!Number.isFinite(options.days)||options.days<=0||options.days>365)throw Error('--days must be greater than 0 and at most 365');
  options.command=positional[0]||'show';options.target=positional[1];
  if(!['show','why','split'].includes(options.command)||positional.length>2)throw Error('Unknown command or unexpected argument');
  return options;
}
function groupJSON(group) {
  const files=new Map();
  for(const r of group.records){
    if(!files.has(r.file))files.set(r.file,{file:displayPath(r.file),add:0,del:0,lines:[]});
    const f=files.get(r.file);if(r.line){r.side==='old'?f.del++:f.add++;if(r.side==='new')f.lines.push(r.line);}
  }
  return {id:group.id,title:group.intent?.title||(group.id==='ambiguous'?'AMBIGUOUS':'NO AGENT TRACE'),
    attribution:group.attribution,confidence:group.confidence,agent:group.intent?.session.agent||null,
    session:sessionLabel(group.intent?.session.id),requestAt:group.intent?new Date(group.intent.requestAt).toISOString():null,
    resume:group.intent?resume(group.intent.session):null,files:[...files.values()]};
}
function range(nums){
  const values=[...new Set(nums)].sort((a,b)=>a-b),out=[];let first,last;
  for(const n of values){if(first===undefined){first=last=n;}else if(n===last+1)last=n;else{out.push(first===last?''+first:first+'-'+last);first=last=n;}}
  if(first!==undefined)out.push(first===last?''+first:first+'-'+last);
  return out.slice(0,5).join(',')+(out.length>5?',…':'');
}
function resolveWhy(analysis,files,target,old=false){
  if(!target)throw Error('why requires a repository-relative file:line');
  const m=target.match(/^(.*?)(?::([0-9]+))?$/),name=norm(m[1]).replace(/^\.\//,'');
  let matches=[...files.keys()].filter(f=>norm(f)===name);
  if(!matches.length)matches=[...files.keys()].filter(f=>norm(f).endsWith('/'+name));
  if(matches.length!==1)throw Error(matches.length?'AMBIGUOUS_FILE: use the full repository-relative path':'File is not dirty');
  const file=matches[0],line=m[2]?+m[2]:null;
  if(m[2]&&line<1)throw Error('Line numbers start at 1');
  const side=old||files.get(file).status==='D'?'old':'new';
  return analysis.records.filter(r=>r.file===file&&(!line||(r.side===side&&r.line===line)));
}
async function main(argv=process.argv.slice(2)){
  const opt=parseArgs(argv);
  if(opt.help||opt.h){console.log('wipwho v0.1 — conversation-level provenance estimation\n\nwipwho [--repo DIR] [--days N] [--json] [--no-cache] [--profile]\nwipwho why file:line [--old] [--json]\nwipwho split --out NEW-DIRECTORY [--text-only] [--json]\n\nRead-only source repository. No network, stage, commit, reset or restore.\nMEDIUM is an estimate; LOW is unresolved. Full prompts and commands are withheld.');return;}
  const begin=performance.now();
  let repo;try{repo=fs.realpathSync(git(path.resolve(opt.repo||process.cwd()),['rev-parse','--show-toplevel']).trim());}catch{throw Error('Not a Git working repository');}
  const snapshot=readDirty(repo);
  if(!snapshot.files.size){console.log(opt.json?JSON.stringify({version:'0.1.0',groups:[],status:'CLEAN'}):'Working tree is clean.');return;}
  const logs=await scan({repo,dirtyNorm:new Map([...snapshot.files.keys()].map(n=>[norm(n),n])),sinceMs:Date.now()-opt.days*86400000,noCache:opt['no-cache']});
  const start=performance.now(),analysis=analyze(snapshot,logs);
  const profile={gitMs:Math.round(snapshot.elapsedMs),logsMs:Math.round(logs.stats.elapsedMs),attributionMs:Math.round(performance.now()-start),...logs.stats};
  if(opt.command==='why'){
    const found=resolveWhy(analysis,snapshot.files,opt.target,opt.old).map(publicRecord);
    if(opt.json)console.log(JSON.stringify({version:'0.1.0',lines:found},null,2));
    else if(!found.length)console.log('That is not a changed line on the selected side. Use --old for a removed line.');
    else for(const r of found){
      console.log('\n'+r.file+(r.line?':'+r.line:'')+' ['+r.side+']');
      console.log(r.attribution+' / confidence '+r.confidence);
      console.log('Agent: '+(r.agent||'unknown')+' | session: '+(r.session||'unknown'));
      console.log('Intent: '+(r.requestSummary||'Unknown; a matching candidate is not confirmed provenance.'));
      console.log('Requested: '+(r.requestAt||'unknown')+' | edit: '+(r.timestamp||'unknown'));
      console.log('Evidence: '+Object.entries(r.evidence).map(([k,v])=>k+'='+v).join('; '));
      if(r.candidates.length)console.log('Candidate requests: '+r.candidates.map(c=>c.intent+' ('+c.agent+')').join(', '));
      console.log('Resume: '+(r.resume||'unknown'));
    }
  }else if(opt.command==='split'){
    if(!opt.out)throw Error('split requires --out NEW-DIRECTORY');
    const t=performance.now(),plan=split(snapshot,analysis,opt.out,{textOnly:opt['text-only']});profile.splitMs=Math.round(performance.now()-t);
    if(opt.json)console.log(JSON.stringify(plan,null,2));
    else console.log('Verified '+plan.patches.length+' sequential patches; '+plan.hashes.length+'/'+plan.hashes.length+' file hashes match.\nOmitted files: '+plan.omitted.length+'. Omitted/extra changed lines in included files: 0/0.\nReview commit-plan.md and commit-plan.json in the requested output directory. Source repository unchanged.');
  }else{
    const groups=analysis.groups.map(groupJSON);
    if(opt.json)console.log(JSON.stringify({version:'0.1.0',files:snapshot.files.size,groups,warnings:['Conversation-level estimates, not recorded authorship. Identical rewrites inside a tool interval cannot be distinguished.']},null,2));
    else{
      console.log('wipwho v0.1 · '+snapshot.files.size+' dirty files · estimated provenance');
      for(const group of groups){
        console.log('\n'+group.title+' ['+group.confidence+']'+(group.agent?' · '+group.agent+' · '+group.id:''));
        if(group.requestAt)console.log('  requested '+group.requestAt+' · session '+group.session);
        for(const f of group.files.slice(0,opt.all?undefined:12))console.log('  '+f.file+(f.lines.length?':'+range(f.lines):'')+'  +'+f.add+' -'+f.del);
        if(!opt.all&&group.files.length>12)console.log('  … '+(group.files.length-12)+' more files (--all)');
        if(group.resume)console.log('  '+group.resume);
      }
      console.log('\nNO AGENT TRACE means no usable evidence was found, not proof of human authorship.\nAMBIGUOUS/LOW remains unresolved; time-only command matches never establish ownership.');
    }
  }
  profile.totalMs=Math.round(performance.now()-begin);
  if(opt.profile)console.error(JSON.stringify({profile}));
}
if(require.main===module)main().catch(e=>{const message=/^(UNSAFE_TO_SPLIT:|AMBIGUOUS_FILE:|Missing |Unknown |--days |why requires|File is not dirty|Line numbers|Not a Git|split requires|A committed|DIFF_)/.test(e.message)?e.message:'Operation failed safely; no attribution result was produced ('+(e.code||'validation error')+').';console.error('wipwho: '+message);process.exitCode=e.message.startsWith('UNSAFE_TO_SPLIT:')?3:2;});
module.exports={main,parseArgs,resolveWhy,groupJSON};
