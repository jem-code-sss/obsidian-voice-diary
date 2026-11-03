const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {SenseVoiceEngine,SENSEVOICE_LANGUAGES}=require('../src/sensevoice');

// This suite never starts Python, reads a user's recording, or accesses the network.
// The fake filesystem is Windows-shaped so spaces and Chinese path segments also
// exercise the production spawn argument construction on any test host.
const win=path.win32;
const ROOT='D:\\中文 安装目录\\Sense Voice';
const SCRIPT='D:\\插件 目录\\sensevoice-runner.py';
const PRIVATE='私人录音内容 PRIVATE-KEY traceback';
const goodResult=text=>({ok:true,model:'SenseVoiceSmall INT8',device:'cpu',text});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

function fixture(options={}) {
  const files=new Map(),calls=[],removals=[],written=[],timerCalls=[],timers=new Map();
  const spawned=deferred(),readStarted=deferred(),cleanupStarted=deferred(),cleanupRelease=deferred();
  let timerId=0;
  const python=win.join(ROOT,'.venv','Scripts','python.exe');
  const model=win.join(ROOT,'models','model.int8.onnx');
  const tokens=win.join(ROOT,'models','tokens.txt');
  for(const name of [python,model,tokens,SCRIPT])files.set(name,{type:'file',data:Buffer.from('local installation')});
  const h={files,calls,removals,written,timerCalls,timers,python,model,tokens,
    spawned:spawned.promise,readStarted:readStarted.promise,cleanupStarted:cleanupStarted.promise,releaseCleanup:cleanupRelease.resolve};
  const io={
    async realpath(p){if(options.holdRealpath)await options.holdRealpath;return p;},
    async stat(p){const f=files.get(p);if(!f)throw Error(PRIVATE);return {isFile:()=>f.type==='file',size:f.size??f.data?.length??0};},
    async mkdtemp(prefix){const dir=options.tempPath??prefix+'case';h.temp=dir;files.set(dir,{type:'directory'});return dir;},
    async writeFile(p,data,opts){assert.equal(opts.flag,'wx');if(files.has(p))throw Error('exists');const copy=Buffer.from(data);written.push({path:p,data:copy});files.set(p,{type:'file',data:copy});},
    async readFile(p){readStarted.resolve();if(options.holdRead)await options.holdRead;const f=files.get(p);if(!f)throw Error(PRIVATE);return f.data.toString('utf8');},
    async rm(p,opts){removals.push({path:p,opts});cleanupStarted.resolve();if(options.holdCleanup)await cleanupRelease.promise;if(options.failCleanup)throw Error(PRIVATE);for(const key of [...files.keys()])if(key===p||key.startsWith(p+'\\'))files.delete(key);}
  };
  const deps={fs:io,path:win,os:{tmpdir:()=> 'C:\\临时 目录'},Buffer,platform:options.platform??'win32',env:{LOCAL_MARKER:'local-only',...(options.systemRoot===undefined?{}:{SystemRoot:options.systemRoot})},
    setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});timerCalls.push(delay);return id;},
    clearTimeout(id){timers.delete(id);},
    spawn(command,args,spawnOptions){
      calls.push({command,args,options:spawnOptions});
      if(options.spawnThrows)throw Error(PRIVATE);
      if(spawnOptions.stdio==='ignore') {
        if(options.helperThrows)throw Error(PRIVATE);
        h.helper=new EventEmitter();return h.helper;
      }
      const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
      child.pid=options.pid;child.exitCode=null;child.signalCode=null;
      child.writes=[];child.kills=0;child.stdin.write=value=>{child.writes.push(value);return true;};child.kill=()=>{child.kills++;return true;};
      h.child=child;spawned.resolve(child);return child;
    }
  };
  h.engine=new SenseVoiceEngine(deps);h.deps=deps;
  h.options={root:ROOT,scriptPath:SCRIPT,language:'zh',audio:Uint8Array.from([1,2,3]).buffer};
  h.finish=async(result=goodResult('识别正文'),code=0)=>{
    const child=await h.spawned;
    if(result!==null) {
      const output=h.calls[0].args[h.calls[0].args.indexOf('--output')+1];
      files.set(output,{type:'file',data:Buffer.from(typeof result==='string'?result:JSON.stringify(result))});
    }
    child.emit('close',code,null);
  };
  h.assertClean=()=>{
    assert.equal(removals.length,1);assert.equal(removals[0].path,h.temp);assert.equal(removals[0].opts.recursive,true);assert.equal(removals[0].opts.force,true);
    assert.ok(![...files.keys()].some(p=>p===h.temp||p.startsWith(h.temp+'\\')));
    assert.ok(files.has(python));assert.ok(files.has(model));assert.ok(files.has(tokens));assert.equal(timers.size,0);
  };
  return h;
}
function safeError(code,{pause=true,manual}={}) {
  return error=>{
    assert.equal(error.code,code);assert.equal(error.pause,pause);
    if(manual!==undefined)assert.equal(error.manual,manual);
    assert.ok(!String(error.stack).includes(PRIVATE));assert.ok(!String(error.message).includes('PRIVATE-KEY'));
    return true;
  };
}

