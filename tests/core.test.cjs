const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Queue,LlmClient,DiaryError,DEFAULTS,clone,sha256,finalContent,splitText,llmConfig}=require('../src/core');
class Vault {
  constructor(){this.files=new Map();this.folders=new Map();this.contents=new Map();this.time=1;}
  add(path,body){const binary=Buffer.from(body);const f={path,name:path.split('/').pop(),stat:{size:binary.length,mtime:this.time++}};this.files.set(path,f);this.contents.set(path,binary);return f;}
  getFiles(){return [...this.files.values()];}
  getAbstractFileByPath(p){return this.files.get(p)||this.folders.get(p);}
  async createFolder(p){if(this.getAbstractFileByPath(p))throw Error('exists');const f={path:p,children:[]};this.folders.set(p,f);return f;}
  async read(f){return this.contents.get(f.path).toString();}
  async readBinary(f){const b=this.contents.get(f.path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.length);}
  async create(path,body){if(this.files.has(path))throw Error('exists');return this.add(path,body);}
  change(f,body){const b=Buffer.from(body);this.contents.set(f.path,b);Object.assign(f.stat,{size:b.length,mtime:this.time++});}
  rename(f,path){const body=this.contents.get(f.path);this.files.delete(f.path);this.contents.delete(f.path);return this.add(path,body);}
}
function setup(overrides={}) {
  const vault=overrides.vault||new Vault(),state=overrides.state||{enabled:true,initialized:true,jobs:{}};
  let now=100000,asr=0,llm=0,saved=0;
  const config={...clone(DEFAULTS),apiEnabled:true,apiUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',apiKey:'test-secret',model:'qwen3.8-flash'};
  const queue=new Queue({vault,state,config:()=>config,save:async()=>{saved++;},now:()=>now,
    transcribe:async()=>{asr++;return '今天录了一段日记。';},llm:{complete:async()=>{llm++;return '今天，录了一段日记。';}},...overrides});
  return {vault,state,queue,config,advance:(n=31000)=>{now+=n;},counts:()=>({asr,llm,saved})};
}
const addAudio=h=>h.vault.add('Voice Diary/Recordings/voice-test.webm','audio');
async function run(h){await h.queue.tick();h.advance();await h.queue.tick();}

test('natural cleanup sends the unchanged transcript under the selected built-in rules',async()=>{
  const {NATURAL_PROMPT}=require('../src/correction');
  const h=setup(),file=addAudio(h),raw='嗯，明天可能不去，还没决定。不是三百，是三百五十元。';let received;
  h.queue.transcribe=async()=>raw;h.queue.llm.complete=async(_config,text,prompt)=>{received={text,prompt};return raw;};
  await run(h);assert.deepEqual(received,{text:raw,prompt:NATURAL_PROMPT});assert.equal(h.state.jobs[file.path].status,'done');
});

test('long cleanup supplies bounded adjacent raw context while every current chunk is sent exactly once',async()=>{
  const h=setup();addAudio(h);h.config.chunkChars=500;
  const raw='甲'.repeat(500)+'乙'.repeat(500)+'丙'.repeat(500),sent=[];h.queue.transcribe=async()=>raw;
  h.queue.llm.complete=async(_config,text,prompt)=>{sent.push({text,reference:JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1))});return '模型生成片段'+sent.length;};
  await run(h);assert.equal(sent.length,3);assert.equal(sent.map(x=>x.text).join(''),raw);
  assert.deepEqual(sent[0].reference,{前文:'',后文:'乙'.repeat(300)});
  assert.deepEqual(sent[1].reference,{前文:'甲'.repeat(300),后文:'丙'.repeat(300)});
  assert.deepEqual(sent[2].reference,{前文:'乙'.repeat(300),后文:''});
  assert.ok(!JSON.stringify(sent.map(x=>x.reference)).includes('模型生成'));
});

