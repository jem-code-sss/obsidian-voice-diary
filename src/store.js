// Desktop data lives outside the synced vault. Plaintext, not a secret vault.
const {sha256,DiaryError}=require('./core');
class DeviceStore {
  constructor(app,mobile) {this.app=app;this.mobile=mobile;this.tail=Promise.resolve();}
  async init() {
    if(this.mobile) return;
    const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
    const identity=this.app.vault.adapter.getBasePath?.();
    if(!identity) throw new DiaryError('storage','无法确定本机仓库路径，未开启处理');
    const base=process.platform==='win32'?(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')):
      process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support'):(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'));
    this.runtimeRoot=path.join(base,'voice-diary-unified','sensevoice');
    this.runtimeCacheRoot=path.join(base,'voice-diary-unified','runtime-cache');
    this.dir=path.join(base,'voice-diary-unified',(await sha256(identity)).slice(0,24));
    this.file=path.join(this.dir,'device.json');this.fs=fs;
    await fs.mkdir(this.dir,{recursive:true});
    // Exclusive process lock also prevents two Obsidian windows consuming one local queue.
    const lock=path.join(this.dir,'device.lock');
    try {this.lock=await fs.open(lock,'wx');}
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      let pid;
      try {pid=Number(await fs.readFile(lock,'utf8'));} catch {}
      let live=true;
      if(Number.isInteger(pid)&&pid>0) {try {process.kill(pid,0);} catch(err) {if(err.code==='ESRCH') live=false;}}
      if(live) throw new DiaryError('lock','此仓库已有运行进程或未完成的锁；请关闭重复窗口后重启 Obsidian');
      await fs.unlink(lock);this.lock=await fs.open(lock,'wx');
    }
    this.lockPath=lock;await this.lock.writeFile(String(process.pid));
  }
  async load() {
    try {
      const data=this.mobile?(this.app.loadLocalStorage('voice-diary-unified:mobile')||{}):JSON.parse(await this.fs.readFile(this.file,'utf8'));
      const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
      if(!object(data)||(data.jobs!==undefined&&(!object(data.jobs)||Object.values(data.jobs).some(j=>!object(j)||typeof j.status!=='string')))||
        (data.config!==undefined&&!object(data.config))||(data.enabled!==undefined&&typeof data.enabled!=='boolean')) throw Error('invalid state schema');
      return data;
    }
    catch(e) {if(e.code==='ENOENT') return {};throw new DiaryError('storage','本机任务数据无法读取；请保留 device.json 和备份，未开启处理');}
  }
  save(state) {
    const snapshot=JSON.stringify(state);
    const task=this.tail.catch(()=>{}).then(async()=>{
      if(this.mobile){this.app.saveLocalStorage('voice-diary-unified:mobile',JSON.parse(snapshot));return;}
      const temp=this.file+'.tmp';
      const handle=await this.fs.open(temp,'w');
      try {await handle.writeFile(snapshot,'utf8');await handle.sync();} finally {await handle.close();}
      try {await this.fs.copyFile(this.file,this.file+'.bak');} catch(e) {if(e.code!=='ENOENT') throw e;}
      await this.fs.rename(temp,this.file);
    });
    this.tail=task;return task;
  }
  async close() {
    await this.tail.catch(()=>{});
    if(this.lock){await this.lock.close();await this.fs.unlink(this.lockPath);this.lock=null;}
  }
}
module.exports={DeviceStore};
