'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {T,temp,makeFile,patch,codex,claude,scenario}=require('./helpers.cjs');
const {extractPatches,parseLog,scan}=require('../transcripts.cjs');
const {norm,summary}=require('../common.cjs');
const {publicRecord}=require('../attribution.cjs');
const {resolveWhy,parseArgs}=require('../wipwho.cjs');
const fixtureResults=[];
function check(name,run){test(name,()=>{const classification=run();fixtureResults.push({case:name,result:classification});});}
const old='const originalValue = 1;',one='const firstValue = 2;',two='const secondValue = 3;';
check('A Claude-only file',()=>{const x=scenario([makeFile('a.cjs',old+'\n',one+'\n')],r=>[['claude',claude(r,{events:[{added:[one],removed:[old]}]})]]);a.ok(x.analysis.records.every(r=>r.intent?.session.agent==='claude'&&r.confidence==='MEDIUM'));return 'CORRECT';});
check('B Codex-only file and nonzero patch lines',()=>{const x=scenario([makeFile('a.cjs',old+'\n',one+'\n')],r=>[['codex',codex(r,{events:[{added:[one],removed:[old]}]})]]);a.equal(x.scan.edits[0].added.length,1);a.ok(x.analysis.records.every(r=>r.intent?.session.agent==='codex'));return 'CORRECT';});
for(const [label,first,last]of [['C','claude','codex'],['D','codex','claude']])check(label+' sequential agents, different retained lines',()=>{
  const x=scenario([makeFile('a.cjs',null,one+'\n'+two+'\n',T+20500)],r=>[[first,(first==='claude'?claude:codex)(r,{events:[{added:[one],operation:'Add',tool:first==='claude'?'Write':'apply_patch'}]})],[last,(last==='claude'?claude:codex)(r,{events:[{added:[two],at:20000}]})]]);
  a.equal(x.analysis.records[0].intent?.session.agent,first);a.equal(x.analysis.records[1].intent?.session.agent,last);return 'CORRECT';
});
check('E separate lines, separate requests in one file',()=>{const x=scenario([makeFile('a.cjs',null,one+'\n'+two+'\n',T+20500)],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add',prompt:'Add parser'},{added:[two],at:20000,prompt:'Add tests'}]})]]);a.notEqual(x.analysis.records[0].intent.id,x.analysis.records[1].intent.id);return 'CORRECT';});
check('surviving local block remains attributable after another request changes distant lines',()=>{
  const initial=Array.from({length:10},(_,i)=>`const retainedValue${i} = ${i};`),current=[...initial];current[9]='const changedLastValue = 99;';
  const x=scenario([makeFile('a.cjs',null,current.join('\n')+'\n',T+20500)],r=>[['codex',codex(r,{events:[{added:initial,operation:'Add'},{added:[current[9]],removed:[initial[9]],at:20000}]})]]);
  a.equal(x.analysis.records[0].attribution,'ESTIMATED');a.equal(x.analysis.records[0].intent.requestAt,T+9000);a.equal(x.analysis.records[9].intent.requestAt,T+19000);return 'CORRECT';
});
check('F identical line candidates from two agents never use latest wins',()=>{const x=scenario([makeFile('a.cjs',null,one+'\n',T+20500)],r=>[['claude',claude(r,{events:[{tool:'Write',added:[one]}]})],['codex',codex(r,{events:[{added:[one],operation:'Add',at:20000}]})]]);a.equal(x.analysis.records[0].attribution,'AMBIGUOUS');return 'AMBIGUOUS';});
check('G human-equivalent novel addition and later identical rewrite',()=>{const x=scenario([makeFile('a.cjs',null,one+'\n// human-only observation\n',T+50000)],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add'}]})]]);a.equal(x.analysis.records[0].attribution,'AMBIGUOUS');a.equal(x.analysis.records[1].attribution,'NO_AGENT_TRACE');return 'AMBIGUOUS';});
check('H rename source has no fabricated line attribution',()=>{const moved='*** Begin Patch\n*** Update File: a.cjs\n*** Move to: b.cjs\n@@\n-'+old+'\n+'+one+'\n*** End Patch';const x=scenario([makeFile('a.cjs',old+'\n',null),makeFile('b.cjs',null,one+'\n')],r=>[['codex',codex(r,{events:[{source:moved}]})]]);a.equal(x.analysis.records.find(r=>r.file==='a.cjs').attribution,'NO_AGENT_TRACE');a.equal(x.analysis.records.find(r=>r.file==='b.cjs').attribution,'ESTIMATED');return 'AMBIGUOUS';});
check('I explicit successful delete',()=>{const x=scenario([makeFile('a.cjs',old+'\n',null)],r=>[['codex',codex(r,{events:[{operation:'Delete'}]})]]);a.equal(x.analysis.records[0].attribution,'ESTIMATED');return 'CORRECT';});
check('delete followed by recreation cannot explain a later unlogged deletion',()=>{const x=scenario([makeFile('a.cjs',old+'\n',null)],r=>[['codex',codex(r,{events:[{operation:'Delete'},{operation:'Add',added:[old],at:20000}]})]]);a.equal(x.analysis.records[0].attribution,'AMBIGUOUS');return 'AMBIGUOUS';});
check('J new file including punctuation',()=>{const body=['function example() {','  return 12345;','}'];const x=scenario([makeFile('a.cjs',null,body.join('\n')+'\n')],r=>[['codex',codex(r,{events:[{added:body,operation:'Add'}]})]]);a.ok(x.analysis.records.every(r=>r.attribution==='ESTIMATED'));return 'CORRECT';});
check('K binary file is never line-attributed',()=>{const x=scenario([makeFile('a.bin',null,Buffer.from([0,1,2]))],[]);a.equal(x.analysis.records[0].attribution,'NO_AGENT_TRACE');return 'UNTRACEABLE';});
check('L larger than 4 MiB is explicitly omitted',()=>{const x=scenario([makeFile('big.txt',null,'x'.repeat(4*1024*1024+1))],[]);a.equal(x.snapshot.files.get('big.txt').omitted,'LARGE_FILE');a.equal(x.analysis.records[0].attribution,'NO_AGENT_TRACE');return 'UNTRACEABLE';});
check('M mixed CRLF and LF exact lines',()=>{const x=scenario([makeFile('a.cjs',null,one+'\r\n'+two+'\n')],r=>[['codex',codex(r,{events:[{added:[one,two],operation:'Add'}]})]]);a.ok(x.analysis.records.every(r=>r.attribution==='ESTIMATED'));return 'CORRECT';});
check('N subagent fork cannot steal parent request timeline',()=>{
  const repo=temp(),parent=codex(repo,{id:'parent',events:[{added:[one],operation:'Add',prompt:'Add parser',at:10000}]});
  const child=codex(repo,{id:'child',parent:'parent',metaTime:15000,fork:parent,events:[{added:[two],prompt:'Verify tests',at:20000}]});
  const files=[makeFile('a.cjs',null,one+'\n'+two+'\n',T+20500)];
  // Rebase fixture paths to scenario's temporary root, preserving log topology.
  const x=scenario(files,r=>[['codex',JSON.parse(JSON.stringify(parent).split(JSON.stringify(repo).slice(1,-1)).join(JSON.stringify(r).slice(1,-1)))],['codex',JSON.parse(JSON.stringify(child).split(JSON.stringify(repo).slice(1,-1)).join(JSON.stringify(r).slice(1,-1)))]]);
  a.equal(x.analysis.records[0].intent.session.id,'parent');a.equal(x.analysis.records[1].intent.session.id,'child');a.equal(x.analysis.records[1].intent.session.parent,'parent');return 'CORRECT';
});
check('O resumed session uses the later request',()=>{const x=scenario([makeFile('a.cjs',null,one+'\n'+two+'\n',T+20500)],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add',prompt:'Add parser'},{added:[two],at:20000,prompt:'Verify regression tests'}]})]]);a.equal(x.analysis.records[1].intent.requestAt,T+19000);return 'CORRECT';});
check('continuation is kept with the existing request, not a new intent',()=>{const x=scenario([makeFile('a.cjs',null,one+'\n'+two+'\n',T+20500)],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add',prompt:'Add parser'},{added:[two],at:20000,prompt:'続けて'}]})]]);a.equal(x.analysis.records[0].intent.id,x.analysis.records[1].intent.id);return 'CORRECT';});
for(const delta of [-10000,1200,10000,60000])check('time skew/autosave delay '+delta+'ms is not ownership',()=>{const x=scenario([makeFile('a.cjs',null,one+'\n',T+10000+delta)],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add'}]})]]);a.equal(x.analysis.records[0].attribution,'AMBIGUOUS');return 'AMBIGUOUS';});
check('overlapping background commands never own unmatched content',()=>{const x=scenario([makeFile('a.cjs',null,one+'\n')],r=>[['codex',codex(r,{events:[{tool:'exec_command',source:'node generate.cjs'},{tool:'exec_command',source:'node watch.cjs'}]})]]);a.equal(x.analysis.records[0].attribution,'NO_AGENT_TRACE');return 'UNTRACEABLE';});
check('failed and pending patch calls remain unresolved',()=>{for(const option of [{failed:true},{pending:true}]){const x=scenario([makeFile('a.cjs',null,one+'\n')],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add',...option}]})]]);a.equal(x.analysis.records[0].attribution,'AMBIGUOUS');}return 'AMBIGUOUS';});
check('whitespace difference is not normalized into attribution',()=>{const x=scenario([makeFile('a.cjs',null,'const  firstValue = 2;\n')],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add'}]})]]);a.equal(x.analysis.records[0].attribution,'NO_AGENT_TRACE');return 'UNTRACEABLE';});
test('exec const patch and regex escapes; unused/quoted/dynamic patches ignored',()=>{
  const text=patch('a.cjs',[one],[],'Add');
  a.equal(extractPatches('const $patch = '+JSON.stringify(text)+'; await tools.apply_patch($patch);','exec').length,1);
  a.equal(extractPatches('const patch = '+JSON.stringify(text)+';','exec').length,0);
  a.equal(extractPatches(JSON.stringify('tools.apply_patch('+JSON.stringify(text)+')'),'exec').length,0);
  a.equal(extractPatches('tools.apply_patch(`*** Begin Patch\n${variable}\n*** End Patch`)','exec').length,0);
  a.equal(extractPatches('if(false) await tools.apply_patch('+JSON.stringify(text)+');','exec').length,0);
  a.equal(extractPatches('// await tools.apply_patch('+JSON.stringify(text)+');','exec').length,0);
  a.equal(extractPatches('const fn = async()=>await tools.apply_patch('+JSON.stringify(text)+');','exec').length,0);
  a.equal(extractPatches('let patch = '+JSON.stringify(text)+'; patch="unused"; await tools.apply_patch(patch);','exec').length,0);
});
check('same-byte rewrite inside tool interval is observationally indistinguishable, never HIGH',()=>{
  // These two physical histories have exactly the same retrospective evidence.
  // MEDIUM means a historical content match, not a claim of the final writer.
  const x=scenario([makeFile('a.cjs',null,one+'\n')],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add'}]})]]);
  const record=publicRecord(x.analysis.records[0]);a.equal(record.attribution,'ESTIMATED');a.equal(record.confidence,'MEDIUM');
  return 'AMBIGUOUS';
});
check('future-dated clock cannot establish a current edit',()=>{
  const future=Date.now()+86400000;
  const x=scenario([makeFile('a.cjs',null,one+'\n',future+500)],r=>[['codex',codex(r,{events:[{added:[one],operation:'Add'}]}).map(row=>({...row,timestamp:new Date(future+(Date.parse(row.timestamp)-T-10000)).toISOString()}))]]);
  a.equal(x.analysis.records[0].attribution,'AMBIGUOUS');return 'AMBIGUOUS';
});
check('Claude sidechain keeps its request separate and resumes the parent',()=>{
  const x=scenario([makeFile('a.cjs',null,two+'\n',T+20500)],r=>[['claude',claude(r,{events:[{tool:'Write',added:[one],prompt:'Add parser'}]})],['claude',claude(r,{child:true,events:[{tool:'Write',added:[two],prompt:'Verify tests',at:20000}]})]]);
  const row=publicRecord(x.analysis.records[0]);a.ok(row.session.includes('/sub/'));a.equal(row.resume,'claude --resume cc-session');return 'CORRECT';
});
test('malicious request/session metadata never echoes paths, tokens or commands',()=>{
  const x=scenario([makeFile('a.cjs',null,one+'\n')],r=>[['claude',claude(r,{id:'C:\\Users\\PRIVATE_USER\\secret',events:[{tool:'Write',added:[one],prompt:'Fix parser tests\nTOKEN=sk-abcdefghijklmnopqrst\nrun $danger'}]})]]);
  const output=JSON.stringify(publicRecord(x.analysis.records[0]));
  for(const secret of ['PRIVATE_USER','sk-abcdefghijklmnopqrst','$danger','C:\\\\Users'])a.ok(!output.includes(secret));
});
test('heading-only labels do not hide the substantive request; secrets never become summary',()=>{
  const safe=summary('目的:\nFix parser tests\nsecret=sk-abcdefghijklmnopqrst\nC:\\Users\\private-name\\secrets');
  a.equal(safe,'Fix: tests, parsing, privacy');a.ok(!safe.includes('private-name'));a.ok(!safe.includes('sk-'));
});
test('why rejects ambiguous basenames and returns all required evidence fields',()=>{
  const x=scenario([makeFile('x/a.cjs',null,one+'\n'),makeFile('y/a.cjs',null,two+'\n')],[]);
  a.throws(()=>resolveWhy(x.analysis,x.snapshot.files,'a.cjs:1'),/AMBIGUOUS_FILE/);
  const r=publicRecord(resolveWhy(x.analysis,x.snapshot.files,'x/a.cjs:1')[0]);
  for(const name of ['attribution','confidence','agent','session','requestSummary','timestamp','evidence','resume'])a.ok(name in r);
  a.throws(()=>parseArgs(['--days','NaN']));a.throws(()=>parseArgs(['--days','0']));
});
test('cache validates source content and corruption, works without cache, stores no prompt text',async()=>{
  const repo=temp(),root=temp(),cache=temp(),log=path.join(root,'session.jsonl');
  const make=()=>codex(repo,{events:[{added:[one],operation:'Add',prompt:'Fix parser tests SUPER_PRIVATE_REQUEST'}]}).map(r=>JSON.stringify(r)).join('\n');
  fs.writeFileSync(log,make());const args={repo,dirtyNorm:new Map([['a.cjs','a.cjs']]),sinceMs:0,roots:{codex:root},cacheRoot:cache};
  const cold=await scan(args),warm=await scan(args);a.equal(warm.stats.cacheHits,1);a.deepEqual(warm.edits,cold.edits);
  const cacheFile=path.join(cache,fs.readdirSync(cache)[0]);a.ok(!fs.readFileSync(cacheFile,'utf8').includes('SUPER_PRIVATE_REQUEST'));
  fs.writeFileSync(cacheFile,'broken');const corrupt=await scan(args);a.equal(corrupt.stats.cacheCorrupt,1);a.deepEqual(corrupt.edits,cold.edits);
  const stat=fs.statSync(log);fs.writeFileSync(log,make().replaceAll('firstValue','otherValue'));fs.utimesSync(log,stat.atime,stat.mtime);
  const changed=await scan(args);a.notDeepEqual(changed.edits[0].added,cold.edits[0].added);
  const no=await scan({...args,noCache:true});a.deepEqual(no.edits,changed.edits);
});
test.after(()=>{if(process.env.WIPWHO_TEST_REPORT){fs.writeFileSync(process.env.WIPWHO_TEST_REPORT,JSON.stringify(fixtureResults,null,2)+'\n',{flag:'wx'});}});
