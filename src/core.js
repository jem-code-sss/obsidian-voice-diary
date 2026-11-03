// Queue and commit rules are independent of Obsidian and exercised with a fake vault.
const {LEGACY_PROMPT: PROMPT,correctionPlan,chunkPrompt,joinCorrected}=require('./correction');
const DEFAULTS = { folder:'Voice Diary/Recordings', finalFolder:'Voice Diary/Notes', language:'zh', senseVoiceRoot:'',
  inputDeviceId:'', apiEnabled:false, apiUrl:'', apiKey:'', model:'', timeoutSeconds:120, disableThinking:true,
  prompt:PROMPT, correctionMode:'natural', chunkChars:4000, targetLanguage:'简体中文',
  actions:[{id:'grammar',title:'忠实校对',prompt:PROMPT},
    {id:'translate',title:'翻译',prompt:'将输入正文翻译为{TARGET_LANGUAGE}，只输出译文。'},
    {id:'refine',title:'润色',prompt:'润色输入文字，保持原意与事实。只输出修改后的正文。'},
    {id:'summarize',title:'总结',prompt:'简明总结输入文字，只输出总结。'},
    {id:'expand',title:'扩写',prompt:'在不编造事实的前提下扩写输入文字，只输出正文。'}] };
class DiaryError extends Error {
  constructor(code, message, options={}) { super(message); this.code=code; Object.assign(this,options); }
}
const clone = value => JSON.parse(JSON.stringify(value));
const signature = f => `${f.stat.size}:${f.stat.mtime}`;
const isAudio = f => /\.(m4a|mp3|wav|webm|ogg|oga|opus|flac|aac|3gp)$/i.test(f.path);
function folderPath(value,label='目录') {
  const p=typeof value==='string'?value.trim().replace(/\\/g,'/').replace(/\/+$/,''):'';
  if (!p || p.startsWith('/') || /[\x00-\x1f\[\]#:*?"<>|]/.test(p) || p.split('/').some(x=>!x || x==='.' || x==='..'))
    throw new DiaryError('folder',`${label}须为仓库内的相对目录，例如 Voice Diary/Notes`, {pause:true});
  return p;
}
async function ensureFolder(vault,value) {
  const folder=folderPath(value);let current='';
  for(const segment of folder.split('/')) {
    current=current?current+'/'+segment:segment;
    let existing=vault.getAbstractFileByPath(current);
    if(!existing) {
      try {await vault.createFolder(current);}catch(e) {
        existing=vault.getAbstractFileByPath(current);
        if(!existing)throw e;
      }
      existing=vault.getAbstractFileByPath(current);
    }
    if(!existing||!Array.isArray(existing.children))throw new DiaryError('folder',`目录路径被文件占用或无法创建：${current}`, {manual:true});
  }
  return folder;
}
function transcriptPath(audio,folder,number=1) {
  const stem=audio.slice(audio.lastIndexOf('/')+1).replace(/\.[^/.]+$/,'');
  return `${folderPath(folder,'成品笔记目录')}/${stem}${number>1?'-'+number:''}-transcript.md`;
}
function numberedTranscript(path,number) {return number===1?path:path.replace(/-transcript\.md$/i,`-${number}-transcript.md`);}
function splitText(text, limit=4000) {
  const chunks=[]; let rest=text;
  limit=Math.max(500,Math.min(16000,Number(limit)||4000));
  while(rest.length>limit) {
    let cut=-1;
    for (let i=limit-1; i>=Math.floor(limit/2); i--)
      if (/[\n。！？!?；;]/.test(rest[i]) || (rest[i]==='.'&&!/[\dA-Za-z]/.test(rest[i+1]||''))) {cut=i+1;break;}
    if(cut<0)for(let i=limit-1;i>=Math.floor(limit/2);i--)
      if(/[，,、\s]/.test(rest[i])) {cut=i+1;break;}
    if (cut<0) cut=limit;
    // Never split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(rest[cut-1])) cut--;
    chunks.push(rest.slice(0,cut)); rest=rest.slice(cut);
  }
  if(rest.length) chunks.push(rest);
  return chunks;
}
async function sha256(data) {
  const input=typeof data==='string'?new TextEncoder().encode(data):data;
  const hash=await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
}
function finalContent(job) {
  const stage=job.stage==='local_transcribed'?'local_transcribed':'qwen_corrected';
  return `---\nsource_audio: ${JSON.stringify(job.path)}\nvoice_diary_stage: ${stage}\nreview_status: 待核对\nvoice_diary_job_id: ${JSON.stringify(job.id)}\nvoice_diary_source_sha256: ${JSON.stringify(job.sha)}\n---\n\n![[${job.path}]]\n\n${job.corrected.trim()}\n`;
}
function matchesFinal(body, sha) {
  const fm=body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm || !/^voice_diary_stage: (?:qwen_corrected|local_transcribed)\s*$/m.test(fm[1])) return false;
  const value=fm[1].match(/^voice_diary_source_sha256:\s*"?([a-f0-9]{64})"?\s*$/m)?.[1];
  const prose=body.slice(fm[0].length).replace(/!\[\[[^\n]*\]\]/g,'').trim();
  return value===sha && !!prose;
}
const settingText=value=>typeof value==='string'?value.trim():'';
const localApi=url=>/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
function apiMode(config={}) {
  if(config.apiEnabled===false)return 'disabled';
  if(!settingText(config.apiUrl)||!settingText(config.model))return 'unconfigured';
  let url;
  try {url=new URL(config.apiUrl);}catch {return settingText(config.apiKey)?'enabled':'unconfigured';} // Missing credentials stay local; malformed configured addresses are validated.
  if(!localApi(url)&&!settingText(config.apiKey))return 'unconfigured';
  return 'enabled';
}
function normalizeApi(config={}) {
  return {...config,apiEnabled:typeof config.apiEnabled==='boolean'?config.apiEnabled:apiMode(config)==='enabled'};
}
function requireApi(config) {
  if(apiMode(config)!=='enabled')throw new DiaryError('api-disabled','文字 API 未开启或配置未填完整；当前仅本地转写。如需文字整理，请开启 API 并补齐配置', {manual:true});
}
function llmConfig(config) {
  requireApi(config);
  let url;
  try {url=new URL(config.apiUrl);} catch {throw new DiaryError('config','请设置完整的文字接口地址', {pause:true});}
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !String(config.model).trim())
    throw new DiaryError('config','请检查文字接口地址和模型配置', {pause:true});
  const local=localApi(url);
  if (!local && !String(config.apiKey).trim()) throw new DiaryError('config','请填写本机 API Key 或迁移原配置', {pause:true});
  const body={model:config.model, temperature:0.1, stream:false};
  // Provider-specific extension is never sent to generic compatible endpoints.
  const dash=/^(?:dashscope(?:-intl|-us)?\.aliyuncs\.com|dashscope\.aliyun\.com)$/.test(url.hostname);
  if (config.disableThinking && dash && /^qwen(?:3(?:\.[0-9]+)?(?:-|$)|-(?:plus|flash|turbo)(?:-|$))/i.test(config.model)) body.enable_thinking=false;
  return {url:url.href, body};
}
class LlmClient {
  constructor(request, timers, canRequest=()=>true) {
    this.request=request;
    this.canRequest=canRequest;
    // Browser timers require their Window receiver. Storing native functions in
    // an arbitrary object changes `this` and throws Illegal invocation in Electron.
    this.timers=timers||{
      setTimeout:(fn,delay)=>globalThis.setTimeout(fn,delay),
      clearTimeout:id=>globalThis.clearTimeout(id)
    };
    this.active=false;
  }
  async complete(config, text, prompt) {
    requireApi(config);
    if(!this.canRequest())throw new DiaryError('api-disabled','文字 API 已关闭，未发送请求', {manual:true});
    if(this.active) throw new DiaryError('inflight','前一次接口请求尚未结束，请稍后重试', {manual:true});
    const {url,body}=llmConfig(config);
    this.active=true;
    const headers={'Content-Type':'application/json'};
    if(config.apiKey) headers.Authorization=`Bearer ${config.apiKey}`;
    let timer;
    // requestUrl cannot abort. Keep the busy guard until the underlying promise settles.
    const pending=Promise.resolve().then(()=>{
      if(!this.canRequest())throw new DiaryError('api-disabled','文字 API 已关闭，未发送请求', {manual:true});
      return this.request({url,method:'POST',headers,
        body:JSON.stringify({...body,messages:[{role:'system',content:prompt},{role:'user',content:text}]}),throw:false});
    });
    this.pending=pending;
    pending.then(()=>{this.active=false;this.pending=null;},()=>{this.active=false;this.pending=null;});
    let result;
    try {
      result=await Promise.race([pending,new Promise((_,reject)=>{
        timer=this.timers.setTimeout(()=>reject(new DiaryError('timeout','接口请求超时；服务端可能已处理，请手动重试', {manual:true})),Math.max(30,Math.min(300,Number(config.timeoutSeconds)||120))*1000);
      })]);
    } catch(e) {
      if(e instanceof DiaryError) throw e;
      throw new DiaryError('network','文字接口连接失败，请检查网络');
    } finally {if(timer!==undefined)this.timers.clearTimeout(timer);}
    if(result.status!==200) {
      const status=Number(result.status)||0;
      if([400,401,403,404,422].includes(status)) throw new DiaryError('config',`文字接口 HTTP ${status}，请检查 Key、模型及接口参数`, {pause:true});
      throw new DiaryError('http',`文字接口 HTTP ${status}`, {manual:status!==429 && status<500});
    }
    let choice;
    try {choice=result.json?.choices?.[0];} catch {throw new DiaryError('response','接口返回的 JSON 无效', {manual:true});}
    if(choice?.finish_reason!=='stop') throw new DiaryError('response','模型输出被截断或未正常结束，未创建最终稿', {manual:true});
    const content=choice?.message?.content;
    if(typeof content!=='string' || !content.trim()) throw new DiaryError('response','模型没有返回有效正文', {manual:true});
    return content.trim();
  }
}
class Queue {
  constructor({vault,state,save,transcribe,llm,config,notify=()=>{},now=Date.now,closed=()=>false}) {
    Object.assign(this,{vault,state,save,transcribe,llm,config,notify,now,closed});
    this.observed=new Map(); this.busy=false;
  }
  files() {
    const prefix=folderPath(this.config().folder,'录音保存目录')+'/';
    return this.vault.getFiles().filter(f=>{
      const job=this.state.jobs[f.path];
      return isAudio(f)&&(f.path.startsWith(prefix)||(job&&!['ignored','done'].includes(job.status)));
    });
  }
  async fingerprint(file, expected=signature(file)) {
    const bytes=await this.vault.readBinary(file);
    const sha=await sha256(bytes);
    const current=this.vault.getAbstractFileByPath(file.path);
    if (!current || signature(current)!==expected || bytes.byteLength!==file.stat.size) throw new DiaryError('changed','录音仍在变化，等待稳定');
    return sha;
  }
  async arm(on) {
    if(this.busy) {if(!on){this.state.enabled=false;await this.save();return;} throw new DiaryError('busy','当前任务结束后再开启自动处理');}
    this.busy=true;
    try {
      if(on&&!this.state.initialized) {
        for(const f of this.files()) {
          const existing=this.state.jobs[f.path];
          if(existing){if(existing.status==='ignored'&&!existing.sha){try{existing.sha=await this.fingerprint(f);}catch{}}continue;}
          const j={path:f.path,status:'ignored',sig:signature(f)};
          this.state.jobs[f.path]=j;
          try {j.sha=await this.fingerprint(f);} catch {}
        }
        this.state.initialized=true;
      }
      this.state.enabled=on; await this.save();
    } finally {this.busy=false;}
  }
  enqueue(file) {
    if(this.busy) throw new DiaryError('busy','请等待当前处理结束再选择历史录音');
    const prior=this.state.jobs[file.path];
    if(prior?.status==='done') throw new DiaryError('done','此录音已有完成记录，请先查看最终稿');
    this.state.jobs[file.path]={...(prior?.status==='ignored'?{}:prior),path:file.path,status:'observed',manual:true,tries:0,next:0};
    return this.save();
  }
  async retry() {
    if(this.busy) throw new DiaryError('busy','当前任务仍在运行');
    for(const j of Object.values(this.state.jobs)) if(j.status==='error') {
      j.status='observed';j.tries=0;j.next=0;delete j.error;
      if(!j.parts?.length) {delete j.chunks;delete j.parts;delete j.correctionConfig;}
    }
    await this.save();
  }
  async restartChangedCorrections() {
    if(this.busy)throw new DiaryError('busy','当前任务仍在运行');
    let count=0;
    for(const j of Object.values(this.state.jobs))if(j.status==='error'&&j.errorCode==='correction-config') {
      // Explicit user action: keep ASR, but recompute every corrected chunk under
      // one endpoint/model. Never silently mix providers or reuse a rotated key.
      for(const key of ['chunks','parts','corrected','correctionConfig','error','errorCode'])delete j[key];
      j.status='observed';j.tries=0;j.next=0;count++;
    }
    if(count)await this.save();
    return count;
  }
  async findFinal(sha) {
    // Metadata permits recovery even when final creation succeeded before state persistence.
    for(const f of this.vault.getFiles().filter(f=>/-transcript\.md$/i.test(f.path))) {
      if(matchesFinal(await this.vault.read(f),sha)) return f.path;
    }
    return null;
  }
  async tick() {
    if(this.busy||this.closed()||!this.state.enabled) return;
    this.busy=true;
    try {
      for(const f of this.files()) {
        let j=this.state.jobs[f.path];
        if(!j) {j=this.state.jobs[f.path]={path:f.path,status:'observed',tries:0};await this.save();}
        if(j.status==='ignored'||j.status==='done'||j.status==='error'||(j.next||0)>this.now()) continue;
        const sig=signature(f), seen=this.observed.get(f.path);
        if(!seen||seen.sig!==sig) {this.observed.set(f.path,{sig,at:this.now()});continue;}
        if(!f.stat.size||this.now()-seen.at<30000) continue;
        try {await this.process(f,j,sig);} catch(e) {
          if(this.closed()) break;
          if(e.code==='changed') {
            this.reset(j);this.observed.delete(f.path);j.status='observed';j.next=0;
          } else {
            j.tries=(j.tries||0)+1;
            j.error=e instanceof DiaryError?e.message:'本地转写或文件保存失败；请检查模型、目录权限及可用空间';
            j.errorCode=e instanceof DiaryError?e.code:'local';
            j.status=e.pause||e.manual||j.tries>=3?'error':'retry_wait';j.next=this.now()+60000;
            if(e.pause) this.state.enabled=false;
            this.notify(j.error);
          }
          await this.save();
        }
        break;
      }
    } finally {this.busy=false;}
  }
  reset(j) { for(const k of ['sha','raw','chunks','parts','corrected','target','output','id','sig','correctionConfig','processingMode','stage']) delete j[k]; }
  useLocalTranscript(j) {
    j.processingMode='local';j.stage='local_transcribed';j.corrected=j.raw;
    for(const key of ['chunks','parts','correctionConfig'])delete j[key];
    j.status='committing';
  }
  async process(file,j,sig) {
    const sha=await this.fingerprint(file,sig);
    if(j.sha&&j.sha!==sha) this.reset(j);
    j.sha=sha;j.sig=sig;j.id||=globalThis.crypto.randomUUID();
    const recovered=await this.findFinal(sha);
    if(recovered) {j.output=recovered;j.status='done';delete j.error;await this.save();return;}
    const duplicate=Object.values(this.state.jobs).find(x=>x!==j&&x.sha===sha&&x.status==='ignored');
    if(duplicate&&!j.manual) {j.status='ignored';await this.save();return;}
    // Existing transcripts are protected even if their historical stage cannot be established.
    if(!j.target) {
      j.target=j.output||transcriptPath(file.path,this.config().finalFolder??DEFAULTS.finalFolder);
      await this.save();
    }
    const canonical=j.target,legacy=file.path.replace(/\.[^/.]+$/,'-transcript.md');
    if(!j.corrected && [canonical,legacy].some(path=>this.vault.getAbstractFileByPath(path)))
      throw new DiaryError('conflict','成品目录或录音旁已有同名 -transcript 稿件，保留文件；请核对后另行处理', {manual:true});
    await ensureFolder(this.vault,canonical.slice(0,canonical.lastIndexOf('/')));
    if(this.closed()) return;
    if(!j.processingMode) {
      j.processingMode=apiMode(this.config())==='enabled'?'api':'local';
      await this.save();
    }
    if(!j.raw) {
      if(j.processingMode==='api'&&apiMode(this.config())==='enabled')llmConfig(this.config());
      j.status='transcribing';await this.save();
      this.notify(`正在本地转写：${file.name}`);
      const raw=await this.transcribe(file);
      if(typeof raw!=='string'||!raw.trim()) throw new DiaryError('empty','没有识别到有效语音', {manual:true});
      if(await this.fingerprint(file,sig)!==sha) throw new DiaryError('changed','录音已改变');
      j.raw=raw.trim(); j.status='correcting';await this.save();
    }
    if(this.closed()) return;
    if(!j.corrected&&(j.processingMode==='local'||apiMode(this.config())!=='enabled')) {
      this.useLocalTranscript(j);await this.save();
    }
    if(!j.corrected) {
      // Settings are device-local and may change between attempts or chunks.
      // A saved endpoint must never be combined with the current endpoint's key.
      const sameProvider=()=>{
        const current=this.config(),prior=j.correctionConfig;
        if(!prior)return true;
        let currentUrl,priorUrl;
        try {currentUrl=new URL(current.apiUrl).href;priorUrl=new URL(prior.apiUrl).href;}catch {return false;}
        return currentUrl===priorUrl&&String(current.model).trim()===String(prior.model).trim();
      };
      const verifyProvider=()=>{
        if(!sameProvider())throw new DiaryError('correction-config','文字接口或模型已更改，已暂停此任务。可改回原配置后重试，或点击“按新配置重新校对”；本地转写保留', {manual:true});
      };
      if(j.chunks&&!j.parts?.length&&!sameProvider()) {
        delete j.chunks;delete j.parts;delete j.correctionConfig;
      }
      verifyProvider();
      if(!j.chunks) {j.chunks=splitText(j.raw,this.config().chunkChars);j.parts=[];
        // Preserve prompt/model semantics across partial retries without storing a second API key.
        const cfg=this.config(); j.correctionConfig={model:cfg.model,apiUrl:cfg.apiUrl,...correctionPlan(cfg),disableThinking:cfg.disableThinking};
        await this.save();}
      for(let i=j.parts.length;i<j.chunks.length;i++) {
        if(this.closed()) return;
        if(apiMode(this.config())!=='enabled'){this.useLocalTranscript(j);await this.save();break;}
        verifyProvider();
        this.notify(`正在校对：${file.name}（${i+1}/${j.chunks.length}）`);
        const cfg={...clone(this.config()),...j.correctionConfig};
        const prompt=chunkPrompt(j.correctionConfig,j.chunks,i);
        let part;
        try {part=await this.llm.complete(cfg,j.chunks[i],prompt);}catch(e) {
          if(!this.closed()&&apiMode(this.config())!=='enabled'){this.useLocalTranscript(j);await this.save();break;}
          throw e;
        }
        j.parts.push(part); j.status='correcting';await this.save();
      }
      if(!j.corrected) {
        if(apiMode(this.config())!=='enabled')this.useLocalTranscript(j);
        else {j.corrected=joinCorrected(j.parts,j.chunks,j.correctionConfig.contextVersion);j.stage='qwen_corrected';j.status='committing';}
        await this.save();
      }
    }
    if(this.closed()) return;
    if(await this.fingerprint(file,sig)!==sha) throw new DiaryError('changed','录音已改变');
    const final=finalContent(j);
    // Create only; never modify, trash, rename or remove any existing note/audio.
    let target=j.output||canonical;
    if(j.output) {
      const existing=this.vault.getAbstractFileByPath(target);
      if(existing) {
        if(matchesFinal(await this.vault.read(existing),sha)){j.status='done';delete j.error;await this.save();return;}
        throw new DiaryError('conflict','已选定的最终稿路径被其他文件占用，保留文件', {manual:true});
      }
    }
    for(let n=1;n<=100;n++) {
      target=n===1?(j.output||canonical):numberedTranscript(canonical,n);
      if(this.vault.getAbstractFileByPath(target)) continue;
      j.output=target;j.status='committing';await this.save();
      try {await this.vault.create(target,final);break;} catch(e) {
        const existing=this.vault.getAbstractFileByPath(target);
        if(!existing) throw e;
        // Some adapters can finish the write and still reject. Recover the
        // marked recording before choosing another name and creating a duplicate.
        if(matchesFinal(await this.vault.read(existing),sha))break;
        if(n===100) throw new DiaryError('conflict','最终稿路径冲突过多', {manual:true});
      }
    }
    const saved=this.vault.getAbstractFileByPath(target);
    if(!saved || !matchesFinal(await this.vault.read(saved),sha)) throw new DiaryError('save','最终稿保存验证未通过');
    j.output=target;j.status='done';delete j.error;await this.save();
    // A completed record and the marked final remain sufficient for future deduplication.
    for(const k of ['raw','chunks','parts','corrected','correctionConfig']) delete j[k];
    await this.save();this.notify(`语音日记完成：${target}`);
  }
}
module.exports={DEFAULTS,PROMPT,DiaryError,Queue,LlmClient,clone,signature,isAudio,folderPath,ensureFolder,transcriptPath,splitText,sha256,finalContent,matchesFinal,llmConfig,apiMode,normalizeApi,requireApi};
