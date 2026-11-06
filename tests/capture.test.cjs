const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {capturedTime,captureName,recordingMetadata,metadataPath,isTodoAudio,parseRecordingMetadata}=require('../src/capture');
const ID='12345678-1234-4234-8234-123456789abc';
const bytes=new TextEncoder().encode('synthetic todo audio').buffer;
const hash=createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const audio=`Recordings/todo-2026-11-07-035900-${ID}.m4a`;
const pending=()=>({recordedAt:Date.parse('2026-11-06T19:59:00.000Z'),localDate:'2026-11-07',localTime:'03:59:00',utcOffsetMinutes:480,timeZone:'Asia/Shanghai',recordingId:ID,mode:'todo'});
const file={path:audio,stat:{size:bytes.byteLength}};
async function manifest(){return recordingMetadata(pending(),bytes,audio);}

test('manifest binds exact audio bytes to capture time before the diary day boundary',async()=>{
  const metadata=await manifest();
  assert.equal(metadata.recordedAt,'2026-11-06T19:59:00.000Z');assert.equal(metadata.localDate,'2026-11-07');
  assert.equal(metadata.audioSha256,hash);assert.equal(metadata.byteLength,bytes.byteLength);assert.equal(metadata.recordingId,ID);
  assert.deepEqual(parseRecordingMetadata(JSON.stringify(metadata),file,hash),metadata);
  assert.equal(metadataPath(audio),audio+'.voice.json');assert.equal(isTodoAudio(file),true);assert.equal(isTodoAudio('Recordings/voice-2026-11-07-035900.m4a'),false);
});

test('capture name uses frozen local time and stable todo identity across retries',()=>{
  const capture=pending();assert.equal(captureName(capture,'m4a'),path.basename(audio));
  capture.recovered=true;const retry=captureName(capture,'m4a');assert.match(retry,/^todo-2026-11-07-035900-/);assert.notEqual(retry,path.basename(audio));assert.equal(capture.recordingId,ID);
  capture.mode='diary';assert.match(captureName(capture,'webm'),/^voice-2026-11-07-035900-/);
});

test('capture local date and name survive a later device timezone change',()=>{
  const modulePath=path.join(__dirname,'../src/capture.js');
  const script=`const assert=require('node:assert/strict');const c=require(${JSON.stringify(modulePath)});process.env.TZ='Asia/Shanghai';const p={...c.capturedTime(Date.parse('2026-11-06T19:59:00Z')),mode:'todo'};process.env.TZ='America/New_York';assert.equal(p.localDate,'2026-11-07');assert.equal(p.utcOffsetMinutes,480);assert.match(c.captureName(p,'m4a'),/^todo-2026-11-07-035900-/);`;
  const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});

test('wrong hashes, lengths and conflicting calendar evidence are rejected',async()=>{
  const metadata=await manifest();
  for(const mutation of [{byteLength:1},{localDate:'2026-11-06'},{localTime:'04:00:00'},{utcOffsetMinutes:0},{timeZone:'America/New_York'},{recordedAt:'2026-02-30T19:59:00.000Z'},{complete:false},{audioSha256:'f'.repeat(64)}])
    assert.throws(()=>parseRecordingMetadata({...metadata,...mutation},file,hash));
  assert.throws(()=>parseRecordingMetadata(metadata,{...file,stat:{size:1}},hash));
});

test('manifest parsing is bounded, strict and does not accept coercible field types or extra permissions',async()=>{
  const metadata=await manifest();
  for(const mutation of [{recordingId:[ID]},{localDate:[metadata.localDate]},{localTime:[metadata.localTime]},{audioSha256:[hash]},{timeZone:{}},{apiKey:'never a manifest field'},{byteLength:'20'},{audioName:'../private.wav'},{audioName:'C:\\private.wav'}])
    assert.throws(()=>parseRecordingMetadata({...metadata,...mutation},file,hash));
  assert.throws(()=>parseRecordingMetadata(JSON.stringify({...metadata,timeZone:'界'.repeat(3000)}),file,hash));
  assert.throws(()=>parseRecordingMetadata(' '.repeat(8193),file,hash));
  assert.throws(()=>parseRecordingMetadata('{"version":1',file,hash));
});

test('audio renaming is accepted only with explicit permission and matching verified content hash',async()=>{
  const metadata=await manifest(),renamed={path:'Recordings/renamed audio.m4a',stat:{size:bytes.byteLength}};
  assert.throws(()=>parseRecordingMetadata(metadata,renamed,hash));
  assert.throws(()=>parseRecordingMetadata(metadata,renamed,undefined,{allowRename:true}));
  assert.throws(()=>parseRecordingMetadata(metadata,renamed,'f'.repeat(64),{allowRename:true}));
  assert.equal(parseRecordingMetadata(metadata,renamed,hash,{allowRename:true}).recordingId,ID);
});

test('todo metadata refuses invented capture time when session evidence is missing',async()=>{
  await assert.rejects(recordingMetadata({mode:'todo'},bytes,audio));
  assert.throws(()=>capturedTime(NaN));
});