test('cleanup mode and context protocol stay pinned across a partial retry and restart',async()=>{
  const {NATURAL_PROMPT}=require('../src/correction'),h=await partialJob();
  const resumed=setup({state:clone(h.state),vault:h.vault});resumed.config.correctionMode='faithful';resumed.config.prompt='新自定义';
  const requests=[];resumed.queue.llm.complete=async(_config,text,prompt)=>{requests.push(prompt);return text;};resumed.advance(92000);await run(resumed);
  assert.equal(resumed.state.jobs[h.file.path].status,'done');assert.ok(requests.length>0);
  assert.ok(requests.every(prompt=>prompt.startsWith(NATURAL_PROMPT)&&prompt.includes('相邻原文参考')));assert.equal(resumed.counts().asr,0);
});

test('legacy partial checkpoints keep their exact old prompt protocol and paragraph joining',async()=>{
  const h=await partialJob(),job=h.state.jobs[h.file.path];delete job.correctionConfig.contextVersion;job.correctionConfig.prompt='旧自定义规则';
  const requests=[];h.queue.llm.complete=async(_config,text,prompt)=>{requests.push(prompt);return text;};h.advance(61000);await h.queue.tick();
  assert.ok(requests.length>0);assert.ok(requests.every(prompt=>prompt==='旧自定义规则\n输入是长录音的一个连续片段；保留片段内容及未完句，不补写开头结尾。'));
  assert.ok((await h.vault.read(h.vault.getAbstractFileByPath(job.output))).includes('OLD-FIRST-CHUNK\n\n'));assert.equal(job.status,'done');
});

test('a size boundary inside an unpunctuated transcript does not invent a paragraph or duplicate context',async()=>{
  const h=setup(),file=addAudio(h);h.config.chunkChars=500;const raw='今天继续记录项目的实现细节'.repeat(120);
  h.queue.transcribe=async()=>raw;h.queue.llm.complete=async(_config,text)=>text;await run(h);
  const body=await h.vault.read(h.vault.getAbstractFileByPath(h.state.jobs[file.path].output));assert.ok(body.includes(raw));
});

