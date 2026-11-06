const {test}=require('node:test');
const assert=require('node:assert/strict');
const {sourceDate,cleanTopic,topicFromText,namingSnapshot,diaryFilename}=require('../src/naming');
const {Queue,DEFAULTS,clone,sha256,DiaryError}=require('../src/core');
const file=(name,ctime)=>({name,path:`Voice Diary/Recordings/${name}`,stat:{ctime}});

test('recording filename wins over creation or processing dates after synchronization',()=>{
  const source=file('voice-2026-12-13-150100-id.webm',new Date(2027,1,3,10).getTime());
  assert.deepEqual(sourceDate(source,new Date(2028,2,1).getTime()),{date:'2026-12-13',source:'filename'});
  assert.equal(diaryFilename(namingSnapshot(source,DEFAULTS), '今天和朋友一起出游。'),'12.13日记_出游.md');
});
for(const [name,date] of [
  ['voice-2026-12-13-035959-id.webm','2026-12-12'],
  ['voice-2026-12-13-040000-id.webm','2026-12-13'],
  ['voice-2027-01-01-000001-id.webm','2026-12-31'],
  ['voice-2028-03-01-025959-id.webm','2028-02-29'],
  ['voice-2027-03-01-025959-id.webm','2027-02-28'],
  ['voice-2026-12-13.webm','2026-12-13'],
  ['voice-2026-12-13-uuid-without-time.webm','2026-12-13']
])test(`diary wall-clock boundary: ${name}`,()=>assert.equal(sourceDate(file(name)).date,date));

test('external recordings use local creation time and apply the same 04:00 boundary',()=>{
  assert.deepEqual(sourceDate(file('interview.m4a',new Date(2027,0,1,3,59,59).getTime())),{date:'2026-12-31',source:'created'});
  assert.deepEqual(sourceDate(file('interview.m4a',new Date(2027,0,1,4).getTime())),{date:'2027-01-01',source:'created'});
  assert.deepEqual(sourceDate(file('voice-2027-02-30-120000-id.m4a',new Date(2027,2,4,10).getTime())),{date:'2027-03-04',source:'created'});
  assert.deepEqual(sourceDate(file('interview.m4a'),new Date(2027,0,2,12).getTime()),{date:'2027-01-02',source:'processed'});
  for(const unusable of [null,NaN,Infinity,-1,''])
    assert.deepEqual(sourceDate(file('external.wav',unusable),new Date(2027,0,2,12).getTime()),{date:'2027-01-02',source:'processed'});
});

test('year option is explicit, keeps the recording year and is captured with the date',()=>{
  const source=file('voice-2027-01-01-010000-id.webm');
  const cfg={...DEFAULTS,titleIncludeYear:true},snapshot=namingSnapshot(source,cfg);
  cfg.titleIncludeYear=false;assert.equal(diaryFilename(snapshot,'主题：跨年回顾'),'2026.12.31日记_跨年回顾.md');
  assert.equal(snapshot.dayStartHour,4);assert.equal(snapshot.dateSource,'filename');
});

test('explicit headings win over a topic keyword, then local travel keywords, short sentence and fallback apply',()=>{
  assert.equal(topicFromText('# 项目复盘\n下一次旅行还没安排。'),'项目复盘');
  assert.equal(topicFromText('主题：春日家庭聚会\n今天去郊游。'),'春日家庭聚会');
  assert.equal(topicFromText('今天和朋友一起去旅游，心情很好。'),'出游');
  assert.equal(topicFromText('嗯，完成了项目复盘。接下来准备周会。'),'完成了项目复盘');
  assert.equal(topicFromText('  '),'随记');
});

