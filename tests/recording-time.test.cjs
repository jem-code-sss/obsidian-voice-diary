const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {webcrypto}=require('node:crypto');

const localTime=(day,hour,minute,second=0)=>new Date(2026,10,day,hour,minute,second).getTime();
function clockDate(clock){
  return class extends Date{
    constructor(...args){super(...(args.length?args:[clock.now]));}
    static now(){return clock.now;}
  };
}
function engineHost(clock,controls={}){
  const timers=[];
  class MediaRecorder{
    static isTypeSupported(type){return type==='audio/mp4';}
    constructor(){this.mimeType='audio/mp4';this.state='inactive';}
    start(){this.state='recording';}
    requestData(){this.ondataavailable?.({data:new Blob(['recorded speech'])});}
    stop(){this.state='inactive';if(!controls.delayStop)this.onstop?.();}
  }
  const context={module:{exports:{}},require:()=>require('../src/core'),Blob,Date:clockDate(clock),MediaRecorder,
    navigator:{mediaDevices:{async getUserMedia(){if(controls.permission)await controls.permission;return{getTracks:()=>[{stop(){}}]};}}},
    setTimeout(callback){timers.push(callback);return timers.length;},clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/recorder.js'),'utf8'),context);
  return{recorder:new context.module.exports.AudioRecorder(),timers};
}
function saveHost(clock,controls={}){
  const files=new Map(),mainPath=path.join(__dirname,'../src/main.js'),sourceRequire=createRequire(mainPath);
  const vault={
    getAbstractFileByPath:name=>files.get(name),
    async createFolder(name){files.set(name,{path:name,children:[]});if(controls.afterFolder)controls.afterFolder();},
    async createBinary(name,bytes){if(files.has(name))throw Error('exists');const file={path:name,name:name.split('/').pop(),data:controls.partialWrite?bytes.slice(0,2):bytes};files.set(name,file);if(controls.partialWrite)throw Error('partial write');return file;},
    async readBinary(file){return file.data;}
  };
  const obsidian={Plugin:class{constructor(app){this.app=app;}},PluginSettingTab:class{},Modal:class{},Setting:class{},Notice:class{},Platform:{},setIcon(){}};
  const context={module:{exports:{}},require:name=>name==='obsidian'?obsidian:sourceRequire(name),Date:clockDate(clock),crypto:webcrypto,
    Blob,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,URL,setTimeout,clearTimeout,console};
  vm.runInNewContext(fs.readFileSync(mainPath,'utf8'),context);
  const plugin=new context.module.exports({vault});plugin.settings={folder:'Recordings'};plugin.updateStatus=()=>{};
  return{plugin,files,audio:()=>[...files.values()].filter(file=>file.data)};
}

test('recording crossing 04:00 retains actual capture start rather than stop time',async()=>{
  const clock={now:localTime(7,3,59,55)},h=engineHost(clock),started=clock.now;
  await h.recorder.start();clock.now=localTime(7,4,0,10);const pending=await h.recorder.stop();
  assert.equal(pending.recordedAt,started);assert.equal(h.recorder.startedAt,started);assert.equal(await pending.blob.text(),'recorded speech');
});

test('delayed microphone permission records the granted capture start',async()=>{
  let grant;const controls={permission:new Promise(resolve=>{grant=resolve;})},clock={now:localTime(7,3,59,55)},h=engineHost(clock,controls);
  const starting=h.recorder.start();clock.now=localTime(7,4,0,10);grant();await starting;
  const started=clock.now;clock.now=localTime(7,4,1);assert.equal((await h.recorder.stop()).recordedAt,started);
});

test('partial stop fallback keeps the same start timestamp and buffered audio',async()=>{
  const clock={now:localTime(6,23,59,55)},h=engineHost(clock,{delayStop:true}),started=clock.now;
  await h.recorder.start();clock.now=localTime(7,4,5);const stopped=h.recorder.stop();h.timers.at(-1)();const pending=await stopped;
  assert.equal(pending.recordedAt,started);assert.equal(pending.partial,true);assert.equal(await pending.blob.text(),'recorded speech');
});

test('saving on another day names the recording by the actual start timestamp',async()=>{
  const clock={now:localTime(8,12,0)},h=saveHost(clock);
  h.plugin.pendingAudio={blob:new Blob(['speech']),ext:'m4a',recordedAt:localTime(7,3,59,55)};
  await h.plugin.saveRecording();assert.equal(h.audio().length,1);assert.match(h.audio()[0].path,/^Recordings\/voice-2026-11-07-035955-/);
});

test('retry after partial save retains the start in the replacement filename',async()=>{
  const clock={now:localTime(7,4,2)},controls={partialWrite:true},h=saveHost(clock,controls),started=localTime(7,3,59,55);
  h.plugin.pendingAudio={blob:new Blob(['complete speech']),ext:'m4a',recordedAt:started};
  await assert.rejects(h.plugin.saveRecording());const original=h.plugin.pendingAudio.path;clock.now=localTime(8,18,0);controls.partialWrite=false;
  await h.plugin.saveRecording();assert.equal(h.audio().length,2);assert.equal(h.files.get(original).data.byteLength,2);
  const recovered=h.audio().find(file=>file.path!==original);assert.match(recovered.path,/^Recordings\/voice-2026-11-07-035955-/);assert.equal(new TextDecoder().decode(recovered.data),'complete speech');
});

test('legacy pending bytes pin their compatibility time before delayed folder creation',async()=>{
  const clock={now:localTime(7,3,59,55)},h=saveHost(clock,{afterFolder(){clock.now=localTime(8,12,0);}});
  h.plugin.pendingAudio={blob:new Blob(['legacy speech']),ext:'m4a'};await h.plugin.saveRecording();
  assert.match(h.audio()[0].path,/^Recordings\/voice-2026-11-07-035955-/);
});