test('custom cleanup preserves its prompt and original protocol even for long text',async()=>{
  const h=setup();addAudio(h);h.config.correctionMode='custom';h.config.prompt='用户自己的完整要求';h.config.chunkChars=500;
  h.queue.transcribe=async()=> '甲'.repeat(1100);const sent=[];h.queue.llm.complete=async(_config,text,prompt)=>{sent.push(prompt);return text;};await run(h);
  assert.equal(sent.length,3);assert.ok(sent.every(x=>x==='用户自己的完整要求\n输入是长录音的一个连续片段；保留片段内容及未完句，不补写开头结尾。'));
});
test('initial baseline and content-identical renamed baseline do not call ASR or Qwen',async()=>{
  const h=setup({state:{enabled:false,jobs:{}}}),f=addAudio(h);
  await h.queue.arm(true);assert.equal(h.state.jobs[f.path].status,'ignored');
  h.vault.rename(f,'Voice Diary/Recordings/renamed.webm');await run(h);
  assert.equal(h.counts().asr,0);assert.equal(h.counts().llm,0);
});
test('growing synced file restarts 30 second observation and processes only once',async()=>{
  const h=setup(),f=addAudio(h);await h.queue.tick();h.advance(25000);h.vault.change(f,'longer audio');await h.queue.tick();
  h.advance(25000);await h.queue.tick();assert.equal(h.counts().asr,0);h.advance(6000);await h.queue.tick();
  await h.queue.tick();assert.equal(h.counts().asr,1);assert.equal(h.counts().llm,1);
  const j=h.state.jobs[f.path];assert.equal(j.status,'done');assert.match(await h.vault.read(h.vault.getAbstractFileByPath(j.output)),/voice_diary_stage: qwen_corrected/);
  assert.ok(h.vault.getAbstractFileByPath(f.path));assert.equal(h.vault.getFiles().length,2);
});
test('ASR checkpoint survives Qwen failure and restart without repeated transcription',async()=>{
  const h=setup(),f=addAudio(h);h.queue.llm.complete=async()=>{throw new DiaryError('network','网络失败');};await run(h);
  const persisted=clone(h.state);assert.equal(persisted.jobs[f.path].raw,'今天录了一段日记。');
  const restarted=setup({state:persisted,vault:h.vault});restarted.advance(92000);await run(restarted);
  assert.equal(restarted.counts().asr,0);assert.equal(restarted.counts().llm,1);assert.equal(restarted.state.jobs[f.path].status,'done');
});
test('successful Qwen checkpoint survives final-save failure and restart without another API call',async()=>{
  const h=setup(),f=addAudio(h),create=h.vault.create.bind(h.vault);h.vault.create=async()=>{throw Error('disk full');};
  await run(h);assert.ok(h.state.jobs[f.path].corrected);assert.equal(h.state.jobs[f.path].status,'retry_wait');h.vault.create=create;
  const restarted=setup({state:clone(h.state),vault:h.vault});restarted.advance(92000);await run(restarted);
  assert.equal(restarted.counts().asr,0);assert.equal(restarted.counts().llm,0);assert.equal(restarted.state.jobs[f.path].status,'done');
});
test('commit is recovered from final metadata after state loss and audio rename',async()=>{
  const h=setup(),f=addAudio(h);await run(h);const out=h.state.jobs[f.path].output;
  h.vault.rename(f,'Voice Diary/Recordings/re-synced.webm');const restarted=setup({vault:h.vault});await run(restarted);
  assert.equal(restarted.counts().asr,0);assert.equal(restarted.counts().llm,0);assert.equal(restarted.state.jobs['Voice Diary/Recordings/re-synced.webm'].output,out);
});
test('historical transcript and mobile note are never overwritten or deleted',async()=>{
  const h=setup(),f=addAudio(h);const path=f.path.replace('.webm','-transcript.md');h.vault.add(path,'我修改过的历史稿');h.vault.add(f.path.replace('.webm','.md'),'手机手写内容');
  await run(h);assert.equal(h.state.jobs[f.path].status,'error');assert.equal(h.counts().asr,0);assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(path)),'我修改过的历史稿');assert.equal(h.vault.getFiles().length,3);
});
test('concurrent final creation preserves the competing note and saves with transcript suffix',async()=>{
  const h=setup(),f=addAudio(h),create=h.vault.create.bind(h.vault);let raced=false;
  h.vault.create=async(path,body)=>{if(!raced){raced=true;h.vault.add(path,'另一个窗口的内容');throw Error('exists');}return create(path,body);};
  await run(h);const j=h.state.jobs[f.path];assert.equal(j.status,'done');assert.match(j.output,/-2-transcript.md$/);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(`${DEFAULTS.finalFolder}/voice-test-transcript.md`)),'另一个窗口的内容');
});
test('an adapter rejection after the final write recovers the one saved note without another copy',async()=>{
  const h=setup(),f=addAudio(h),create=h.vault.create.bind(h.vault);let creates=0;
  h.vault.create=async(path,body)=>{const result=await create(path,body);creates++;if(creates===1)throw Error('adapter rejected after writing');return result;};
  await run(h);const j=h.state.jobs[f.path];assert.equal(j.status,'done');assert.equal(j.output,`${DEFAULTS.finalFolder}/voice-test-transcript.md`);
  assert.equal(creates,1);assert.equal(h.vault.getFiles().filter(f=>f.path.endsWith('.md')).length,1);
  assert.match(await h.vault.read(h.vault.getAbstractFileByPath(j.output)),/今天，录了一段日记。/);
  assert.deepEqual({asr:h.counts().asr,llm:h.counts().llm},{asr:1,llm:1});
});
test('a competing marked final for the same recording is recovered and preserved after create rejects',async()=>{
  const h=setup(),f=addAudio(h);let creates=0,existingBody;
  h.vault.create=async(path)=>{creates++;existingBody=finalContent({...h.state.jobs[f.path],id:'recovered-job',corrected:'已经核对的现有成品'});h.vault.add(path,existingBody);throw Error('concurrent creation');};
  await run(h);const j=h.state.jobs[f.path];assert.equal(j.status,'done');assert.equal(creates,1);
  assert.equal(j.output,`${DEFAULTS.finalFolder}/voice-test-transcript.md`);assert.equal(h.vault.getFiles().filter(f=>f.path.endsWith('.md')).length,1);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(j.output)),existingBody);
});
test('a competing marked final with a different source hash is preserved while this recording gets a suffix',async()=>{
  const h=setup(),f=addAudio(h),create=h.vault.create.bind(h.vault);let creates=0,existingBody;
  h.vault.create=async(path,body)=>{creates++;if(creates===1){existingBody=finalContent({...h.state.jobs[f.path],sha:'f'.repeat(64),corrected:'另一段录音的成品'});h.vault.add(path,existingBody);throw Error('concurrent creation');}return create(path,body);};
  await run(h);const j=h.state.jobs[f.path];assert.equal(j.status,'done');assert.equal(creates,2);assert.match(j.output,/-2-transcript.md$/);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(`${DEFAULTS.finalFolder}/voice-test-transcript.md`)),existingBody);
  assert.match(await h.vault.read(h.vault.getAbstractFileByPath(j.output)),/今天，录了一段日记。/);
});
test('audio changed during Qwen does not commit stale text, and restarts ASR after stable',async()=>{
  const h=setup(),f=addAudio(h);h.queue.llm.complete=async()=>{h.vault.change(f,'changed recording');return '校对结果';};
  await run(h);assert.equal(h.state.jobs[f.path].status,'observed');assert.equal(h.state.jobs[f.path].raw,undefined);
  assert.equal(h.vault.getFiles().length,1);
  h.queue.llm.complete=async()=>'新的校对结果';await run(h);assert.equal(h.counts().asr,2);assert.equal(h.state.jobs[f.path].status,'done');
});
test('partial long-note retry resumes from next chunk and preserves the full input',async()=>{
  const h=setup(),f=addAudio(h),text='第一段日记。'.repeat(300);h.config.chunkChars=500;let calls=0;
  h.queue.transcribe=async()=>text;
  h.queue.llm.complete=async(_c,t)=>{calls++;if(calls===2)throw new DiaryError('network','网络失败');return t;};await run(h);
  const j=h.state.jobs[f.path];assert.equal(j.parts.length,1);assert.equal(j.chunks.join(''),text);
  let resumed=0;h.queue.llm.complete=async(_c,t)=>{resumed++;return t;};h.advance(90000);await h.queue.tick();assert.equal(resumed,splitText(text,500).length-1);assert.equal(j.status,'done');
});
test('raw API error bodies and credentials never enter saved failure state',async()=>{
  const h=setup(),f=addAudio(h);h.queue.llm=new LlmClient(async()=>({status:401,json:{error:'secret-test-key private diary'}}));await run(h);
  assert.equal(h.state.enabled,false);const j=h.state.jobs[f.path];assert.equal(j.status,'error');assert.ok(!j.error.includes('secret-test-key'));assert.ok(!j.error.includes('private diary'));
});
test('missing API configuration saves a local transcript without pausing or calling the text API',async()=>{
  const h=setup(),f=addAudio(h);h.config.apiKey='';await run(h);assert.equal(h.counts().asr,1);assert.equal(h.counts().llm,0);assert.equal(h.state.enabled,true);assert.equal(h.state.jobs[f.path].status,'done');
  assert.equal(h.state.jobs[f.path].stage,'local_transcribed');
});
test('three retryable failures are bounded; manual retry reuses ASR',async()=>{
  const h=setup(),f=addAudio(h);let attempts=0;h.queue.llm.complete=async()=>{attempts++;throw new DiaryError('network','失败');};
  await run(h);for(let n=0;n<4;n++){h.advance(61000);await h.queue.tick();}assert.equal(attempts,3);assert.equal(h.state.jobs[f.path].status,'error');
  await h.queue.retry();h.queue.llm.complete=async()=>'恢复成功';await h.queue.tick();assert.equal(h.counts().asr,1);assert.equal(h.state.jobs[f.path].status,'done');
});
test('invalid responses never become final text',async()=>{
  for(const response of [{status:200,json:{choices:[{finish_reason:'length',message:{content:'残缺'}}]}},{status:200,json:{choices:[{finish_reason:'stop',message:{content:' '}}]}},{status:200,json:{}},{status:200,json:{choices:[{finish_reason:'content_filter',message:{content:'x'}}]}}]){
    const h=setup(),f=addAudio(h);h.queue.llm=new LlmClient(async()=>response);await run(h);assert.equal(h.state.jobs[f.path].status,'error');assert.equal(h.vault.getFiles().length,1);
  }
});
test('thinking extension is scoped to supported Qwen providers',()=>{
  const base={...DEFAULTS,apiEnabled:true,apiUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',apiKey:'x',model:'qwen3.8-flash'};
  assert.equal(llmConfig(base).body.enable_thinking,false);
  assert.ok(!('enable_thinking' in llmConfig({...base,apiUrl:'https://example.org/v1/chat/completions'}).body));
  assert.ok(!('enable_thinking' in llmConfig({...base,model:'other-model'}).body));
});
test('uncancellable timeout prevents overlapping requests until original settles',async()=>{
  let finish,timeout;
  const client=new LlmClient(()=>new Promise(r=>{finish=r;}),{setTimeout:fn=>{timeout=fn;return 1;},clearTimeout:()=>{}});
  const cfg={...DEFAULTS,apiEnabled:true,apiUrl:'http://localhost:1234/v1/chat/completions',model:'local'};
  const p=client.complete(cfg,'正文','校对');await Promise.resolve();timeout();await assert.rejects(p,e=>e.code==='timeout');
  await assert.rejects(client.complete(cfg,'正文','校对'),e=>e.code==='inflight');
  finish({status:200,json:{choices:[{finish_reason:'stop',message:{content:'完成'}}]}});await client.pending;await Promise.resolve();assert.equal(client.active,false);
});
test('corrected result is not published while paused by unload',async()=>{
  const h=setup(),f=addAudio(h);let closed=false;h.queue.closed=()=>closed;
  h.queue.llm.complete=async()=>{closed=true;return '校对完成';};await run(h);
  assert.equal(h.vault.getFiles().length,1);assert.ok(h.state.jobs[f.path].corrected);
});
test('manual retry may fix invalid model if no corrected chunk was saved',async()=>{
  const h=setup(),f=addAudio(h);h.queue.llm.complete=async()=>{throw new DiaryError('config','模型错误',{pause:true});};await run(h);
  h.config.model='qwen-flash';await h.queue.retry();await h.queue.arm(true);
  h.queue.llm.complete=async cfg=>{assert.equal(cfg.model,'qwen-flash');return '完成';};await h.queue.tick();assert.equal(h.state.jobs[f.path].status,'done');
});
test('chunk splitting retains every code unit including emoji on chunk boundaries',()=>{
  const text='文'.repeat(499)+'😀'+'末尾'.repeat(800);const parts=splitText(text,500);assert.equal(parts.join(''),text);
  for(const part of parts)assert.ok(!/[\uD800-\uDBFF]$/.test(part));
});
test('explicit historical selection overrides ignored duplicate baselines without bulk processing history',async()=>{
  const h=setup({state:{enabled:false,jobs:{}}}),chosen=addAudio(h);
  const duplicate=h.vault.add('Voice Diary/Recordings/duplicate.webm','audio');
  await h.queue.arm(true);await h.queue.enqueue(chosen);await run(h);
  assert.equal(h.state.jobs[chosen.path].status,'done');assert.equal(h.state.jobs[duplicate.path].status,'ignored');assert.equal(h.counts().asr,1);assert.equal(h.counts().llm,1);
});
test('changing endpoint after partial correction never sends a rotated key to the saved old endpoint',async()=>{
  const h=setup(),file=addAudio(h);h.config.chunkChars=500;
  h.queue.transcribe=async()=> '原始文字。'.repeat(300);
  let calls=0;
  h.queue.llm.complete=async()=>{calls++;if(calls===2)throw new DiaryError('network','网络失败');return 'OLD-FIRST-CHUNK';};
  await run(h);assert.equal(h.state.jobs[file.path].parts.length,1);
  h.config.apiUrl='https://new-provider.example/v1/chat/completions';h.config.apiKey='ROTATED-KEY';
  const sent=[];h.queue.llm.complete=async cfg=>{sent.push(cfg);return 'NEW-CHUNK';};h.advance(61000);await h.queue.tick();
  assert.equal(sent.length,0);assert.equal(h.state.jobs[file.path].status,'error');assert.equal(h.state.jobs[file.path].errorCode,'correction-config');
});
async function partialJob() {
  const h=setup(),file=addAudio(h);h.config.chunkChars=500;let transcriptions=0,calls=0;
  h.queue.transcribe=async()=>{transcriptions++;return '原始文字。'.repeat(300);};
  h.queue.llm.complete=async()=>{calls++;if(calls===2)throw new DiaryError('network','网络失败');return 'OLD-FIRST-CHUNK';};
  await run(h);return {...h,file,transcriptions:()=>transcriptions};
}
test('explicit restart under the new provider retains ASR but recomputes every corrected chunk consistently',async()=>{
  const h=await partialJob();h.config.apiUrl='https://new-provider.example/v1/chat/completions';h.config.apiKey='ROTATED-KEY';
  h.advance(61000);await h.queue.tick();assert.equal(h.state.jobs[h.file.path].errorCode,'correction-config');
  const raw=h.state.jobs[h.file.path].raw;
  h.state.jobs['unrelated']={path:'unrelated',status:'error',errorCode:'network',raw:'其他任务原文',parts:['保留片段']};
  const count=await h.queue.restartChangedCorrections();assert.equal(count,1);assert.equal(h.state.jobs[h.file.path].raw,raw);
  assert.deepEqual(h.state.jobs.unrelated.parts,['保留片段']);assert.equal(h.state.jobs.unrelated.status,'error');
  const sent=[];h.queue.llm.complete=async cfg=>{sent.push(cfg);return 'NEW-CHUNK';};await h.queue.tick();
  const j=h.state.jobs[h.file.path];assert.equal(j.status,'done');assert.equal(h.transcriptions(),1);
  assert.equal(sent.length,splitText(raw,500).length);assert.ok(sent.every(c=>c.apiUrl===h.config.apiUrl&&c.apiKey==='ROTATED-KEY'));
  const body=await h.vault.read(h.vault.getAbstractFileByPath(j.output));assert.ok(!body.includes('OLD-FIRST-CHUNK'));
});
test('changing model between chunks blocks the next API call within the same queue run',async()=>{
  const h=setup(),file=addAudio(h);h.config.chunkChars=500;h.queue.transcribe=async()=> '原始文字。'.repeat(300);let calls=0;
  h.queue.llm.complete=async()=>{calls++;h.config.model='new-model';return '第一段';};await run(h);
  assert.equal(calls,1);assert.equal(h.state.jobs[file.path].errorCode,'correction-config');assert.equal(h.state.jobs[file.path].parts.length,1);
});
test('switching provider before any corrected chunk exists adopts current settings without redoing ASR',async()=>{
  const h=setup(),file=addAudio(h);h.queue.llm.complete=async()=>{throw new DiaryError('network','网络失败');};await run(h);
  h.config.apiUrl='https://new-provider.example/v1/chat/completions';h.config.apiKey='NEW-KEY';
  const sent=[];h.queue.llm.complete=async cfg=>{sent.push(cfg);return '已恢复';};h.advance(61000);await h.queue.tick();
  assert.equal(h.counts().asr,1);assert.equal(sent[0].apiUrl,h.config.apiUrl);assert.equal(h.state.jobs[file.path].status,'done');
});
test('rotating a key for the same endpoint can resume existing corrected chunks',async()=>{
  const h=await partialJob(),j=h.state.jobs[h.file.path];h.config.apiKey='ROTATED-SAME-PROVIDER';const previousParts=j.parts.length,raw=j.raw;
  const sent=[];h.queue.llm.complete=async cfg=>{sent.push(cfg);return '后续片段';};h.advance(61000);await h.queue.tick();
  assert.equal(j.status,'done');assert.equal(sent.length,splitText(raw,500).length-previousParts);assert.ok(sent.every(c=>c.apiKey==='ROTATED-SAME-PROVIDER'));assert.equal(h.transcriptions(),1);
});
test('restoring the original endpoint permits ordinary retry with the saved first chunk',async()=>{
  const h=await partialJob(),original=h.config.apiUrl,j=h.state.jobs[h.file.path];h.config.apiUrl='https://new.example/v1/chat/completions';h.advance(61000);await h.queue.tick();
  assert.equal(j.errorCode,'correction-config');h.config.apiUrl=original;await h.queue.retry();h.queue.llm.complete=async()=> '恢复后续片段';await h.queue.tick();
  assert.equal(j.status,'done');const body=await h.vault.read(h.vault.getAbstractFileByPath(j.output));assert.ok(body.includes('OLD-FIRST-CHUNK'));assert.equal(h.transcriptions(),1);
});
test('default storage separates audio from the finished note and preserves its source embed',async()=>{
  const h=setup(),file=addAudio(h);await run(h);const job=h.state.jobs[file.path];
  assert.equal(job.output,'Voice Diary/Notes/voice-test-transcript.md');assert.ok(h.vault.folders.has('Voice Diary/Notes'));
  const body=await h.vault.read(h.vault.getAbstractFileByPath(job.output));
  assert.ok(body.includes(`source_audio: ${JSON.stringify(file.path)}`));assert.ok(body.includes(`![[${file.path}]]`));
  assert.ok(h.vault.getAbstractFileByPath(file.path));assert.equal(h.vault.getAbstractFileByPath('Voice Diary/Recordings/voice-test-transcript.md'),undefined);
});
test('custom Chinese nested output folders are created without changing the original audio path',async()=>{
  const h=setup(),file=addAudio(h);h.config.finalFolder='笔记 成品/日记/语音';await run(h);
  assert.equal(h.state.jobs[file.path].output,'笔记 成品/日记/语音/voice-test-transcript.md');
  assert.ok(h.vault.folders.has('笔记 成品'));assert.ok(h.vault.folders.has('笔记 成品/日记/语音'));
  assert.equal(h.vault.getAbstractFileByPath(file.path),file);
});
test('changing final folder during a request affects later jobs, while the running job keeps its target',async()=>{
  const h=setup(),file=addAudio(h);h.config.finalFolder='原成品目录';
  h.queue.llm.complete=async()=>{h.config.finalFolder='新成品目录';return '校对结果';};await run(h);
  assert.equal(h.state.jobs[file.path].output,'原成品目录/voice-test-transcript.md');
  const next=h.vault.add('Voice Diary/Recordings/next.webm','another recording');await run(h);
  assert.equal(h.state.jobs[next.path].output,'新成品目录/next-transcript.md');
});
test('save failure followed by restart and a folder edit preserves target without repeating ASR or Qwen',async()=>{
  const h=setup(),file=addAudio(h);h.config.finalFolder='目标 A';const create=h.vault.create.bind(h.vault);
  h.vault.create=async()=>{throw Error('disk full');};await run(h);h.vault.create=create;
  assert.equal(h.state.jobs[file.path].output,'目标 A/voice-test-transcript.md');
  const next=setup({vault:h.vault,state:clone(h.state)});next.config.finalFolder='目标 B';next.advance(92000);await run(next);
  assert.equal(next.state.jobs[file.path].output,'目标 A/voice-test-transcript.md');assert.equal(next.counts().asr,0);assert.equal(next.counts().llm,0);
  assert.equal(h.vault.getAbstractFileByPath('目标 B/voice-test-transcript.md'),undefined);
});
test('legacy interrupted commit keeps its recorded numbered path on upgrade',async()=>{
  const h=setup(),file=addAudio(h),sha=await sha256('audio');
  h.state.jobs[file.path]={path:file.path,status:'committing',sha,raw:'旧转写',corrected:'旧校对',output:'Voice Diary/Recordings/voice-test-7-transcript.md'};
  h.config.finalFolder='新目录';await run(h);
  assert.equal(h.state.jobs[file.path].output,'Voice Diary/Recordings/voice-test-7-transcript.md');assert.equal(h.counts().asr,0);assert.equal(h.counts().llm,0);
});
test('an intermediate output path occupied by a file fails before ASR or API and keeps that file',async()=>{
  const h=setup(),file=addAudio(h);h.config.finalFolder='成品/目录';h.vault.add('成品','用户原有文件');await run(h);
  assert.equal(h.state.jobs[file.path].errorCode,'folder');assert.equal(h.counts().asr,0);assert.equal(h.counts().llm,0);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath('成品')),'用户原有文件');
});
test('a folder created concurrently is accepted only when it is actually a folder',async()=>{
  for(const actualFolder of [true,false]) {
    const h=setup(),file=addAudio(h);h.config.finalFolder='新目录/成品';const mkdir=h.vault.createFolder.bind(h.vault);
    h.vault.createFolder=async p=>{if(p==='新目录/成品'){if(actualFolder)await mkdir(p);else h.vault.add(p,'另一个窗口的文件');throw Error('race');}return mkdir(p);};
    await run(h);assert.equal(h.state.jobs[file.path].status,actualFolder?'done':'error');
    if(!actualFolder){assert.equal(h.counts().asr,0);assert.equal(await h.vault.read(h.vault.getAbstractFileByPath('新目录/成品')),'另一个窗口的文件');}
  }
});
test('existing same-name finished note in the chosen directory is not overwritten or billed again',async()=>{
  const h=setup(),file=addAudio(h);h.config.finalFolder='成品';h.vault.add('成品/voice-test-transcript.md','手写最终稿');await run(h);
  assert.equal(h.state.jobs[file.path].errorCode,'conflict');assert.equal(h.counts().asr,0);assert.equal(h.counts().llm,0);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath('成品/voice-test-transcript.md')),'手写最终稿');
});
test('marked final moved to another folder is recovered despite a different configured output folder',async()=>{
  const h=setup(),file=addAudio(h);await run(h);const output=h.vault.getAbstractFileByPath(h.state.jobs[file.path].output);
  h.vault.rename(output,'归档/voice-test-transcript.md');const next=setup({vault:h.vault});next.config.finalFolder='另一个目录';await run(next);
  assert.equal(next.state.jobs[file.path].output,'归档/voice-test-transcript.md');assert.equal(next.counts().asr,0);assert.equal(next.counts().llm,0);
});
test('absolute and traversing output paths are rejected before ASR or API',async()=>{
  for(const finalFolder of ['C:/outside','/outside','../outside','成品/../其他','\\\\server\\share','','.','成品/含?字符']) {
    const h=setup(),file=addAudio(h);h.config.finalFolder=finalFolder;await run(h);
    assert.equal(h.state.jobs[file.path].errorCode,'folder',finalFolder);assert.equal(h.counts().asr,0);assert.equal(h.counts().llm,0);
  }
});
test('an unfinished task outside the newly watched audio folder still resumes from its checkpoint',async()=>{
  const h=setup(),file=addAudio(h);h.queue.llm.complete=async()=>{throw new DiaryError('network','网络失败');};await run(h);
  h.config.folder='新的录音目录';h.queue.llm.complete=async()=> '恢复成功';h.advance(61000);await h.queue.tick();
  assert.equal(h.state.jobs[file.path].status,'done');assert.equal(h.counts().asr,1);
});
test('same audio basename in different source folders conflicts safely in the shared output folder',async()=>{
  const h=setup(),one=h.vault.add('Voice Diary/Recordings/A/同名.webm','one'),two=h.vault.add('Voice Diary/Recordings/B/同名.webm','two');
  await run(h);await h.queue.tick();assert.equal(h.state.jobs[one.path].status,'done');assert.equal(h.state.jobs[two.path].errorCode,'conflict');
  assert.equal(h.counts().asr,1);const body=await h.vault.read(h.vault.getAbstractFileByPath(h.state.jobs[one.path].output));assert.ok(body.includes(`![[${one.path}]]`));
});
module.exports={Vault,setup,run,addAudio};
