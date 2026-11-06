const {DiaryError}=require('./core');
const MIME_TYPES=[['audio/mp4','m4a'],['audio/webm;codecs=opus','webm'],['audio/webm','webm'],['audio/ogg;codecs=opus','ogg']];
function extension(mime) {
  if(/mp4/i.test(mime)) return 'm4a';
  if(/webm/i.test(mime)) return 'webm';
  if(/ogg/i.test(mime)) return 'ogg';
  if(/wav/i.test(mime)) return 'wav';
  throw new DiaryError('mime','浏览器返回了未支持的音频格式，录音保留在内存中');
}
class AudioRecorder {
  constructor(interrupted=()=>{}) {this.interrupted=interrupted;this.state='idle';}
  async start(deviceId='') {
    if(this.state!=='idle') return;
    if(!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder)
      throw new DiaryError('microphone','此设备不支持录音，请检查 Obsidian 麦克风权限');
    this.cancelled=false;this.state='starting';
    try {
      this.stream=await navigator.mediaDevices.getUserMedia({audio:deviceId?{deviceId:{exact:deviceId},channelCount:1}:true});
      if(this.cancelled) {this.release();this.state='idle';return;}
      const mime=MIME_TYPES.find(([m])=>MediaRecorder.isTypeSupported(m))?.[0];
      const chunks=[];this.chunks=chunks;
      this.media=mime?new MediaRecorder(this.stream,{mimeType:mime}):new MediaRecorder(this.stream);
      this.mime=this.media.mimeType||mime||'';
      extension(this.mime);
      const session={media:this.media,chunks,mime:this.mime,stopSeen:false};this.session=session;
      const current=()=>this.session===session;
      this.media.ondataavailable=e=>{if(current()&&e.data?.size) chunks.push(e.data);};
      const interrupt=reason=>{if(current()&&this.state==='recording') this.interrupted(reason);};
      this.media.onerror=()=>interrupt('device');
      this.media.onpause=()=>interrupt('paused');
      this.media.onstop=()=>{if(current()){session.stopSeen=true;interrupt('device');}};
      for(const track of this.stream.getTracks()) {
        track.onended=()=>interrupt('device');
        // Track mute means the source cannot provide data, not that the room is quiet.
        track.onmute=()=>interrupt('muted');
      }
      session.recordedAt=Date.now();
      this.media.start(500);this.startedAt=session.recordedAt;this.state='recording';
    } catch(e) {this.release();this.state='idle';throw e instanceof DiaryError?e:new DiaryError('microphone','无法开始录音，请检查麦克风权限及设备');}
  }
  async stop() {
    if(this.state!=='recording') return null;
    this.state='stopping';const session=this.session,media=session.media;
    return new Promise(resolve=>{
      let settled=false,timer;
      const finish=partial=>{
        if(settled||this.session!==session) return; settled=true;globalThis.clearTimeout(timer);
        const blob=new Blob(session.chunks,{type:session.mime});
        this.release();this.chunks=[];this.state='idle';
        resolve(blob.size?{blob,ext:extension(session.mime),partial,recordedAt:session.recordedAt}:null);
      };
      media.onstop=()=>{session.stopSeen=true;finish(false);};
      timer=globalThis.setTimeout(()=>finish(true),4000);
      // Inactive can precede the queued final dataavailable and stop events.
      if(session.stopSeen)finish(false);
      else if(media.state!=='inactive') {
        try {media.requestData?.();} catch {} // Best effort before mobile freezes.
        try {media.stop();} catch {} // Retain late final data until stop or timeout.
      }
    });
  }
  release() {
    this.session=null;
    for(const t of this.stream?.getTracks()||[]){t.onended=null;t.onmute=null;t.stop();}
    if(this.media)for(const event of ['ondataavailable','onstop','onpause','onerror'])this.media[event]=null;
    this.stream=null;
  }
}
module.exports={AudioRecorder,extension};
