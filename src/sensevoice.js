// Node dependencies are deliberately loaded only when desktop recognition starts.
const {DiaryError}=require('./core');
const SENSEVOICE_LANGUAGES=Object.freeze(['auto','zh','en','ja','ko','yue']);
const MODEL='SenseVoiceSmall INT8';
const LOCAL_PATH=/^[A-Za-z]:[\\/]/;
const fail=(code,message,options={})=>new DiaryError(code,message,{pause:true,...options});
const RUNNER_ERRORS=Object.freeze({
  dependencies:['sensevoice_dependencies','SenseVoice 本地依赖未就绪，请检查 Python 环境及 sherpa-onnx、NumPy、FFmpeg 的安装'],
  model:['sensevoice_model','SenseVoice 模型加载失败，请检查模型文件和本机安装目录'],
  audio_decode:['sensevoice_audio_decode','无法解码这份录音，请检查文件是否完整或重新录制；原录音保留',{manual:true,pause:false}],
  recognition:['sensevoice_recognition','SenseVoice 识别失败，请检查模型和识别语言；原录音保留'],
  output:['sensevoice_output','本地识别结果无法写入，请检查临时目录权限和磁盘空间；原录音保留'],
  runtime:['sensevoice_runtime','SenseVoice 本地运行失败，请检查本机安装环境；原录音保留']
});

