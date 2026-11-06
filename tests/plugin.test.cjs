const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const {DEFAULTS,clone}=require('../src/core');
const bundle=()=>fs.readFileSync(path.join(__dirname,'../dist/voice-diary-unified/main.js'),'utf8');
function host(mobile=false,{browserTimers=false,request}={}) {
  const notices=[],noticeDurations=[],modals=[],buttons=[],texts=[],dropdowns=[],toggles=[],requires=[],descriptions=[],elements=[],openedUrls=[];
  const element=(tag,options={})=>{const el={text:options.text||'',setText(t){this.text=t;},setAttribute(){},addClass(){},remove(){},empty(){},classList:{toggle(){}},createEl:element};elements.push(el);return el;};
  const eventTarget=()=>{
    const listeners=new Map();
    return {addEventListener(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);},
      removeEventListener(name,fn){listeners.get(name)?.delete(fn);},dispatchEvent(event){for(const fn of [...(listeners.get(event.type)||[])])fn(event);}};
  };
  class Plugin {constructor(app){this.app=app;this.manifest={dir:'.obsidian/plugins/voice-diary-unified'};this.commands=[];this.events=[];this.domEvents=[];}addCommand(c){this.commands.push(c);}addRibbonIcon(){return element();}addStatusBarItem(){return element();}addSettingTab(tab){this.settingTab=tab;}registerInterval(){}registerEvent(e){this.events.push(e);}registerDomEvent(target,name,fn){target.addEventListener(name,fn);this.domEvents.push([target,name,fn]);}}
  class Modal {constructor(app){this.app=app;this.contentEl=element();this.titleEl=element();modals.push(this);}open(){this.onOpen?.();}close(){this.onClose?.();}}
  class Setting {
    constructor(){}setName(name){this.name=name;return this;}setDesc(desc){descriptions.push(desc);return this;}
    addText(fn){const text={inputEl:{},setValue(value){this.value=value;return this;},onChange(callback){this.change=callback;return this;}};texts.push({name:this.name,text});fn(text);return this;}
    addTextArea(fn){return this.addText(fn);}
    addToggle(fn){const toggle={setValue(value){this.value=value;return this;},onChange(callback){this.change=callback;return this;}};toggles.push({name:this.name,toggle});fn(toggle);return this;}
    addDropdown(fn){const dropdown={options:{},addOption(key,title){this.options[key]=title;return this;},setValue(value){this.value=value;return this;},onChange(callback){this.change=callback;return this;}};dropdowns.push({name:this.name,dropdown});fn(dropdown);return this;}
    addButton(fn){const b={setButtonText(t){this.text=t;return this;},setCta(){return this;},onClick(fn){buttons.push({text:this.text,fn});return this;}};fn(b);return this;}
  }
  class MarkdownView {}
  const obsidian={Plugin,Modal,Setting,MarkdownView,PluginSettingTab:class{constructor(app){this.app=app;this.containerEl=element();}},Notice:class{constructor(m,duration){notices.push(m);noticeDurations.push(duration);}},TFile:class{},Platform:{isMobileApp:mobile,isMobile:mobile,isDesktop:!mobile,isDesktopApp:!mobile},requestUrl:request||(()=>{throw Error('unexpected HTTP');}),setIcon(){},moment:{locale:()=> 'zh-cn'}};
  const ctx={module:{exports:{}},require(id){requires.push(id);if(id==='obsidian')return obsidian;throw Error('unexpected Node dependency: '+id);},console,crypto:webcrypto,TextEncoder,TextDecoder,URL,Blob,setTimeout,clearTimeout,Date,Uint8Array,ArrayBuffer,
    window:{...eventTarget(),setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,open:(...args)=>openedUrls.push(args)},document:{...eventTarget(),visibilityState:'visible',body:{createEl:()=>element()}},localStorage:{getItem:()=>null},navigator:{clipboard:{writeText:async()=>{}}}};
  vm.createContext(ctx);
  if(browserTimers) vm.runInContext(`
    globalThis.__timerRecords=[];globalThis.__timeout=null;
    globalThis.setTimeout=function(fn,delay){
      if(this!==globalThis)throw new TypeError('Illegal invocation');
      __timerRecords.push('set');__timeout=fn;return 7;
    };
    globalThis.clearTimeout=function(id){
      if(this!==globalThis)throw new TypeError('Illegal invocation');
      __timerRecords.push('clear');
    };
  `,ctx);
  vm.runInContext(bundle(),ctx,{timeout:1000});
  return {Plugin:ctx.module.exports,ctx,notices,noticeDurations,modals,buttons,texts,dropdowns,toggles,requires,descriptions,elements,openedUrls,MarkdownView};
}
const apiSettings=()=>({...clone(DEFAULTS),apiEnabled:true,apiUrl:'http://localhost:1234/v1/chat/completions',model:'test-model'});
test('mobile bundle loads and unloads with no Node modules, worker, ASR or HTTP calls',async()=>{
  const h=host(true);const app={loadLocalStorage:()=>null,saveLocalStorage(){},vault:{},workspace:{}};
  const p=new h.Plugin(app);await p.onload();
  assert.ok(h.requires.every(id=>id==='obsidian'));assert.equal(p.queue,undefined);assert.equal(p.state.enabled,false);assert.equal(p.settings.apiKey,'');
  assert.deepEqual(p.commands.map(c=>c.id),['record','record-todo','save-recording']);p.onunload();await Promise.resolve();
});
test('manual text edits during request prevent applying result to modified note',async()=>{
  const h=host(),file={path:'note.md'};let content='原始选区',replaced=0,finish;
  const editor={getValue:()=>content,getSelection:()=>content,getCursor:which=>which==='from'?{line:0,ch:0}:{line:0,ch:content.length},replaceRange:()=>{replaced++;}};
  const p=new h.Plugin({workspace:{getActiveViewOfType:()=>({file,editor})}});
  p.mobile=false;p.queue={busy:false};p.settings=apiSettings();p.llm={complete:()=>new Promise(resolve=>{finish=resolve;})};
  const task=p.runText(editor,{prompt:'校对'});content='用户输入的新内容';finish('返回结果');await task;
  assert.equal(h.modals.length,1);h.buttons.find(b=>b.text==='应用到原选区').fn();assert.equal(replaced,0);assert.ok(h.notices.some(x=>x.includes('已经改变')));
});
test('manual result applies only to the unchanged original file and captured range',async()=>{
  const h=host(),file={path:'note.md'};let replacement;
  const editor={getValue:()=> '前缀原文后缀',getSelection:()=> '原文',getCursor:x=>x==='from'?{line:0,ch:2}:{line:0,ch:4},replaceRange:(...args)=>{replacement=args;}};
  const p=new h.Plugin({workspace:{getActiveViewOfType:()=>({file,editor})}});p.mobile=false;p.queue={busy:false};p.settings=apiSettings();p.llm={complete:async()=> '结果'};
  await p.runText(editor,{prompt:'校对'});h.buttons.find(b=>b.text==='应用到原选区').fn();assert.equal(replacement[0],'结果');assert.equal(replacement[1].ch,2);assert.equal(replacement[2].ch,4);
});
test('switching active note blocks result application even when contents match',async()=>{
  const h=host(),file={path:'one.md'};let current=file,count=0;
  const editor={getValue:()=> '原文',getSelection:()=> '原文',getCursor:()=>({line:0,ch:0}),replaceRange:()=>count++};
  const p=new h.Plugin({workspace:{getActiveViewOfType:()=>({file:current,editor})}});p.mobile=false;p.queue={busy:false};p.settings=apiSettings();p.llm={complete:async()=> '结果'};
  await p.runText(editor,{prompt:'校对'});current={path:'two.md'};h.buttons.find(b=>b.text==='应用到原选区').fn();assert.equal(count,0);
});
test('explicit migration copies settings without changing old files, enabling jobs or copying Key to notes',async()=>{
  const h=host(),old={
    '.obsidian/plugins/voice-scribe/data.json':JSON.stringify({language:'zh',folder:'Voice Diary/Recordings',device:'auto'}),
    '.obsidian/plugins/llm-text-assistant/data.json':JSON.stringify({apiUrl:'https://example.org/v1/chat/completions',apiKey:'PRIVATE-KEY',model:'qwen3.8-flash',promptGrammar:'用户校对提示词',customActions:[{title:'自己的动作',prompt:'自己的指令'}]})
  };
  const before=JSON.stringify(old);let persisted;
  const app={vault:{configDir:'.obsidian',adapter:{getBasePath:()=> 'D:/中文 含空格/仓库',exists:async p=>p in old,read:async p=>old[p]}},loadLocalStorage:()=> 'turbo'};
  const p=new h.Plugin(app);p.queue={busy:false};p.settings=clone(DEFAULTS);p.state={jobs:{},config:p.settings,enabled:true};p.persist=async()=>{persisted=JSON.stringify(p.state);};
  await p.migrate();assert.equal(p.settings.apiKey,'PRIVATE-KEY');assert.equal(p.settings.senseVoiceRoot,DEFAULTS.senseVoiceRoot);assert.equal(p.settings.modelPref,undefined);assert.equal(p.settings.correctionMode,'custom');assert.equal(p.settings.prompt,'用户校对提示词');assert.equal(p.state.enabled,false);assert.equal(p.settings.actions.at(-1).title,'自己的动作');assert.equal(JSON.stringify(old),before);assert.ok(persisted);assert.ok(!h.notices.join('').includes('PRIVATE-KEY'));
});
test('failed recording save keeps audio in memory and successful retry writes no markdown',async()=>{
  const h=host(),files=new Map();let failure=true;
  const vault={getAbstractFileByPath:p=>files.get(p),createFolder:async p=>files.set(p,{path:p,children:[]}),
    createBinary:async(p,b)=>{if(failure)throw Error('disk');const f={path:p,name:p.split('/').pop(),data:b};files.set(p,f);return f;},readBinary:async f=>f.data};
  const p=new h.Plugin({vault});p.settings=clone(DEFAULTS);p.pendingAudio={blob:new Blob(['audio-bytes']),ext:'webm'};
  await assert.rejects(p.saveRecording());assert.ok(p.pendingAudio);failure=false;await p.saveRecording();assert.equal(p.pendingAudio,null);assert.equal([...files.keys()].filter(p=>p.endsWith('.webm')).length,1);assert.ok(![...files.keys()].some(p=>p.endsWith('.md')));
});
test('actual MediaRecorder wrapper maps the recorded mime and frees microphone tracks',async()=>{
  const {extension}=require('../src/recorder');assert.equal(extension('audio/mp4'),'m4a');assert.equal(extension('audio/webm;codecs=opus'),'webm');assert.throws(()=>extension('audio/unknown'));
  let stops=0;
  class MediaRecorder {static isTypeSupported(t){return t==='audio/webm;codecs=opus';}constructor(_s,opts){this.mimeType=opts.mimeType;this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['valid bytes'])});this.onstop();}}
  const ctx={module:{exports:{}},require:id=>require(id==='./capture'?'../src/capture':'../src/core'),crypto:webcrypto,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stops++;}}]})}},MediaRecorder,Blob,Date,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/recorder.js'),'utf8'),ctx);
  const rec=new ctx.module.exports.AudioRecorder();await rec.start();const result=await rec.stop();assert.equal(result.ext,'webm');assert.equal(await result.blob.text(),'valid bytes');assert.equal(stops,1);assert.equal(rec.state,'idle');
});
test('tick ownership remains attached to the active task across interval firings',async()=>{
  const h=host(),p=new h.Plugin({});let resolve;
  p.safeTick=()=>new Promise(r=>{resolve=r;});p.kickTick();const first=p.task;p.kickTick();assert.equal(p.task,first);resolve();await first;await Promise.resolve();assert.equal(p.task,null);
});

