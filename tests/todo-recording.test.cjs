const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {parseRecordingMetadata}=require('../src/capture');

function host(options={}){
  const files=new Map(),notices=[],controls={...options},events=[];let started=0;
  const vault={getAbstractFileByPath:name=>files.get(name),
    async createFolder(name){files.set(name,{path:name,children:[]});},
    async createBinary(name,bytes){if(files.has(name))throw Error('exists');const data=controls.partialAudio?bytes.slice(0,2):bytes;
      const file={path:name,name:name.split('/').pop(),data,stat:{size:data.byteLength}};files.set(name,file);events.push('audio-create');if(controls.partialAudio)throw Error('partial audio');return file;},
    async readBinary(file){events.push('audio-verify');return file.data;},
    async create(name,text){if(files.has(name))throw Error('exists');const file={path:name,name:name.split('/').pop(),text:controls.partialManifest?text.slice(0,30):text};files.set(name,file);events.push('manifest-create');if(controls.partialManifest||controls.completeThenThrow)throw Error('manifest write rejected');return file;},
    async read(file){events.push('manifest-verify');if(controls.unreadableManifest)throw Error('unreadable');return file.text;}};
  const obsidian={Plugin:class{constructor(app){this.app=app;}},Modal:class{},ItemView:class{},PluginSettingTab:class{},Setting:class{},Notice:class{constructor(message){notices.push(message);}},Platform:{},setIcon(){}};
  class MediaRecorder{static isTypeSupported(type){return type==='audio/mp4';}constructor(){this.mimeType='audio/mp4';this.state='inactive';}
    start(){started++;this.state='recording';}requestData(){this.ondataavailable?.({data:new Blob(['todo synthetic speech'])});}stop(){this.state='inactive';this.onstop?.();}}
  const ctx=vm.createContext({Blob,Date,Intl,crypto:webcrypto,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,URL,console,setTimeout,clearTimeout,
    MediaRecorder,navigator:{mediaDevices:{async getUserMedia(){if(controls.permission)await controls.permission;return{getTracks:()=>[{stop(){}}]};}}}});
  const cache=new Map(),src=path.join(__dirname,'../src');
  function load(filename){if(cache.has(filename))return cache.get(filename).exports;const module={exports:{}};cache.set(filename,module);
    const requireLocal=name=>name==='obsidian'?obsidian:load(path.resolve(path.dirname(filename),name+'.js'));
    vm.runInContext('(function(require,module,exports){'+fs.readFileSync(filename,'utf8')+'\n})',ctx,{filename})(requireLocal,module,module.exports);return module.exports;}
  const Plugin=load(path.join(src,'main.js')),Recorder=load(path.join(src,'recorder.js')).AudioRecorder,p=new Plugin({vault});
  p.settings={folder:'Recordings'};p.state={enabled:false};p.mobile=false;p.recorder=new Recorder();p.updateStatus=()=>{};
  return {p,files,vault,notices,controls,events,started:()=>started,audio:()=>[...files.values()].filter(file=>file.data),manifests:()=>[...files.values()].filter(file=>file.text!==undefined)};
}

test('todo capture creates verified audio then one complete synced manifest with the capture identity',async()=>{
  const h=host();await h.p.toggleRecording('todo');const capture={...h.p.recorder.session.capture};
  assert.equal(h.p.recorder.session.mode,'todo');assert.ok(h.notices.some(text=>text.includes(capture.localDate)&&text.includes('明天')));
  await h.p.toggleRecording();assert.equal(h.started(),1);assert.equal(h.audio().length,1);assert.equal(h.manifests().length,1);assert.equal(h.p.pendingAudio,null);
  const audio=h.audio()[0],metadata=parseRecordingMetadata(h.manifests()[0].text,audio);
  assert.equal(metadata.recordingId,capture.recordingId);assert.equal(metadata.recordedAt,new Date(capture.recordedAt).toISOString());assert.match(audio.name,/^todo-/);
  assert.ok(h.events.indexOf('audio-verify')<h.events.indexOf('manifest-create'));assert.equal(h.events.at(-1),'manifest-verify');
});

