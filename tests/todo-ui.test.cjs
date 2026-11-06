const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {renderTodoNote,parseTodoNote}=require('../src/todo-notes');
const SHA='a'.repeat(64),RID='12345678-1234-4123-8123-123456789abc',ID='vdt-'+'1'.repeat(20);
const NOTE='Voice Diary/Tasks/2026.11.06待办_140000_12345678.md',AUDIO='Voice Diary/Recordings/todo-recording.webm';
function item(overrides={}){return {id:ID,title:'买牛奶',evidence:'明天买牛奶',timeExpression:'明天',dateKind:'scheduled',date:'2026-11-07',startDate:null,endDate:null,timeText:'',status:'confirmed',reason:'',method:'local',...overrides};}
function note(items=[item()]){return renderTodoNote({path:AUDIO,sha:SHA,id:'temporary',capture:{recordingId:RID,recordedAt:'2026-11-06T06:00:00.000Z',localDate:'2026-11-06',localTime:'14:00:00'},raw:'明天买牛奶。',todoResult:{version:1,items}});}
class Element{
  constructor(tag='div',options={}){this.tag=tag;this.text=options.text||'';this.children=[];this.attributes={...options.attr};this.classes=new Set((options.cls||'').split(' ').filter(Boolean));this.disabled=false;}
  createEl(tag,options={}){const node=new Element(tag,options);this.children.push(node);return node;}
  createDiv(options={}){return this.createEl('div',options);}
  setText(text){this.text=String(text);this.children=[];return this;}
  empty(){this.text='';this.children=[];}
  addClass(name){this.classes.add(name);}
  setAttribute(name,value){this.attributes[name]=value;}
  set innerHTML(_){throw Error('Unsafe HTML rendering');}
  all(){return [this,...this.children.flatMap(child=>child.all())];}
}
class Vault{
  constructor(body=note()){this.files=new Map();this.bodies=new Map();this.reads=[];this.writes=0;this.add(NOTE,body);this.files.set(AUDIO,{path:AUDIO,stat:{size:10}});}
  add(path,body){this.files.set(path,{path,stat:{size:Buffer.byteLength(body)}});this.bodies.set(path,body);}
  getFiles(){return [...this.files.values()];}
  getAbstractFileByPath(path){return this.files.get(path);}
  async read(file){this.reads.push(file.path);return this.bodies.get(file.path);}
  async process(file,transform){if(this.beforeProcess){this.beforeProcess(file);this.beforeProcess=null;}const body=transform(this.bodies.get(file.path));this.bodies.set(file.path,body);this.writes++;return body;}
  async modify(){throw Error('unsafe modify');}
  parsed(){return parseTodoNote(this.bodies.get(NOTE),NOTE).items[0];}
}
function host({vault=new Vault(),clock=new Date(2026,10,6,3,59),notesModule}={}){
  const notices=[],modals=[],opened=[],settings=[];
  class Modal{
    constructor(app){this.app=app;this.contentEl=new Element();this.titleEl=new Element('h2');modals.push(this);}
    open(){this.onOpen();return this;}
    close(){this.onClose();}
  }
  class Setting{
    constructor(parent){this.el=parent.createDiv();this.name='';settings.push(this);}
    setName(name){this.name=name;this.el.createEl('label',{text:name});return this;}
    setDesc(text){this.el.createEl('small',{text});return this;}
    addText(fn){const control={setValue(value){this.value=value;return this;},setPlaceholder(){return this;},onChange(callback){this.onChangeValue=callback;return this;}};this.control=control;fn(control);return this;}
    addDropdown(fn){const control={addOptions(options){this.options=options;return this;},setValue(value){this.value=value;return this;},onChange(callback){this.onChangeValue=callback;return this;}};this.control=control;fn(control);return this;}
  }
  const source=path.join(__dirname,'../src/todo-ui.js'),sourceRequire=createRequire(source);
  const ClockDate=class extends Date{constructor(...args){super(...(args.length?args:[clock.getTime()]));}static now(){return clock.getTime();}};
  const context={module:{exports:{}},Date:ClockDate,require:name=>name==='obsidian'?{Modal,Setting,Notice:class{constructor(text){notices.push(text);}}}:name==='./todo-notes'&&notesModule?notesModule:sourceRequire(name)};
  vm.runInNewContext(fs.readFileSync(source,'utf8'),context);
  const plugin={app:{vault,workspace:{getLeaf(){return{async openFile(file){opened.push(file.path);}}}}},state:{todoNotes:[NOTE]},settings:{todoFolder:'Voice Diary/Tasks'},closed:false};
  const {TodoListModal,TodoEditModal}=context.module.exports;
  return {plugin,vault,notices,modals,opened,settings,TodoListModal,TodoEditModal,async open(kind='tomorrow'){const modal=new TodoListModal(plugin,kind);modal.open();await new Promise(resolve=>setImmediate(resolve));return modal;}};
}
const buttons=modal=>modal.contentEl.all().filter(el=>el.tag==='button');