async function connectionPlugin(request) {
  // Mobile initialization avoids real disk I/O; connection testing is invoked
  // directly to exercise the same bundled client and handler used on desktop.
  const h=host(true,{browserTimers:true,request});
  const p=new h.Plugin({loadLocalStorage:()=>null,saveLocalStorage(){},vault:{},workspace:{}});
  await p.onload();p.settings=apiSettings();p.mobile=false;
  return {h,p};
}
test('bundled connection test succeeds with Window-receiver checks on both native timers',async()=>{
  let sent;
  const {h,p}=await connectionPlugin(async req=>{sent=JSON.parse(req.body);return {status:200,json:{choices:[{finish_reason:'stop',message:{content:'连接成功'}}]}};});
  await p.testConnection();assert.ok(h.notices.includes('文字接口连接成功'));assert.equal(sent.messages[1].content,'测试');
  assert.deepEqual(Array.from(h.ctx.__timerRecords),['set','clear']);assert.equal(p.llm.active,false);
  p.onunload();
});
test('connection test shows safe HTTP 401 detail instead of unrelated storage advice',async()=>{
  const {h,p}=await connectionPlugin(async()=>({status:401,json:{error:'PRIVATE-KEY diary contents'}}));
  await p.testConnection();assert.ok(h.notices.some(x=>x.includes('HTTP 401')));assert.ok(!h.notices.join('').includes('PRIVATE-KEY'));
  assert.ok(!h.notices.join('').includes('本机存储'));p.onunload();
});
test('connection network failure retains a specific message under strict browser timers',async()=>{
  const {h,p}=await connectionPlugin(async()=>{throw new Error('Authorization: Bearer PRIVATE-KEY');});
  await p.testConnection();assert.ok(h.notices.some(x=>x.includes('文字接口连接失败')));assert.ok(!h.notices.join('').includes('PRIVATE-KEY'));p.onunload();
});
test('connection timeout still blocks overlaps until the uncancellable request settles',async()=>{
  let finish;
  const {h,p}=await connectionPlugin(()=>new Promise(resolve=>{finish=resolve;}));
  const task=p.testConnection();await Promise.resolve();h.ctx.__timeout();await task;
  assert.ok(h.notices.some(x=>x.includes('接口请求超时')));assert.equal(p.llm.active,true);
  await p.testConnection();assert.equal(h.notices.at(-1),'请等待当前任务完成');
  finish({status:200,json:{choices:[{finish_reason:'stop',message:{content:'完成'}}]}});
  await p.llm.pending;assert.equal(p.llm.active,false);p.onunload();
});
test('unexpected connection exceptions identify an internal error without exposing its message',async()=>{
  const h=host(),p=new h.Plugin({});p.settings=apiSettings();p.llm={complete:async()=>{throw new TypeError('PRIVATE-KEY private diary');}};
  await p.testConnection();assert.ok(h.notices.at(-1).includes('插件内部错误（TypeError）'));assert.ok(!h.notices.join('').includes('PRIVATE-KEY'));
});

