const {Plugin,PluginSettingTab,Setting,Notice,Platform,TFile,Modal,MarkdownView,requestUrl,setIcon}=require('obsidian');
const {DEFAULTS,PROMPT,DiaryError,Queue,LlmClient,clone,isAudio,folderPath,ensureFolder,signature,apiMode,normalizeApi,requireApi}=require('./core');
const {MODES,normalizeCorrection}=require('./correction');
const {DeviceStore}=require('./store');
const {AudioRecorder}=require('./recorder');
// Desktop dependencies are loaded only inside the engine's methods.
const {SenseVoiceEngine,SENSEVOICE_LANGUAGES}=require('./sensevoice');
const {RuntimeAssets}=require('./runtime-assets');
const safeMessage=e=>e instanceof DiaryError?e.message:'操作未完成，请检查本机存储、设备权限或网络；原文件保留';
const INTERRUPTION={background:'手机切后台或锁屏',muted:'麦克风暂时无法收声',paused:'录音被系统暂停',device:'录音设备中断'};
class ResultModal extends Modal {
  constructor(plugin,editor,snapshot,from,to,result,sourceFile) {super(plugin.app);Object.assign(this,{plugin,editor,snapshot,from,to,result,sourceFile});}
  onOpen() {
    this.titleEl.setText('文字处理结果');
    const area=this.contentEl.createEl('textarea',{cls:'vdu-result'});area.value=this.result;area.readOnly=true;
    new Setting(this.contentEl).addButton(b=>b.setButtonText('复制').onClick(()=>void navigator.clipboard.writeText(this.result).catch(()=>new Notice('复制失败，可在结果框内手动选择复制'))))
      .addButton(b=>b.setButtonText('应用到原选区').setCta().onClick(()=>{
        const view=this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if(view?.file!==this.sourceFile||view.editor!==this.editor||this.editor.getValue()!==this.snapshot) {new Notice('笔记或当前页面已经改变，请复制结果后手动合并');return;}
        this.editor.replaceRange(this.result,this.from,this.to);this.close();
      }));
  }
  onClose(){this.contentEl.empty();}
}
module.exports=class VoiceDiaryUnified extends Plugin {
  async onload() {
    this.closed=false;this.mobile=Platform.isMobileApp||Platform.isMobile;
    this.store=new DeviceStore(this.app,this.mobile);
    try {await this.store.init();this.state=await this.store.load();}
    catch(e){await this.store.close().catch(()=>{});new Notice(safeMessage(e),12000);return;}
    const legacyPaths=this.state.config?.finalFolder===undefined;
    this.state.config={...clone(DEFAULTS),...normalizeApi(normalizeCorrection(this.state.config))};this.state.jobs||={};this.state.enabled??=false;
    if(legacyPaths)for(const job of Object.values(this.state.jobs)) {
      if(!job.target&&job.path&&(job.raw||job.corrected||['transcribing','correcting','committing'].includes(job.status)))
        job.target=job.output||job.path.replace(/\.[^/.]+$/,'-transcript.md');
    }
    this.settings=this.state.config;
    if(this.mobile){this.state.enabled=false;this.state.jobs={};this.settings.apiKey='';this.settings.apiEnabled=false;}
    this.llm=new LlmClient(requestUrl,undefined,()=>!this.closed&&!this.mobile&&apiMode(this.settings)==='enabled');
    this.recorder=new AudioRecorder(reason=>void this.interruptRecording(reason));
    if(!this.mobile){
      this.asr=new SenseVoiceEngine();this.managedSenseVoiceRoot=this.store.runtimeRoot;
      this.runtimeAssets=new RuntimeAssets({baseRuntimeCacheRoot:this.store.runtimeCacheRoot,version:this.manifest.version||'unversioned'});
    }
    if(!this.mobile) this.queue=new Queue({vault:this.app.vault,state:this.state,save:()=>this.persist(),
      config:()=>this.settings,transcribe:f=>this.transcribeLocal(f),llm:this.llm,closed:()=>this.closed,
      notify:message=>{this.progress=message;this.updateStatus();new Notice(message,6000);}});
    this.addSettingTab(new Settings(this.app,this));
    this.ribbon=this.addRibbonIcon('mic','语音日记：开始／停止录音',()=>void this.toggleRecording());
    this.status=this.addStatusBarItem();this.status.addClass('vdu-status');this.status.onclick=()=>void this.toggleRecording();
    if(this.mobile){
      this.fab=document.body.createEl('button',{cls:'vdu-mic',attr:{'aria-label':'语音日记：开始／停止录音'}});this.fab.onclick=()=>void this.toggleRecording();
      this.recordIndicator=document.body.createEl('div',{cls:'vdu-record-indicator',attr:{'aria-live':'polite'}});
      this.setupMobileRecordingGuard();
    }
    this.addCommand({id:'record',name:'开始／停止录音',callback:()=>void this.toggleRecording()});
    this.addCommand({id:'save-recording',name:'重试保存录音',callback:()=>void this.saveRecording().catch(e=>new Notice(safeMessage(e),10000))});
    if(!this.mobile) {
      this.addCommand({id:'retry',name:'重试失败的语音日记（复用检查点）',callback:()=>void this.retry()});
      this.addCommand({id:'retry-current-config',name:'按新配置重新校对因接口或模型变更而暂停的任务',callback:()=>void this.retryCurrentConfig()});
      this.addCommand({id:'pause',name:'暂停自动处理',callback:()=>void this.queue.arm(false).then(()=>this.updateStatus()).catch(e=>new Notice(safeMessage(e)))});
      this.addCommand({id:'process-active',name:'处理当前音频（含历史录音）',callback:()=>void this.enqueue(this.app.workspace.getActiveFile())});
      this.addCommand({id:'status',name:'查看任务进度',callback:()=>this.showStatus()});
      for(const action of this.settings.actions) this.addCommand({id:`text-${action.id}`,name:`选中文字：${action.title}`,editorCallback:editor=>void this.runText(editor,action)});
      this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{
        if(file instanceof TFile&&isAudio(file)) menu.addItem(item=>item.setTitle('转写为语音日记').setIcon('mic').onClick(()=>void this.enqueue(file)));
      }));
      this.registerEvent(this.app.workspace.on('editor-menu',(menu,editor)=>{
        if(editor.getSelection()) for(const action of this.settings.actions) menu.addItem(item=>item.setTitle(action.title).onClick(()=>void this.runText(editor,action)));
      }));
      this.app.workspace.onLayoutReady(()=>this.kickTick());
      this.registerInterval(window.setInterval(()=>this.kickTick(),10000));
    }
    this.registerInterval(window.setInterval(()=>this.updateStatus(),1000));this.updateStatus();
  }
  persist(){return this.store.save(this.state);}
  async setApiEnabled(enabled) {
    const previous=this.settings.apiEnabled;this.settings.apiEnabled=!!enabled;
    try {await this.persist();}catch(e){
      if(enabled){this.settings.apiEnabled=previous;throw e;}
      // A failed settings write must never silently re-enable outbound requests.
      this.updateStatus();throw new DiaryError('storage','文字 API 已在当前会话关闭，但设置保存失败；请检查磁盘并重试保存，重启前确认关闭状态', {manual:true});
    }
    this.updateStatus();
    new Notice(enabled?(apiMode(this.settings)==='enabled'?'文字 API 整理已开启；本地任务和已有成品不会自动重新整理。':'文字 API 开关已开启，但配置未填完整；当前仍仅本地转写。'):
      '文字 API 已关闭；后续不再发送请求。已发出的请求无法撤回，未完成整理的任务将保存完整本地转写。',10000);
  }
  applyFolder(key,value) {
    if(this.folderTask)return Promise.reject(new DiaryError('busy','正在应用目录设置，请稍候'));
    const task=this.commitFolder(key,value);this.folderTask=task;
    void task.then(()=>{if(this.folderTask===task)this.folderTask=null;},()=>{if(this.folderTask===task)this.folderTask=null;});
    return task;
  }
  async commitFolder(key,value) {
    const label=key==='folder'?'录音保存目录':'成品笔记目录';
    if(!['folder','finalFolder'].includes(key))throw new DiaryError('folder','未知的目录设置');
    if(this.mobile&&key==='finalFolder')throw new DiaryError('folder','成品笔记目录请在电脑端设置');
    const next=folderPath(value,label),previous=this.settings[key];
    if(next===previous)return next;
    const existing=this.app.vault.getAbstractFileByPath(next);
    if(existing&&!Array.isArray(existing.children))throw new DiaryError('folder','该路径已被文件占用，请指定文件夹');
    const added=[];let locked=false;
    if(key==='folder') {
      if(this.recordingBusy||this.recordingStop||this.pendingAudio||this.recorder.state!=='idle')throw new DiaryError('busy','请先结束并保存当前录音，再更改录音目录');
      if(!this.mobile) {
        if(this.queue.busy)throw new DiaryError('busy','请等待当前任务完成后再更改录音目录');
        this.queue.busy=true;locked=true;
      }
    }
    try {
      await ensureFolder(this.app.vault,next);
      // Switching the watched folder must not bill for its existing recordings.
      if(locked&&this.state.initialized)for(const file of this.app.vault.getFiles().filter(f=>f.path.startsWith(next+'/')&&isAudio(f))) {
        if(this.state.jobs[file.path])continue;
        const job={path:file.path,status:'ignored',sig:signature(file)};
        this.state.jobs[file.path]=job;added.push(file.path);
        try {job.sha=await this.queue.fingerprint(file);}catch {}
      }
      this.settings[key]=next;await this.persist();
      new Notice(key==='folder'?'录音目录已应用；新目录内已有录音已跳过，可手动选择处理。手机与电脑请使用相同录音目录。':'成品笔记目录已应用；新任务使用此目录，已有文件保留原位。',10000);
      return next;
    }catch(e){this.settings[key]=previous;for(const path of added)delete this.state.jobs[path];throw e;}
    finally {if(locked)this.queue.busy=false;this.updateStatus();}
  }
  setupMobileRecordingGuard() {
    if(!this.mobile)return;
    this.registerDomEvent(document,'visibilitychange',()=>{
      if(document.visibilityState==='hidden')void this.interruptRecording('background');
      else this.showRecordingInterruption();
    });
    this.registerDomEvent(window,'pagehide',()=>void this.interruptRecording('background'));
  }
  kickTick(){
    if(this.task||this.closed)return;
    const task=this.safeTick();this.task=task;
    void task.finally(()=>{if(this.task===task)this.task=null;});
  }
  async safeTick() {
    if(this.closed||!this.queue||this.preparing||this.manualBusy||this.llm.active||this.oldProcessorActive()||this.recorder.state!=='idle'||this.pendingAudio) return;
    try {await this.queue.tick();} catch {this.state.enabled=false;new Notice('本机检查点保存失败，自动处理已暂停；请检查磁盘空间和权限',10000);}
    this.updateStatus();
  }
  oldProcessorActive() {
    const old=this.app.plugins.getPlugin('voice-diary-auto');
    if(old?.state?.enabled||old?.busy) {if(!this.oldWarned){new Notice('请先在 Voice Diary Auto 中暂停自动处理，避免同一录音重复调用',12000);this.oldWarned=true;}return true;}
    this.oldWarned=false;return false;
  }
  async runtimeScript() {
    if(this.mobile||this.closed)throw new DiaryError('closed','本地识别已关闭，未准备运行文件', {pause:true});
    if(!this.runtimeAssets) {
      if(typeof this.store?.runtimeCacheRoot!=='string'||!this.store.runtimeCacheRoot)
        throw new DiaryError('runtime_assets','无法确定本地识别运行文件目录，请重新加载插件', {pause:true});
      this.runtimeAssets=new RuntimeAssets({baseRuntimeCacheRoot:this.store.runtimeCacheRoot,version:this.manifest.version||'unversioned'});
    }
    const scriptPath=await this.runtimeAssets.ensureRunner();
    if(this.closed)throw new DiaryError('closed','本地识别已关闭，未启动识别', {pause:true});
    return scriptPath;
  }
  async senseVoiceOptions(root=this.settings.senseVoiceRoot||this.managedSenseVoiceRoot) {
    return {root,scriptPath:await this.runtimeScript(),language:this.settings.language,
      onProgress:progress=>{
        this.progress=progress.stage==='loading'?'正在加载 SenseVoice 本地模型…':progress.stage==='complete'?'SenseVoice 本地识别完成':
          'SenseVoice 本地识别'+(progress.pct!=null?` ${Math.round(progress.pct)}%`:'');
        this.updateStatus();}};
  }
  async transcribeLocal(file) {
    if(this.mobile) throw new DiaryError('mobile','手机只保存录音');
    const audio=await this.app.vault.readBinary(file);
    return this.asr.transcribe({...await this.senseVoiceOptions(),audio});
  }
  async prepareModel() {
    if(this.mobile||this.closed||this.queue.busy||this.preparing) return;
    this.preparing=true;this.progress='正在检查 SenseVoice 本地模型…';this.updateStatus();
    try {const info=await this.asr.prepare(await this.senseVoiceOptions());if(!this.closed)new Notice(`模型就绪：${info.model} (${info.device})`);}
    catch(e){if(!this.closed)new Notice(safeMessage(e),10000);}finally{this.preparing=false;this.progress='';this.updateStatus();}
  }
  async applySenseVoiceRoot(value) {
    if(this.mobile||this.closed||this.queue.busy||this.preparing)throw new DiaryError('busy','请等待当前识别或模型检查完成');
    const next=String(value).trim()||this.managedSenseVoiceRoot,previous=this.settings.senseVoiceRoot;
    this.preparing=true;this.progress='正在检查 SenseVoice 本地模型…';this.updateStatus();
    try {
      await this.asr.prepare(await this.senseVoiceOptions(next));
      if(this.closed)throw new DiaryError('closed','插件已关闭，未应用安装目录');
      this.settings.senseVoiceRoot=next;
      try{await this.persist();}catch(e){this.settings.senseVoiceRoot=previous;throw e;}
      new Notice('SenseVoice 已检查可用，安装目录已应用');return next;
    }finally{this.preparing=false;this.progress='';this.updateStatus();}
  }
  async toggleRecording() {
    if(this.recordingBusy||this.closed) return;
    if(this.folderTask){new Notice('正在应用目录设置，请稍候再开始录音');return;}
    this.recordingBusy=true;
    try {
      if(this.recorder.state==='recording') {
        await this.stopRecording();
      } else if(this.pendingAudio) await this.saveRecording();
      else {
        if(this.mobile&&document.visibilityState==='hidden')throw new DiaryError('background','请回到 Obsidian 前台再开始录音');
        folderPath(this.settings.folder);
        this.recordFolder=this.settings.folder;
        this.recordingInterruption=null;this.interruptionShown=false;
        await this.recorder.start(this.settings.inputDeviceId);
        if(this.mobile&&document.visibilityState==='hidden')await this.interruptRecording('background');
        if(this.recorder.state==='recording')new Notice(this.mobile?'录音开始，请保持 Obsidian 前台；再次点击即可保存':'录音开始，再次点击麦克风即可保存');
      }
    } catch(e){new Notice(safeMessage(e),10000);}
    finally{this.recordingBusy=false;this.updateStatus();}
  }
  async interruptRecording(reason='device') {
    if(this.closed||!['starting','recording','stopping'].includes(this.recorder.state))return;
    this.recordingInterruption||=INTERRUPTION[reason]||INTERRUPTION.device;
    if(this.recorder.state==='starting') {
      // Permission may resolve after the app has already left the foreground.
      this.recorder.cancelled=true;this.updateStatus();return;
    }
    await this.stopRecording(this.recordingInterruption);
  }
  stopRecording(interruption=null) {
    if(this.recordingStop)return this.recordingStop;
    if(this.recorder.state!=='recording')return Promise.resolve();
    this.recordingBusy=true;
    const task=(async()=>{
      try {
        const stopped=this.recorder.stop();this.updateStatus();
        const pending=await stopped;
        if(!pending){new Notice('没有收到音频，请检查麦克风');return;}
        if(interruption)pending.interruption=interruption;
        this.pendingAudio=pending;
        await this.saveRecording();
      }catch(e){new Notice(safeMessage(e),12000);}
      finally {this.recordingBusy=false;this.updateStatus();}
    })();
    this.recordingStop=task;
    void task.then(()=>{if(this.recordingStop===task)this.recordingStop=null;},()=>{if(this.recordingStop===task)this.recordingStop=null;});
    return task;
  }
  showRecordingInterruption() {
    if(!this.recordingInterruption||this.interruptionShown)return;
    this.interruptionShown=true;
    const state=this.pendingAudio?'音频待保存，请点击重试':this.recordingStop?'正在保存本段音频':'录音已结束，点击麦克风可再录一段';
    new Notice(`${this.recordingInterruption}：${state}。`,4000);
    this.updateStatus();
  }
  async saveRecording() {
    if(!this.pendingAudio||this.saving) return;
    this.saving=true;
    try {
      const pending=this.pendingAudio;
      const folder=await ensureFolder(this.app.vault,this.recordFolder||this.settings.folder);
      const bytes=await pending.blob.arrayBuffer();
      if(!pending.path){const d=new Date();const pad=n=>String(n).padStart(2,'0');
        pending.path=`${folder}/voice-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomUUID().slice(0,8)}.${pending.ext}`;}
      // If a previous call wrote before rejecting, byte equality proves retry safety.
      let file=this.app.vault.getAbstractFileByPath(pending.path);
      if(file){const saved=new Uint8Array(await this.app.vault.readBinary(file)),original=new Uint8Array(bytes);
        if(saved.length!==original.length||saved.some((v,i)=>v!==original[i])) throw new DiaryError('save','录音目标路径被占用；音频保留在内存，重启前请另存');}
      else file=await this.app.vault.createBinary(pending.path,bytes);
      const check=new Uint8Array(await this.app.vault.readBinary(file)),original=new Uint8Array(bytes);
      if(check.length!==original.length||check.some((v,i)=>v!==original[i])) throw new DiaryError('save','录音保存验证失败，请重试保存');
      this.pendingAudio=null;
      new Notice(`录音已保存：${file.name}${pending.interruption?`；${pending.interruption}，录音已结束`:''}${pending.partial?'；设备中断，末尾可能不完整':''}`,pending.interruption?4000:10000);
    } catch(e){new Notice('录音尚未保存，音频仍在内存。请修复目录权限后点击麦克风或“重试保存录音”，暂勿退出 Obsidian',15000);throw e;}
    finally{this.saving=false;this.updateStatus();}
  }
  async enqueue(file) {
    try {
      if(this.mobile||!file||!isAudio(file)) throw new DiaryError('audio','请先打开或右键选择一段录音');
      if(!file.path.startsWith(folderPath(this.settings.folder)+'/')) throw new DiaryError('folder','请选择录音目录内的音频');
      if(this.oldProcessorActive()) return;
      await this.queue.enqueue(file);new Notice('录音已加入队列；开启自动处理后，稳定 30 秒再处理');
    } catch(e){new Notice(safeMessage(e),10000);}
  }
  async retry() {try{if(this.oldProcessorActive())return;await this.queue.retry();new Notice('失败任务已重置，复用已有检查点；请确保自动处理已开启');this.kickTick();}catch(e){new Notice(safeMessage(e));}}
  async retryCurrentConfig() {
    try {
      if(this.oldProcessorActive())return;
      const count=await this.queue.restartChangedCorrections();
      new Notice(count?`已将 ${count} 个配置变更任务加入队列；复用本地转写，${apiMode(this.settings)==='enabled'?'校对将重新请求文字接口':'当前仅本地模式，将保存完整本地转写'}。请确保自动处理开启。`:'没有因接口或模型变更而暂停的任务',12000);
      if(count)this.kickTick();
    }catch(e){new Notice(safeMessage(e),12000);}
  }
  async runText(editor,action) {
    if(this.mobile||this.closed||this.manualBusy) return;
    try {requireApi(this.settings);}catch(e){new Notice(safeMessage(e),10000);return;}
    if(this.queue.busy||this.llm.active){new Notice('请等待当前校对请求完成');return;}
    const text=editor.getSelection();
    if(!text){new Notice('请先选中需要处理的文字');return;}
    const snapshot=editor.getValue(),from=editor.getCursor('from'),to=editor.getCursor('to');
    const sourceFile=this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    this.manualBusy=true;
    try {
      const cfg=clone(this.settings),prompt=action.prompt.replaceAll('{TARGET_LANGUAGE}',cfg.targetLanguage);
      const parts=[];
      for(const chunk of require('./core').splitText(text,cfg.chunkChars)){if(this.closed)return;requireApi(this.settings);parts.push(await this.llm.complete(cfg,chunk,prompt));}
      if(!this.closed)new ResultModal(this,editor,snapshot,from,to,parts.join('\n\n'),sourceFile).open();
    }catch(e){new Notice(safeMessage(e),10000);}finally{this.manualBusy=false;}
  }
  async testConnection() {
    if(this.queue?.busy||this.manualBusy||this.llm.active){new Notice('请等待当前任务完成');return;}
    try {
      requireApi(this.settings);
      await this.llm.complete(clone(this.settings),'测试','只回复“连接成功”。');
      new Notice('文字接口连接成功');
    } catch(e) {
      if(e instanceof DiaryError){new Notice(`连接测试失败：${e.message}`,12000);return;}
      // Never display raw errors: request libraries may include URLs, keys or bodies.
      const label=['TypeError','RangeError','SyntaxError'].includes(e?.name)?e.name:'Error';
      new Notice(`连接测试发生插件内部错误（${label}），请保留当前配置并反馈此提示`,12000);
    }
  }
  showStatus() {
    const modal=new Modal(this.app);modal.titleEl.setText('语音日记任务');
    const labels={ignored:'已跳过',observed:'等待稳定',transcribing:'本地转写',correcting:'文字校对',committing:'保存最终稿',done:'已完成',retry_wait:'等待重试',error:'失败'};
    const jobs=Object.values(this.state.jobs).filter(j=>j.status!=='ignored');
    modal.contentEl.createEl('p',{text:`自动处理${this.state.enabled?'已开启':'已暂停'}；${apiMode(this.settings)==='enabled'?'文字 API 整理':'仅本地转写'}；${this.progress||'空闲'}。`});
    for(const j of jobs.slice(-30).reverse()) modal.contentEl.createEl('p',{text:`${j.path}：${labels[j.status]||j.status}${j.error?' · '+j.error:''}`});
    if(!jobs.length)modal.contentEl.createEl('p',{text:'暂无任务。首次开启会跳过既有录音。'});
    modal.open();
  }
  updateStatus() {
    if(!this.recorder)return;
    const recording=this.recorder.state==='recording';
    const seconds=recording?Math.floor((Date.now()-this.recorder.startedAt)/1000):0;
    const label=recording?`录音 ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} · 点击保存`:
      this.pendingAudio?'录音待保存 · 点击重试':this.recorder.state==='starting'?'正在请求麦克风…':this.recordingBusy?'正在保存录音…':this.queue?.busy||this.preparing?this.progress||'正在处理语音日记':`语音日记${this.mobile?' · 仅录音':(this.state.enabled?' · 自动处理开启':' · 自动处理暂停')+(apiMode(this.settings)==='enabled'?' · API 整理':' · 仅本地转写')}`;
    this.status?.setText(label);
    if(this.ribbon){setIcon(this.ribbon,recording?'square':'mic');this.ribbon.setAttribute('aria-label',label);}
    if(this.fab){setIcon(this.fab,recording?'square':'mic');this.fab.setAttribute('aria-label',label);this.fab.classList.toggle('is-recording',recording);}
    this.recordIndicator?.setText(recording||this.pendingAudio||this.recordingBusy?label:'');
  }
  async migrate() {
    if(this.mobile||this.queue.busy||this.preparing||this.folderTask) return;
    try {
      const root=this.app.vault.configDir+'/plugins';
      const read=async id=>{const p=`${root}/${id}/data.json`;return await this.app.vault.adapter.exists(p)?JSON.parse(await this.app.vault.adapter.read(p)):{};};
      const voice=await read('voice-scribe'),llm=await read('llm-text-assistant');
      const imported={...clone(this.settings)};
      for(const key of ['language','inputDeviceId']) if(typeof voice[key]==='string')imported[key]=voice[key];
      if(typeof voice.folder==='string') imported.folder=folderPath(voice.folder);
      for(const key of ['apiUrl','apiKey','model','targetLanguage']) if(typeof llm[key]==='string'&&llm[key])imported[key]=llm[key];
      if(llm.timeoutSeconds) imported.timeoutSeconds=Math.max(30,Math.min(300,Number(llm.timeoutSeconds)||120));
      if(llm.promptGrammar) {imported.prompt=llm.promptGrammar;imported.correctionMode='custom';}
      const map={grammar:'promptGrammar',translate:'promptTranslate',expand:'promptExpand',summarize:'promptSummarize'};
      for(const a of imported.actions) if(llm[map[a.id]])a.prompt=llm[map[a.id]];
      // Custom actions from the old plugin are data, not executable source.
      if(Array.isArray(llm.customActions))llm.customActions.forEach((a,i)=>{if(a&&typeof a.prompt==='string'&&a.prompt.trim()) {
        const entry={id:`custom-${i}`,title:String(a.title||`自定义 ${i+1}`),prompt:a.prompt};
        const n=imported.actions.findIndex(x=>x.id===entry.id);if(n>=0)imported.actions[n]=entry;else imported.actions.push(entry);
      }});
      const identity=this.app.vault.adapter.getBasePath?.()||this.app.vault.getName();
      const jobs=clone(this.state.jobs);
      const oldRaw=localStorage.getItem('voice-diary-auto:v1:'+identity);
      if(oldRaw){const old=JSON.parse(oldRaw);for(const [p,j] of Object.entries(old.jobs||{})) {
        if(jobs[p]||!['done','ignored'].includes(j.status))continue;
        // Import as a protected baseline. Old records do not have a reliable audio hash.
        jobs[p]={path:p,status:'ignored',legacyStatus:j.status,legacyOutput:j.output||null};
      }}
      this.state.config=imported;this.settings=imported;this.state.jobs=jobs;this.state.enabled=false;
      this.state.migratedAt=new Date().toISOString();await this.persist();
      new Notice('已读取并迁移本机旧配置；旧插件未改动。自动处理保持关闭，自定义命令重载插件后可见。',12000);
    } catch(e){new Notice(safeMessage(e),12000);}
  }
  onunload() {
    this.closed=true;this.fab?.remove();this.recordIndicator?.remove();
    if(!this.recorder){void this.store?.close();return;}
    this.recorder.cancelled=true;const closingAsr=this.asr?.close(),closingRuntime=this.runtimeAssets?.close();
    const finish=async()=>{
      await this.recordingStop;
      await this.folderTask?.catch(()=>{});
      await closingAsr;
      await closingRuntime;
      if(this.recorder.state==='recording')this.pendingAudio=await this.recorder.stop();
      if(this.pendingAudio)await this.saveRecording();
      await this.task;
      // Keep the local lock while an uncancellable request is still alive.
      await this.llm.pending?.catch(()=>{});
      await this.store.close();
    };
    void finish().catch(()=>new Notice('退出时录音或检查点未保存，请保留窗口并检查本机存储',15000));
  }
};
class Settings extends PluginSettingTab {
  constructor(app,p){super(app,p);this.p=p;this.activeSection='recording';this.folderDrafts={};}
  display(){
    const p=this.p,c=this.containerEl;c.empty();c.addClass('vdu-settings');
    c.createEl('h2',{text:`${p.manifest.name||'Voice Diary Processor'}${p.manifest.version?' · '+p.manifest.version:''}`});
    c.createEl('p',{text:p.mobile?'本设备只录音并保存音频，等待仓库同步到电脑处理。不会运行转写或调用文字模型。':'直接录音、本地 SenseVoice 转写，可选文字 API 整理。原始音频和所有历史稿保留。'});
    const summary=p.mobile?null:c.createEl('p',{cls:'vdu-settings-summary',attr:{'aria-live':'polite'}});
    const groups=p.mobile?[['recording','录音与路径']]:[
      ['recording','录音与路径'],['local','本地识别'],['api','API 整理'],['text','文字处理'],['tasks','任务与恢复']
    ];
    const nav=p.mobile?null:c.createEl('div',{cls:'vdu-settings-nav',attr:{role:'tablist','aria-label':'设置分区'}});
    const panels={},tabs=[];
    const activate=(key,focus=false)=>{
      this.activeSection=key;
      for(const tab of tabs){const selected=tab.key===key;tab.button.setAttribute('aria-selected',String(selected));tab.button.tabIndex=selected?0:-1;tab.button.classList.toggle('is-active',selected);if(selected&&focus)tab.button.focus();}
      for(const [id,panel] of Object.entries(panels))panel.hidden=id!==key;
    };
    for(const [key,title] of groups) {
      const tabId=`vdu-settings-tab-${key}`,panelId=`vdu-settings-panel-${key}`,headingId=`vdu-settings-heading-${key}`;
      if(nav) {
        const button=nav.createEl('button',{text:title,cls:'vdu-settings-tab',attr:{type:'button',id:tabId,role:'tab','aria-controls':panelId}});
        button.onclick=()=>activate(key);button.onkeydown=event=>{
          if(event.altKey||event.ctrlKey||event.metaKey)return;
          const index=tabs.findIndex(tab=>tab.key===key);let next;
          if(event.key==='ArrowRight')next=(index+1)%tabs.length;
          else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;
          else if(event.key==='Home')next=0;
          else if(event.key==='End')next=tabs.length-1;
          else return;
          event.preventDefault();activate(tabs[next].key,true);
        };
        tabs.push({key,button});
      }
      const panel=panels[key]=c.createEl('section',{cls:'vdu-settings-section',attr:{id:panelId,role:nav?'tabpanel':'region','aria-labelledby':nav?tabId:headingId}});
      panel.createEl('h3',{text:title,cls:'vdu-settings-section-title',attr:{id:headingId}});
    }
    activate(groups.some(([key])=>key===this.activeSection)?this.activeSection:groups[0][0]);
    const {recording,local,api,text,tasks}=panels;
    let apiLabel;
    const refreshApi=()=>{apiLabel?.setText(apiMode(p.settings)==='enabled'?'当前模式：本地转写后调用文字 API 整理。':apiMode(p.settings)==='disabled'?'当前模式：仅本地转写，文字 API 已关闭。':'当前模式：仅本地转写，API 配置未填完整。');summary?.setText(`自动处理：${p.state.enabled?'开启':'暂停'} · ${apiMode(p.settings)==='enabled'?'API 整理':'仅本地转写'}`);p.updateStatus();};
    const save=()=>{refreshApi();void p.persist().catch(e=>new Notice(safeMessage(e)));};
    const field=(container,name,key,desc='',secret=false)=>new Setting(container).setName(name).setDesc(desc).addText(t=>{
      t.setValue(String(p.settings[key]??''));if(secret)t.inputEl.type='password';
      t.onChange(v=>{p.settings[key]=v;save();});});
    const folderField=(name,key,desc)=>{
      let draft=this.folderDrafts[key]??p.settings[key],input;
      new Setting(recording).setName(name).setDesc(desc).addText(t=>{input=t;t.setValue(draft).onChange(v=>{draft=v;this.folderDrafts[key]=v;});})
        .addButton(b=>b.setButtonText('应用').onClick(async()=>{try{draft=await p.applyFolder(key,draft);delete this.folderDrafts[key];input.setValue(draft);}catch(e){new Notice(safeMessage(e),10000);}}));
    };
    folderField('录音保存目录','folder','仓库内相对路径，默认 Voice Diary/Recordings。输入后点击应用；手机和电脑需保持一致。');
    if(!p.mobile)folderField('成品笔记目录','finalFolder','仓库内相对路径，默认 Voice Diary/Notes。不存在时自动创建；已有文件不搬动，处理中的任务保留原定位置。');
    new Setting(recording).setName('录音待保存').setDesc(p.pendingAudio?'音频仍在内存，退出前请保存。':'停止录音后自动保存原始音频。').addButton(b=>b.setButtonText('重试保存').onClick(()=>void p.saveRecording().catch(e=>new Notice(safeMessage(e)))));
    if(p.mobile){recording.createEl('p',{text:'成品笔记目录在电脑端设置，保存后同步回手机。请保持 Obsidian 在前台录音；切后台、锁屏或麦克风中断时结束本段并尝试保存，返回后需重新点击录音。本版不支持后台持续收音。'});return;}
    new Setting(local).setName('本地模型').setDesc('SenseVoiceSmall INT8 · CPU 本地识别，自动标点和数字规范化。');
    new Setting(local).setName('手动准备 SenseVoice 环境').setDesc('电脑端需要单独准备 Python、识别依赖和约 230 MB 的 SenseVoice 模型。打开说明下载后由你手动运行准备工具；插件只检查和调用已安装环境。当前支持 Windows x64。')
      .addButton(b=>b.setButtonText('手动环境准备说明').setCta().onClick(()=>window.open('https://github.com/jem-code-sss/obsidian-voice-diary/releases','_blank','noopener,noreferrer')))
      .addButton(b=>b.setButtonText('官方模型下载').onClick(()=>window.open('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2','_blank','noopener,noreferrer')));
    new Setting(local).setName('模型来源与许可').setDesc('SenseVoice 由原作者提供，ONNX 识别资源由 sherpa-onnx 官方项目发布。')
      .addButton(b=>b.setButtonText('SenseVoice 原作者').onClick(()=>window.open('https://github.com/QwenAudio/SenseVoice','_blank','noopener,noreferrer')))
      .addButton(b=>b.setButtonText('模型许可').onClick(()=>window.open('https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE','_blank','noopener,noreferrer')));
    let senseDraft=this.folderDrafts.senseVoiceRoot??(p.settings.senseVoiceRoot===p.managedSenseVoiceRoot?'':p.settings.senseVoiceRoot),senseInput;
    new Setting(local).setName('现有 SenseVoice 安装目录（可选）').setDesc('留空检查手动准备工具的默认本机目录；也可选择已有的 .venv 和 models 目录，点击应用检查。应用路径不会下载文件。').addText(t=>{senseInput=t;t.setValue(senseDraft).onChange(v=>{senseDraft=v;this.folderDrafts.senseVoiceRoot=v;});})
      .addButton(b=>b.setButtonText('应用路径').onClick(async()=>{try{senseDraft=await p.applySenseVoiceRoot(senseDraft);delete this.folderDrafts.senseVoiceRoot;senseInput.setValue(senseDraft===p.managedSenseVoiceRoot?'':senseDraft);}catch(e){new Notice(safeMessage(e),10000);}}));
    new Setting(local).setName('准备本地模型').setDesc('检查 Python、FFmpeg 和模型，并用本地样例验证识别。').addButton(b=>b.setButtonText('检查并准备').onClick(()=>void p.prepareModel()));
    new Setting(local).setName('识别语言').setDesc('用于后续识别；自动识别可用于多语言录音。').addDropdown(d=>{
      const labels={auto:'自动识别',zh:'中文',en:'英语',ja:'日语',ko:'韩语',yue:'粤语'};
      for(const language of SENSEVOICE_LANGUAGES)d.addOption(language,`${labels[language]} (${language})`);
      if(!SENSEVOICE_LANGUAGES.includes(p.settings.language))d.addOption(p.settings.language,`${p.settings.language}（暂不支持，请重新选择）`);
      d.setValue(p.settings.language).onChange(v=>{if(SENSEVOICE_LANGUAGES.includes(v)){p.settings.language=v;save();}});
    });
    new Setting(api).setName('启用文字 API 整理').setDesc('关闭或配置未填完整时，只用本地 SenseVoice 转写并保存到成品目录。关闭也会停用选区文字处理和连接测试；已发出的请求无法撤回，后续片段停止调用。').addToggle(t=>t.setValue(p.settings.apiEnabled).onChange(async v=>{
      try{await p.setApiEnabled(v);}catch(e){new Notice(safeMessage(e),10000);t.setValue(p.settings.apiEnabled);}refreshApi();
    }));
    apiLabel=api.createEl('p',{cls:'vdu-settings-note'});refreshApi();
    field(api,'文字接口完整地址','apiUrl');field(api,'文字模型','model');field(api,'本机 API Key','apiKey','明文保存在本机用户数据目录，不写入仓库的 data.json。',true);
    new Setting(api).setName('请求超时（秒）').addText(t=>t.setValue(String(p.settings.timeoutSeconds)).onChange(v=>{p.settings.timeoutSeconds=Math.max(30,Math.min(300,Number(v)||120));save();}));
    new Setting(api).setName('Qwen 非思考模式').setDesc('仅对已识别的 DashScope Qwen 接口发送 enable_thinking=false；实际模型支持需连接测试确认。').addToggle(t=>t.setValue(p.settings.disableThinking).onChange(v=>{p.settings.disableThinking=v;save();}));
    new Setting(api).setName('连接测试').setDesc('仅点击时向已配置文字接口发送“测试”，不发送历史日记。').addButton(b=>b.setButtonText('测试连接').onClick(()=>void p.testConnection()));
    new Setting(api).setName('日记整理方式').setDesc('自然整理会去除无意义口水词、机械重复并理顺表达；忠实校对保留口语。两者均保留细节、情绪与不确定性，长稿参考同一录音相邻原文，不读取其他笔记。变更只用于尚未开始校对的任务。').addDropdown(d=>{
      this.correctionSelect=d.selectEl;
      for(const [key,title] of Object.entries(MODES))d.addOption(key,title);
      d.setValue(p.settings.correctionMode).onChange(v=>{
        p.settings.correctionMode=v;save();const scrollTop=c.scrollTop;this.display();c.scrollTop=scrollTop;this.correctionSelect?.focus?.({preventScroll:true});
      });
    });
    if(p.settings.correctionMode==='custom')new Setting(api).setName('日记自动校对提示词').setDesc('保留原有自定义提示词和请求方式；如需内置上下文整理，请选择自然整理或忠实校对。').addTextArea(t=>t.setValue(p.settings.prompt).onChange(v=>{p.settings.prompt=v||PROMPT;save();}));
    text.createEl('p',{cls:'vdu-settings-note',text:'选中笔记文字后，通过右键菜单或命令运行。使用 API 整理分区中的接口与开关，处理结果先预览。'});
    field(text,'翻译目标语言','targetLanguage');
    for(const action of p.settings.actions)new Setting(text).setName(`手动选区：${action.title}`).setDesc('先展示结果；应用前检查原笔记是否变化。').addTextArea(t=>t.setValue(action.prompt).onChange(v=>{action.prompt=v;save();}));
    new Setting(tasks).setName('启用本电脑自动处理').setDesc('先暂停旧 Voice Diary Auto。首次开启跳过已有录音；只在一台电脑开启。').addToggle(t=>t.setValue(p.state.enabled).onChange(async v=>{
      if(v&&p.oldProcessorActive()){t.setValue(false);return;}
      try{await p.queue.arm(v);new Notice(v?'自动处理开启，监听新增且稳定 30 秒的音频':'自动处理暂停；在途任务继续至检查点');}catch(e){new Notice(safeMessage(e));t.setValue(p.state.enabled);}refreshApi();
    }));
    new Setting(tasks).setName('任务与恢复').addButton(b=>b.setButtonText('查看进度').onClick(()=>p.showStatus())).addButton(b=>b.setButtonText('重试失败任务').onClick(()=>void p.retry()));
    new Setting(tasks).setName('接口或模型变更后的恢复').setDesc('仅处理因配置变更而暂停的任务。保留本地转写，丢弃这些任务的旧校对片段并重新请求接口，可能再次计费。').addButton(b=>b.setButtonText('按新配置重新校对').onClick(()=>void p.retryCurrentConfig()));
    new Setting(tasks).setName('从旧插件迁移本机配置').setDesc('读取录音目录、语言、Qwen 接口和提示词；本地识别继续使用 SenseVoice。不改动旧配置，不把 Key 复制到手机。').addButton(b=>b.setButtonText('读取并迁移').onClick(async()=>{await p.migrate();this.folderDrafts={};this.display();}));
    tasks.createEl('p',{cls:'vdu-settings-note',text:'设置和任务检查点仅保存在本机用户数据目录，不进入仓库同步。检查点可能含转写正文，API Key 以明文保存；诊断和安装包不包含这些数据。SenseVoice 环境由用户手动准备，插件不会下载或安装识别依赖；转写在本机运行。'});
  }
}