test('SenseVoice module can be imported by mobile without loading Node dependencies',()=>{
  const imports=[],context={module:{exports:{}},require(id){imports.push(id);if(id==='./core')return require('../src/core');throw Error('Node loaded on mobile');}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/sensevoice.js'),'utf8'),context);
  assert.deepEqual(imports,['./core']);assert.equal(typeof context.module.exports.SenseVoiceEngine,'function');
  assert.deepEqual([...SENSEVOICE_LANGUAGES],['auto','zh','en','ja','ko','yue']);
});

test('prepare probes only the installed local runner with offline flags and cleans its result',async()=>{
  const h=fixture(),progress=[],job=h.engine.prepare({...h.options,onProgress:p=>progress.push(p)});await h.spawned;
  const call=h.calls[0];assert.equal(call.command,h.python);assert.ok(Array.isArray(call.args));assert.ok(call.args.includes('--probe'));assert.ok(!call.args.includes('--input'));
  assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.equal(call.options.cwd,h.temp);
  assert.equal(call.options.env.HF_HUB_OFFLINE,'1');assert.equal(call.options.env.TRANSFORMERS_OFFLINE,'1');assert.equal(call.options.env.PYTHONDONTWRITEBYTECODE,'1');
  h.child.stdout.emit('data',Buffer.from('{"event":"ready"}\n'));await h.finish(goodResult(undefined));
  assert.deepEqual(await job,{model:'SenseVoiceSmall INT8',device:'cpu'});assert.deepEqual(progress.map(p=>p.stage),['loading','transcribing','complete']);assert.equal(h.written.length,0);h.assertClean();
});

test('transcribe preserves Unicode and space paths as individual spawn arguments and writes only the audio view',async()=>{
  const h=fixture(),bytes=Uint8Array.from([99,10,20,30,99]),job=h.engine.transcribe({...h.options,audio:bytes.subarray(1,4)});await h.spawned;
  const call=h.calls[0];assert.equal(call.args[2],SCRIPT);assert.equal(call.args[call.args.indexOf('--root')+1],ROOT);assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
  assert.deepEqual([...h.written[0].data],[10,20,30]);assert.equal(h.written[0].path,win.join(h.temp,'input.audio'));
  await h.finish(goodResult('  保留否定：还没有决定。\n'));assert.equal(await job,'保留否定：还没有决定。');h.assertClean();
});

for(const [name,part] of [['Python','python'],['model','model'],['tokens','tokens'],['runner','script']]) {
  test(`missing ${name} fails without starting a child or downloading anything`,async()=>{
    const h=fixture();h.files.delete(part==='script'?SCRIPT:h[part]);
    await assert.rejects(h.engine.prepare(h.options),safeError('sensevoice_install'));assert.equal(h.calls.length,0);assert.equal(h.written.length,0);assert.equal(h.removals.length,0);
  });
}

test('missing ffmpeg reported by the offline runner fails safely and removes temporary audio',async()=>{
  const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;h.child.stderr.emit('data',Buffer.from(PRIVATE+' ffmpeg missing'));
  await h.finish(null,1);await assert.rejects(job,safeError('sensevoice_failed'));h.assertClean();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].command,h.python);assert.ok(!h.calls[0].args.some(a=>/pip|download|https?:/i.test(a)));
});

