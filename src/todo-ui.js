const {Modal,Setting,Notice}=require('obsidian');
const {collectTodoItems,updateTodoItem}=require('./todo-notes');
const {todoNotePaths}=require('./todo-discovery');
const {dateWindow,validDate}=require('./todos');

const VIEWS=[['tomorrow','明天'],['next-week','下周'],['review','待确认'],['all','全部未完成']];
const PAGE_SIZE=30;
const SAVE_ERROR='未能保存。待办可能已被修改，请刷新清单后重试；原笔记保留。';
const SINGLE_LINE=/[\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
function localToday(){const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;}
function rangeFor(kind){return kind==='review'?{review:true}:kind==='all'?{all:true}:dateWindow(kind,localToday());}
function dateLabel(item){
  let label=item.dateKind==='window'?`${item.startDate} 至 ${item.endDate}`:item.date?`${item.dateKind==='deadline'?'截止':'执行'} ${item.date}`:'日期未指定';
  if(item.timeText)label+=` · ${item.timeText}`;
  return label;
}
function button(parent,text,action,{disabled=false,selected=false}={}){
  const el=parent.createEl('button',{text,attr:{type:'button'}});el.disabled=disabled;
  if(selected){el.addClass('mod-cta');el.setAttribute('aria-pressed','true');}
  el.onclick=()=>void action();return el;
}
async function openFile(plugin,path){
  try{
    const file=plugin.app.vault.getAbstractFileByPath(path);
    if(!file||Array.isArray(file.children))throw Error('missing');
    await plugin.app.workspace.getLeaf(true).openFile(file);
  }catch{new Notice('暂时无法打开文件，请确认文件已同步到本机。');}
}

class TodoEditModal extends Modal {
  constructor(plugin,item,afterSave){
    super(plugin.app);this.plugin=plugin;this.item=item;this.afterSave=afterSave;this.saving=false;
    this.draft={title:item.title,dateKind:item.dateKind,date:item.date||'',startDate:item.startDate||'',endDate:item.endDate||'',timeText:item.timeText||'',status:item.status};
  }
  onOpen(){
    this.titleEl.setText('编辑待办');this.contentEl.addClass('vdu-todo-editor');
    if(this.item.conflictPaths?.length){this.contentEl.createEl('p',{text:'同一事项有多个不同副本，请返回清单打开原笔记处理。'});return;}
    this.contentEl.createEl('p',{text:`原话：${this.item.evidence||'未记录'}`,cls:'vdu-todo-evidence'});
    if(this.item.status==='needs_confirmation'&&this.item.reason)this.contentEl.createEl('p',{text:`待确认原因：${this.item.reason}`});
    if(this.item.notePaths?.length>1)this.contentEl.createEl('p',{text:'此事项有相同的同步副本。修改只保存到当前笔记，保存后请在“待确认”中核对其余副本。',cls:'vdu-todo-reason'});
    new Setting(this.contentEl).setName('待办内容').addText(text=>text.setValue(this.draft.title).onChange(value=>{this.draft.title=value;}));
    new Setting(this.contentEl).setName('日期含义').addDropdown(dropdown=>dropdown.addOptions({scheduled:'执行日期',deadline:'截止日期',window:'一段时间内',unspecified:'暂不指定'}).setValue(this.draft.dateKind).onChange(value=>{this.draft.dateKind=value;this.renderDates();}));
    this.dateEl=this.contentEl.createDiv({cls:'vdu-todo-dates'});this.renderDates();
    new Setting(this.contentEl).setName('时间补充').setDesc('例如：上午、18:00。留空表示未指定。').addText(text=>text.setValue(this.draft.timeText).onChange(value=>{this.draft.timeText=value;}));
    new Setting(this.contentEl).setName('状态').addDropdown(dropdown=>dropdown.addOptions({confirmed:'已确认',needs_confirmation:'待确认',cancelled:'取消这项待办'}).setValue(this.draft.status).onChange(value=>{this.draft.status=value;}));
    this.errorEl=this.contentEl.createEl('p',{cls:'vdu-todo-error',attr:{role:'alert'}});
    this.contentEl.createEl('p',{text:'保存后只更新这项待办；原始录音和转写保留。',cls:'vdu-todo-hint'});
    const actions=this.contentEl.createDiv({cls:'vdu-todo-actions'});
    this.saveButton=button(actions,'保存',()=>this.save(),{selected:true});button(actions,'返回',()=>this.close());
  }
  renderDates(){
    this.dateEl.empty();
    const field=(key,label)=>new Setting(this.dateEl).setName(label).addText(text=>text.setPlaceholder('YYYY-MM-DD').setValue(this.draft[key]).onChange(value=>{this.draft[key]=value;}));
    if(this.draft.dateKind==='window'){field('startDate','开始日期');field('endDate','结束日期');}
    else if(['scheduled','deadline'].includes(this.draft.dateKind))field('date','日期');
  }
  changes(){
    const draft=this.draft,title=draft.title.trim(),timeText=draft.timeText.trim();
    if(!title||title.length>500||SINGLE_LINE.test(draft.title))throw Error('请填写一行待办内容，最多 500 字。');
    if(timeText.length>240||SINGLE_LINE.test(draft.timeText))throw Error('时间补充须为一行文字，最多 240 字。');
    if(!['confirmed','needs_confirmation','cancelled'].includes(draft.status))throw Error('请选择有效的待办状态。');
    const changes={title,timeText,status:draft.status,dateKind:draft.dateKind,date:null,startDate:null,endDate:null};
    if(['scheduled','deadline'].includes(draft.dateKind)){
      changes.date=draft.date.trim();if(!validDate(changes.date))throw Error('请填写有效日期，例如 2026-11-08。');
    }else if(draft.dateKind==='window'){
      changes.startDate=draft.startDate.trim();changes.endDate=draft.endDate.trim();
      if(!validDate(changes.startDate)||!validDate(changes.endDate)||changes.startDate>changes.endDate)throw Error('请填写有效的起止日期，结束日期不能早于开始日期。');
    }else if(draft.dateKind!=='unspecified')throw Error('请选择有效的日期含义。');
    return changes;
  }
  async save(){
    if(this.saving||this.item.conflictPaths?.length)return;
    let changes;try{changes=this.changes();}catch(error){this.errorEl.setText(error.message);return;}
    this.saving=true;this.saveButton.disabled=true;this.errorEl.setText('');
    try{
      if(this.plugin.closed)throw Error('closed');
      const file=this.plugin.app.vault.getAbstractFileByPath(this.item.path);
      await updateTodoItem(this.plugin.app.vault,file,this.item.id,changes,this.item);
      new Notice(this.item.notePaths?.length>1?'当前副本已保存，请在“待确认”中核对其余同步副本。':'待办已保存');this.close();await this.afterSave?.();
    }catch{this.errorEl.setText(SAVE_ERROR);}
    finally{this.saving=false;this.saveButton.disabled=false;}
  }
  onClose(){this.contentEl.empty();}
}

class TodoListModal extends Modal {
  constructor(plugin,kind='tomorrow'){
    super(plugin.app);this.plugin=plugin;this.kind=VIEWS.some(([key])=>key===kind)?kind:'tomorrow';this.page=0;this.items=[];this.generation=0;this.active=false;this.busy=new Set();
  }
  onOpen(){this.active=true;this.titleEl.setText('语音待办');this.contentEl.addClass('vdu-todo-list');void this.refresh();}
  async refresh(){
    if(!this.active)return;
    const generation=++this.generation,range=rangeFor(this.kind);this.renderFrame(range);this.rowsEl.setText('正在读取待办…');
    try{
      const paths=todoNotePaths(this.plugin.app.vault,this.plugin.state,this.plugin.settings,this.plugin.app.metadataCache);
      const items=await collectTodoItems(this.plugin.app.vault,paths,range);
      if(!this.active||generation!==this.generation)return;
      this.items=items;this.page=Math.min(this.page,Math.max(0,Math.ceil(items.length/PAGE_SIZE)-1));this.renderItems();
    }catch{if(this.active&&generation===this.generation)this.rowsEl.setText('暂时无法读取待办，请检查文件是否已同步，再点击刷新。');}
  }
  renderFrame(range){
    this.contentEl.empty();const tabs=this.contentEl.createDiv({cls:'vdu-todo-tabs'});
    for(const [key,label]of VIEWS)button(tabs,label,async()=>{if(this.kind===key)return;this.kind=key;this.page=0;await this.refresh();},{selected:this.kind===key});
    const caption=range.startDate?`${range.startDate}${range.endDate!==range.startDate?' 至 '+range.endDate:''} · 按今天的本地日期查看`:
      this.kind==='review'?'日期、内容或同步副本需要你确认的事项。':'所有已确认且尚未完成的事项，包括未指定日期的待办。';
    this.contentEl.createEl('p',{text:caption,cls:'vdu-todo-hint'});
    button(tabs,'刷新',()=>this.refresh());
    this.rowsEl=this.contentEl.createDiv({cls:'vdu-todo-rows',attr:{'aria-live':'polite'}});
    this.pagerEl=this.contentEl.createDiv({cls:'vdu-todo-pages'});
  }
  renderItems(){
    this.rowsEl.empty();this.pagerEl.empty();
    if(!this.items.length){this.rowsEl.createEl('p',{text:this.kind==='review'?'暂无需要确认的待办。':'暂无已提取的未完成事项。可用“录制待办”说出准备做的事及日期；录音同步到电脑处理后会出现在这里。'});return;}
    for(const item of this.items.slice(this.page*PAGE_SIZE,(this.page+1)*PAGE_SIZE))this.renderItem(item);
    const count=Math.ceil(this.items.length/PAGE_SIZE);
    if(count>1){
      button(this.pagerEl,'上一页',()=>{this.page--;this.renderItems();},{disabled:this.page===0});
      this.pagerEl.createEl('span',{text:`${this.page+1} / ${count} 页，共 ${this.items.length} 项`});
      button(this.pagerEl,'下一页',()=>{this.page++;this.renderItems();},{disabled:this.page===count-1});
    }else this.pagerEl.createEl('span',{text:`共 ${this.items.length} 项`});
  }
  renderItem(item){
    const card=this.rowsEl.createDiv({cls:'vdu-todo-card'});
    card.createEl('h3',{text:item.title});card.createEl('p',{text:dateLabel(item),cls:'vdu-todo-date'});
    if(item.evidence)card.createEl('p',{text:`原话：${item.evidence}`,cls:'vdu-todo-evidence'});
    if(item.status==='needs_confirmation'&&item.reason)card.createEl('p',{text:`待确认原因：${item.reason}`,cls:'vdu-todo-reason'});
    const actions=card.createDiv({cls:'vdu-todo-actions'});
    if(item.conflictPaths?.length){
      card.createEl('p',{text:'存在内容不同的同步副本，请逐一打开核对；清单不会覆盖其中任何一份。',cls:'vdu-todo-reason'});
      for(const [index,path]of item.conflictPaths.entries())button(actions,`打开副本 ${index+1}`,()=>openFile(this.plugin,path));
    }else{
      if(item.notePaths?.length>1)card.createEl('p',{text:`此事项有 ${item.notePaths.length} 份相同的同步副本；修改只保存到当前笔记，随后需核对其余副本。`,cls:'vdu-todo-reason'});
      if(item.status==='confirmed')button(actions,'标记完成',()=>this.complete(item),{disabled:this.busy.has(item.path+'#'+item.id)});
      button(actions,item.status==='needs_confirmation'?'确认或修改':'修改',()=>new TodoEditModal(this.plugin,item,()=>this.refresh()).open());
      button(actions,'打开笔记',()=>openFile(this.plugin,item.path));
    }
    button(actions,'听原录音',()=>openFile(this.plugin,item.sourcePath));
  }
  async complete(item){
    const key=item.path+'#'+item.id;
    if(this.busy.has(key)||item.conflictPaths?.length||item.status!=='confirmed')return;
    this.busy.add(key);this.renderItems();
    try{
      if(this.plugin.closed)throw Error('closed');
      const file=this.plugin.app.vault.getAbstractFileByPath(item.path);
      await updateTodoItem(this.plugin.app.vault,file,item.id,{checked:true},item);
      new Notice(item.notePaths?.length>1?'当前副本已标记完成，请在“待确认”中核对其余同步副本。':'已标记完成');
    }catch{new Notice(SAVE_ERROR,8000);}
    finally{this.busy.delete(key);await this.refresh();}
  }
  onClose(){this.active=false;this.generation++;this.contentEl.empty();}
}
module.exports={TodoListModal,TodoEditModal};