async function mobileRecorder({failSave=false}={}) {
  const h=host(true),files=new Map();
  const vault={getAbstractFileByPath:p=>files.get(p),createFolder:async p=>files.set(p,{path:p,children:[]}),
    createBinary:async(p,b)=>{if(failSave)throw Error('disk');const f={path:p,name:p.split('/').pop(),data:b};files.set(p,f);return f;},readBinary:async f=>f.data};
  const p=new h.Plugin({loadLocalStorage:()=>null,saveLocalStorage(){},vault,workspace:{}});await p.onload();
  let stopped=0,started=0;
  const recorder={state:'recording',startedAt:Date.now()-120000,
    async stop(){this.state='stopping';stopped++;await Promise.resolve();this.state='idle';return {blob:new Blob(['before background audio']),ext:'webm'};},
    async start(){started++;this.state='recording';this.startedAt=Date.now();}};
  p.recorder=recorder;
  return {h,p,files,counts:()=>({stopped,started}),allowSave:()=>{failSave=false;}};
}
test('mobile visibility loss stops and saves exactly once; foreground return never resumes microphone automatically',async()=>{
  const {h,p,files,counts}=await mobileRecorder();
  h.ctx.document.visibilityState='hidden';h.ctx.document.dispatchEvent({type:'visibilitychange'});
  const saving=p.recordingStop;h.ctx.window.dispatchEvent({type:'pagehide'});await saving;
  assert.equal(counts().stopped,1);assert.equal(p.recorder.state,'idle');assert.equal([...files.keys()].filter(x=>x.endsWith('.webm')).length,1);
  h.ctx.document.visibilityState='visible';h.ctx.document.dispatchEvent({type:'visibilitychange'});
  assert.equal(counts().started,0);assert.ok(h.notices.at(-1).includes('录音已结束'));assert.equal(h.noticeDurations.at(-1),4000);
  assert.equal(p.recordIndicator.text,'');assert.ok(!p.status.text.includes('录音 2:'));
  await p.toggleRecording();assert.equal(counts().started,1);assert.equal(p.recordingInterruption,null);p.onunload();await p.recordingStop;
});
test('background interruption save failure keeps audio and blocks new recording until saved',async()=>{
  const {h,p,counts,allowSave}=await mobileRecorder({failSave:true});
  h.ctx.document.visibilityState='hidden';h.ctx.document.dispatchEvent({type:'visibilitychange'});await p.recordingStop;
  assert.ok(p.pendingAudio);assert.equal(p.recorder.state,'idle');assert.ok(p.recordIndicator.text.includes('待保存'));
  h.ctx.document.visibilityState='visible';allowSave();await p.toggleRecording();assert.equal(p.pendingAudio,null);assert.equal(counts().started,0);p.onunload();
});
test('background change during microphone permission cancels the pending start',async()=>{
  const {h,p}=await mobileRecorder();let resolvePermission;
  p.recorder.state='idle';p.recorder.start=async()=>{p.recorder.state='starting';await new Promise(r=>{resolvePermission=r;});p.recorder.state=p.recorder.cancelled?'idle':'recording';};
  const starting=p.toggleRecording();h.ctx.document.visibilityState='hidden';h.ctx.document.dispatchEvent({type:'visibilitychange'});
  assert.equal(p.recorder.cancelled,true);resolvePermission();await starting;
  assert.equal(p.recorder.state,'idle');assert.ok(!h.notices.some(x=>x.startsWith('录音开始')));p.onunload();
});
test('desktop recording has no mobile visibility/pagehide auto-stop handlers',async()=>{
  const h=host(false),p=new h.Plugin({});let stopped=0;
  p.mobile=false;p.recorder={state:'recording',stop:async()=>{stopped++;}};p.setupMobileRecordingGuard();
  h.ctx.document.visibilityState='hidden';h.ctx.document.dispatchEvent({type:'visibilitychange'});h.ctx.window.dispatchEvent({type:'pagehide'});
  assert.equal(p.domEvents.length,0);assert.equal(stopped,0);assert.equal(p.recorder.state,'recording');
});
test('device interruption uses stop path without toggling an idle recorder back on',async()=>{
  const {p,counts}=await mobileRecorder();await p.interruptRecording('muted');await p.interruptRecording('device');
  assert.equal(counts().stopped,1);assert.equal(counts().started,0);assert.ok(p.recordingInterruption.includes('麦克风'));p.onunload();
});
test('mobile rejects starting a recording while already hidden',async()=>{
  const {h,p,counts}=await mobileRecorder();p.recorder.state='idle';h.ctx.document.visibilityState='hidden';await p.toggleRecording();
  assert.equal(counts().started,0);assert.ok(h.notices.at(-1).includes('前台'));p.onunload();
});
test('mobile folder field keeps edits as a draft until Apply and persists only the validated folder',async()=>{
  const {h,p,files}=await mobileRecorder();p.recorder.state='idle';let saves=0;p.persist=async()=>{saves++;};
  p.settingTab.display();const field=h.texts.find(x=>x.name==='录音保存目录').text;
  field.change('手机录音/新目录');assert.equal(p.settings.folder,DEFAULTS.folder);assert.equal(saves,0);
  assert.ok(!h.texts.some(x=>x.name==='成品笔记目录'));await h.buttons.find(x=>x.text==='应用').fn();
  assert.equal(p.settings.folder,'手机录音/新目录');assert.equal(saves,1);assert.ok(files.get('手机录音/新目录').children);p.onunload();
});
async function desktopFolderPlugin(){
  const fixture=await mobileRecorder(),{p,files}=fixture;p.recorder.state='idle';p.mobile=false;p.state.initialized=true;p.state.enabled=true;
  p.app.vault.getFiles=()=>[...files.values()].filter(x=>x.data);
  p.queue=new (require('../src/core').Queue)({vault:p.app.vault,state:p.state,config:()=>p.settings,save:()=>p.persist(),transcribe:async()=> '文字',llm:{complete:async()=> '校对'}});
  const add=(path,body)=>{const data=new TextEncoder().encode(body).buffer;const file={path,name:path.split('/').pop(),data,stat:{size:data.byteLength,mtime:1}};files.set(path,file);return file;};
  return {...fixture,add};
}
test('applying a new audio folder baselines its existing files and retains unfinished jobs in the old folder',async()=>{
  const {p,add}=await desktopFolderPlugin();const old=add('Voice Diary/Recordings/pending.webm','old'),existing=add('新录音/历史.webm','history');
  p.state.jobs[old.path]={path:old.path,status:'retry_wait',raw:'已保存的转写'};
  await p.applyFolder('folder','新录音');assert.equal(p.settings.folder,'新录音');assert.equal(p.state.jobs[existing.path].status,'ignored');
  assert.equal(p.state.jobs[old.path].raw,'已保存的转写');assert.ok(p.queue.files().includes(old));assert.equal(p.queue.busy,false);p.onunload();
});
test('folder application rejects busy or unsaved recording states and invalid destinations without changing settings',async()=>{
  const {p,files}=await desktopFolderPlugin();const original=p.settings.folder;
  p.pendingAudio={blob:new Blob(['pending']),ext:'webm'};await assert.rejects(p.applyFolder('folder','新的录音'),e=>e.code==='busy');p.pendingAudio=null;
  p.queue.busy=true;await assert.rejects(p.applyFolder('folder','新的录音'),e=>e.code==='busy');p.queue.busy=false;
  files.set('文件占位',{path:'文件占位',data:new ArrayBuffer(1)});
  const output=p.settings.finalFolder;await assert.rejects(p.applyFolder('finalFolder','文件占位/子目录'),e=>e.code==='folder');
  assert.equal(p.settings.folder,original);assert.equal(p.settings.finalFolder,output);p.onunload();
});
test('failed settings persistence rolls back folder choice and newly inserted ignore records',async()=>{
  const {p,add}=await desktopFolderPlugin();const existing=add('新目录/历史.webm','history'),original=p.settings.folder;
  p.persist=async()=>{throw Error('disk full');};await assert.rejects(p.applyFolder('folder','新目录'));
  assert.equal(p.settings.folder,original);assert.equal(p.state.jobs[existing.path],undefined);assert.equal(p.queue.busy,false);p.onunload();
});