test('topic filenames reject path injection, hidden controls and Windows invalid characters with a bounded Unicode length',()=>{
  const topic=cleanTopic('../../..\\outside\u0000\n<name>:"?*|[x]#^\u202e\u200b.' );
  assert.ok(!/[\p{Cc}\p{Cf}<>:"/\\|?*\[\]#^]/u.test(topic));assert.ok(!topic.startsWith('.'));assert.ok(!topic.endsWith('.'));
  assert.equal(Array.from(cleanTopic('游'.repeat(100))).length,24);
  assert.equal(cleanTopic('... / \\ \u0000'),'随记');
  const filename=diaryFilename({date:'2026-12-13'},'标题：../../outside\\other');
  assert.ok(filename.startsWith('12.13日记_'));assert.ok(!/[\\/]/.test(filename));
});

class Vault {
  constructor(){this.files=new Map();this.folders=new Map();this.contents=new Map();}
  add(path,body,ctime=new Date(2026,11,13,10).getTime()){
    const bytes=Buffer.from(body),file={path,name:path.split('/').pop(),stat:{size:bytes.length,mtime:1,ctime}};
    this.files.set(path,file);this.contents.set(path,bytes);return file;
  }
  getFiles(){return [...this.files.values()];}
  getAbstractFileByPath(path){return this.files.get(path)||this.folders.get(path);}
  async createFolder(path){if(this.getAbstractFileByPath(path))throw Error('exists');this.folders.set(path,{path,children:[]});}
  async read(file){return this.contents.get(file.path).toString();}
  async readBinary(file){const b=this.contents.get(file.path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.length);}
  async create(path,body){if(this.getAbstractFileByPath(path))throw Error('exists');return this.add(path,body);}
}
function fixture({vault=new Vault(),state={enabled:true,initialized:true,jobs:{}},config={}}={}) {
  const cfg={...clone(DEFAULTS),...config};let now=new Date(2027,0,5,10).getTime(),asr=0,api=0;
  const queue=new Queue({vault,state,config:()=>cfg,save:async()=>{},now:()=>now,
    transcribe:async()=>{asr++;return '今天和朋友一起出游。';},llm:{complete:async()=>{api++;return '今天和朋友一起出游。';}}});
  return {vault,state,config:cfg,queue,advance:()=>{now+=31000;},counts:()=>({asr,api})};
}
async function run(h){await h.queue.tick();h.advance();await h.queue.tick();}
const audio=(h,name='voice-2026-12-13-120000-id.webm',body='synthetic recording')=>h.vault.add(`${DEFAULTS.folder}/${name}`,body);

test('default local queue writes the requested title without API and completed jobs are not renamed by new settings',async()=>{
  const h=fixture(),f=audio(h);await run(h);const j=h.state.jobs[f.path];
  assert.equal(j.output,`${DEFAULTS.finalFolder}/12.13日记_出游.md`);assert.equal(j.status,'done');assert.deepEqual(h.counts(),{asr:1,api:0});
  const contents=await h.vault.read(h.vault.getAbstractFileByPath(j.output));
  h.config.titleIncludeYear=true;h.config.noteNaming='source';h.config.finalFolder='新目录';await h.queue.retry();await h.queue.tick();
  assert.equal(j.output,`${DEFAULTS.finalFolder}/12.13日记_出游.md`);assert.equal(j.status,'done');
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(j.output)),contents);assert.deepEqual(h.counts(),{asr:1,api:0});
  assert.throws(()=>h.queue.enqueue(f),error=>error.code==='done');
});

test('same-date same-topic notes and racing creates preserve existing files with distinct numbered titles',async()=>{
  const h=fixture(),one=audio(h),existing=`${DEFAULTS.finalFolder}/12.13日记_出游.md`;
  h.vault.add(existing,'用户手写内容');await run(h);
  assert.equal(h.state.jobs[one.path].output,`${DEFAULTS.finalFolder}/12.13日记_出游-2.md`);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(existing)),'用户手写内容');
  const two=audio(h,'voice-2026-12-13-140000-two.webm','second synthetic recording'),create=h.vault.create.bind(h.vault);let raced=false;
  h.vault.create=async(path,body)=>{if(!raced){raced=true;h.vault.add(path,'竞态写入稿件');throw Error('exists');}return create(path,body);};
  await run(h);assert.equal(h.state.jobs[two.path].status,'done');
  assert.equal(h.state.jobs[two.path].output,`${DEFAULTS.finalFolder}/12.13日记_出游-4.md`);
  assert.equal(await h.vault.read(h.vault.getAbstractFileByPath(`${DEFAULTS.finalFolder}/12.13日记_出游-3.md`)),'竞态写入稿件');
});