test('switching the requested mode while the microphone is starting cannot create a second session',async()=>{
  let grant;const h=host({permission:new Promise(resolve=>{grant=resolve;})});const start=h.p.toggleRecording('todo');
  await h.p.toggleRecording('diary');grant();await start;assert.equal(h.started(),1);assert.equal(h.p.recorder.session.mode,'todo');await h.p.stopRecording();
});

test('ordinary diary recording keeps its voice filename and creates no manifest',async()=>{
  const h=host();await h.p.toggleRecording();await h.p.toggleRecording();assert.equal(h.audio().length,1);assert.match(h.audio()[0].name,/^voice-/);assert.equal(h.manifests().length,0);
});

test('partial audio never gets a complete manifest; retry preserves the original and recording identity',async()=>{
  const h=host({partialAudio:true});await h.p.toggleRecording('todo');const id=h.p.recorder.session.capture.recordingId;await h.p.stopRecording();
  assert.equal(h.manifests().length,0);assert.ok(h.p.pendingAudio);const old=h.audio()[0];h.controls.partialAudio=false;await h.p.saveRecording();
  assert.equal(old.data.byteLength,2);assert.equal(h.audio().length,2);assert.equal(JSON.parse(h.manifests()[0].text).recordingId,id);assert.equal(h.p.pendingAudio,null);
});

test('partial manifest stays untouched and retry saves a new complete pair with the same recording identity',async()=>{
  const h=host({partialManifest:true});await h.p.toggleRecording('todo');const id=h.p.recorder.session.capture.recordingId;await h.p.stopRecording();
  assert.ok(h.p.pendingAudio);assert.equal(h.p.pendingAudio.path,null);const original=h.manifests()[0],before=original.text;
  h.controls.partialManifest=false;await h.p.saveRecording();assert.equal(h.p.pendingAudio,null);assert.equal(original.text,before);assert.equal(h.audio().length,2);
  const recovered=h.manifests().find(file=>file!==original);assert.equal(JSON.parse(recovered.text).recordingId,id);
});

test('complete manifest write followed by a rejected response is verified without duplicate audio',async()=>{
  const h=host({completeThenThrow:true});await h.p.toggleRecording('todo');await h.p.stopRecording();assert.equal(h.p.pendingAudio,null);assert.equal(h.audio().length,1);assert.equal(h.manifests().length,1);
});

test('unreadable existing manifest is preserved and pending audio remains recoverable',async()=>{
  const h=host({unreadableManifest:true});await h.p.toggleRecording('todo');await h.p.stopRecording();assert.ok(h.p.pendingAudio);
  const old=h.manifests()[0],before=old.text;h.controls.unreadableManifest=false;await h.p.saveRecording();assert.equal(old.text,before);assert.equal(h.p.pendingAudio,null);assert.equal(h.audio().length,2);
});

test('a conflicting existing manifest is never overwritten or accepted for the pending capture',async()=>{
  const h=host();await h.p.toggleRecording('todo');const capture=h.p.recorder.session.capture;
  const audio=`Recordings/todo-${capture.localDate}-${capture.localTime.replace(/:/g,'')}-${capture.recordingId}.m4a`,manifestPath=audio+'.voice.json';
  const existing={path:manifestPath,name:manifestPath.split('/').pop(),text:'{"unrelated":"preserve this content"}'};h.files.set(manifestPath,existing);
  await h.p.stopRecording();assert.ok(h.p.pendingAudio);assert.equal(h.files.get(manifestPath),existing);assert.equal(h.p.pendingAudio.path,null);
  await h.p.saveRecording();assert.equal(h.p.pendingAudio,null);assert.equal(existing.text,'{"unrelated":"preserve this content"}');assert.equal(h.audio().length,2);
  assert.equal(JSON.parse(h.manifests().find(file=>file!==existing).text).recordingId,capture.recordingId);
});
