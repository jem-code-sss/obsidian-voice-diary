const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function recorderFixture(){
  const reasons=[];let flushes=0,stops=0;
  const track={stop(){stops++;}};
  class MediaRecorder {
    static isTypeSupported(t){return t==='audio/mp4';}
    constructor(){this.mimeType='audio/mp4';this.state='inactive';}
    start(){this.state='recording';}
    requestData(){flushes++;this.ondataavailable({data:new Blob(['before interruption'])});}
    stop(){this.state='inactive';this.onstop();}
  }
  const ctx={module:{exports:{}},require:name=>require(name==='./capture'?'../src/capture':'../src/core'),navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track]})}},MediaRecorder,Blob,Date,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/recorder.js'),'utf8'),ctx);
  const recorder=new ctx.module.exports.AudioRecorder(reason=>reasons.push(reason));
  return {recorder,track,reasons,counts:()=>({flushes,stops})};
}
test('track mute is reported as input interruption and callbacks are removed after stop',async()=>{
  const {recorder,track,reasons,counts}=recorderFixture();await recorder.start();track.onmute();assert.deepEqual(reasons,['muted']);
  const result=await recorder.stop();assert.equal(result.ext,'m4a');assert.equal(await result.blob.text(),'before interruption');assert.equal(counts().flushes,1);
  assert.equal(track.onmute,null);assert.equal(track.onended,null);assert.equal(counts().stops,1);
});
test('system pause is reported instead of silently preserving recording state',async()=>{
  const {recorder,reasons}=recorderFixture();await recorder.start();recorder.media.onpause();assert.deepEqual(reasons,['paused']);await recorder.stop();
});

function orderedFixture(){
  const timers=[],reasons=[],controls={automaticStop:false,throwStop:false};let nativeStops=0,pending;
  const track={stop(){}};
  class MediaRecorder{
    static isTypeSupported(type){return type==='audio/mp4';}
    constructor(){this.mimeType='audio/mp4';this.state='inactive';}
    start(){this.state='recording';}
    requestData(){}
    stop(){nativeStops++;this.state='inactive';if(controls.throwStop)throw Error('native stop error');if(controls.automaticStop)this.onstop?.();}
  }
  const ctx={module:{exports:{}},require:name=>require(name==='./capture'?'../src/capture':'../src/core'),navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track]})}},MediaRecorder,Blob,Date,
    setTimeout(callback,delay){assert.equal(delay,4000);timers.push(callback);return timers.length;},clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/recorder.js'),'utf8'),ctx);
  const recorder=new ctx.module.exports.AudioRecorder(reason=>{reasons.push(reason);pending=recorder.stop();});
  return{recorder,timers,controls,reasons,stopCount:()=>nativeStops,pending:()=>pending};
}
test('native error inactive transition retains final buffered speech until dataavailable then stop',async()=>{
  const h=orderedFixture();await h.recorder.start();const media=h.recorder.media;media.state='inactive';media.onerror();
  assert.equal(h.recorder.state,'stopping');assert.equal(typeof media.ondataavailable,'function');
  media.ondataavailable({data:new Blob(['final buffered speech'])});media.onstop();const result=await h.pending();
  assert.equal(await result.blob.text(),'final buffered speech');assert.equal(result.partial,false);assert.equal(h.stopCount(),0);
});
test('native onstop that arrived before wrapper stop completes immediately',async()=>{
  const h=orderedFixture();await h.recorder.start();const media=h.recorder.media;media.state='inactive';media.ondataavailable({data:new Blob(['ended speech'])});media.onstop();
  assert.equal(h.recorder.state,'idle');assert.equal(await (await h.pending()).blob.text(),'ended speech');assert.equal(h.stopCount(),0);
});
test('inactive native recorder without stop uses bounded fallback after preserving final data',async()=>{
  const h=orderedFixture();await h.recorder.start();const media=h.recorder.media;media.state='inactive';media.onerror();assert.equal(h.recorder.state,'stopping');
  media.ondataavailable({data:new Blob(['late buffered speech'])});h.timers.at(-1)();const result=await h.pending();
  assert.equal(result.partial,true);assert.equal(await result.blob.text(),'late buffered speech');assert.equal(h.recorder.state,'idle');
});
test('native stop throwing does not preempt queued final data and stop',async()=>{
  const h=orderedFixture();h.controls.throwStop=true;await h.recorder.start();const media=h.recorder.media,pending=h.recorder.stop();
  assert.equal(h.recorder.state,'stopping');media.ondataavailable({data:new Blob(['tail after stop threw'])});media.onstop();
  const result=await pending;assert.equal(result.partial,false);assert.equal(await result.blob.text(),'tail after stop threw');
});
test('late old session callbacks do not write or interrupt the next recording',async()=>{
  const h=orderedFixture();await h.recorder.start();const old=h.recorder.media,lateData=old.ondataavailable,lateStop=old.onstop;
  old.ondataavailable({data:new Blob(['first'])});const first=h.recorder.stop();old.onstop();await first;
  await h.recorder.start();lateData({data:new Blob(['stale bytes'])});lateStop();assert.equal(h.recorder.state,'recording');assert.deepEqual(h.reasons,[]);
  const current=h.recorder.media;current.ondataavailable({data:new Blob(['second'])});const second=h.recorder.stop();current.onstop();assert.equal(await (await second).blob.text(),'second');
});