test('todo destination is an applied draft and does not change already planned output paths',async()=>{
  const {h,p,files}=await desktopFolderPlugin();p.managedSenseVoiceRoot='';
  p.state.jobs['recording.webm']={mode:'todo',target:'old/kept.md',targetFolder:'old',status:'committing'};
  p.settingTab.display();const text=h.texts.find(x=>x.name==='待办保存目录').text;
  text.change('我的计划/待办');assert.equal(p.settings.todoFolder,'Voice Diary/Tasks');
  await p.applyFolder('todoFolder','我的计划/待办');
  assert.equal(p.settings.todoFolder,'我的计划/待办');assert.ok(files.get('我的计划/待办').children);
  assert.equal(p.state.jobs['recording.webm'].target,'old/kept.md');p.onunload();
});

test('todo API opt-in is independent and disabling fails closed when settings cannot be saved',async()=>{
  const h=host(),p=new h.Plugin({});p.settings=apiSettings();p.settings.todoUseApi=false;p.persist=async()=>{};
  await p.setTodoApiEnabled(true);assert.equal(p.settings.todoUseApi,true);assert.equal(p.settings.apiEnabled,true);
  p.persist=async()=>{throw Error('disk');};
  await assert.rejects(p.setTodoApiEnabled(false),e=>e.code==='storage');assert.equal(p.settings.todoUseApi,false);
  await assert.rejects(p.setTodoApiEnabled(true));assert.equal(p.settings.todoUseApi,false);
  assert.equal(p.settings.apiEnabled,true);
});

