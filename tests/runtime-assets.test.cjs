const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {RuntimeAssets}=require('../src/runtime-assets');
const win=path.win32;
const BASE='C:\\Users\\用户\\Local Data\\voice-diary-unified\\runtime';
const VERSION='0.2.2';
const TEXT='# local bundled runner\nprint("本地识别")\n';
const PRIVATE='C:\\Users\\Private Name\\secret PRIVATE-KEY';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture(options={}) {
  const files=new Map(),calls=[],opened=deferred(),release=deferred();let counter=0;
  const error=code=>Object.assign(Error(PRIVATE),{code});
  const key=p=>win.resolve(p).toLowerCase();
  function put(p,type='directory',data='') {files.set(key(p),{type,data,ino:++counter,mtimeMs:counter,ctimeMs:counter});}
  function get(p) {const f=files.get(key(p));if(!f)throw error('ENOENT');return f;}
  const stat=f=>({isDirectory:()=>f.type==='directory',isFile:()=>f.type==='file',isSymbolicLink:()=>f.type==='link',
    fileAttributes:f.reparse?0x400:0,size:Buffer.byteLength(f.data||''),ino:f.ino,dev:1,mtimeMs:f.mtimeMs,ctimeMs:f.ctimeMs});
  put('C:\\');
  function directories(p) {let current=win.parse(p).root;for(const part of p.slice(current.length).split('\\')){current=win.join(current,part);if(!files.has(key(current)))put(current);}}
  directories(BASE);
  const io={
    async lstat(p){calls.push(['lstat',p]);return stat(get(p));},
    async realpath(p){const f=get(p);return f.realpath||win.resolve(p);},
    async mkdir(p){calls.push(['mkdir',p]);if(files.has(key(p)))throw error('EEXIST');get(win.dirname(p));put(p);},
    async readFile(p){calls.push(['read',p]);return Buffer.from(get(p).data);},
    async open(p,flags,mode){
      calls.push(['open',p,flags,mode]);assert.equal(flags,'wx');if(options.openFailure)throw error('EACCES');
      if(files.has(key(p)))throw error('EEXIST');put(p,'file');opened.resolve(p);
      const owned=get(p);return {
        async stat(){return stat(owned);},
        async writeFile(text){calls.push(['write',p]);if(options.holdWrite)await release.promise;if(options.writeFailure)throw error('EIO');owned.data=text;},
        async sync(){calls.push(['sync',p]);if(options.syncFailure)throw error('EIO');},
        async close(){calls.push(['close',p]);if(options.afterClose)options.afterClose({files,put,get,key});}
      };
    },
    async rename(from,to){calls.push(['rename',from,to]);if(options.renameFailure)throw error('EACCES');const f=get(from);files.set(key(to),f);files.delete(key(from));},
    async unlink(p){calls.push(['unlink',p]);files.delete(key(p));}
  };
  const deps={fs:io,path:win,crypto,baseRuntimeCacheRoot:BASE,version:VERSION,runnerText:TEXT};
  return {files,calls,put,get,key,directories,deps,assets:new RuntimeAssets(deps),opened:opened.promise,release:release.resolve,
    target:win.join(BASE,VERSION,'sensevoice_runner.py'),temps:()=>[...files.keys()].filter(p=>p.endsWith('.tmp'))};
}
function safeError(error) {
  assert.equal(error.code,'runtime_assets');assert.equal(error.pause,true);
  assert.equal(error.message,'本地识别运行文件准备失败，请重试或重新安装插件');
  assert.ok(!error.stack.includes('PRIVATE-KEY'));assert.ok(!error.stack.includes('Private Name'));return true;
}

