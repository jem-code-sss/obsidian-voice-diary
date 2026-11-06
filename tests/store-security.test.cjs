const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {fork,spawn}=require('node:child_process');
const source=syncFs.readFileSync(path.resolve(__dirname,'../src/store.js'),'utf8');
const parent=path.resolve(__dirname,'../.test-output');
const app={vault:{adapter:{getBasePath:()=> 'D:/synthetic-security-test-vault'}}};

function storeClass(root){
  const context={module:{exports:{}},require:id=>id==='./core'?require('../src/core'):require(id),
    process:{platform:'win32',pid:process.pid,env:{LOCALAPPDATA:root},kill:process.kill.bind(process)}};
  vm.runInNewContext(source,context);return context.module.exports.DeviceStore;
}
async function isolated(t){
  await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'store-security-'));
  const Store=storeClass(root),store=new Store(app,false);
  t.after(async()=>{
    await store.close().catch(()=>{});
    const resolved=path.resolve(root);assert.ok(resolved.startsWith(parent+path.sep));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  return {root,Store,store};
}

if(process.argv[2]==='--lock-worker'){
  const Store=storeClass(process.argv[3]),store=new Store(app,false);
  process.on('message',async message=>{
    if(message==='acquire'){
      try{await store.init();process.send({status:'acquired',pid:process.pid,owner:store.owner});}
      catch(error){process.send({status:'rejected',code:error.code});}
    }else if(message==='close'){
      await store.close().catch(()=>{});process.disconnect();
    }
  });
  process.send({status:'ready'});
}else{
  const {test}=require('node:test');
  test('two actual processes reclaiming one dead-PID lock never both acquire it',{timeout:10000},async t=>{
    const children=[];
    t.after(async()=>{for(const child of children){if(child.connected)child.send('close');}
      await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>{
        child.once('exit',resolve);const timer=setTimeout(()=>{child.kill();resolve();},3000);timer.unref();
      })));});
    const {root,store}=await isolated(t);await store.init();const lock=store.lockPath;await store.close();
    const dead=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
    await new Promise((resolve,reject)=>{dead.once('error',reject);dead.once('exit',resolve);});
    assert.throws(()=>process.kill(dead.pid,0),error=>error.code==='ESRCH');
    await fs.writeFile(lock,String(dead.pid));
    const launch=()=>new Promise((resolve,reject)=>{
      const child=fork(__filename,['--lock-worker',root],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);
      child.once('error',reject);child.once('exit',()=>reject(Error('lock worker exited before startup')));
      child.on('message',message=>{if(message.status==='ready')resolve(child);});
    });
    const active=await Promise.all([launch(),launch()]);
    const results=active.map(child=>new Promise((resolve,reject)=>{
      child.on('message',message=>{if(message.status!=='ready')resolve(message);});child.once('error',reject);
    }));
    for(const child of active)child.send('acquire');
    const outcomes=await Promise.all(results);
    assert.equal(outcomes.filter(item=>item.status==='acquired').length,1);
    assert.equal(outcomes.filter(item=>item.status==='rejected'&&item.code==='lock').length,1);
    const winner=outcomes.find(item=>item.status==='acquired'),record=JSON.parse(await fs.readFile(lock,'utf8'));
    assert.equal(record.pid,winner.pid);assert.equal(record.owner,winner.owner);
    // Finish children before isolated-directory cleanup, including the held lock.
    for(const child of active)child.send('close');
    await Promise.all(active.map(child=>new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);})));
  });

  test('a leftover transaction guard fails closed and is never reclaimed based on its dead PID',async t=>{
    const {Store,store}=await isolated(t);await store.init();await store.close();
    const contents=JSON.stringify({pid:77777777,owner:'abandoned transaction'});
    await fs.writeFile(store.guardPath,contents);
    const next=new Store(app,false);await assert.rejects(next.init(),error=>error.code==='lock'&&error.message.includes('device.guard')&&error.message.includes('关闭所有'));
    assert.equal(await fs.readFile(store.guardPath,'utf8'),contents);assert.equal(next.lock,undefined);
    await assert.rejects(fs.stat(store.lockPath),error=>error.code==='ENOENT');
  });

  for(const mutation of ['different inode','different owner token']){
    test(`closing an old owner preserves a replacement lock with ${mutation}`,async t=>{
      const {store}=await isolated(t);await store.init();await store.save({stage:'original'});
      if(mutation==='different inode')await fs.rename(store.lockPath,store.lockPath+'.original');
      const replacement=JSON.stringify({pid:process.pid,owner:'replacement owner'});await fs.writeFile(store.lockPath,replacement);
      await assert.rejects(store.save({stage:'must not write'}),error=>error.code==='lock');
      await assert.rejects(store.close(),error=>error.code==='lock');
      assert.equal(await fs.readFile(store.lockPath,'utf8'),replacement);
      assert.equal(JSON.parse(await fs.readFile(store.file,'utf8')).stage,'original');
    });
  }

  for(const suffix of ['.tmp','.bak','']){
    test(`a hard-linked managed ${suffix||'primary'} file cannot overwrite the outside sentinel`,async t=>{
      const {root,store}=await isolated(t);await store.init();await store.save({stage:'valid original'});
      const original=await fs.readFile(store.file),sentinel=path.join(root,'outside-state-sentinel.txt'),target=store.file+suffix;
      await fs.writeFile(sentinel,'KEEP SYNTHETIC SENTINEL');
      if(suffix==='')await fs.unlink(target);
      await fs.link(sentinel,target);
      await assert.rejects(store.save({stage:'must not write'}),error=>error.code==='storage');
      await assert.rejects(store.load(),error=>error.code==='storage');
      assert.equal(await fs.readFile(sentinel,'utf8'),'KEEP SYNTHETIC SENTINEL');
      if(suffix!=='')assert.deepEqual(await fs.readFile(store.file),original);
      await fs.unlink(target);if(suffix==='')await fs.writeFile(store.file,original);
      await store.save({stage:'recovered'});assert.equal((await store.load()).stage,'recovered');
    });
  }

  test('random exclusive temporary creation refuses a preexisting hard link without modifying either file',async t=>{
    const {root,store}=await isolated(t);await store.init();await store.save({stage:'original'});
    const sentinel=path.join(root,'exclusive-create-sentinel.txt'),id='00000000-0000-4000-8000-000000000000';
    await fs.writeFile(sentinel,'KEEP EXCLUSIVE SENTINEL');await fs.link(sentinel,store.file+'.'+id+'.tmp');store.uuid=()=>id;
    await assert.rejects(store.save({stage:'must not write'}),error=>error.code==='EEXIST');
    assert.equal(await fs.readFile(sentinel,'utf8'),'KEEP EXCLUSIVE SENTINEL');
    assert.equal(JSON.parse(await fs.readFile(store.file,'utf8')).stage,'original');
  });

  test('temporary state files use random names, exclusive creation and owner-only mode; legacy tmp is untouched',async t=>{
    const {store}=await isolated(t);await store.init();await fs.writeFile(store.file+'.tmp','KEEP LEGACY TEMP');
    const real=store.fs,opened=[];store.fs={...real,async open(file,flags,mode){opened.push({file,flags,mode});return real.open(file,flags,mode);}};
    await store.save({stage:'one'});await store.save({stage:'two'});
    const temporary=opened.filter(item=>/device\.json\.[0-9a-f-]{36}\.(?:bak\.)?tmp$/.test(item.file));
    assert.equal(temporary.length,3);assert.ok(temporary.every(item=>item.flags==='wx'&&item.mode===0o600));
    assert.equal(new Set(temporary.map(item=>item.file)).size,3);assert.equal(await fs.readFile(store.file+'.tmp','utf8'),'KEEP LEGACY TEMP');
    assert.equal((await store.load()).stage,'two');assert.equal(JSON.parse(await fs.readFile(store.file+'.bak','utf8')).stage,'one');
  });

  test('failure replacing the primary leaves the valid prior state and an intact atomic backup',async t=>{
    const {store}=await isolated(t);await store.init();await store.save({stage:'valid original'});const real=store.fs;
    store.fs={...real,async rename(from,to){if(to===store.file)throw Error('simulated final rename failure');return real.rename(from,to);}};
    await assert.rejects(store.save({stage:'never committed'}));
    assert.equal(JSON.parse(await fs.readFile(store.file,'utf8')).stage,'valid original');
    assert.equal(JSON.parse(await fs.readFile(store.file+'.bak','utf8')).stage,'valid original');
    assert.ok(!(await fs.readdir(store.dir)).some(file=>/\.[0-9a-f-]{36}\.(?:bak\.)?tmp$/.test(file)));
    store.fs=real;await store.save({stage:'retry committed'});assert.equal((await store.load()).stage,'retry committed');
  });

  test('a junction in a managed ancestor is rejected before writing any state or lock',async t=>{
    const {root,store}=await isolated(t),outside=path.join(root,'junction-target');await fs.mkdir(outside);
    await fs.symlink(outside,path.join(root,'voice-diary-unified'),'junction');
    await assert.rejects(store.init(),error=>error.code==='storage');assert.deepEqual(await fs.readdir(outside),[]);
  });
}