test('the compiled plugin preserves a saved custom prompt during load instead of silently selecting a preset',async()=>{
  const h=host(true),saved={config:{prompt:'已有自定义提示词'},jobs:{},enabled:false};
  const p=new h.Plugin({loadLocalStorage:()=>saved,saveLocalStorage(){},vault:{},workspace:{}});await p.onload();
  assert.equal(p.settings.correctionMode,'custom');assert.equal(p.settings.prompt,'已有自定义提示词');p.onunload();
});

test('desktop cleanup mode selector changes new-task mode without replacing the stored custom prompt',async()=>{
  const {h,p}=await desktopFolderPlugin();p.settings.prompt='原有自定义提示词';p.settings.correctionMode='custom';let saves=0;p.persist=async()=>{saves++;};
  p.settingTab.display();const selector=h.dropdowns.find(x=>x.name==='日记整理方式').dropdown;
  assert.deepEqual(Object.keys(selector.options),['natural','faithful','custom']);selector.change('natural');
  assert.equal(p.settings.correctionMode,'natural');assert.equal(p.settings.prompt,'原有自定义提示词');assert.equal(saves,1);
  h.dropdowns.at(-1).dropdown.change('custom');assert.equal(p.settings.correctionMode,'custom');
  assert.equal(h.texts.filter(x=>x.name==='日记自动校对提示词').at(-1).text.value,'原有自定义提示词');p.onunload();
});

test('disabling the text API blocks both manual text actions and connection testing before any client call',async()=>{
  const h=host(),p=new h.Plugin({});p.settings={...apiSettings(),apiEnabled:false};p.mobile=false;p.queue={busy:false};let requests=0;
  p.llm={complete:async()=>{requests++;return '不应调用';}};
  await p.runText({getSelection:()=> '私人原文'},{prompt:'校对'});await p.testConnection();
  assert.equal(requests,0);assert.equal(h.modals.length,0);assert.ok(h.notices.every(x=>x.includes('文字 API 未开启')));
});

test('manual multi-chunk processing stops after API is disabled without offering an incomplete result',async()=>{
  const h=host(),p=new h.Plugin({workspace:{getActiveViewOfType:()=>({file:{path:'test.md'}})}});p.settings=apiSettings();p.settings.chunkChars=500;p.mobile=false;p.queue={busy:false};let requests=0;
  const text='原文'.repeat(600);p.llm={complete:async()=>{requests++;p.settings.apiEnabled=false;return '片段';}};
  const editor={getSelection:()=>text,getValue:()=>text,getCursor:()=>({line:0,ch:0})};
  await p.runText(editor,{prompt:'校对'});assert.equal(requests,1);assert.equal(h.modals.length,0);assert.equal(p.manualBusy,false);
});

test('API toggle closes the live gate before its persistence resolves and does not erase credentials',async()=>{
  const {h,p}=await connectionPlugin(async()=>{throw Error('unexpected request');});let finishSave;
  p.settings.apiKey='SAVED-KEY';p.persist=()=>new Promise(resolve=>{finishSave=resolve;});
  const changing=p.setApiEnabled(false);assert.equal(p.settings.apiEnabled,false);assert.equal(p.llm.canRequest(),false);
  await p.testConnection();finishSave();await changing;assert.equal(p.settings.apiKey,'SAVED-KEY');assert.ok(!h.notices.join('').includes('SAVED-KEY'));p.onunload();
});

test('failed persistence while disabling API keeps the current session disabled',async()=>{
  const {p}=await desktopFolderPlugin();p.settings=apiSettings();p.persist=async()=>{throw Error('disk full');};
  await assert.rejects(p.setApiEnabled(false),e=>e.code==='storage'&&e.message.includes('当前会话关闭'));
  assert.equal(p.settings.apiEnabled,false);p.onunload();
});

test('desktop exposes an API toggle independently of automatic processing',async()=>{
  const {h,p}=await desktopFolderPlugin();p.settings=apiSettings();p.state.enabled=true;p.persist=async()=>{};
  p.settingTab.display();const toggle=h.toggles.find(x=>x.name==='启用文字 API 整理').toggle;
  assert.equal(toggle.value,true);await toggle.change(false);assert.equal(p.settings.apiEnabled,false);assert.equal(p.state.enabled,true);
  assert.ok(p.status.text.includes('仅本地转写'));p.onunload();
});