test('invalid language, non-local path and empty audio fail without starting a child',async()=>{
  for(const [override,code] of [[{language:'not-supported'},'sensevoice_language'],[{root:'\\\\server\\share'},'sensevoice_path'],[{scriptPath:'https://example.invalid/runner.py'},'sensevoice_path'],[{audio:new ArrayBuffer(0)},'sensevoice_audio']]) {
    const h=fixture();await assert.rejects(h.engine.transcribe({...h.options,...override}),safeError(code,code==='sensevoice_audio'?{pause:false,manual:true}:undefined));assert.equal(h.calls.length,0);if(h.temp)h.assertClean();
  }
});

test('missing or empty input is a per-recording error requiring manual retry',async()=>{
  for(const audio of [null,undefined,'not audio',new ArrayBuffer(0),new Uint8Array(0)]) {
    const h=fixture();await assert.rejects(h.engine.transcribe({...h.options,audio}),safeError('sensevoice_audio',{pause:false,manual:true}));
    assert.equal(h.calls.length,0);h.assertClean();
  }
});

test('the same engine rejects overlapping work without disturbing its active process',async()=>{
  const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;
  await assert.rejects(h.engine.prepare(h.options),safeError('sensevoice_busy'));assert.equal(h.calls.length,1);assert.equal(h.child.writes.length,0);
  await h.finish();assert.equal(await job,'识别正文');h.assertClean();
});

test('spawn exceptions and child launch errors are private and clean up temporary files',async()=>{
  const thrown=fixture({spawnThrows:true});await assert.rejects(thrown.engine.transcribe(thrown.options),safeError('sensevoice_process'));thrown.assertClean();
  const emitted=fixture(),job=emitted.engine.transcribe(emitted.options);await emitted.spawned;
  emitted.child.emit('error',Error(PRIVATE));await emitted.finish(null,-1);await assert.rejects(job,safeError('sensevoice_process'));emitted.assertClean();
});

for(const [name,result,code,errorOptions] of [
  ['missing output file',null,'sensevoice_result'],['malformed output JSON','{'+PRIVATE,'sensevoice_result'],
  ['null output JSON','null','sensevoice_result'],
  ['wrong model',{...goodResult(PRIVATE),model:'remote-model'},'sensevoice_result'],
  ['wrong device',{...goodResult(PRIVATE),device:'network'},'sensevoice_result'],
  ['unsuccessful result',{...goodResult(PRIVATE),ok:false},'sensevoice_result'],
  ['empty transcript',goodResult(' \n '),'sensevoice_empty',{pause:false,manual:true}]
]) {
  test(`${name} never produces a successful transcript or exposes child output`,async()=>{
    const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;h.child.stderr.emit('data',Buffer.from(PRIVATE));await h.finish(result);
    await assert.rejects(job,safeError(code,errorOptions));h.assertClean();
  });
}

test('silence and punctuation-only results do not report completion or pause other recordings',async()=>{
  for(const text of ['', ' \n ', '。！？……，；：', '.,!?;:-_()[]{}', '🎤 👋 ✅']) {
    const h=fixture(),progress=[],job=h.engine.transcribe({...h.options,onProgress:p=>progress.push(p)});await h.spawned;
    await h.finish(goodResult(text));await assert.rejects(job,safeError('sensevoice_empty',{pause:false,manual:true}));
    assert.ok(!progress.some(p=>p.stage==='complete'));h.assertClean();
  }
});