test('tomorrow view uses actual local date before 04:00 and does not read unrelated notes',async()=>{
  const h=host();h.vault.add('Private/diary.md','do not read');h.vault.add('Voice Diary/Tasks/unrelated.md','ordinary');const modal=await h.open();
  assert.equal(modal.items.length,1);assert.equal(modal.items[0].date,'2026-11-07');assert.deepEqual(h.vault.reads,[NOTE]);
  assert.ok(modal.contentEl.all().some(el=>el.text.includes('2026-11-07 ·')));assert.equal(h.vault.writes,0);
});
test('untrusted speech and metadata are rendered as text without interpreted HTML',async()=>{
  const payload='<img src=x onerror="window.stolen=true">[open](https://example.invalid)';
  const h=host({vault:new Vault(note([item({title:payload,evidence:payload,reason:payload})]))}),modal=await h.open();
  assert.ok(modal.contentEl.all().some(el=>el.tag==='h3'&&el.text===payload));assert.ok(modal.contentEl.all().some(el=>el.text==='原话：'+payload));
  assert.ok(!modal.contentEl.all().some(el=>el.tag==='img'||el.tag==='a'));assert.equal(h.opened.length,0);
});
test('complete updates the authoritative checkbox through process and preserves user notes',async()=>{
  const h=host({vault:new Vault(note()+'\n用户的补充内容\n')}),modal=await h.open();await modal.complete(modal.items[0]);
  assert.equal(h.vault.writes,1);assert.equal(h.vault.parsed().checked,true);assert.equal(modal.items.length,0);assert.ok(h.vault.bodies.get(NOTE).endsWith('用户的补充内容\n'));
});
test('stale completion cannot overwrite a concurrently edited task and displays a fixed safe error',async()=>{
  const h=host(),modal=await h.open();h.vault.beforeProcess=()=>h.vault.bodies.set(NOTE,h.vault.bodies.get(NOTE).replace('- [ ] 买牛奶','- [ ] 用户刚改成买豆浆'));
  await modal.complete(modal.items[0]);assert.equal(h.vault.writes,0);assert.equal(h.vault.parsed().checked,false);assert.equal(modal.items[0].title,'用户刚改成买豆浆');assert.match(h.notices.at(-1),/待办可能已被修改/);
  h.vault.process=async()=>{throw Error('secret API key and private storage path');};await modal.complete(modal.items[0]);assert.ok(h.notices.every(text=>!text.includes('secret')));
});
test('conflicting synced copies cannot be completed or edited and open exact local files',async()=>{
  const copy=NOTE.replace('.md','-1.md'),h=host();h.vault.add(copy,note([item({title:'另一个设备修改'})]));const modal=await h.open('review'),conflict=modal.items[0];
  assert.equal(conflict.conflictPaths.length,2);assert.ok(!buttons(modal).some(button=>['标记完成','修改','确认或修改'].includes(button.text)));
  await modal.complete(conflict);assert.equal(h.vault.writes,0);const editor=new h.TodoEditModal(h.plugin,conflict);editor.open();await editor.save();assert.equal(h.vault.writes,0);
  buttons(modal).find(button=>button.text==='打开副本 2').onclick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.opened,[copy]);
});
test('identical synced copies warn that changes affect one note and preserve the other copy for review',async()=>{
  const copy=NOTE.replace('.md','-1.md'),h=host();h.vault.add(copy,note());const modal=await h.open();
  assert.equal(modal.items.length,1);assert.equal(modal.items[0].notePaths.length,2);assert.ok(modal.contentEl.all().some(el=>el.text.includes('修改只保存到当前笔记')));
  await modal.complete(modal.items[0]);assert.match(h.notices.at(-1),/待确认/);assert.equal(parseTodoNote(h.vault.bodies.get(copy),copy).items[0].checked,false);
  modal.kind='review';await modal.refresh();assert.equal(modal.items.length,1);assert.equal(modal.items[0].conflictPaths.length,2);
});
test('editor rejects impossible dates and backwards windows before modifying a file',async()=>{
  const h=host(),modal=await h.open(),editor=new h.TodoEditModal(h.plugin,modal.items[0],()=>modal.refresh());editor.open();
  editor.draft.date='2026-02-30';await editor.save();assert.match(editor.errorEl.text,/有效日期/);assert.equal(h.vault.writes,0);
  Object.assign(editor.draft,{dateKind:'window',startDate:'2026-11-09',endDate:'2026-11-08'});await editor.save();assert.match(editor.errorEl.text,/结束日期/);assert.equal(h.vault.writes,0);
  editor.draft.title='标题\n- [ ] injected';await editor.save();assert.match(editor.errorEl.text,/一行/);assert.equal(h.vault.writes,0);
});
test('editor saves explicit confirmation, a date range and time without changing the evidence',async()=>{
  const h=host({vault:new Vault(note([item({status:'needs_confirmation',dateKind:'unspecified',date:null,reason:'请确认日期'})]))}),modal=await h.open('review');
  const editor=new h.TodoEditModal(h.plugin,modal.items[0],()=>modal.refresh());editor.open();Object.assign(editor.draft,{title:'买燕麦奶',dateKind:'window',startDate:'2026-11-09',endDate:'2026-11-15',timeText:'上午',status:'confirmed'});
  await editor.save();const changed=h.vault.parsed();assert.equal(h.vault.writes,1);assert.equal(changed.title,'买燕麦奶');assert.equal(changed.timeText,'上午');assert.equal(changed.startDate,'2026-11-09');assert.equal(changed.endDate,'2026-11-15');assert.equal(changed.evidence,'明天买牛奶');assert.equal(modal.items.length,0);
});
test('editor retains stale values for review when a concurrent change prevents safe save',async()=>{
  const h=host(),modal=await h.open(),editor=new h.TodoEditModal(h.plugin,modal.items[0],()=>modal.refresh());editor.open();editor.draft.title='准备保存的修改';
  h.vault.beforeProcess=()=>h.vault.bodies.set(NOTE,h.vault.bodies.get(NOTE).replace('- [ ] 买牛奶','- [x] 买牛奶'));await editor.save();
  assert.equal(h.vault.writes,0);assert.equal(h.vault.parsed().checked,true);assert.equal(editor.draft.title,'准备保存的修改');assert.match(editor.errorEl.text,/未能保存/);
});
test('pagination limits visible cards to 30 while preserving all unfinished items',async()=>{
  const items=Array.from({length:31},(_,index)=>item({id:'vdt-'+index.toString(16).padStart(20,'0'),title:`待办 ${index+1}`})),h=host({vault:new Vault(note(items))}),modal=await h.open('all');
  assert.equal(modal.contentEl.all().filter(el=>el.classes.has('vdu-todo-card')).length,30);buttons(modal).find(button=>button.text==='下一页').onclick();
  assert.equal(modal.page,1);assert.equal(modal.contentEl.all().filter(el=>el.classes.has('vdu-todo-card')).length,1);assert.equal(buttons(modal).find(button=>button.text==='下一页').disabled,true);
});
test('later tab selection wins over a slower previous read and closing prevents stale rendering',async()=>{
  const reads=[],notesModule={...require('../src/todo-notes'),collectTodoItems:async(_vault,_paths,range)=>new Promise(resolve=>reads.push({range,resolve}))},h=host({notesModule});
  const modal=new h.TodoListModal(h.plugin);modal.open();modal.kind='review';const latest=modal.refresh();reads[1].resolve([item({title:'待确认的新结果',path:NOTE,status:'needs_confirmation'})]);await latest;
  reads[0].resolve([item({title:'较旧的结果'})]);await new Promise(resolve=>setImmediate(resolve));assert.equal(modal.items[0].title,'待确认的新结果');
  const pending=modal.refresh();modal.close();reads[2].resolve([item()]);await pending;assert.equal(modal.contentEl.children.length,0);
});
test('missing audio and storage errors never expose private error details',async()=>{
  const h=host(),modal=await h.open();h.vault.files.delete(AUDIO);buttons(modal).find(button=>button.text==='听原录音').onclick();await new Promise(resolve=>setImmediate(resolve));assert.match(h.notices.at(-1),/文件已同步/);
  h.vault.getFiles=()=>{throw Error('private secret configuration');};await modal.refresh();assert.match(modal.rowsEl.text,/暂时无法读取/);assert.ok(!modal.rowsEl.text.includes('secret'));
});