class SenseVoiceEngine {
  constructor(deps={}) { this.deps=deps;this.current=null;this.closed=false; }
  prepare(options={}) { return this._start(options,true); }
  transcribe(options={}) { return this._start(options,false); }
  async cancel() {
    const state=this.current;
    if(state){this._cancel(state,'cancelled');await state.done.catch(()=>{});}
  }
  async close() {
    this.closed=true;
    const state=this.current;
    if(state) {this._cancel(state,'closed');await state.done.catch(()=>{});}
  }
  async _start(options,probe) {
    if(this.closed)throw fail('sensevoice_closed','本地识别已关闭，请重新加载插件');
    if(this.current)throw fail('sensevoice_busy','本地识别正在运行，请稍后重试');
    const state={cancelled:null,child:null,killTimer:null,timeout:null,done:null};
    this.current=state;
    state.done=this._execute(options,probe,state).finally(()=>{if(this.current===state)this.current=null;});
    return state.done;
  }
  _modules() {
    const d=this.deps;
    return {fs:d.fs||require('fs/promises'),path:d.path||require('path'),os:d.os||require('os'),
      spawn:d.spawn||require('child_process').spawn,Buffer:d.Buffer||require('buffer').Buffer,
      setTimeout:d.setTimeout||((f,t)=>globalThis.setTimeout(f,t)),
      clearTimeout:d.clearTimeout||(t=>globalThis.clearTimeout(t)),
      env:d.env||(typeof process==='object'?process.env:{})};
  }
  _cancel(state,reason) {
    if(state.cancelled)return;
    state.cancelled=reason;
    const child=state.child;
    if(!child)return;
    // Cooperative cancellation lets the runner stop its own ffmpeg child first.
    try {child.stdin?.write('cancel\n');}catch(_) {}
    const schedule=this.deps.setTimeout||((f,t)=>globalThis.setTimeout(f,t));
    state.killTimer=schedule(()=>this._forceStop(state,child),5000);
  }
  _forceStop(state,child) {
    if(state.child!==child||child.exitCode!=null||child.signalCode!=null)return;
    const platform=this.deps.platform||(typeof process==='object'?process.platform:'');
    const kill=()=>{try {child.kill();}catch(_) {}};
    if(platform!=='win32'||!Number.isSafeInteger(child.pid)||child.pid<=0){kill();return;}
    // Windows venv launchers create a second Python process. Kill only the tree
    // rooted at this exact, still-owned child, never all processes by image name.
    const m=this._modules(),systemRoot=m.env.SystemRoot||m.env.SYSTEMROOT||'C:\\Windows';
    if(!LOCAL_PATH.test(systemRoot)){kill();return;}
    try {
      const helper=m.spawn(m.path.join(systemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],
        {shell:false,windowsHide:true,stdio:'ignore'});
      helper.once('error',kill);
      helper.once('close',code=>{if(code!==0)kill();});
    }catch(_) {kill();}
  }
  _checkCancelled(state) {
    if(state.cancelled==='timeout')throw fail('sensevoice_timeout','本地识别超过 10 分钟，已停止；原录音保留，可稍后重试');
    if(state.cancelled==='protocol')throw fail('sensevoice_protocol','本地识别进程返回异常，未保存不完整转写');
    if(state.cancelled)throw fail('sensevoice_cancelled','本地识别已取消，原录音保留');
  }
  async _execute(options,probe,state) {
    let m,temp;
    try {
      m=this._modules();
      const language=options.language??'zh';
      if(!SENSEVOICE_LANGUAGES.includes(language))throw fail('sensevoice_language','SenseVoice 语言仅支持 zh、auto、en、ja、ko、yue，请修改识别语言');
      const local=value=>typeof value==='string'&&LOCAL_PATH.test(value)&&!/[\x00-\x1f]/.test(value);
      if(!local(options.root)||!local(options.scriptPath))throw fail('sensevoice_path','请设置本机磁盘上的 SenseVoice 安装目录');
      let root,scriptPath;
      try {
        root=await m.fs.realpath(options.root);scriptPath=await m.fs.realpath(options.scriptPath);
        if(!local(root)||!local(scriptPath))throw new Error();
        for(const file of [m.path.join(root,'.venv','Scripts','python.exe'),m.path.join(root,'models','model.int8.onnx'),m.path.join(root,'models','tokens.txt'),scriptPath])
          if(!(await m.fs.stat(file)).isFile())throw new Error();
      }catch(_) {throw fail('sensevoice_install','未找到完整的 SenseVoice 本地环境，请检查安装目录、Python 和模型文件');}
      this._checkCancelled(state);
      temp=await m.fs.mkdtemp(m.path.join(m.os.tmpdir(),'voice-diary-sensevoice-'));
      const resultPath=m.path.join(temp,'result.json');
      const args=['-B','-u',scriptPath,'--root',root,'--language',language,'--output',resultPath];
      if(probe)args.push('--probe');
      else {
        const audio=options.audio;
        if(!(audio instanceof ArrayBuffer)&&!ArrayBuffer.isView(audio))throw fail('sensevoice_audio','没有可供本地识别的录音数据',{manual:true,pause:false});
        const bytes=audio instanceof ArrayBuffer?m.Buffer.from(audio):m.Buffer.from(audio.buffer,audio.byteOffset,audio.byteLength);
        if(!bytes.length)throw fail('sensevoice_audio','录音为空，请重新录制',{manual:true,pause:false});
        const inputPath=m.path.join(temp,'input.audio');
        await m.fs.writeFile(inputPath,bytes,{flag:'wx'});
        args.push('--input',inputPath);
      }
      this._checkCancelled(state);
      let tail='',stdoutBytes=0,stderrTail='',runnerError=null;
      const report=value=>{try {options.onProgress?.(value);}catch(_) {}};
      report({stage:'loading',pct:0});
      this._checkCancelled(state);
      const status=await new Promise(resolve=>{
        let child;
        try {
          child=m.spawn(m.path.join(root,'.venv','Scripts','python.exe'),args,{shell:false,windowsHide:true,
            cwd:temp,stdio:['pipe','pipe','pipe'],env:{...m.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',
              HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
        }catch(_) {resolve({spawnFailed:true});return;}
        state.child=child;
        child.stdin?.on('error',()=>{});
        child.stdout?.on('data',chunk=>{
          stdoutBytes+=chunk.length;
          if(stdoutBytes>1024*1024){this._cancel(state,'protocol');return;}
          tail+=chunk.toString('utf8');
          if(tail.length>65536){this._cancel(state,'protocol');return;}
          let lineEnd;
          while((lineEnd=tail.indexOf('\n'))>=0) {
            const line=tail.slice(0,lineEnd);tail=tail.slice(lineEnd+1);
            try {
              const p=JSON.parse(line);
              if(p.event==='ready')report({stage:'transcribing',pct:0});
              if(p.event==='progress'&&Number.isFinite(p.pct))report({stage:'transcribing',pct:Math.max(0,Math.min(100,Math.round(p.pct)))});
              if(p.event==='error'&&typeof p.code==='string'&&Object.prototype.hasOwnProperty.call(RUNNER_ERRORS,p.code))runnerError=p.code;
            }catch(_) {/* Private process output is never passed to notices or logs. */}
          }
        });
        child.stderr?.on('data',chunk=>{stderrTail=(stderrTail+chunk.toString('utf8')).slice(-8192);});
        let spawnFailed=false;
        child.once('error',()=>{spawnFailed=true;});
        child.once('close',(code,signal)=>resolve({code,signal,spawnFailed}));
        state.timeout=m.setTimeout(()=>this._cancel(state,'timeout'),this.deps.timeoutMs||600000);
      });
      // stderr remains bounded and private; never attach it to errors or telemetry.
      stderrTail='';
      if(state.timeout)m.clearTimeout(state.timeout);
      if(state.killTimer)m.clearTimeout(state.killTimer);
      state.child=null;
      this._checkCancelled(state);
      if(status.spawnFailed)throw fail('sensevoice_process','无法启动 SenseVoice 本地 Python，请检查本机安装环境');
      if(status.code!==0) {
        if(runnerError)throw fail(...RUNNER_ERRORS[runnerError]);
        throw fail('sensevoice_failed','SenseVoice 本地识别未完成，请检查模型、语言和录音格式；原录音保留');
      }
      let result;
      try {
        const stat=await m.fs.stat(resultPath);
        if(!stat.isFile()||stat.size>16*1024*1024)throw new Error();
        result=JSON.parse(await m.fs.readFile(resultPath,'utf8'));
      }catch(_) {throw fail('sensevoice_result','本地识别结果不完整，未保存转写；原录音保留');}
      this._checkCancelled(state);
      if(!result||result.ok!==true||result.model!==MODEL||result.device!=='cpu')throw fail('sensevoice_result','本地识别结果不完整，未保存转写；原录音保留');
      if(!probe&&(typeof result.text!=='string'||!/[\p{L}\p{N}]/u.test(result.text)))throw fail('sensevoice_empty','未识别到可用文字，请检查录音；原录音保留',{manual:true,pause:false});
      report({stage:'complete',pct:100});
      this._checkCancelled(state);
      if(probe)return {model:MODEL,device:'cpu'};
      return result.text.trim();
    }catch(e) {
      if(e instanceof DiaryError)throw e;
      throw fail('sensevoice_failed','SenseVoice 本地识别未完成，请检查本机环境和磁盘空间；原录音保留');
    }finally {
      if(m&&state.timeout)m.clearTimeout(state.timeout);
      if(m&&state.killTimer)m.clearTimeout(state.killTimer);
      if(temp&&m) {
        try {
          const target=m.path.resolve(temp),parent=m.path.resolve(m.os.tmpdir());
          if(m.path.dirname(target)!==parent||!m.path.basename(target).startsWith('voice-diary-sensevoice-'))throw new Error();
          await m.fs.rm(target,{recursive:true,force:true,maxRetries:4,retryDelay:100});
        }
        catch(_) {throw fail('sensevoice_cleanup','本地识别临时文件清理失败，请重启 Obsidian 后重试');}
      }
    }
  }
}

module.exports={SenseVoiceEngine,SENSEVOICE_LANGUAGES};