test('Unicode letters and numbers remain valid transcript content',async()=>{
  for(const text of ['一。','ひらがな。','한글.','café!','العربية','𠮷','123','１２３','Ⅶ']) {
    const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;await h.finish(goodResult(text));
    assert.equal(await job,text);h.assertClean();
  }
});

for(const [runnerCode,errorCode,message,pause] of [
  ['dependencies','sensevoice_dependencies','依赖',true],
  ['model','sensevoice_model','模型加载',true],
  ['audio_decode','sensevoice_audio_decode','解码',false],
  ['recognition','sensevoice_recognition','识别失败',true],
  ['output','sensevoice_output','磁盘空间',true],
  ['runtime','sensevoice_runtime','本地运行',true]
]) {
  test(`runner ${runnerCode} errors expose only their fixed safe category`,async()=>{
    const h=fixture(),progress=[],job=h.engine.transcribe({...h.options,onProgress:p=>progress.push(p)});await h.spawned;
    h.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'error',code:runnerCode,message:PRIVATE,detail:{path:PRIVATE}})+'\n'));
    h.child.stderr.emit('data',Buffer.from(PRIVATE));await h.finish(null,1);
    await assert.rejects(job,error=>{
      safeError(errorCode,{pause,manual:pause?undefined:true})(error);assert.ok(error.message.includes(message));return true;
    });assert.ok(!progress.some(p=>p.stage==='complete'));h.assertClean();
  });
}

test('unknown runner error codes and private messages fall back to the safe generic failure',async()=>{
  for(const code of [PRIVATE,'__proto__','constructor','audio_decode '+PRIVATE,{toString:PRIVATE},null]) {
    const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;
    h.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'error',code,message:PRIVATE})+'\n'));await h.finish(null,1);
    await assert.rejects(job,safeError('sensevoice_failed'));h.assertClean();
  }
});

test('error codes in non-error events cannot change failure categories',async()=>{
  const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;
  h.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'progress',code:'audio_decode',message:PRIVATE})+'\n'));await h.finish(null,1);
  await assert.rejects(job,safeError('sensevoice_failed'));h.assertClean();
});

test('a failed launch takes precedence over a runner error category',async()=>{
  const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;
  h.child.stdout.emit('data',Buffer.from('{"event":"error","code":"audio_decode"}\n'));h.child.emit('error',Error(PRIVATE));await h.finish(null,-1);
  await assert.rejects(job,safeError('sensevoice_process'));h.assertClean();
});

test('oversized result files fail before their private contents are read',async()=>{
  const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;
  const output=h.calls[0].args[h.calls[0].args.indexOf('--output')+1];h.files.set(output,{type:'file',size:16*1024*1024+1,data:Buffer.from(PRIVATE)});
  h.child.emit('close',0,null);await assert.rejects(job,safeError('sensevoice_result'));h.assertClean();
});

test('bounded library logs are ignored while structured progress is clamped',async()=>{
  const h=fixture(),progress=[],job=h.engine.transcribe({...h.options,onProgress:value=>progress.push(value)});await h.spawned;
  h.child.stdout.emit('data',Buffer.from(PRIVATE+'\n{"event":"progress","pct":150}\n{"event":"progress","pct":-2}\n'));
  await h.finish();assert.equal(await job,'识别正文');assert.deepEqual(progress.map(p=>p.pct),[0,100,0,100]);assert.ok(!JSON.stringify(progress).includes(PRIVATE));h.assertClean();
});

test('excessive process output cancels cooperatively, awaits child exit and fails safely',async()=>{
  const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;h.child.stdout.emit('data',Buffer.alloc(65537,'x'));
  assert.deepEqual(h.child.writes,['cancel\n']);let settled=false;job.then(()=>{settled=true;},()=>{settled=true;});await turn();assert.equal(settled,false);assert.equal(h.removals.length,0);
  await h.finish(goodResult(PRIVATE));await assert.rejects(job,safeError('sensevoice_protocol'));h.assertClean();
});