test('API endpoint, model and key edits stay in memory drafts until explicitly applied',async()=>{
  const {h,p}=await desktopFolderPlugin();Object.assign(p.settings,{...apiSettings(),apiUrl:'https://old.example.invalid/v1/chat/completions',apiKey:'SYNTHETIC-OLD-KEY'});
  let saves=0;p.persist=async()=>{saves++;};p.settingTab.display();
  const input=name=>h.texts.find(x=>x.name===name).text;
  input('文字接口完整地址').change('https://new.example.invalid/v1/chat/completions');
  assert.equal(input('本机 API Key').value,'');assert.equal(p.settingTab.apiDrafts.apiKey,'');
  input('文字模型').change('new-model');input('本机 API Key').change('SYNTHETIC-NEW-KEY');
  assert.equal(p.settings.apiUrl,'https://old.example.invalid/v1/chat/completions');assert.equal(p.settings.apiKey,'SYNTHETIC-OLD-KEY');
  assert.equal(p.settings.model,'test-model');assert.equal(p.settings.apiEnabled,true);assert.equal(saves,0);
  await h.buttons.find(x=>x.text==='应用接口配置').fn();
  assert.equal(p.settings.apiUrl,'https://new.example.invalid/v1/chat/completions');assert.equal(p.settings.model,'new-model');
  assert.equal(p.settings.apiKey,'SYNTHETIC-NEW-KEY');assert.equal(p.settings.apiEnabled,false);assert.equal(saves,1);
  assert.equal(h.toggles.find(x=>x.name==='启用文字 API 整理').toggle.value,false);
  assert.ok(!h.notices.join('').includes('SYNTHETIC'));p.onunload();
});

test('unapplied API drafts cannot be enabled and survive settings redraw without persistence',async()=>{
  const {h,p}=await desktopFolderPlugin();p.settings.apiEnabled=false;let saves=0;p.persist=async()=>{saves++;};p.settingTab.display();
  h.texts.find(x=>x.name==='文字接口完整地址').text.change('https://new.example.invalid/v1/chat/completions');
  await h.toggles.find(x=>x.name==='启用文字 API 整理').toggle.change(true);
  assert.equal(p.settings.apiEnabled,false);assert.equal(saves,0);assert.ok(h.notices.at(-1).includes('尚未应用'));
  p.settingTab.display();assert.equal(h.texts.filter(x=>x.name==='文字接口完整地址').at(-1).text.value,'https://new.example.invalid/v1/chat/completions');
  assert.equal(p.settings.apiUrl,'');assert.equal(saves,0);p.onunload();
});

test('origin changes clear a copied old key even when bypassing the settings UI',async()=>{
  for(const [apiUrl,apiKey] of [['https://new.example.invalid/v1/chat/completions','SYNTHETIC-OLD-KEY'],['https://old.example.invalid:9443/v1/chat/completions','  SYNTHETIC-OLD-KEY  ']]) {
    const {h,p}=await desktopFolderPlugin();Object.assign(p.settings,{...apiSettings(),apiUrl:'https://old.example.invalid/v1/chat/completions',apiKey});p.persist=async()=>{};
    await p.applyApiConfig({...p.settings,apiUrl});
    assert.equal(p.settings.apiUrl,apiUrl);assert.equal(p.settings.apiKey,'');assert.equal(p.settings.apiEnabled,false);
    assert.ok(h.notices.at(-1).includes('清除'));p.onunload();
  }
});

test('same-origin path and key rotation are applied together and still require enabling API',async()=>{
  const {p}=await desktopFolderPlugin();Object.assign(p.settings,{...apiSettings(),apiUrl:'https://provider.example.invalid/old',apiKey:'SYNTHETIC-KEY'});p.persist=async()=>{};
  await p.applyApiConfig({...p.settings,apiUrl:'https://provider.example.invalid/new'});
  assert.equal(p.settings.apiKey,'SYNTHETIC-KEY');assert.equal(p.settings.apiEnabled,false);
  await p.applyApiConfig({...p.settings,apiKey:'SYNTHETIC-ROTATED'});assert.equal(p.settings.apiKey,'SYNTHETIC-ROTATED');
  await p.setApiEnabled(true);assert.equal(p.settings.apiEnabled,true);p.onunload();
});

test('applying API drafts is blocked while an ASR, manual action or uncancellable HTTP call is active',async()=>{
  for(const busy of ['queue','manual','http']) {
    const {p}=await desktopFolderPlugin();const before=JSON.stringify(p.settings);p.persist=async()=>{throw Error('must not save');};
    if(busy==='queue')p.queue.busy=true;else if(busy==='manual')p.manualBusy=true;else p.llm.active=true;
    await assert.rejects(p.applyApiConfig({apiUrl:'https://new.example.invalid/v1/chat/completions',model:'new',apiKey:'synthetic'}),e=>e.code==='busy');
    assert.equal(JSON.stringify(p.settings),before);p.queue.busy=false;p.manualBusy=false;p.llm.active=false;p.onunload();
  }
});

test('API apply closes the gate before persistence, blocks re-enable, and stays off after a disk failure',async()=>{
  const {h,p}=await desktopFolderPlugin();Object.assign(p.settings,{...apiSettings(),apiUrl:'https://old.example.invalid/v1/chat/completions',apiKey:'SYNTHETIC-OLD-KEY'});
  let failSave;p.persist=()=>new Promise((_,reject)=>{failSave=reject;});
  const applying=p.applyApiConfig({apiUrl:'https://new.example.invalid/v1/chat/completions',model:'new',apiKey:'SYNTHETIC-NEW-KEY'});
  assert.equal(p.settings.apiEnabled,false);await assert.rejects(p.setApiEnabled(true),e=>e.code==='busy');
  failSave(Error('disk SYNTHETIC-NEW-KEY'));await assert.rejects(applying,e=>e.code==='storage');
  assert.equal(p.settings.apiEnabled,false);assert.equal(p.settings.apiUrl,'https://old.example.invalid/v1/chat/completions');
  assert.equal(p.settings.apiKey,'SYNTHETIC-OLD-KEY');assert.equal(p.apiConfigTask,false);assert.ok(!h.notices.join('').includes('SYNTHETIC'));p.onunload();
});

