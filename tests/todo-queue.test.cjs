const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Queue,LlmClient,DiaryError,DEFAULTS,clone}=require('../src/core');
const {recordingMetadata,metadataPath}=require('../src/capture');
const {extractLocal,LIMITS}=require('../src/todos');
const {parseTodoNote,matchesTodoNote}=require('../src/todo-notes');
const {todoNotePaths}=require('../src/todo-discovery');
const RID='12345678-1234-4123-8123-123456789abc';
const RAW='明天买牛奶，下周整理资料。';
const capture={mode:'todo',recordingId:RID,recordedAt:Date.parse('2026-11-06T19:59:00.000Z'),localDate:'2026-11-07',localTime:'03:59:00',utcOffsetMinutes:480,timeZone:'Asia/Shanghai'};
class Vault {
  constructor(){this.files=new Map();this.folders=new Map();this.contents=new Map();this.reads=[];this.time=1;}
  add(path,body){const bytes=Buffer.from(body),file={path,name:path.split('/').pop(),stat:{size:bytes.length,mtime:this.time++,ctime:123}};this.files.set(path,file);this.contents.set(path,bytes);return file;}
  getFiles(){return [...this.files.values()];}
  getAbstractFileByPath(path){return this.files.get(path)||this.folders.get(path);}
  async createFolder(path){if(this.getAbstractFileByPath(path))throw Error('exists');this.folders.set(path,{path,children:[]});}
  async read(file){this.reads.push(file.path);return this.contents.get(file.path).toString();}
  async readBinary(file){const bytes=this.contents.get(file.path);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length);}
  async create(path,body){if(this.getAbstractFileByPath(path))throw Error('exists');return this.add(path,body);}
  change(file,body){const bytes=Buffer.from(body);this.contents.set(file.path,bytes);Object.assign(file.stat,{size:bytes.length,mtime:this.time++});}
  remove(path){this.files.delete(path);this.contents.delete(path);}
  rename(file,path){const body=this.contents.get(file.path);this.remove(file.path);return this.add(path,body);}
}
function fixture({vault=new Vault(),state={enabled:true,initialized:true,jobs:{}},settings={}}={}) {
  const config={...clone(DEFAULTS),apiUrl:'https://example.invalid/v1/chat/completions',model:'synthetic',apiKey:'synthetic-test-only',...settings};
  const snapshots=[];let now=Date.parse('2030-01-10T00:00:00Z'),asr=0,api=0,closed=false;
  const queue=new Queue({vault,state,config:()=>config,now:()=>now,closed:()=>closed,save:async()=>snapshots.push(clone(state)),
    transcribe:async()=>{asr++;return RAW;},llm:{complete:async(_cfg,raw)=>{api++;return response(raw);}}});
  return {vault,state,config,queue,snapshots,advance:(ms=31000)=>{now+=ms;},stop:()=>{closed=true;},counts:()=>({asr,api})};
}
function response(raw=RAW){return JSON.stringify({...extractLocal(raw,capture),items:extractLocal(raw,capture).items.map(({method,...item})=>item)});}
async function addTodo(h,{path=`${DEFAULTS.folder}/todo-2026-11-07-035900-${RID}.webm`,metadata=true,body='synthetic task recording',recording=capture}={}) {
  const file=h.vault.add(path,body),manifest=await recordingMetadata({...recording},await h.vault.readBinary(file),path);
  if(metadata)h.vault.add(metadataPath(path),JSON.stringify(manifest));return {file,manifest};
}
async function run(h){await h.queue.tick();h.advance();await h.queue.tick();}
async function note(h,file){const job=h.state.jobs[file.path];return parseTodoNote(await h.vault.read(h.vault.getAbstractFileByPath(job.output)),job.output);}
const noteFiles=h=>h.vault.getFiles().filter(file=>file.path.endsWith('.md'));

