const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Queue,LlmClient,DiaryError,DEFAULTS,clone,apiMode,normalizeApi,requireApi}=require('../src/core');

// Everything is in memory: these cases never read user data or send HTTP.
class Vault {
  constructor(){this.files=new Map();this.folders=new Map();this.contents=new Map();this.time=1;}
  add(path,body){const bytes=Buffer.from(body),file={path,name:path.split('/').pop(),stat:{size:bytes.length,mtime:this.time++}};this.files.set(path,file);this.contents.set(path,bytes);return file;}
  getFiles(){return [...this.files.values()];}
  getAbstractFileByPath(path){return this.files.get(path)||this.folders.get(path);}
  async createFolder(path){if(this.getAbstractFileByPath(path))throw Error('exists');const folder={path,children:[]};this.folders.set(path,folder);return folder;}
  async read(file){return this.contents.get(file.path).toString();}
  async readBinary(file){const bytes=this.contents.get(file.path);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length);}
  async create(path,body){if(this.getAbstractFileByPath(path))throw Error('exists');return this.add(path,body);}
  rename(file,path){const body=this.contents.get(file.path);this.files.delete(file.path);this.contents.delete(file.path);return this.add(path,body);}
}
const configured={apiEnabled:true,apiUrl:'https://example.invalid/v1/chat/completions',apiKey:'test-key',model:'test-model'};
const response=text=>({status:200,json:{choices:[{finish_reason:'stop',message:{content:text}}]}});
function fixture(options={}) {
  const vault=options.vault||new Vault(),state=options.state||{enabled:true,initialized:true,jobs:{}};
  const config={...clone(DEFAULTS),...options.config};
  const raw=options.raw||'今天可能不去，还没决定。\n\n金额是350元，不是500元。';
  let now=100000,asr=0,http=0,saves=0;
  const client=new LlmClient(async request=>{http++;return options.request?options.request(request,http):response('整理结果');},undefined,()=>apiMode(config)==='enabled');
  const queue=new Queue({vault,state,config:()=>config,save:async()=>{saves++;},now:()=>now,
    transcribe:async file=>{asr++;if(options.transcribe)return options.transcribe(file,config);return raw;},llm:client});
  return {vault,state,config,raw,client,queue,advance:(ms=31000)=>{now+=ms;},counts:()=>({asr,http,saves})};
}
const audio=h=>h.vault.add('Voice Diary/Recordings/local-test.webm','mock recording');
async function run(h){await h.queue.tick();h.advance();await h.queue.tick();}
async function finalBody(h,file){const job=h.state.jobs[file.path];assert.equal(job.status,'done');return h.vault.read(h.vault.getAbstractFileByPath(job.output));}
async function assertLocal(h,file,raw=h.raw){const body=await finalBody(h,file);assert.match(body,/^voice_diary_stage: local_transcribed$/m);assert.ok(body.endsWith(`\n\n${raw.trim()}\n`));return body;}

test('empty defaults transcribe locally without HTTP and survive restart deduplication',async()=>{
  const h=fixture(),file=audio(h);assert.equal(DEFAULTS.apiEnabled,false);assert.equal(apiMode(h.config),'disabled');
  await run(h);await assertLocal(h,file);assert.deepEqual({asr:h.counts().asr,http:h.counts().http},{asr:1,http:0});
  assert.equal(h.state.enabled,true);assert.equal(h.state.jobs[file.path].processingMode,'local');
  const restarted=fixture({vault:h.vault,state:clone(h.state)});await run(restarted);
  assert.equal(restarted.counts().asr,0);assert.equal(restarted.counts().http,0);assert.equal(h.vault.getFiles().length,2);
});

for(const code of ['sensevoice_empty','sensevoice_audio_decode'])test(`${code} affects only that recording and the next local recording still completes`,async()=>{
  const h=fixture({transcribe:async file=>{if(file.name==='local-test.webm')throw new DiaryError(code,'本段录音没有可用识别内容',{manual:true,pause:false});return '下一段录音正常。';}}),failed=audio(h),next=h.vault.add('Voice Diary/Recordings/next.webm','next recording');
  await run(h);assert.equal(h.state.jobs[failed.path].status,'error');assert.equal(h.state.jobs[failed.path].errorCode,code);assert.equal(h.state.enabled,true);
  await h.queue.tick();await assertLocal(h,next,'下一段录音正常。');
  assert.deepEqual({asr:h.counts().asr,http:h.counts().http},{asr:2,http:0});assert.ok(h.vault.getAbstractFileByPath(failed.path));assert.equal(h.state.jobs[failed.path].output,undefined);
  await h.queue.tick();assert.equal(h.counts().asr,2);assert.equal(h.state.enabled,true);
});

