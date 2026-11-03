const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {DeviceStore:RealStore}=require('../src/store');
const parent=path.resolve(__dirname,'../.test-output');
async function instance(t) {
  await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'device-'));
  // Redirect only this VM's OS data path; production never receives a test path.
  const context={module:{exports:{}},require:id=>id==='./core'?require('../src/core'):require(id),process:{platform:'win32',pid:process.pid,env:{LOCALAPPDATA:root},kill:process.kill.bind(process)}};
  vm.runInNewContext(syncFs.readFileSync(path.resolve(__dirname,'../src/store.js'),'utf8'),context);
  const Store=context.module.exports.DeviceStore,app={vault:{adapter:{getBasePath:()=> 'D:/中文 空格/仓库'}}},store=new Store(app,false);
  await store.init();t.after(async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});});
  return {store,Store,app};
}
test('desktop store serializes atomic checkpoints, backs up and holds exclusive device lock',async t=>{
  const {store,Store,app}=await instance(t);
  assert.equal(store.runtimeRoot,path.join(path.dirname(store.dir),'sensevoice'));
  assert.equal(store.runtimeCacheRoot,path.join(path.dirname(store.dir),'runtime-cache'));
  await assert.rejects(fs.stat(store.runtimeRoot),e=>e.code==='ENOENT');
  await Promise.all([store.save({stage:'asr',text:'原稿'}),store.save({stage:'corrected',text:'校对稿'})]);
  assert.equal((await store.load()).stage,'corrected');assert.equal(JSON.parse(await fs.readFile(store.file+'.bak','utf8')).stage,'asr');
  const second=new Store(app,false);await assert.rejects(second.init(),e=>e.code==='lock');
  await store.close();await second.init();assert.equal((await second.load()).text,'校对稿');await second.close();
});
test('failed atomic rename leaves prior valid state and supports a later retry',async t=>{
  const {store}=await instance(t);await store.save({stage:'original'});const real=store.fs;
  store.fs={...real,rename:async()=>{throw Error('simulated power loss before rename');}};
  await assert.rejects(store.save({stage:'new'}));assert.equal(JSON.parse(await real.readFile(store.file,'utf8')).stage,'original');
  store.fs=real;await store.save({stage:'retried'});assert.equal((await store.load()).stage,'retried');
});
test('unreadable device state fails closed and is not silently replaced',async t=>{
  const {store}=await instance(t);await fs.writeFile(store.file,'{ damaged');await assert.rejects(store.load(),e=>e.code==='storage');assert.equal(await fs.readFile(store.file,'utf8'),'{ damaged');
  await fs.writeFile(store.file,JSON.stringify({jobs:{bad:null}}));await assert.rejects(store.load(),e=>e.code==='storage');
});