test('remote HTTP is rejected on apply and enable without persisting unsafe credentials',async()=>{
  const {p}=await desktopFolderPlugin();let saves=0;p.persist=async()=>{saves++;};const before=JSON.stringify(p.settings);
  await assert.rejects(p.applyApiConfig({apiUrl:'http://remote.example.invalid/v1/chat/completions',model:'m',apiKey:'synthetic'}),e=>e.code==='config'&&e.message.includes('HTTPS'));
  assert.equal(JSON.stringify(p.settings),before);assert.equal(saves,0);
  Object.assign(p.settings,{apiUrl:'http://remote.example.invalid/v1/chat/completions',model:'m',apiKey:'synthetic',apiEnabled:false});
  await assert.rejects(p.setApiEnabled(true),e=>e.code==='config'&&e.message.includes('HTTPS'));
  assert.equal(p.settings.apiEnabled,false);assert.equal(saves,0);p.onunload();
});

test('editing provider drafts during local ASR cannot send its old key to the new host',async()=>{
  const {h,p,add}=await desktopFolderPlugin();Object.assign(p.settings,{...apiSettings(),apiUrl:'https://old.example.invalid/v1/chat/completions',apiKey:'SYNTHETIC-OLD-KEY'});p.persist=async()=>{};
  p.app.vault.create=async(path,body)=>add(path,body);p.app.vault.read=async file=>new TextDecoder().decode(file.data);
  let now=0,enter,finish;const entered=new Promise(resolve=>{enter=resolve;}),blocked=new Promise(resolve=>{finish=resolve;});let sent;
  p.queue.now=()=>now;p.queue.transcribe=async()=>{enter();await blocked;return 'synthetic diary';};
  p.queue.llm={complete:async config=>{sent=config;return 'synthetic result';}};
  const audio=add('Voice Diary/Recordings/new.webm','synthetic audio');await p.queue.tick();now=31000;
  const processing=p.queue.tick();await entered;p.settingTab.display();
  h.texts.find(x=>x.name==='文字接口完整地址').text.change('https://new.example.invalid/v1/chat/completions');
  await h.buttons.find(x=>x.text==='应用接口配置').fn();assert.ok(h.notices.at(-1).includes('请等待'));
  finish();await processing;assert.equal(p.state.jobs[audio.path].status,'done');
  assert.equal(sent.apiUrl,'https://old.example.invalid/v1/chat/completions');assert.equal(sent.apiKey,'SYNTHETIC-OLD-KEY');p.onunload();
});

test('partial legacy migration changes origin without inheriting the current provider key or enabling API',async()=>{
  const h=host(),legacy=JSON.stringify({apiUrl:'https://new.example.invalid/v1/chat/completions',model:'new-model'});
  const p=new h.Plugin({vault:{configDir:'.obsidian',adapter:{getBasePath:()=> 'D:/synthetic-vault',exists:async path=>path.includes('llm-text-assistant'),read:async()=>legacy}}});
  p.settings={...apiSettings(),apiUrl:'https://old.example.invalid/v1/chat/completions',apiKey:'SYNTHETIC-OLD-KEY'};
  p.queue={busy:false};p.state={config:p.settings,jobs:{},enabled:true};p.persist=async()=>{};
  await p.migrate();assert.equal(p.settings.apiUrl,'https://new.example.invalid/v1/chat/completions');assert.equal(p.settings.apiKey,'');
  assert.equal(p.settings.apiEnabled,false);assert.equal(p.state.enabled,false);assert.ok(!h.notices.join('').includes('SYNTHETIC'));
});

test('model preparation displays its busy state and blocks queue polling until it finishes',async()=>{
  const {h,p}=await desktopFolderPlugin();let finish,ticks=0;
  p.senseVoiceOptions=()=>({});p.asr={prepare:()=>new Promise(resolve=>{finish=resolve;}),close:async()=>{}};
  p.queue.tick=async()=>{ticks++;};
  const task=p.prepareModel();assert.equal(p.preparing,true);assert.match(p.status.text,/正在检查 SenseVoice/);
  await p.safeTick();assert.equal(ticks,0);
  finish({model:'SenseVoiceSmall INT8',device:'cpu'});await task;
  assert.equal(p.preparing,false);assert.equal(p.progress,'');assert.match(p.status.text,/自动处理开启/);
  assert.ok(h.notices.some(x=>x.includes('模型就绪')));p.onunload();
});

test('failed model-path persistence restores the previous path and clears the checking status',async()=>{
  const {p}=await desktopFolderPlugin();const original=p.settings.senseVoiceRoot;
  p.senseVoiceOptions=root=>({root});p.asr={prepare:async()=>({model:'SenseVoiceSmall INT8',device:'cpu'}),close:async()=>{}};
  p.persist=async()=>{throw Error('disk full');};
  await assert.rejects(p.applySenseVoiceRoot('D:/another installation'));
  assert.equal(p.settings.senseVoiceRoot,original);assert.equal(p.preparing,false);assert.equal(p.progress,'');
  assert.match(p.status.text,/自动处理开启/);p.onunload();
});

test('language selection offers only supported choices without silently rewriting an old unsupported value',async()=>{
  const {h,p}=await desktopFolderPlugin();p.settings.language='zh-CN';let saves=0;p.persist=async()=>{saves++;};
  p.settingTab.display();const language=h.dropdowns.find(x=>x.name==='识别语言').dropdown;
  assert.equal(language.value,'zh-CN');assert.match(language.options['zh-CN'],/暂不支持/);assert.equal(saves,0);
  language.change('unsupported');assert.equal(p.settings.language,'zh-CN');assert.equal(saves,0);
  language.change('auto');assert.equal(p.settings.language,'auto');assert.equal(saves,1);
  assert.deepEqual(Object.keys(language.options).filter(x=>x!=='zh-CN'),['auto','zh','en','ja','ko','yue']);p.onunload();
});