test('destination and naming are frozen before ASR and survive correction failure plus a restart',async()=>{
  const h=fixture({config:{apiEnabled:true,apiUrl:'https://example.invalid/api',model:'model',apiKey:'synthetic'}}),f=audio(h);
  h.queue.transcribe=async()=>{h.config.finalFolder='修改后的目录';h.config.titleIncludeYear=true;return '今天去旅行。';};
  h.queue.llm.complete=async()=>{throw new DiaryError('network','synthetic failure');};await run(h);
  const j=h.state.jobs[f.path];assert.equal(j.target,undefined);assert.equal(j.targetFolder,DEFAULTS.finalFolder);assert.equal(j.naming.includeYear,false);
  const resumed=fixture({vault:h.vault,state:clone(h.state),config:{...h.config}});resumed.advance();resumed.advance();resumed.advance();await run(resumed);
  const next=resumed.state.jobs[f.path];assert.equal(next.status,'done');assert.equal(next.output,`${DEFAULTS.finalFolder}/12.13日记_出游.md`);assert.equal(resumed.counts().asr,0);
});

test('a failed date-topic commit retries the pinned target without another transcription or API request',async()=>{
  const h=fixture(),f=audio(h),create=h.vault.create.bind(h.vault);h.vault.create=async()=>{throw Error('disk full');};await run(h);
  const j=h.state.jobs[f.path],target=j.target;assert.equal(j.status,'retry_wait');assert.equal(target,`${DEFAULTS.finalFolder}/12.13日记_出游.md`);
  h.vault.create=create;h.config.finalFolder='别处';h.config.titleIncludeYear=true;
  const resumed=fixture({vault:h.vault,state:clone(h.state),config:h.config});resumed.advance();resumed.advance();resumed.advance();await run(resumed);
  assert.equal(resumed.state.jobs[f.path].output,target);assert.equal(resumed.state.jobs[f.path].status,'done');assert.deepEqual(resumed.counts(),{asr:0,api:0});
});

test('date-topic final metadata recovers after job-state loss and audio rename with no duplicate processing',async()=>{
  const h=fixture(),f=audio(h);await run(h);const target=h.state.jobs[f.path].output;
  const body=h.vault.contents.get(f.path);h.vault.files.delete(f.path);h.vault.contents.delete(f.path);const renamed=audio(h,'renamed.m4a',body);
  const resumed=fixture({vault:h.vault});await run(resumed);
  assert.equal(resumed.state.jobs[renamed.path].output,target);assert.deepEqual(resumed.counts(),{asr:0,api:0});
});

test('old source-mode checkpoints keep the exact selected target under the new default',async()=>{
  const h=fixture(),f=audio(h),target='历史目录/old-7-transcript.md';
  h.state.jobs[f.path]={path:f.path,status:'committing',sha:await sha256('synthetic recording'),target,raw:'旧稿',corrected:'旧稿'};
  await run(h);assert.equal(h.state.jobs[f.path].output,target);assert.equal(h.state.jobs[f.path].status,'done');assert.deepEqual(h.counts(),{asr:0,api:0});
});

test('the final fingerprint still blocks a stale note when source audio changes during transcription',async()=>{
  const h=fixture(),f=audio(h);h.queue.transcribe=async()=>{h.vault.contents.set(f.path,Buffer.from('changed bytes'));f.stat.size=13;f.stat.mtime=2;return '出游';};
  await run(h);assert.equal(h.state.jobs[f.path].status,'observed');assert.equal(h.vault.getFiles().filter(file=>file.path.endsWith('.md')).length,0);
});
