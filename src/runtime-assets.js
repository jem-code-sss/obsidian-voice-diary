// The marketplace installs only main.js, manifest.json and styles.css. Keep the
// Python runner in the bundle and materialize it only on the desktop, in this
// plugin's private versioned runtime cache. This module never downloads anything.
const {DiaryError}=require('./core');
const SERIALS=new Map();
const MESSAGE='本地识别运行文件准备失败，请重试或重新安装插件';
const fail=()=>new DiaryError('runtime_assets',MESSAGE,{pause:true});
const missing=error=>error?.code==='ENOENT';
const reserved=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

class RuntimeAssets {
  constructor(deps={}) {this.deps=deps;this.closed=false;this.pending=new Map();this.tail=Promise.resolve();}
  _modules() {
    if(!this.modules)this.modules={
      fs:this.deps.fs||require('node:fs/promises'),
      path:this.deps.path||require('node:path').win32,
      crypto:this.deps.crypto||require('node:crypto')
    };
    return this.modules;
  }
  ensureRunner(options={}) {
    if(this.closed)return Promise.reject(fail());
    const config={baseRuntimeCacheRoot:options.baseRuntimeCacheRoot??this.deps.baseRuntimeCacheRoot,
      version:options.version??this.deps.version,runnerText:options.runnerText??this.deps.runnerText};
    const key=JSON.stringify([config.baseRuntimeCacheRoot,config.version,config.runnerText]);
    if(this.pending.has(key))return this.pending.get(key);
    const serialKey=String(config.baseRuntimeCacheRoot).replace(/\//g,'\\').toLowerCase();
    const previous=Promise.all([this.tail,SERIALS.get(serialKey)||Promise.resolve()]);
    const cleanup=()=>{if(this.pending.get(key)===task)this.pending.delete(key);};
    const task=previous.catch(()=>{}).then(()=>this._ensure(config)).then(value=>{cleanup();return value;},()=>{cleanup();throw fail();});
    const settled=task.then(()=>{},()=>{});
    SERIALS.set(serialKey,settled);this.pending.set(key,task);this.tail=settled;
    settled.then(()=>{if(SERIALS.get(serialKey)===settled)SERIALS.delete(serialKey);});
    return task;
  }
  async close() {this.closed=true;await this.tail;}
  _localPath(value,path) {
    if(typeof value!=='string'||!/^([a-z]):[\\/]/i.test(value))throw fail();
    const parts=value.slice(3).split(/[\\/]/);
    if(!parts.length||parts.some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f<>:"|?*]/.test(part)||/[. ]$/.test(part)||reserved.test(part)))throw fail();
    const result=path.resolve(value);
    if(!path.isAbsolute(result)||!/^([a-z]):\\/i.test(result))throw fail();
    return result;
  }
  _equal(a,b,path) {return path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
  _linked(stat) {
    return stat.isSymbolicLink()||!!((Number(stat.fileAttributes)||Number(stat.attributes)||0)&0x400);
  }
  async _entry(file,{directory=false,absent=false}={}) {
    const {fs,path}=this._modules();let stat;
    try {stat=await fs.lstat(file);}catch(error){if(absent&&missing(error))return null;throw error;}
    if(this._linked(stat)||!(directory?stat.isDirectory():stat.isFile()))throw fail();
    if(!this._equal(await fs.realpath(file),file,path))throw fail();
    return stat;
  }
  async _directories(directory,create) {
    const {fs,path}=this._modules(),root=path.parse(directory).root;
    if(!root||!this._equal(root.slice(0,2)+'\\',root,path))throw fail();
    await this._entry(root,{directory:true});let current=root;
    for(const part of directory.slice(root.length).split(path.sep)) {
      current=path.join(current,part);
      let stat=await this._entry(current,{directory:true,absent:true});
      if(!stat) {
        if(!create)throw fail();
        try {await fs.mkdir(current);}catch(error){if(error?.code!=='EEXIST')throw error;}
        stat=await this._entry(current,{directory:true});
      }
    }
  }
  async _fingerprint(file) {
    const {fs,crypto}=this._modules(),stat=await this._entry(file,{absent:true});
    if(!stat)return null;
    // Do not read an unbounded, possibly corrupted cache file into memory.
    const hash=stat.size<=1024*1024?crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'):null;
    return {hash,size:stat.size,ino:stat.ino,dev:stat.dev,mtime:stat.mtimeMs,ctime:stat.ctimeMs};
  }
  async _ensure(config) {
    const {fs,path,crypto}=this._modules(),base=this._localPath(config.baseRuntimeCacheRoot,path),version=config.version;
    if(typeof version!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version)||/[.]$/.test(version)||reserved.test(version))throw fail();
    const text=config.runnerText??require('../runtime/sensevoice_runner.py');
    if(typeof text!=='string'||!text.length||text.length>1024*1024)throw fail();
    const directory=path.join(base,version),target=path.join(directory,'sensevoice_runner.py');
    if(!this._equal(path.dirname(directory),base,path)||!this._equal(path.dirname(target),directory,path))throw fail();
    const expected=crypto.createHash('sha256').update(text,'utf8').digest('hex');
    await this._directories(directory,true);
    const before=await this._fingerprint(target);
    if(before?.hash===expected) {
      await this._directories(directory,false);await this._entry(target);
      return target;
    }
    const temp=path.join(directory,`.sensevoice-runner-${crypto.randomBytes(12).toString('hex')}.tmp`);
    if(!this._equal(path.dirname(temp),directory,path))throw fail();
    let handle,owned=false;
    try {
      handle=await fs.open(temp,'wx',0o600);owned=true;
      const stat=await handle.stat();if(!stat.isFile()||this._linked(stat))throw fail();
      await handle.writeFile(text,{encoding:'utf8'});await handle.sync();await handle.close();handle=null;
      await this._directories(directory,false);await this._entry(temp);
      const now=await this._fingerprint(target);
      // Refuse to clobber a file that another actor changed while we prepared it.
      if(JSON.stringify(now)!==JSON.stringify(before))throw fail();
      await fs.rename(temp,target);owned=false;
      await this._directories(directory,false);
      if((await this._fingerprint(target))?.hash!==expected)throw fail();
      return target;
    } finally {
      if(handle)try {await handle.close();}catch {}
      if(owned)try {
        await this._directories(directory,false);
        if(await this._entry(temp,{absent:true}))await fs.unlink(temp);
      }catch {} // Never follow a replaced parent or delete someone else's file.
    }
  }
}
module.exports={RuntimeAssets};