test('close waits for process exit and temporary cleanup, then prevents later work',async()=>{
  const h=fixture({holdCleanup:true}),job=h.engine.transcribe(h.options);await h.spawned;
  let closed=false;const closing=h.engine.close().then(()=>{closed=true;});assert.deepEqual(h.child.writes,['cancel\n']);await turn();assert.equal(closed,false);assert.equal(h.removals.length,0);
  await h.finish(goodResult(PRIVATE));await h.cleanupStarted;assert.equal(closed,false);h.releaseCleanup();
  await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;assert.equal(closed,true);h.assertClean();
  await assert.rejects(h.engine.prepare(h.options),safeError('sensevoice_closed'));assert.equal(h.calls.length,1);
});

test('closing during installation checks prevents a late child from starting',async()=>{
  const gate=deferred(),h=fixture({holdRealpath:gate.promise}),job=h.engine.prepare(h.options),closing=h.engine.close();
  gate.resolve();await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;assert.equal(h.calls.length,0);assert.equal(h.removals.length,0);
});

test('closing from the loading callback prevents Python from starting and cleans temporary input',async()=>{
  const h=fixture();let closing;
  const job=h.engine.transcribe({...h.options,onProgress:p=>{if(p.stage==='loading')closing=h.engine.close();}});
  await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;
  assert.equal(h.calls.length,0);h.assertClean();assert.equal(h.engine.closed,true);
});

test('closing from the complete callback prevents both probe and transcript success',async()=>{
  for(const method of ['prepare','transcribe']) {
    const h=fixture();let closing;
    const job=h.engine[method]({...h.options,onProgress:p=>{if(p.stage==='complete')closing=h.engine.close();}});await h.spawned;
    await h.finish();await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;h.assertClean();
  }
});

test('closing while the successful result is being read rejects it and waits for cleanup',async()=>{
  const gate=deferred(),h=fixture({holdRead:gate.promise}),job=h.engine.transcribe(h.options);await h.spawned;
  await h.finish(goodResult(PRIVATE));await h.readStarted;let closed=false;
  const closing=h.engine.close().then(()=>{closed=true;});await turn();assert.equal(closed,false);gate.resolve();
  await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;h.assertClean();
});

test('temporary file cleanup failure is surfaced without returning text or exposing filesystem errors',async()=>{
  const h=fixture({failCleanup:true}),job=h.engine.transcribe(h.options);await h.spawned;await h.finish(goodResult(PRIVATE));
  await assert.rejects(job,safeError('sensevoice_cleanup'));assert.equal(h.removals.length,1);assert.equal(h.timers.size,0);
});

test('recursive cleanup rejects temporary paths outside the private directory boundary',async()=>{
  for(const tempPath of ['C:\\outside\\voice-diary-sensevoice-case','C:\\临时 目录\\unrelated-folder']) {
    const h=fixture({tempPath}),job=h.engine.prepare(h.options);await h.spawned;await h.finish(goodResult(undefined));
    await assert.rejects(job,safeError('sensevoice_cleanup'));assert.equal(h.removals.length,0);assert.ok(h.files.has(tempPath));assert.equal(h.timers.size,0);
  }
});

test('timeout sends cancellation then kills an unresponsive runner and awaits close before cleanup',async()=>{
  const h=fixture(),job=h.engine.transcribe(h.options);await h.spawned;
  [...h.timers.values()].find(t=>t.delay===600000).fn();assert.deepEqual(h.child.writes,['cancel\n']);assert.equal(h.removals.length,0);
  [...h.timers.values()].find(t=>t.delay===5000).fn();assert.equal(h.child.kills,1);assert.equal(h.removals.length,0);
  await h.finish(null,1);await assert.rejects(job,safeError('sensevoice_timeout'));h.assertClean();
});