test('new installs use public paths while saved folder and external runtime settings remain unchanged',async()=>{
  assert.equal(DEFAULTS.folder,'Voice Diary/Recordings');assert.equal(DEFAULTS.finalFolder,'Voice Diary/Notes');assert.equal(DEFAULTS.senseVoiceRoot,'');
  const h=host(true),saved={config:{folder:'旧目录/录音',finalFolder:'旧目录/成品',senseVoiceRoot:'D:/Existing SenseVoice'},jobs:{},enabled:false};
  const p=new h.Plugin({loadLocalStorage:()=>saved,saveLocalStorage(){},vault:{},workspace:{}});await p.onload();
  assert.equal(p.settings.folder,'旧目录/录音');assert.equal(p.settings.finalFolder,'旧目录/成品');assert.equal(p.settings.senseVoiceRoot,'D:/Existing SenseVoice');p.onunload();
});

test('public settings omit device identities and offer only manual environment preparation links',async()=>{
  const {h,p}=await desktopFolderPlugin();p.store.dir='C:/Users/PRIVATE-USER/AppData/Local/private-id';
  p.managedSenseVoiceRoot='C:/Users/PRIVATE-USER/AppData/Local/sensevoice';p.settings.senseVoiceRoot=p.managedSenseVoiceRoot;
  p.settingTab.display();
  const visible=[...h.elements.map(x=>x.text),...h.descriptions,...h.texts.map(x=>x.text.value)].join('\n');
  assert.ok(!visible.includes('PRIVATE-USER'));assert.ok(!visible.includes('04_Daily'));assert.ok(!visible.includes('开发版'));
  assert.ok(h.buttons.some(x=>x.text==='手动环境准备说明'));assert.ok(h.buttons.some(x=>x.text==='官方模型下载'));assert.ok(h.buttons.some(x=>x.text==='SenseVoice 原作者'));
  assert.ok(!h.buttons.some(x=>x.text==='下载并准备'||x.text==='取消下载'));
  assert.equal(h.texts.find(x=>x.name==='现有 SenseVoice 安装目录（可选）').text.value,'');assert.equal(p.installer,undefined);assert.equal(p.downloadSenseVoice,undefined);p.onunload();
});

test('manual preparation buttons only open official resources and project release instructions',async()=>{
  const {h,p}=await desktopFolderPlugin();const before=JSON.stringify(p.settings),enabled=p.state.enabled;let saves=0;
  p.persist=async()=>{saves++;};p.settingTab.display();
  for(const title of ['手动环境准备说明','官方模型下载','SenseVoice 原作者','模型许可'])await h.buttons.find(x=>x.text===title).fn();
  assert.deepEqual(h.openedUrls.map(x=>x[0]),[
    'https://github.com/jem-code-sss/obsidian-voice-diary/releases',
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
    'https://github.com/QwenAudio/SenseVoice','https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE']);
  assert.ok(h.openedUrls.every(x=>x[1]==='_blank'&&x[2]==='noopener,noreferrer'));
  assert.equal(JSON.stringify(p.settings),before);assert.equal(p.state.enabled,enabled);assert.equal(saves,0);assert.equal(p.installer,undefined);
  assert.ok(h.requires.every(id=>id==='obsidian'));p.onunload();
});

test('local transcription awaits the bundled runner cache and never requires extra plugin files',async()=>{
  const {p}=await desktopFolderPlugin();let release,options,calls=0,started;
  const waiting=new Promise(resolve=>{started=resolve;});p.settings.senseVoiceRoot='D:/Existing Runtime';
  p.runtimeAssets={ensureRunner:()=>{started();return new Promise(resolve=>{release=resolve;});},close:async()=>{}};
  p.asr={transcribe:async input=>{calls++;options=input;return '识别结果';},close:async()=>{}};
  const data=new TextEncoder().encode('audio bytes').buffer,task=p.transcribeLocal({data});await waiting;assert.equal(calls,0);
  release('C:/Cache/0.3.0/sensevoice_runner.py');assert.equal(await task,'识别结果');assert.equal(calls,1);
  assert.equal(options.scriptPath,'C:/Cache/0.3.0/sensevoice_runner.py');assert.equal(options.root,'D:/Existing Runtime');assert.equal(options.audio,data);p.onunload();
});

test('unloading during runner-cache preparation prevents a late Python process',async()=>{
  const {p}=await desktopFolderPlugin();let release,started,calls=0;
  const waiting=new Promise(resolve=>{started=resolve;}),ready=new Promise(resolve=>{release=resolve;});
  p.runtimeAssets={ensureRunner:()=>{started();return ready;},close:async()=>{await ready;}};
  p.asr={transcribe:async()=>{calls++;},close:async()=>{}};
  const task=p.transcribeLocal({data:new ArrayBuffer(2)}),rejected=assert.rejects(task,e=>e.code==='closed');await waiting;
  p.onunload();release('C:/Cache/0.3.0/sensevoice_runner.py');await rejected;assert.equal(calls,0);
});

test('a missing desktop runtime cache root fails safely before reading or writing external files',async()=>{
  const {h,p}=await desktopFolderPlugin();assert.equal(p.runtimeAssets,undefined);
  await assert.rejects(p.runtimeScript(),e=>e.code==='runtime_assets'&&e.pause===true);
  assert.ok(h.requires.every(id=>id==='obsidian'));p.onunload();
});

test('desktop naming controls persist the source option and year flag while explaining the local 04:00 rule',async()=>{
  const {h,p}=await desktopFolderPlugin();let saved=0;p.persist=async()=>{saved++;};p.settingTab.display();
  const naming=h.dropdowns.find(item=>item.name==='成品笔记命名').dropdown;
  const year=h.toggles.find(item=>item.name==='标题包含年份').toggle;
  assert.equal(naming.value,'date-topic');assert.equal(year.value,false);
  naming.change('source');year.change(true);
  assert.equal(p.settings.noteNaming,'source');assert.equal(p.settings.titleIncludeYear,true);assert.equal(saved,2);
  assert.ok(h.descriptions.some(text=>text.includes('04:00')&&text.includes('创建时间')));
  assert.ok(h.descriptions.some(text=>text.includes('本地提取')&&text.includes('不额外调用 API')));p.onunload();
});
