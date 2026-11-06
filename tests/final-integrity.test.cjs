const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Queue,DEFAULTS,clone,sha256,finalContent,matchesFinal}=require('../src/core');
const RAW='完整原文：今天和朋友去出游。记录交通、午餐和回家的详细过程。所有细节都应保留。';
class Vault {
  constructor(){this.files=new Map();this.folders=new Map();this.contents=new Map();}
  add(path,body){const bytes=Buffer.from(body),file={path,name:path.split('/').pop(),stat:{size:bytes.length,mtime:1,ctime:1}};this.files.set(path,file);this.contents.set(path,bytes);return file;}
  getFiles(){return [...this.files.values()];}
  getAbstractFileByPath(path){return this.files.get(path)||this.folders.get(path);}
  async createFolder(path){if(this.getAbstractFileByPath(path))throw Error('exists');this.folders.set(path,{path,children:[]});}
  async read(file){return this.contents.get(file.path).toString();}
  async readBinary(file){const b=this.contents.get(file.path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.length);}
  async create(path,body){if(this.getAbstractFileByPath(path))throw Error('exists');return this.add(path,body);}
}
function fixture({vault=new Vault(),state={enabled:true,initialized:true,jobs:{}}}={}) {
  const config={...clone(DEFAULTS)},snapshots=[];let now=100000,asr=0,api=0,closed=false;
  const queue=new Queue({vault,state,config:()=>config,save:async()=>{snapshots.push(clone(state));},closed:()=>closed,now:()=>now,
    transcribe:async()=>{asr++;return RAW;},llm:{complete:async()=>{api++;throw Error('unexpected API');}}});
  return {vault,state,queue,snapshots,advance:()=>{now+=61000;},stop:()=>{closed=true;},counts:()=>({asr,api})};
}
async function run(h){await h.queue.tick();h.advance();await h.queue.tick();}
const audio=h=>h.vault.add(`${DEFAULTS.folder}/voice-2026-12-13-120000-id.webm`,'synthetic original recording');
const truncated=body=>body.slice(0,body.lastIndexOf('\n\n')+3);

for(const reject of [false,true])test(`a truncated final with a complete marker cannot commit after create ${reject?'rejects':'resolves'}`,async()=>{
  const h=fixture(),f=audio(h);let partial,path,creates=0;
  h.vault.create=async(target,body)=>{
    creates++;path=target;partial=truncated(body);
    const persisted=h.snapshots.at(-1).jobs[f.path];
    assert.equal(persisted.output,target);assert.equal(persisted.pendingFinal.path,target);
    assert.equal(persisted.pendingFinal.sha256,await sha256(body));
    const result=h.vault.add(target,partial);if(reject)throw Error('partial write followed by rejection');return result;
  };
  await run(h);const job=h.state.jobs[f.path];
  assert.equal(matchesFinal(partial,job.sha),true,'fixture reproduces the former marker-only false positive');
  assert.equal(job.status,'error');assert.equal(job.errorCode,'save');assert.equal(job.raw,RAW);assert.equal(job.corrected,RAW);
  assert.equal(job.output,undefined);assert.deepEqual(job.incompleteOutputs,[path]);assert.equal(creates,1);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(path)),partial);
  const saved=h.snapshots.at(-1).jobs[f.path];assert.equal(saved.raw,RAW);assert.deepEqual(saved.incompleteOutputs,[path]);
  h.vault.create=Vault.prototype.create.bind(h.vault);
  const resumed=fixture({vault:h.vault,state:clone(h.snapshots.at(-1))});await resumed.queue.retry();await run(resumed);
  const next=resumed.state.jobs[f.path];assert.equal(next.status,'done');assert.notEqual(next.output,path);assert.ok(next.output.endsWith('-2.md'));
  assert.ok((await h.vault.read(h.vault.getAbstractFileByPath(next.output))).includes(RAW));
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(path)),partial);assert.deepEqual(resumed.counts(),{asr:0,api:0});
});

