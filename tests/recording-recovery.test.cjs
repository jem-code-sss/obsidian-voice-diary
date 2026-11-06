const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');

function host(options={}){
  const files=new Map(),notices=[],controls={...options};let created=0;
  const vault={
    getAbstractFileByPath:name=>files.get(name),
    async createFolder(name){const folder={path:name,children:[]};files.set(name,folder);return folder;},
    async createBinary(name,bytes){
      created++;if(files.has(name))throw Error('exists');
      const file={path:name,name:name.split('/').pop(),data:controls.partialWrite?bytes.slice(0,3):bytes};files.set(name,file);
      if(controls.partialWrite)throw Error('interrupted after partial write');
      if(controls.writeThenReject)throw Error('complete write with rejected response');
      return file;
    },
    async readBinary(file){return controls.readMismatch?new Uint8Array([1]).buffer:file.data;}
  };
  const obsidian={Plugin:class{constructor(app){this.app=app;}},Modal:class{},PluginSettingTab:class{},Setting:class{},
    Notice:class{constructor(message){notices.push(message);}},TFile:class{},MarkdownView:class{},
    Platform:{isMobileApp:false,isMobile:false},requestUrl(){throw Error('unexpected HTTP');},setIcon(){}};
  const context={module:{exports:{}},require(name){assert.equal(name,'obsidian');return obsidian;},
    Blob,Date,Uint8Array,ArrayBuffer,crypto:webcrypto,TextEncoder,TextDecoder,URL,setTimeout,clearTimeout,console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/voice-diary-unified/main.js'),'utf8'),context,{timeout:1000});
  const plugin=new context.module.exports({vault});plugin.settings={folder:'Recordings'};
  return {plugin,files,notices,controls,created:()=>created,audio:()=>[...files.values()].filter(file=>file.data)};
}

test('desktop retry preserves a partial target and saves the full recording under a fresh UUID path',async()=>{
  const h=host({partialWrite:true}),p=h.plugin;
  p.pendingAudio={blob:new Blob(['complete synthetic recording']),ext:'webm'};
  await assert.rejects(p.saveRecording());const originalPath=p.pendingAudio.path;
  assert.equal(h.files.get(originalPath).data.byteLength,3);assert.equal(await p.pendingAudio.blob.text(),'complete synthetic recording');
  h.controls.partialWrite=false;await p.saveRecording();
  assert.equal(p.pendingAudio,null);assert.equal(h.files.get(originalPath).data.byteLength,3);assert.equal(h.audio().length,2);
  const recovered=h.audio().find(file=>file.path!==originalPath);assert.equal(new TextDecoder().decode(recovered.data),'complete synthetic recording');
  assert.match(recovered.path,/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webm$/);
  assert.ok(h.notices.some(message=>message.includes('已另存新文件，原目标已保留')));
});

test('desktop save retains an unrelated existing file and never overwrites its contents',async()=>{
  const h=host(),p=h.plugin,target='Recordings/occupied.webm',existing={path:target,name:'occupied.webm',data:new TextEncoder().encode('keep this file').buffer};
  h.files.set(target,existing);p.pendingAudio={path:target,blob:new Blob(['new recording']),ext:'webm'};
  await p.saveRecording();assert.equal(p.pendingAudio,null);assert.equal(h.files.get(target),existing);
  assert.equal(new TextDecoder().decode(existing.data),'keep this file');assert.equal(h.created(),1);
  assert.equal(new TextDecoder().decode(h.audio().find(file=>file!==existing).data),'new recording');
});

test('desktop recovery failure retains the full pending blob and every incomplete original file',async()=>{
  const h=host({partialWrite:true}),p=h.plugin;p.pendingAudio={blob:new Blob(['full audio retained']),ext:'webm'};
  await assert.rejects(p.saveRecording());const first=p.pendingAudio.path;
  await assert.rejects(p.saveRecording());const second=p.pendingAudio.path;
  assert.notEqual(first,second);assert.equal(await p.pendingAudio.blob.text(),'full audio retained');
  assert.equal(h.files.get(first).data.byteLength,3);assert.equal(h.files.get(second).data.byteLength,3);
  h.controls.partialWrite=false;await p.saveRecording();assert.equal(p.pendingAudio,null);assert.equal(h.audio().length,3);
  assert.equal(new TextDecoder().decode(h.audio().find(file=>file.path!==first&&file.path!==second).data),'full audio retained');
});

test('desktop complete write followed by rejection is verified without writing a duplicate',async()=>{
  const h=host({writeThenReject:true}),p=h.plugin;p.pendingAudio={blob:new Blob(['full audio']),ext:'webm'};
  await p.saveRecording();assert.equal(p.pendingAudio,null);assert.equal(h.created(),1);assert.equal(h.audio().length,1);
});

test('desktop transient verification mismatch reuses the full original once reads recover',async()=>{
  const h=host({readMismatch:true}),p=h.plugin;p.pendingAudio={blob:new Blob(['full audio']),ext:'webm'};
  await assert.rejects(p.saveRecording());const original=p.pendingAudio.path;
  h.controls.readMismatch=false;await p.saveRecording();assert.equal(p.pendingAudio,null);
  assert.equal(h.created(),1);assert.equal(h.audio().length,1);assert.equal(h.audio()[0].path,original);
});