test('Windows cancellation targets only the owned runner PID and its tree using hidden argument-array spawn',async()=>{
  const h=fixture({pid:8421,systemRoot:'D:\\Windows 空格'}),job=h.engine.transcribe(h.options);await h.spawned;
  const closing=h.engine.close();assert.deepEqual(h.child.writes,['cancel\n']);assert.equal(h.calls.length,1);
  [...h.timers.values()].find(t=>t.delay===5000).fn();const helperCall=h.calls[1];
  assert.equal(helperCall.command,'D:\\Windows 空格\\System32\\taskkill.exe');assert.deepEqual(helperCall.args,['/PID','8421','/T','/F']);
  assert.deepEqual(helperCall.options,{shell:false,windowsHide:true,stdio:'ignore'});assert.ok(!helperCall.args.includes('/IM'));
  h.helper.emit('close',0);assert.equal(h.child.kills,0);assert.equal(h.removals.length,0);
  await h.finish(null,1);await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;h.assertClean();
});

test('Windows cancellation falls back to the held child without a valid PID or local system root',async()=>{
  for(const options of [{},{pid:0},{pid:-1},{pid:1.5},{pid:Number.MAX_SAFE_INTEGER+1},{pid:8421,systemRoot:'\\\\network\\Windows'}]) {
    const h=fixture(options),job=h.engine.transcribe(h.options);await h.spawned;const closing=h.engine.close();
    [...h.timers.values()].find(t=>t.delay===5000).fn();assert.equal(h.calls.length,1);assert.equal(h.child.kills,1);
    await h.finish(null,1);await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;h.assertClean();
  }
});

test('non-Windows cancellation kills only the held child even with a valid PID',async()=>{
  const h=fixture({pid:8421,platform:'linux'}),job=h.engine.transcribe(h.options);await h.spawned;const closing=h.engine.close();
  [...h.timers.values()].find(t=>t.delay===5000).fn();assert.equal(h.calls.length,1);assert.equal(h.child.kills,1);
  await h.finish(null,1);await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;h.assertClean();
});

test('taskkill launch errors and unsuccessful exits fall back to the same owned child',async()=>{
  for(const failure of ['error','exit','throw']) {
    const h=fixture({pid:8421,helperThrows:failure==='throw'}),job=h.engine.transcribe(h.options);await h.spawned;const closing=h.engine.close();
    [...h.timers.values()].find(t=>t.delay===5000).fn();
    if(failure==='error')h.helper.emit('error',Error(PRIVATE));
    if(failure==='exit')h.helper.emit('close',1);
    assert.equal(h.child.kills,1);assert.deepEqual(h.calls[1].args,['/PID','8421','/T','/F']);
    await h.finish(null,1);await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;h.assertClean();
  }
});

test('a delayed cancellation callback cannot taskkill a process after its runner has exited',async()=>{
  const h=fixture({pid:8421}),job=h.engine.transcribe(h.options);await h.spawned;const closing=h.engine.close();
  const force=[...h.timers.values()].find(t=>t.delay===5000).fn;
  await h.finish(null,1);await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;
  force();assert.equal(h.calls.length,1);assert.equal(h.child.kills,0);h.assertClean();
});

test('the cancellation fallback leaves an already-exited held child alone',async()=>{
  for(const end of [{exitCode:0},{signalCode:'SIGTERM'}]) {
    const h=fixture({pid:8421}),job=h.engine.transcribe(h.options);await h.spawned;const closing=h.engine.close();Object.assign(h.child,end);
    [...h.timers.values()].find(t=>t.delay===5000).fn();assert.equal(h.calls.length,1);assert.equal(h.child.kills,0);
    await h.finish(null,1);await assert.rejects(job,safeError('sensevoice_cancelled'));await closing;h.assertClean();
  }
});