test('runtime assets import and constructor are mobile safe without loading Node or runner',()=>{
  const imports=[],context={module:{exports:{}},require(id){imports.push(id);if(id==='./core')return require('../src/core');throw Error('Unexpected Node import');}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/runtime-assets.js'),'utf8'),context);
  const instance=new context.module.exports.RuntimeAssets();assert.equal(instance.closed,false);
  assert.deepEqual(imports,['./core']);
});

test('bundled runner materializes using exclusive write, fsync, close then atomic rename',async()=>{
  const h=fixture(),result=await h.assets.ensureRunner();assert.equal(result,h.target);assert.equal(h.get(result).data,TEXT);
  const names=h.calls.map(call=>call[0]);assert.ok(names.indexOf('sync')<names.indexOf('close'));assert.ok(names.indexOf('close')<names.indexOf('rename'));
  const open=h.calls.find(call=>call[0]==='open');assert.equal(open[2],'wx');assert.equal(open[3],0o600);
  assert.deepEqual(h.temps(),[]);assert.ok(h.calls.filter(call=>call[0]==='mkdir').every(call=>call.length===2));
});

test('identical runner is reused by SHA256 without changing the file',async()=>{
  const h=fixture();await h.assets.ensureRunner();const ino=h.get(h.target).ino;h.calls.length=0;
  assert.equal(await h.assets.ensureRunner(),h.target);assert.equal(h.get(h.target).ino,ino);
  assert.ok(h.calls.some(call=>call[0]==='read'));assert.ok(!h.calls.some(call=>['open','write','rename'].includes(call[0])));
});

test('tampered ordinary cache file is atomically repaired; unrelated files remain intact',async()=>{
  const h=fixture();h.directories(win.dirname(h.target));h.put(h.target,'file','corrupted');
  const unrelated=win.join(BASE,'user-file.txt');h.put(unrelated,'file','preserve me');
  assert.equal(await h.assets.ensureRunner(),h.target);assert.equal(h.get(h.target).data,TEXT);assert.equal(h.get(unrelated).data,'preserve me');
  assert.deepEqual(h.temps(),[]);
});

test('different versions have separate immutable runner paths',async()=>{
  const h=fixture(),first=await h.assets.ensureRunner();
  const second=await h.assets.ensureRunner({version:'0.2.3',runnerText:'next version\n'});
  assert.notEqual(first,second);assert.equal(h.get(first).data,TEXT);assert.equal(h.get(second).data,'next version\n');
});

test('simultaneous requests are merged and close waits for the admitted write',async()=>{
  const h=fixture({holdWrite:true}),first=h.assets.ensureRunner(),second=h.assets.ensureRunner();assert.equal(first,second);
  await h.opened;let closed=false;const closing=h.assets.close().then(()=>{closed=true;});await turn();assert.equal(closed,false);
  await assert.rejects(h.assets.ensureRunner(),safeError);h.release();assert.equal(await first,h.target);await closing;assert.equal(closed,true);
  assert.equal(h.calls.filter(call=>call[0]==='open').length,1);
});

test('separate instances sharing a cache serialize and reuse one atomic write',async()=>{
  const h=fixture({holdWrite:true}),other=new RuntimeAssets(h.deps),first=h.assets.ensureRunner();await h.opened;
  const second=other.ensureRunner();await turn();assert.equal(h.calls.filter(call=>call[0]==='open').length,1);
  h.release();assert.equal(await first,h.target);assert.equal(await second,h.target);assert.equal(h.calls.filter(call=>call[0]==='open').length,1);
});

for(const phase of ['openFailure','writeFailure','syncFailure','renameFailure']) {
  test(`${phase} leaves the previous runner unchanged and removes only its temporary file`,async()=>{
    const h=fixture({[phase]:true});h.directories(win.dirname(h.target));h.put(h.target,'file','old runner');
    await assert.rejects(h.assets.ensureRunner(),safeError);assert.equal(h.get(h.target).data,'old runner');assert.deepEqual(h.temps(),[]);
  });
}

test('a concurrent target edit is preserved rather than overwritten',async()=>{
  let edited=false;const h=fixture({afterClose({put}){if(!edited){edited=true;put(h.target,'file','user changed during write');}}});
  h.directories(win.dirname(h.target));h.put(h.target,'file','initial invalid cache');
  await assert.rejects(h.assets.ensureRunner(),safeError);assert.equal(h.get(h.target).data,'user changed during write');assert.deepEqual(h.temps(),[]);
});

for(const target of ['root','ancestor','version','runner']) {
  for(const kind of ['link','reparse','redirect']) {
    test(`rejects ${kind} on ${target} without writing or following it`,async()=>{
      const h=fixture();h.directories(win.dirname(h.target));h.put(h.target,'file',TEXT);
      const name={root:'C:\\',ancestor:'C:\\Users',version:win.dirname(h.target),runner:h.target}[target],entry=h.get(name);
      if(kind==='link')entry.type='link';if(kind==='reparse')entry.reparse=true;if(kind==='redirect')entry.realpath='D:\\Somewhere Else';
      await assert.rejects(h.assets.ensureRunner(),safeError);assert.ok(!h.calls.some(call=>call[0]==='open'));assert.equal(h.get(h.target).data,TEXT);
    });
  }
}

test('file occupying the version directory and directory occupying the runner are refused',async()=>{
  const h=fixture();h.put(win.dirname(h.target),'file','unrelated document');await assert.rejects(h.assets.ensureRunner(),safeError);
  assert.equal(h.get(win.dirname(h.target)).data,'unrelated document');assert.ok(!h.calls.some(call=>call[0]==='open'));
  const j=fixture();j.directories(j.target);await assert.rejects(j.assets.ensureRunner(),safeError);assert.equal(j.get(j.target).type,'directory');
});

test('unsafe local paths and version traversals never touch the filesystem',async()=>{
  for(const base of ['relative','C:relative','\\\\server\\share\\cache','\\\\?\\C:\\cache','C:\\cache\\..\\other','C:\\cache:stream','C:\\cache.','C:\\NUL\\cache','C:\\']) {
    const h=fixture();await assert.rejects(h.assets.ensureRunner({baseRuntimeCacheRoot:base}),safeError);assert.equal(h.calls.length,0,base);
  }
  for(const version of ['..','.','../other','x/y','x\\y','0.2.2:stream','trailing.','CON','lpt9.foo','']) {
    const h=fixture();await assert.rejects(h.assets.ensureRunner({version}),safeError);assert.equal(h.calls.length,0,version);
  }
});

test('oversized corrupted cache is replaced without reading unbounded file contents',async()=>{
  const h=fixture();h.directories(win.dirname(h.target));h.put(h.target,'file','x'.repeat(1024*1024+1));
  await h.assets.ensureRunner();assert.equal(h.get(h.target).data,TEXT);
  assert.equal(h.calls.filter(call=>call[0]==='read'&&call[1]===h.target).length,1); // only the completed new file is read
});

test('a failed request does not poison subsequent cache preparation',async()=>{
  const h=fixture();await assert.rejects(h.assets.ensureRunner({version:'../bad'}),safeError);
  assert.equal(await h.assets.ensureRunner(),h.target);
});