test('a missing SenseVoice environment pauses automatic processing and keeps later recordings untouched',async()=>{
  const h=fixture({transcribe:async()=>{throw new DiaryError('sensevoice_install','SenseVoice 环境未就绪',{pause:true});}}),failed=audio(h),next=h.vault.add('Voice Diary/Recordings/next.webm','next recording');
  await run(h);assert.equal(h.state.jobs[failed.path].status,'error');assert.equal(h.state.jobs[failed.path].errorCode,'sensevoice_install');assert.equal(h.state.enabled,false);
  await h.queue.tick();assert.equal(h.state.jobs[next.path].status,'observed');assert.deepEqual({asr:h.counts().asr,http:h.counts().http},{asr:1,http:0});
  assert.equal(h.vault.getFiles().filter(f=>f.path.endsWith('.md')).length,0);
});

test('an explicit disabled switch overrides populated URL, model and credentials',async()=>{
  const h=fixture({config:{...configured,apiEnabled:false}}),file=audio(h);await run(h);await assertLocal(h,file);
  assert.equal(h.counts().http,0);assert.equal(h.counts().asr,1);assert.equal(h.state.enabled,true);
  await assert.rejects(h.client.complete(h.config,'private text','rules'),{code:'api-disabled'});assert.equal(h.counts().http,0);
});

for(const missing of ['apiUrl','model','apiKey'])test(`an enabled remote API with missing ${missing} falls back to local without HTTP`,async()=>{
  const h=fixture({config:{...configured,[missing]:'  '}}),file=audio(h);assert.equal(apiMode(h.config),'unconfigured');
  await run(h);await assertLocal(h,file);assert.equal(h.counts().http,0);assert.equal(h.state.enabled,true);
});

test('an explicitly enabled localhost text API may omit the key',async()=>{
  const h=fixture({config:{...configured,apiUrl:'http://127.0.0.1:1234/v1/chat/completions',apiKey:''}}),file=audio(h);
  assert.equal(apiMode(h.config),'enabled');await run(h);assert.equal(h.counts().http,1);assert.match(await finalBody(h,file),/^voice_diary_stage: qwen_corrected$/m);
});

test('legacy populated configuration migrates on, but incomplete and explicit off configurations stay local',()=>{
  const legacy={...configured};delete legacy.apiEnabled;
  assert.equal(normalizeApi(legacy).apiEnabled,true);assert.equal(normalizeApi({...legacy,apiKey:''}).apiEnabled,false);
  assert.equal(normalizeApi({...legacy,apiEnabled:false}).apiEnabled,false);assert.equal(normalizeApi({}).apiEnabled,false);
  assert.throws(()=>requireApi({...configured,apiEnabled:false}),{code:'api-disabled'});
});

test('enabling the API during a local transcription does not upgrade that recording',async()=>{
  const raw='我是在本地模式开始录的，这一段应当完整保留。';
  const h=fixture({config:{...configured,apiEnabled:false},raw,transcribe:async(_file,config)=>{config.apiEnabled=true;return raw;}}),file=audio(h);
  await run(h);assert.equal(h.config.apiEnabled,true);await assertLocal(h,file);assert.equal(h.counts().http,0);
  const next=h.vault.add('Voice Diary/Recordings/next.webm','another recording');await run(h);
  assert.equal(h.counts().http,1);assert.match(await finalBody(h,next),/^voice_diary_stage: qwen_corrected$/m);
});

test('disabling the API during a multi-part response sends no next part and saves the entire raw transcript',async()=>{
  const raw='甲'.repeat(500)+'乙'.repeat(500)+'丙'.repeat(200);let h;
  h=fixture({raw,config:{...configured,chunkChars:500},request:async()=>{h.config.apiEnabled=false;return response('这一片已经改写');}});
  const file=audio(h);await run(h);const body=await assertLocal(h,file);
  assert.equal(h.counts().http,1);assert.ok(!body.includes('这一片已经改写'));assert.equal(h.state.jobs[file.path].processingMode,'local');
});