test('process death after a partial write is rejected using the persisted pending digest before any exclusion could be saved',async()=>{
  const h=fixture(),f=audio(h);let path,partial;
  h.vault.create=async(target,body)=>{path=target;partial=truncated(body);h.vault.add(target,partial);h.stop();throw Error('simulated process death');};
  await run(h);const persisted=clone(h.snapshots.at(-1)),pending=persisted.jobs[f.path];
  assert.equal(pending.status,'committing');assert.equal(pending.output,path);assert.ok(pending.pendingFinal.sha256);assert.equal(pending.incompleteOutputs,undefined);
  h.vault.create=Vault.prototype.create.bind(h.vault);
  const resumed=fixture({vault:h.vault,state:persisted});await run(resumed);const next=resumed.state.jobs[f.path];
  assert.equal(next.status,'done');assert.notEqual(next.output,path);assert.deepEqual(next.incompleteOutputs,[path]);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(path)),partial);
  assert.ok((await h.vault.read(h.vault.getAbstractFileByPath(next.output))).includes(RAW));assert.deepEqual(resumed.counts(),{asr:0,api:0});
});

test('a full final followed by a rejected create is verified and reused without another file',async()=>{
  const h=fixture(),f=audio(h);let creates=0,full;
  h.vault.create=async(path,body)=>{creates++;full=body;h.vault.add(path,body);throw Error('saved but reply lost');};
  await run(h);const job=h.state.jobs[f.path];assert.equal(job.status,'done');assert.equal(creates,1);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(job.output)),full);assert.equal(job.raw,undefined);assert.equal(job.corrected,undefined);
  assert.equal(h.vault.getFiles().filter(file=>file.path.endsWith('.md')).length,1);
});

test('legacy unfinished checkpoints without a pending digest still validate their complete saved correction',async()=>{
  const h=fixture(),f=audio(h),path=`${DEFAULTS.finalFolder}/old-transcript.md`;
  const job=h.state.jobs[f.path]={path:f.path,id:'legacy-pending',sha:await sha256('synthetic original recording'),status:'committing',output:path,raw:RAW,corrected:RAW,stage:'local_transcribed'};
  const partial=truncated(finalContent(job));h.vault.add(path,partial);await run(h);
  assert.equal(job.status,'done');assert.notEqual(job.output,path);assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(path)),partial);
  assert.ok((await h.vault.read(h.vault.getAbstractFileByPath(job.output))).includes(RAW));assert.deepEqual(h.counts(),{asr:0,api:0});
});

test('completed notes remain editable and legacy marker recovery after state loss preserves user changes',async()=>{
  const h=fixture(),f=audio(h);await run(h);const target=h.state.jobs[f.path].output;
  const original=await h.vault.read(h.vault.getAbstractFileByPath(target)),edited=original.replace(RAW,'用户亲自修改的成品日记。');
  h.vault.contents.set(target,Buffer.from(edited));await h.queue.tick();assert.equal(h.state.jobs[f.path].status,'done');
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(target)),edited);
  const recovered=fixture({vault:h.vault});await run(recovered);
  assert.equal(recovered.state.jobs[f.path].status,'done');assert.equal(recovered.state.jobs[f.path].output,target);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(target)),edited);assert.deepEqual(recovered.counts(),{asr:0,api:0});
});

test('audio replacement resets pending and incomplete paths rather than inheriting the previous recording receipt',async()=>{
  const h=fixture(),f=audio(h);h.state.jobs[f.path]={path:f.path,status:'committing',sha:'a'.repeat(64),id:'old-recording',raw:'旧稿',corrected:'旧稿',
    target:`${DEFAULTS.finalFolder}/old-transcript.md`,output:`${DEFAULTS.finalFolder}/old-transcript.md`,pendingFinal:{path:'old',sha256:'b'.repeat(64)},incompleteOutputs:['old-incomplete.md']};
  await run(h);const job=h.state.jobs[f.path];assert.equal(job.status,'done');assert.notEqual(job.id,'old-recording');
  assert.equal(job.incompleteOutputs,undefined);assert.equal(job.pendingFinal,undefined);assert.deepEqual(h.counts(),{asr:1,api:0});
  assert.ok((await h.vault.read(h.vault.getAbstractFileByPath(job.output))).includes(RAW));
});
