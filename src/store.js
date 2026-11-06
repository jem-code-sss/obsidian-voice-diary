// Desktop data lives outside the synced vault. Plaintext, not a secret vault.
const {sha256,DiaryError}=require('./core');
const storageError=()=>new DiaryError('storage','本机数据路径包含链接、共享文件或异常文件；为保护原文件已停止，请关闭所有 Obsidian 窗口后检查本机数据目录');
const guardError=()=>new DiaryError('lock','本机锁恢复尚未完成或已中断；请关闭所有 Obsidian 窗口后检查 device.guard，确认没有运行进程后再移除遗留的 guard 文件');
const sameFile=(left,right)=>left.dev===right.dev&&left.ino===right.ino&&left.birthtimeMs===right.birthtimeMs;
const regular=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1;
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
    this.dir=path.resolve(base,'voice-diary-unified',(await sha256(identity)).slice(0,24));
    this.file=path.join(this.dir,'device.json');this.lockPath=path.join(this.dir,'device.lock');
    this.guardPath=path.join(this.dir,'device.guard');this.fs=fs;this.path=path;
    this.uuid=require('node:crypto').randomUUID;
    await this.directories(true);
    await this.withGuard(async()=>{
      await this.stateFiles();
      const previous=await this.readFile(this.lockPath,true);
      if(previous){
        const owner=this.parseOwner(previous.bytes.toString('utf8'));
        let live=true;
        if(owner?.pid&&owner.pid!==process.pid){try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')live=false;}}
        if(live)throw new DiaryError('lock','此仓库已有运行进程或未完成的锁；请关闭重复窗口后重启 Obsidian');
        await this.assertIdentity(this.lockPath,previous.stat);
        await fs.unlink(this.lockPath);
      }
      await this.directories();
      const token=this.uuid(),handle=await fs.open(this.lockPath,'wx',0o600);let identity;
      try{
        identity=await handle.stat();if(!regular(identity))throw storageError();await this.directories();
        await handle.writeFile(JSON.stringify({pid:process.pid,owner:token}),'utf8');await handle.sync();
      }catch(error){
        await handle.close();
        if(identity)try{await this.assertIdentity(this.lockPath,identity);await fs.unlink(this.lockPath);}catch{}
        throw error;
      }
      this.lock=handle;this.lockIdentity=identity;this.owner=token;
    });
  }
  async directories(create=false){
    const parsed=this.path.parse(this.dir);let current=parsed.root;
    for(const segment of this.dir.slice(parsed.root.length).split(this.path.sep).filter(Boolean)){
      current=this.path.join(current,segment);let stat;
      try{stat=await this.fs.lstat(current);}catch(error){
        if(error.code!=='ENOENT'||!create)throw error;
        try{await this.fs.mkdir(current,{mode:0o700});}catch(created){if(created.code!=='EEXIST')throw created;}
        stat=await this.fs.lstat(current);
      }
      if(stat.isSymbolicLink()||!stat.isDirectory())throw storageError();
    }
  }
  async fileStat(file,missing=false){
    try{const stat=await this.fs.lstat(file);if(!regular(stat))throw storageError();return stat;}
    catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}
  }
  async stateFiles(){
    await this.directories();
    for(const file of [this.file,this.file+'.bak',this.file+'.tmp'])await this.fileStat(file,true);
  }
  async assertIdentity(file,identity){
    const current=await this.fileStat(file);if(!sameFile(current,identity))throw storageError();
  }
  async readFile(file,missing=false){
    const before=await this.fileStat(file,missing);if(!before)return null;
    const handle=await this.fs.open(file,'r');
    try{
      const stat=await handle.stat();if(!regular(stat)||!sameFile(before,stat))throw storageError();
      const bytes=await handle.readFile();await this.assertIdentity(file,stat);return {bytes,stat};
    }finally{await handle.close();}
  }
  parseOwner(text){
    if(/^\s*[1-9]\d*\s*$/.test(text)){const pid=Number(text);return Number.isSafeInteger(pid)?{pid}:null;}
    try{const data=JSON.parse(text);return Number.isSafeInteger(data.pid)&&data.pid>0&&typeof data.owner==='string'&&data.owner?data:null;}catch{return null;}
  }
  async withGuard(task){
    await this.directories();
    const owner=this.uuid();let handle;
    for(let attempt=0;attempt<20;attempt++){
      try{handle=await this.fs.open(this.guardPath,'wx',0o600);break;}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        if(attempt===19)throw guardError();
        await new Promise(resolve=>require('node:timers').setTimeout(resolve,10));
      }
    }
    let identity,result,failure;
    try{
      identity=await handle.stat();if(!regular(identity))throw storageError();await this.directories();
      await handle.writeFile(JSON.stringify({pid:process.pid,owner}),'utf8');await handle.sync();
      result=await task();
    }catch(error){failure=error;}
    try{
      await this.directories();
      const current=await this.readFile(this.guardPath);
      const record=this.parseOwner(current.bytes.toString('utf8'));
      if(!identity||!sameFile(identity,current.stat)||record?.owner!==owner||record?.pid!==process.pid)throw guardError();
      await handle.close();handle=null;
      await this.assertIdentity(this.guardPath,identity);await this.fs.unlink(this.guardPath);
    }catch(error){if(!failure)failure=error;}
    finally{if(handle)await handle.close().catch(()=>{});}
    if(failure)throw failure;return result;
  }
  async assertOwner(){
    if(!this.lock)throw new DiaryError('lock','本机任务锁未持有，未写入数据');
    const record=await this.readFile(this.lockPath),owner=this.parseOwner(record.bytes.toString('utf8'));
    if(!sameFile(this.lockIdentity,record.stat)||owner?.owner!==this.owner||owner?.pid!==process.pid)
      throw new DiaryError('lock','本机任务锁归属已变化，已停止写入；请关闭重复窗口后检查本机数据');
  }
  async load() {
    try {
      let data;
      if(this.mobile)data=this.app.loadLocalStorage('voice-diary-unified:mobile')||{};
      else{
        await this.stateFiles();await this.assertOwner();
        const file=await this.readFile(this.file,true);if(!file)return {};
        data=JSON.parse(file.bytes.toString('utf8'));
      }
      const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
      if(!object(data)||(data.jobs!==undefined&&(!object(data.jobs)||Object.values(data.jobs).some(j=>!object(j)||typeof j.status!=='string')))||
        (data.config!==undefined&&!object(data.config))||(data.enabled!==undefined&&typeof data.enabled!=='boolean')) throw Error('invalid state schema');
      return data;
    }
    catch(error) {if(error instanceof DiaryError)throw error;throw new DiaryError('storage','本机任务数据无法读取；请保留 device.json 和备份，未开启处理');}
  }
  async writeTemp(bytes,suffix){
    await this.directories();
    const file=this.file+'.'+this.uuid()+suffix,handle=await this.fs.open(file,'wx',0o600);let identity;
    try{
      identity=await handle.stat();if(!regular(identity))throw storageError();await this.directories();
      await handle.writeFile(bytes);await handle.sync();
    }catch(error){await handle.close();if(identity)await this.removeTemp({file,identity});throw error;}
    await handle.close();return {file,identity};
  }
  async removeTemp(temp){
    if(!temp)return;
    try{await this.directories();await this.assertIdentity(temp.file,temp.identity);await this.fs.unlink(temp.file);}catch{}
  }
  save(state) {
    const snapshot=JSON.stringify(state);
    const task=this.tail.catch(()=>{}).then(async()=>{
      if(this.mobile){this.app.saveLocalStorage('voice-diary-unified:mobile',JSON.parse(snapshot));return;}
      let temp,backup;
      try{
        await this.stateFiles();await this.assertOwner();
        temp=await this.writeTemp(snapshot,'.tmp');
        const previous=await this.readFile(this.file,true);
        if(previous){
          backup=await this.writeTemp(previous.bytes,'.bak.tmp');
          await this.stateFiles();await this.assertOwner();await this.assertIdentity(backup.file,backup.identity);
          await this.fs.rename(backup.file,this.file+'.bak');backup=null;
        }
        await this.stateFiles();await this.assertOwner();await this.assertIdentity(temp.file,temp.identity);
        await this.fs.rename(temp.file,this.file);temp=null;
      }finally{await this.removeTemp(temp);await this.removeTemp(backup);}
    });
    this.tail=task;return task;
  }
  async close() {
    await this.tail.catch(()=>{});
    if(!this.lock)return;
    const handle=this.lock;
    try{
      await this.withGuard(async()=>{
        await this.assertOwner();await handle.close();this.lock=null;
        await this.assertIdentity(this.lockPath,this.lockIdentity);await this.fs.unlink(this.lockPath);
      });
    }finally{if(this.lock===handle){await handle.close().catch(()=>{});this.lock=null;}}
  }
}
module.exports={DeviceStore};