test('closing the API after a partial failure reuses raw checkpoints after restart without another request',async()=>{
  const raw='开头'.repeat(250)+'后面'.repeat(350),h=fixture({raw,config:{...configured,chunkChars:500},request:async(_request,n)=>{
    if(n===2)throw Error('simulated network failure');return response('第一片改写');
  }}),file=audio(h);await run(h);
  const job=h.state.jobs[file.path];assert.equal(h.counts().http,2);assert.equal(job.parts.length,1);assert.equal(job.raw,raw);
  const resumed=fixture({vault:h.vault,state:clone(h.state),raw,config:{...configured,apiEnabled:false}});resumed.advance(92000);await run(resumed);
  const body=await assertLocal(resumed,file);assert.equal(resumed.counts().asr,0);assert.equal(resumed.counts().http,0);assert.ok(!body.includes('第一片改写'));
});

test('a failed local commit remains local after restart even if the API is now enabled',async()=>{
  const h=fixture(),file=audio(h),create=h.vault.create.bind(h.vault);h.vault.create=async()=>{throw Error('disk full');};await run(h);
  const job=h.state.jobs[file.path];assert.equal(job.status,'retry_wait');assert.equal(job.corrected,h.raw);assert.equal(job.processingMode,'local');
  h.vault.create=create;const resumed=fixture({vault:h.vault,state:clone(h.state),raw:h.raw,config:configured});resumed.advance(92000);await run(resumed);
  await assertLocal(resumed,file);assert.equal(resumed.counts().asr,0);assert.equal(resumed.counts().http,0);
});

test('disabling the API after a fully corrected commit fails preserves the complete correction',async()=>{
  const h=fixture({config:configured}),file=audio(h),create=h.vault.create.bind(h.vault);h.vault.create=async()=>{throw Error('disk full');};await run(h);
  const job=h.state.jobs[file.path];assert.equal(job.corrected,'整理结果');assert.equal(job.stage,'qwen_corrected');assert.equal(h.counts().http,1);
  h.vault.create=create;const resumed=fixture({vault:h.vault,state:clone(h.state),config:{...configured,apiEnabled:false}});resumed.advance(92000);await run(resumed);
  const body=await finalBody(resumed,file);assert.match(body,/^voice_diary_stage: qwen_corrected$/m);assert.ok(body.endsWith('\n\n整理结果\n'));
  assert.equal(resumed.counts().asr,0);assert.equal(resumed.counts().http,0);
});

test('the live client gate rejects an enabled configuration snapshot before any HTTP dispatch',async()=>{
  let requests=0;const client=new LlmClient(async()=>{requests++;return response('result');},undefined,()=>false);
  await assert.rejects(client.complete({...configured},'private transcript','rules'),{code:'api-disabled'});assert.equal(requests,0);assert.equal(client.active,false);
});

test('the live client gate checks again immediately before a scheduled HTTP dispatch',async()=>{
  let allowed=true,requests=0;const client=new LlmClient(async()=>{requests++;return response('result');},undefined,()=>allowed);
  const pending=client.complete({...configured},'private transcript','rules');allowed=false;
  await assert.rejects(pending,{code:'api-disabled'});assert.equal(requests,0);assert.equal(client.active,false);
});

test('enabling the API never rewrites a finished local note, including recovery from lost job state',async()=>{
  const h=fixture(),file=audio(h);await run(h);const body=await assertLocal(h,file),output=h.state.jobs[file.path].output;
  h.config.apiEnabled=true;Object.assign(h.config,configured);await run(h);assert.equal(h.counts().http,0);assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(output)),body);
  const renamed=h.vault.rename(file,'Voice Diary/Recordings/moved.webm'),recovered=fixture({vault:h.vault,config:configured});await run(recovered);
  assert.equal(recovered.state.jobs[renamed.path].output,output);assert.equal(recovered.counts().asr,0);assert.equal(recovered.counts().http,0);
  assert.equal(await recovered.vault.read(recovered.vault.getAbstractFileByPath(output)),body);assert.equal(recovered.vault.getFiles().length,2);
});
