// Shared browser-only capture protocol. A complete manifest binds local capture
// time to verified audio bytes; neither sync time nor save time is a date anchor.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const AUDIO=/\.(?:m4a|mp4|mp3|webm|ogg|oga|opus|wav|flac|aac|3gp)$/i;
const KEYS=['version','kind','mode','recordingId','recordedAt','localDate','localTime','utcOffsetMinutes','timeZone','audioName','audioSha256','byteLength','complete'];
const pad=value=>String(value).padStart(2,'0');
function invalid(){throw new Error('录音时间清单无效或与音频不一致，请等待同步完成后重试');}
function basename(value){return String(value||'').replace(/\\/g,'/').split('/').pop();}
function validName(value){return typeof value==='string'&&value.length>0&&value.length<=255&&!/[\\/\x00-\x1f\x7f:*?"<>|]/.test(value)&&value!=='.'&&value!=='..'&&!/[ .]$/.test(value);}
function utf8Length(value){let count=0;for(const char of value){const code=char.codePointAt(0);count+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;}return count;}
function capturedTime(timestamp=Date.now()){
  const date=new Date(timestamp);
  if(!Number.isFinite(date.getTime())||date.getFullYear()<1970||date.getFullYear()>9999)invalid();
  let timeZone=null;try{timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||null;}catch{}
  return {recordedAt:date.getTime(),localDate:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`,
    localTime:`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    utcOffsetMinutes:-date.getTimezoneOffset(),timeZone,recordingId:globalThis.crypto.randomUUID()};
}
function pinCapture(pending,timestamp=Date.now()){
  if(pending.mode==='todo'&&(!Number.isFinite(pending.recordedAt)||!pending.localDate||!pending.localTime||!pending.recordingId||!Number.isInteger(pending.utcOffsetMinutes)))invalid();
  pending.recordedAt??=timestamp;
  // Compatibility for in-memory recordings created before a plugin reload.
  if(!pending.localDate||!pending.localTime||!pending.recordingId){
    const captured=capturedTime(pending.recordedAt);
    for(const [key,value] of Object.entries(captured))if(pending[key]===undefined)pending[key]=value;
  }
  pending.mode=pending.mode==='todo'?'todo':'diary';return pending;
}
function captureName(pending,extension){
  pinCapture(pending);
  if(!/^(m4a|webm|ogg|wav)$/.test(extension)||!/^\d{4}-\d{2}-\d{2}$/.test(pending.localDate)||!/^\d{2}:\d{2}:\d{2}$/.test(pending.localTime))invalid();
  const id=pending.mode==='todo'&&!pending.recovered?pending.recordingId:globalThis.crypto.randomUUID();
  if(!UUID.test(id))invalid();
  return `${pending.mode==='todo'?'todo':'voice'}-${pending.localDate}-${pending.localTime.replace(/:/g,'')}-${id}.${extension}`;
}
function metadataPath(audioPath){return `${audioPath}.voice.json`;}
function isTodoAudio(file){const name=basename(typeof file==='string'?file:file?.path||file?.name);return /^todo-/i.test(name)&&AUDIO.test(name);}
function parseRecordingMetadata(value,file,sha,options={}){
  let encoded;
  try{encoded=typeof value==='string'?value:JSON.stringify(value);}catch{invalid();}
  if(typeof encoded!=='string'||encoded.length>8192||utf8Length(encoded)>8192)invalid();
  let data;try{data=JSON.parse(encoded);}catch{invalid();}
  if(!data||Array.isArray(data)||typeof data!=='object'||Object.keys(data).length!==KEYS.length||KEYS.some(key=>!Object.hasOwn(data,key)))invalid();
  if(data.version!==1||data.kind!=='voice-diary-recording'||data.mode!=='todo'||data.complete!==true||typeof data.recordingId!=='string'||!UUID.test(data.recordingId)||
    typeof data.recordedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.recordedAt)||
    typeof data.localDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.localDate)||typeof data.localTime!=='string'||!/^\d{2}:\d{2}:\d{2}$/.test(data.localTime)||
    !Number.isInteger(data.utcOffsetMinutes)||Math.abs(data.utcOffsetMinutes)>840||
    !validName(data.audioName)||!AUDIO.test(data.audioName)||typeof data.audioSha256!=='string'||!HASH.test(data.audioSha256)||
    !Number.isSafeInteger(data.byteLength)||data.byteLength<=0)invalid();
  const instant=new Date(data.recordedAt),local=new Date(instant.getTime()+data.utcOffsetMinutes*60000);
  if(!Number.isFinite(instant.getTime())||instant.toISOString()!==data.recordedAt||instant.getUTCFullYear()<1970||
    local.toISOString().slice(0,10)!==data.localDate||local.toISOString().slice(11,19)!==data.localTime)invalid();
  if(data.timeZone!==null){
    if(typeof data.timeZone!=='string'||data.timeZone.length>100||!/^[-+A-Za-z0-9_/]+$/.test(data.timeZone))invalid();
    try{
      const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:data.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant).map(part=>[part.type,part.value]));
      if(`${parts.year}-${parts.month}-${parts.day}`!==data.localDate||`${parts.hour}:${parts.minute}:${parts.second}`!==data.localTime)invalid();
    }catch{invalid();}
  }
  const filePath=typeof file==='string'?file:file?.path||file?.name;
  if(!filePath||!AUDIO.test(filePath))invalid();
  if(data.audioName!==basename(filePath)&&!(options.allowRename===true&&sha===data.audioSha256))invalid();
  if(file?.stat?.size!==undefined&&file.stat.size!==data.byteLength)invalid();
  if(sha!==undefined&&(typeof sha!=='string'||!HASH.test(sha)||sha!==data.audioSha256))invalid();
  return data;
}
async function recordingMetadata(pending,bytes,audioPath){
  pinCapture(pending);
  if(pending.mode!=='todo')invalid();
  const data=new Uint8Array(bytes);
  const digest=await globalThis.crypto.subtle.digest('SHA-256',data);
  const audioSha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  const manifest={version:1,kind:'voice-diary-recording',mode:'todo',recordingId:pending.recordingId,
    recordedAt:new Date(pending.recordedAt).toISOString(),localDate:pending.localDate,localTime:pending.localTime,
    utcOffsetMinutes:pending.utcOffsetMinutes,timeZone:pending.timeZone??null,audioName:basename(audioPath),audioSha256,
    byteLength:data.byteLength,complete:true};
  return parseRecordingMetadata(manifest,{path:audioPath,stat:{size:data.byteLength}},audioSha256);
}
async function saveRecordingMetadata(vault,pending,bytes,audioPath){
  const manifest=await recordingMetadata(pending,bytes,audioPath),text=JSON.stringify(manifest,null,2)+'\n',path=metadataPath(audioPath);
  let file=vault.getAbstractFileByPath(path);
  if(!file){
    try{file=await vault.create(path,text);}catch(error){file=vault.getAbstractFileByPath(path);if(!file)throw error;}
  }
  let matches=false;
  try{matches=!Array.isArray(file.children)&&await vault.read(file)===text;}catch{}
  if(!matches){
    // Preserve an incomplete or conflicting manifest. A retry binds a fresh
    // audio path to the same recording identity instead of overwriting it.
    pending.path=null;pending.recovered=true;
    throw new Error('待办录音时间清单未保存完整；请重试保存，原文件会保留');
  }
  return manifest;
}
function captureLabel(capture){
  const offset=capture.utcOffsetMinutes,zone=capture.timeZone||`UTC${offset<0?'-':'+'}${pad(Math.floor(Math.abs(offset)/60))}:${pad(Math.abs(offset)%60)}`;
  return `${capture.localDate} ${capture.localTime}（${zone}）`;
}
module.exports={capturedTime,pinCapture,captureName,captureLabel,recordingMetadata,saveRecordingMetadata,metadataPath,isTodoAudio,parseRecordingMetadata};