test('a missing capture sidecar waits without ASR or API and lets the next diary finish',async()=>{
  const h=fixture(),{file,manifest}=await addTodo(h,{metadata:false}),diary=h.vault.add(`${DEFAULTS.folder}/voice-diary.webm`,'different diary bytes');
  await run(h);assert.equal(h.state.jobs[file.path].status,'waiting_capture');assert.equal(h.state.jobs[diary.path].status,'done');assert.deepEqual(h.counts(),{asr:1,api:0});
  h.vault.add(metadataPath(file.path),JSON.stringify(manifest));h.advance();await h.queue.tick();
  assert.equal(h.state.jobs[file.path].status,'done');assert.deepEqual(h.counts(),{asr:2,api:0});assert.equal((await note(h,file)).items[0].date,'2026-11-08');
});
for(const fault of ['partial','hash','size'])test(`a ${fault} capture sidecar cannot start processing or spend retry attempts`,async()=>{
  const h=fixture({settings:{apiEnabled:true,todoUseApi:true}}),{file,manifest}=await addTodo(h,{metadata:false});
  const bad=fault==='partial'?JSON.stringify(manifest).slice(0,-20):JSON.stringify({...manifest,...(fault==='hash'?{audioSha256:'a'.repeat(64)}:{byteLength:manifest.byteLength+1})});
  h.vault.add(metadataPath(file.path),bad);await run(h);h.advance();await h.queue.tick();
  assert.equal(h.state.jobs[file.path].status,'waiting_capture');assert.equal(h.state.jobs[file.path].tries,0);assert.deepEqual(h.counts(),{asr:0,api:0});assert.equal(noteFiles(h).length,0);
});
test('late sync and the diary 04:00 rule never change tomorrow or next-week dates',async()=>{
  const h=fixture({settings:{diaryDayStartHour:4}}),{file}=await addTodo(h);await run(h);
  const result=await note(h,file);assert.equal(result.recordedAt,'2026-11-06T19:59:00.000Z');
  assert.equal(result.items[0].date,'2026-11-08');assert.equal(result.items[1].dateKind,'window');
  assert.deepEqual([result.items[1].startDate,result.items[1].endDate],['2026-11-09','2026-11-15']);
  assert.match(h.state.jobs[file.path].output,/2026\.11\.07待办_035900_12345678\.md$/);
});
for(const [apiEnabled,todoUseApi,expected] of [[false,false,0],[false,true,0],[true,false,0],[true,true,1]])test(`task API requires both switches: global=${apiEnabled}, tasks=${todoUseApi}`,async()=>{
  const h=fixture({settings:{apiEnabled,todoUseApi}}),{file}=await addTodo(h);await run(h);
  assert.equal(h.state.jobs[file.path].status,'done');assert.deepEqual(h.counts(),{asr:1,api:expected});
  assert.equal((await note(h,file)).items[0].method,expected?'api':'local');
});
test('missing API credentials stay local even with both switches enabled',async()=>{
  const h=fixture({settings:{apiEnabled:true,todoUseApi:true,apiKey:''}}),{file}=await addTodo(h);await run(h);
  assert.equal(h.state.jobs[file.path].status,'done');assert.deepEqual(h.counts(),{asr:1,api:0});
});
for(const key of ['apiEnabled','todoUseApi'])test(`turning ${key} off during transcription sends no task API request`,async()=>{
  const h=fixture({settings:{apiEnabled:true,todoUseApi:true}}),{file}=await addTodo(h);h.queue.transcribe=async()=>{h.config[key]=false;return RAW;};await run(h);
  assert.equal(h.state.jobs[file.path].status,'done');assert.equal(h.counts().api,0);assert.equal((await note(h,file)).items[0].method,'local');
});
test('turning the task API off at its asynchronous dispatch gate prevents HTTP',async()=>{
  const h=fixture({settings:{apiEnabled:true,todoUseApi:true}}),{file}=await addTodo(h);let gates=0,requests=0;
  h.queue.llm=new LlmClient(async()=>{requests++;throw Error('must not dispatch');},undefined,()=>{if(++gates===2)h.config.todoUseApi=false;return true;});
  await run(h);assert.equal(gates,2);assert.equal(requests,0);assert.equal(h.state.jobs[file.path].status,'done');assert.equal((await note(h,file)).items[0].method,'local');
});
test('an already-dispatched response is discarded if the task API was switched off',async()=>{
  const h=fixture({settings:{apiEnabled:true,todoUseApi:true}}),{file}=await addTodo(h);let sent;
  h.queue.llm=new LlmClient(async request=>{sent=JSON.parse(request.body);h.config.todoUseApi=false;return {status:200,json:{choices:[{finish_reason:'stop',message:{content:response()}}]}};});
  await run(h);assert.equal(sent.messages[1].content,RAW);assert.match(sent.messages[0].content,/2026-11-07/);
  assert.equal(sent.messages.length,2);assert.equal((await note(h,file)).items[0].method,'local');
});
test('enabling the API during local ASR never upgrades the frozen local job',async()=>{
  const h=fixture(),{file}=await addTodo(h);h.queue.transcribe=async()=>{h.config.apiEnabled=true;h.config.todoUseApi=true;return RAW;};await run(h);
  assert.equal(h.counts().api,0);assert.equal(h.state.jobs[file.path].processingMode,'local');
});
test('oversized extraction input remains local with review markers and its full raw transcript',async()=>{
  const h=fixture({settings:{apiEnabled:true,todoUseApi:true}}),{file}=await addTodo(h),raw='明天买牛奶。'.repeat(Math.ceil(LIMITS.text/6)+1);
  h.queue.transcribe=async()=>raw;await run(h);const result=await note(h,file);
  assert.equal(h.counts().api,0);assert.ok(result.items.every(item=>item.status==='needs_confirmation'));
  assert.ok((await h.vault.read(h.vault.getAbstractFileByPath(h.state.jobs[file.path].output))).includes(raw));
});
test('changed capture time during ASR preserves raw text and pauses before any API request',async()=>{
  const h=fixture({settings:{apiEnabled:true,todoUseApi:true}}),{file,manifest}=await addTodo(h);
  h.queue.transcribe=async()=>{h.vault.change(h.vault.getAbstractFileByPath(metadataPath(file.path)),JSON.stringify({...manifest,recordedAt:'2026-11-07T19:59:00.000Z',localDate:'2026-11-08'}));return RAW;};
  await run(h);const job=h.state.jobs[file.path];assert.equal(job.status,'error');assert.equal(job.errorCode,'capture-changed');assert.equal(job.raw,RAW);assert.equal(h.counts().api,0);assert.equal(noteFiles(h).length,0);
});
test('equivalent renamed and retry-save sidecars deduplicate while ambiguous capture times wait',async()=>{
  const h=fixture(),{file,manifest}=await addTodo(h,{metadata:false,path:`${DEFAULTS.folder}/renamed.webm`});
  h.vault.add(`${DEFAULTS.folder}/original.webm.voice.json`,JSON.stringify({...manifest,audioName:'original.webm'}));
  h.vault.add(`${DEFAULTS.folder}/retry.webm.voice.json`,JSON.stringify(Object.fromEntries(Object.entries({...manifest,audioName:'retry.webm'}).reverse())));
  await run(h);assert.equal(h.state.jobs[file.path].status,'done');assert.deepEqual(h.counts(),{asr:1,api:0});
  const ambiguous=fixture(),other=await addTodo(ambiguous,{metadata:false,path:`${DEFAULTS.folder}/renamed.webm`});
  ambiguous.vault.add(`${DEFAULTS.folder}/original.webm.voice.json`,JSON.stringify({...other.manifest,audioName:'original.webm'}));
  ambiguous.vault.add(`${DEFAULTS.folder}/conflict.webm.voice.json`,JSON.stringify({...other.manifest,audioName:'conflict.webm',localDate:'2026-11-08',recordedAt:'2026-11-07T19:59:00.000Z'}));
  await run(ambiguous);assert.equal(ambiguous.state.jobs[other.file.path].status,'waiting_capture');assert.deepEqual(ambiguous.counts(),{asr:0,api:0});
});
test('a valid audioName or JSON-key-order change is not a change to the capture clock anchor',async()=>{
  const h=fixture(),{file,manifest}=await addTodo(h);h.queue.transcribe=async()=>{
    const changed=Object.fromEntries(Object.entries({...manifest,audioName:'original-before-rename.webm'}).reverse());
    h.vault.change(h.vault.getAbstractFileByPath(metadataPath(file.path)),JSON.stringify(changed));return RAW;
  };
  await run(h);assert.equal(h.state.jobs[file.path].status,'done');assert.equal((await note(h,file)).items[0].date,'2026-11-08');
});
test('complete manually checked tasks recover after state loss, metadata deletion and audio rename',async()=>{
  const h=fixture(),{file}=await addTodo(h);await run(h);const output=h.state.jobs[file.path].output,final=h.vault.getAbstractFileByPath(output);
  const edited=(await h.vault.read(final)).replace('- [ ] 买牛奶','- [x] 买燕麦奶')+'\n用户补充，保留。\n';h.vault.change(final,edited);h.vault.remove(metadataPath(file.path));
  const first=fixture({vault:h.vault});await run(first);assert.equal(first.state.jobs[file.path].output,output);assert.deepEqual(first.counts(),{asr:0,api:0});
  const renamed=h.vault.rename(file,`${DEFAULTS.folder}/another-name.webm`),second=fixture({vault:h.vault});await run(second);
  assert.equal(second.state.jobs[renamed.path].output,output);assert.deepEqual(second.counts(),{asr:0,api:0});assert.equal(noteFiles(h).length,1);
  assert.equal(await h.vault.read(final),edited);assert.equal((await note(second,renamed)).items[0].checked,true);assert.deepEqual(second.state.todoNotes,[output]);
});
test('a full task note checked after interrupted creation recovers despite its stale pending digest',async()=>{
  const h=fixture(),{file}=await addTodo(h);let output;
  h.vault.create=async(path,body)=>{output=path;h.vault.add(path,body.replace('- [ ] 买牛奶','- [x] 买牛奶'));h.stop();throw Error('interrupted return');};
  await run(h);const saved=clone(h.snapshots.at(-1));assert.equal(saved.jobs[file.path].status,'committing');assert.ok(saved.jobs[file.path].pendingFinal);
  h.vault.create=Vault.prototype.create.bind(h.vault);h.vault.remove(metadataPath(file.path));
  const resumed=fixture({vault:h.vault,state:saved});await run(resumed);
  assert.equal(resumed.state.jobs[file.path].output,output);assert.equal((await note(resumed,file)).items[0].checked,true);assert.deepEqual(resumed.counts(),{asr:0,api:0});assert.equal(noteFiles(h).length,1);
});
test('competing complete creation preserves manual checkbox edits and does not create a second note',async()=>{
  const h=fixture(),{file}=await addTodo(h);let creates=0;
  h.vault.create=async(path,body)=>{creates++;h.vault.add(path,body.replace('- [ ] 买牛奶','- [x] 买牛奶'));throw Error('concurrent create');};
  await run(h);assert.equal(h.state.jobs[file.path].status,'done');assert.equal(creates,1);assert.equal(noteFiles(h).length,1);assert.equal((await note(h,file)).items[0].checked,true);
});
for(const reject of [false,true])test(`a truncated task write ${reject?'rejected':'resolved'} retains checkpoints and retries to a new path`,async()=>{
  const h=fixture(),{file}=await addTodo(h);let partial,output;
  h.vault.create=async(path,body)=>{output=path;partial=body.slice(0,body.indexOf('## 原始转写')+25);const saved=h.vault.add(path,partial);if(reject)throw Error('partial write');return saved;};
  await run(h);const job=h.state.jobs[file.path];assert.equal(job.status,'error');assert.equal(job.errorCode,'save');assert.equal(matchesTodoNote(partial,job.sha),false);assert.equal(job.raw,RAW);assert.ok(job.todoResult);assert.deepEqual(job.incompleteOutputs,[output]);
  h.vault.create=Vault.prototype.create.bind(h.vault);const resumed=fixture({vault:h.vault,state:clone(h.state)});await resumed.queue.retry();await run(resumed);
  assert.equal(resumed.state.jobs[file.path].status,'done');assert.notEqual(resumed.state.jobs[file.path].output,output);assert.match(resumed.state.jobs[file.path].output,/-2\.md$/);
  assert.deepEqual(resumed.counts(),{asr:0,api:0});assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(output)),partial);
});
test('destination is frozen across API failure, restart and settings changes',async()=>{
  const h=fixture({settings:{apiEnabled:true,todoUseApi:true,todoFolder:'待办/原目录'}}),{file}=await addTodo(h);
  h.queue.llm.complete=async()=>{throw new DiaryError('network','接口失败');};await run(h);const originalTarget=h.state.jobs[file.path].target;
  const resumed=fixture({vault:h.vault,state:clone(h.state),settings:{apiEnabled:true,todoUseApi:true,todoFolder:'待办/新目录'}});resumed.advance(92000);await run(resumed);
  assert.equal(resumed.state.jobs[file.path].status,'done');assert.equal(resumed.state.jobs[file.path].output,originalTarget);assert.match(originalTarget,/^待办\/原目录\//);assert.deepEqual(resumed.counts(),{asr:0,api:1});
});
test('first-enable baselines still skip an old task recording after its audio is renamed',async()=>{
  const h=fixture({state:{enabled:false,jobs:{}}}),{file}=await addTodo(h);await h.queue.arm(true);
  const renamed=h.vault.rename(file,`${DEFAULTS.folder}/renamed-history.webm`);await run(h);
  assert.equal(h.state.jobs[renamed.path].status,'ignored');assert.deepEqual(h.counts(),{asr:0,api:0});
  await h.queue.enqueue(renamed);await h.queue.tick();assert.equal(h.state.jobs[renamed.path].status,'done');assert.deepEqual(h.counts(),{asr:1,api:0});
});
test('task discovery uses known paths, expected task names and metadata markers without reading private prose',async()=>{
  const h=fixture(),{file}=await addTodo(h);await run(h);const output=h.state.jobs[file.path].output;
  h.vault.add('Private/unrelated.md','private notes must not be read');h.vault.add(`${DEFAULTS.todoFolder}/unrelated.md`,'ordinary task-folder prose');
  const moved=h.vault.rename(h.vault.getAbstractFileByPath(output),'Archive/用户改名.md');h.vault.reads=[];
  const metadataCache={getFileCache:candidate=>candidate===moved?{frontmatter:{voice_diary_kind:'tasks'}}:null};
  const paths=todoNotePaths(h.vault,{},h.config,metadataCache);assert.deepEqual(paths,[moved.path]);assert.deepEqual(h.vault.reads,[]);
  const recovered=fixture({vault:h.vault});recovered.queue.metadataCache=metadataCache;await run(recovered);
  assert.equal(recovered.state.jobs[file.path].output,moved.path);assert.deepEqual(recovered.counts(),{asr:0,api:0});
  assert.ok(!h.vault.reads.includes('Private/unrelated.md'));assert.ok(!h.vault.reads.includes(`${DEFAULTS.todoFolder}/unrelated.md`));
});
test('independent recording IDs with identical bytes keep their own dates and notes',async()=>{
  const h=fixture(),first=await addTodo(h);await run(h);
  const secondId='87654321-1234-4123-8123-123456789abc',second=await addTodo(h,{path:`${DEFAULTS.folder}/todo-2026-11-08-035900-${secondId}.webm`,recording:{...capture,recordingId:secondId,recordedAt:Date.parse('2026-11-07T19:59:00.000Z'),localDate:'2026-11-08'}});
  await run(h);assert.equal(noteFiles(h).length,2);assert.deepEqual(h.counts(),{asr:2,api:0});
  assert.equal((await note(h,first.file)).recordingId,RID);assert.equal((await note(h,first.file)).items[0].date,'2026-11-08');
  assert.equal((await note(h,second.file)).recordingId,secondId);assert.equal((await note(h,second.file)).items[0].date,'2026-11-09');
});
test('a first-enable baseline does not suppress a new independent capture with identical bytes',async()=>{
  const h=fixture({state:{enabled:false,jobs:{}}}),first=await addTodo(h);await h.queue.arm(true);
  const secondId='87654321-1234-4123-8123-123456789abc',second=await addTodo(h,{path:`${DEFAULTS.folder}/todo-2026-11-08-035900-${secondId}.webm`,recording:{...capture,recordingId:secondId,recordedAt:Date.parse('2026-11-07T19:59:00.000Z'),localDate:'2026-11-08'}});
  await run(h);assert.equal(h.state.jobs[first.file.path].status,'ignored');assert.equal(h.state.jobs[second.file.path].status,'done');assert.deepEqual(h.counts(),{asr:1,api:0});
  assert.equal((await note(h,second.file)).items[0].date,'2026-11-09');
});
for(const metadata of [false,true])test(`an independent identical-byte capture with ${metadata?'partial':'missing'} metadata cannot recover another recording ID`,async()=>{
  const h=fixture();await addTodo(h);await run(h);
  const secondId='87654321-1234-4123-8123-123456789abc',second=await addTodo(h,{metadata:false,path:`${DEFAULTS.folder}/todo-2026-11-08-035900-${secondId}.webm`,recording:{...capture,recordingId:secondId,recordedAt:Date.parse('2026-11-07T19:59:00.000Z'),localDate:'2026-11-08'}});
  if(metadata)h.vault.add(metadataPath(second.file.path),'{"version":1');
  await run(h);assert.equal(h.state.jobs[second.file.path].status,'waiting_capture');assert.equal(noteFiles(h).length,1);assert.deepEqual(h.counts(),{asr:1,api:0});
});
test('a retry-save UUID different from its recording ID accepts a matching audioName manifest',async()=>{
  const h=fixture(),retryId='87654321-1234-4123-8123-123456789abc',saved=await addTodo(h,{metadata:false,path:`${DEFAULTS.folder}/todo-2026-11-07-035900-${retryId}.webm`});
  h.vault.add(`${DEFAULTS.folder}/sidecar-renamed.voice.json`,JSON.stringify(saved.manifest));await run(h);
  assert.equal(h.state.jobs[saved.file.path].status,'done');assert.equal((await note(h,saved.file)).recordingId,RID);assert.deepEqual(h.counts(),{asr:1,api:0});
});
test('more than 1000 unrelated sidecars do not permanently block ordinary diary processing',async()=>{
  const h=fixture(),diary=h.vault.add(`${DEFAULTS.folder}/voice-2026-11-07.webm`,'separate diary');
  for(let n=0;n<1001;n++)h.vault.add(`${DEFAULTS.folder}/other-${n}.webm.voice.json`,'{}');
  await run(h);assert.equal(h.state.jobs[diary.path].status,'done');assert.deepEqual(h.counts(),{asr:1,api:0});
});
