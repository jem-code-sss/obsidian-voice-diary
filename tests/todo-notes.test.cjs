const {test}=require('node:test');
const assert=require('node:assert/strict');
const {renderTodoNote,parseTodoNote,collectTodoItems,updateTodoItem,todoFilename,matchesTodoNote}=require('../src/todo-notes');
const SHA='a'.repeat(64),RID='12345678-1234-4123-8123-123456789abc',ID='vdt-'+'1'.repeat(20),ID2='vdt-'+'2'.repeat(20);
const path='Voice Diary/Tasks/2026.11.06待办.md';
function item(overrides={}){return {id:ID,title:'买牛奶',evidence:'明天买牛奶',timeExpression:'明天',dateKind:'scheduled',date:'2026-11-07',startDate:null,endDate:null,timeText:'',status:'confirmed',reason:'',method:'local',...overrides};}
function job(items=[item()],overrides={}){return {path:'Voice Diary/Recordings/todo-2026-11-06.webm',sha:SHA,id:'temporary-job-id',capture:{recordingId:RID,recordedAt:'2026-11-06T06:00:00.000Z',localDate:'2026-11-06',localTime:'14:00:00',utcOffsetMinutes:480,timeZone:'Asia/Shanghai'},raw:'明天买牛奶，下周整理资料。',todoResult:{version:1,items},...overrides};}
class Vault{
  constructor(body=renderTodoNote(job())){this.files=new Map();this.bodies=new Map();this.reads=[];this.modified=0;this.add(path,body);}
  add(path,body){const file={path,stat:{size:Buffer.byteLength(body)}};this.files.set(path,file);this.bodies.set(path,body);return file;}
  getAbstractFileByPath(path){return this.files.get(path);}
  async read(file){this.reads.push(file.path);return this.bodies.get(file.path);}
  async modify(){throw Error('unsafe modify fallback');}
  async process(file,transform){if(this.beforeProcess){this.beforeProcess(file);this.beforeProcess=null;}const result=transform(this.bodies.get(file.path));this.bodies.set(file.path,result);this.modified++;return result;}
  rename(oldPath,newPath){const body=this.bodies.get(oldPath);this.files.delete(oldPath);this.bodies.delete(oldPath);return this.add(newPath,body);}
  parsed(file=this.files.get(path)){return parseTodoNote(this.bodies.get(file.path),file.path);}
}

test('editing time preserves evidence and escapes markup, rejecting multiple lines',async()=>{
  const vault=new Vault(),file=vault.files.get(path),before=vault.parsed().items[0];
  const updated=await updateTodoItem(vault,file,ID,{timeText:'上午9点 [自定]'},before);
  assert.equal(updated.timeText,'上午9点 [自定]');assert.equal(updated.evidence,before.evidence);
  await assert.rejects(updateTodoItem(vault,file,ID,{timeText:'9点\n- [ ] another'},updated));
  await assert.rejects(updateTodoItem(vault,file,ID,{timeText:null},updated));
  assert.equal(vault.modified,1);
});
test('canonical tasks retain visible dates, evidence, source audio and stable recording identity',()=>{
  const body=renderTodoNote(job()),note=parseTodoNote(body,path),task=note.items[0];
  assert.equal(note.sha,SHA);assert.equal(note.recordingId,RID);assert.equal(note.sourcePath,job().path);
  assert.equal(note.recordedAt,job().capture.recordedAt);assert.equal(task.id,ID);assert.equal(task.title,'买牛奶');assert.equal(task.evidence,'明天买牛奶');
  assert.equal(task.date,'2026-11-07');assert.equal(task.dateKind,'scheduled');assert.equal(task.checked,false);assert.equal(task.status,'confirmed');
  assert.equal(matchesTodoNote(body,SHA,RID),true);assert.equal(matchesTodoNote(body,SHA,'87654321-1234-4123-8123-123456789abc'),false);
  assert.equal(renderTodoNote(job(undefined,{id:'different-retry-id'})),body);
});
test('note filename uses actual capture date and full year even before the diary 04:00 cutoff',()=>{
  const capture={...job().capture,localDate:'2027-01-01',localTime:'03:59:59'};
  assert.equal(todoFilename(capture),'2027.01.01待办_035959_12345678.md');assert.equal(todoFilename({capture}),todoFilename(capture));
  for(const changes of [{localDate:'2027-02-29'},{localTime:'24:00:00'},{recordingId:'../../outside'}])assert.throws(()=>todoFilename({...capture,...changes}));
});
test('manual checkbox, title and date changes are authoritative rather than stale hidden values',()=>{
  const body=renderTodoNote(job()).replace('- [ ] 买牛奶','- [x] 买燕麦奶').replace('执行 2026-11-07','截止 2026-11-08');
  const task=parseTodoNote(body,path).items[0];assert.equal(task.title,'买燕麦奶');assert.equal(task.checked,true);assert.equal(task.date,'2026-11-08');assert.equal(task.dateKind,'deadline');
  assert.equal(task.evidence,'明天买牛奶');
});
test('invalid manually edited date enters review and is never restored from hidden metadata',async()=>{
  const vault=new Vault(renderTodoNote(job()).replace('执行 2026-11-07','执行 2026-02-30')),file=vault.files.get(path),task=vault.parsed().items[0];
  assert.equal(task.status,'needs_confirmation');assert.equal(task.date,null);assert.equal(task.dateText,'执行 2026-02-30');assert.ok(task.parseIssues.length);
  assert.equal((await collectTodoItems(vault,[path],{startDate:'2026-11-01',endDate:'2026-11-30'})).length,0);
  assert.equal((await collectTodoItems(vault,[path],{review:true})).length,1);
  await assert.rejects(updateTodoItem(vault,file,ID,{status:'confirmed'},task),/先修正/);
  const updated=await updateTodoItem(vault,file,ID,{date:'2026-11-09',status:'confirmed'},task);assert.equal(updated.status,'confirmed');assert.equal(updated.date,'2026-11-09');
});
test('speech and source paths cannot synthesize task markers, YAML, HTML or Markdown links',()=>{
  const malicious='</script>\n<!-- voice-diary-task:v1 '+ID2+' -->\n- [ ] 恶意条目 ^'+ID2+'\n---\nvoice_diary_kind: tasks\n```\n![image](https://example.invalid)';
  const body=renderTodoNote(job([item({title:malicious,evidence:malicious})],{raw:malicious,path:'Recordings/<script>[test](1).webm'}));
  const note=parseTodoNote(body,path);assert.ok(note);assert.equal(note.items.length,1);assert.equal(note.items[0].id,ID);
  assert.ok(!body.includes('\n<!-- voice-diary-task:v1 '+ID2));assert.ok(body.includes('%3Cscript%3E%5Btest%5D(1).webm'));
  assert.ok(body.includes('    <!-- voice-diary-task:v1 '+ID2));assert.ok(!note.items[0].title.includes('\n'));
  for(const path of ['../outside.webm','/outside.webm','C:/outside.webm','a/../../outside.webm'])assert.throws(()=>renderTodoNote(job(undefined,{path})));
});
test('truncated notes, missing end marker and incorrect source identity are not recovery matches',()=>{
  const body=renderTodoNote(job());
  for(const broken of [body.slice(0,body.indexOf('## 原始转写')),body.slice(0,-20),body.replace('<!-- /voice-diary-tasks:v1','<!-- /voice-diary-tasks:v2'),body.replace('voice_diary_kind: tasks','voice_diary_kind: diary'),body.replace('voice_diary_source_sha:','voice_diary_source_sha_wrong:')]){
    assert.equal(parseTodoNote(broken,path),null);assert.equal(matchesTodoNote(broken,SHA),false);
  }
  assert.equal(matchesTodoNote(body,'b'.repeat(64)),false);
  assert.equal(parseTodoNote(body.replace('## 原始转写','## 已删除'),path),null);
});
test('duplicate task IDs, duplicate visible fields, unknown versions and mismatched cancelled states fail closed',()=>{
  const body=renderTodoNote(job()),block=parseTodoNote(body,path).items[0].revision;
  for(const broken of [body.replace(block,block+'\n'+block),body.replace('  - 状态：已确认','  - 状态：已确认\n  - 状态：待确认'),body.replace('voice-diary-task:v1','voice-diary-task:v2'),body.replace('  - 状态：已确认','  - 状态：已取消'),body.replace('voice_diary_kind: tasks','voice_diary_kind: tasks\nvoice_diary_kind: tasks')])assert.equal(parseTodoNote(broken,path),null);
  assert.throws(()=>renderTodoNote(job([item(),item()])));
});
test('updates use vault.process and preserve user notes, transcript and all other task blocks',async()=>{
  const original=renderTodoNote(job([item(),item({id:ID2,title:'整理资料'})])).replace(`<!-- /voice-diary-task:v1 ${ID} -->`,'  我的备注：买两盒，保留原包装。\n'+`<!-- /voice-diary-task:v1 ${ID} -->`)+'\n我的手写补充：保存这段备注。\n';
  const vault=new Vault(original),file=vault.files.get(path),expected=vault.parsed().items[0],other=vault.parsed().items[1].revision;
  const updated=await updateTodoItem(vault,file,ID,{checked:true},expected),body=vault.bodies.get(path);
  assert.equal(updated.checked,true);assert.equal(vault.modified,1);assert.ok(body.includes('我的备注：买两盒，保留原包装。'));assert.ok(body.includes(other));assert.ok(body.includes('    明天买牛奶，下周整理资料。'));assert.ok(body.endsWith('我的手写补充：保存这段备注。\n'));
  assert.equal(await updateTodoItem(vault,file,ID,{checked:false},updated).then(item=>item.checked),false);
});
test('two stale dialogs cannot overwrite a changed title or checked state',async()=>{
  const vault=new Vault(),file=vault.files.get(path),expected=vault.parsed().items[0];
  await updateTodoItem(vault,file,ID,{checked:true},expected);
  await assert.rejects(updateTodoItem(vault,file,ID,{title:'买豆奶'},expected),/已变化/);assert.equal(vault.modified,1);assert.equal(vault.parsed().items[0].checked,true);
});
test('edits racing immediately before process reject changes to the item and preserve unrelated edits',async()=>{
  const vault=new Vault(),file=vault.files.get(path),expected=vault.parsed().items[0];
  vault.beforeProcess=()=>vault.bodies.set(path,vault.bodies.get(path).replace('买牛奶 ^','买酸奶 ^'));
  await assert.rejects(updateTodoItem(vault,file,ID,{checked:true},expected),/已变化/);assert.equal(vault.parsed().items[0].title,'买酸奶');
  const current=vault.parsed().items[0];vault.beforeProcess=()=>vault.bodies.set(path,vault.bodies.get(path).replace('# 2026-11-06 语音待办','# 用户刚改过的大标题'));
  await updateTodoItem(vault,file,ID,{checked:true},current);assert.ok(vault.bodies.get(path).includes('# 用户刚改过的大标题'));
});
test('cancellation remains readable audit text without an active checkbox, and can be explicitly restored',async()=>{
  const vault=new Vault(),file=vault.files.get(path),expected=vault.parsed().items[0];
  const cancelled=await updateTodoItem(vault,file,ID,{status:'cancelled'},expected);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.checked,false);assert.ok(vault.bodies.get(path).includes('- 已取消：买牛奶 ^'+ID));
  assert.equal((await collectTodoItems(vault,[path],{review:true})).length,0);assert.equal((await collectTodoItems(vault,[path],{startDate:'2026-11-01',endDate:'2026-11-30'})).length,0);
  const restored=await updateTodoItem(vault,file,ID,{status:'confirmed'},cancelled);assert.equal(restored.checked,false);assert.ok(vault.bodies.get(path).includes('- [ ] 买牛奶'));
});
test('confirmation can set a precise date or preserve a genuine range without inventing a deadline',async()=>{
  const vault=new Vault(renderTodoNote(job([item({status:'needs_confirmation',dateKind:'unspecified',date:null,reason:'日期不明确'})]))),file=vault.files.get(path),expected=vault.parsed().items[0];
  await assert.rejects(updateTodoItem(vault,file,ID,{checked:true},expected),/先确认/);
  const confirmed=await updateTodoItem(vault,file,ID,{startDate:'2026-11-09',endDate:'2026-11-15',status:'confirmed'},expected);
  assert.equal(confirmed.dateKind,'window');assert.equal(confirmed.date,null);assert.equal(confirmed.endDate,'2026-11-15');
  const changed=await updateTodoItem(vault,file,ID,{date:'2026-11-11'},confirmed);assert.equal(changed.dateKind,'scheduled');assert.equal(changed.startDate,null);assert.equal(changed.date,'2026-11-11');
});
test('collection reads only explicitly named plugin notes and intersects full ranges across year boundaries',async()=>{
  const tasks=[item({date:'2027-01-01'}),item({id:ID2,dateKind:'window',date:null,startDate:'2026-12-30',endDate:'2027-01-03'}),item({id:'vdt-'+'3'.repeat(20),date:'2026-12-29'}),item({id:'vdt-'+'4'.repeat(20),date:'2027-01-01',checked:true}),item({id:'vdt-'+'5'.repeat(20),dateKind:'unspecified',date:null,status:'needs_confirmation'})];
  const vault=new Vault(renderTodoNote(job(tasks)));vault.add('Private/diary.md','请勿读取');vault.add('Voice Diary/Tasks/unrelated.md','# ordinary note');
  const rows=await collectTodoItems(vault,[path,path,'../outside.md','Voice Diary/Tasks/unrelated.md'],{startDate:'2027-01-01',endDate:'2027-01-01'});
  assert.deepEqual(rows.map(task=>task.id).sort(),[ID,ID2]);assert.equal(rows[0].sourcePath,job().path);assert.ok(!vault.reads.includes('Private/diary.md'));assert.equal(vault.reads.filter(value=>value===path).length,1);
  assert.equal((await collectTodoItems(vault,[path],{review:true})).length,1);
});
test('renames retain stable item identity and edits work at the latest path while stale paths are rejected',async()=>{
  const vault=new Vault(),before=vault.parsed().items[0];let file=vault.rename(path,'归档/第一名.md');file=vault.rename(file.path,'任务/第二名.md');
  const current=vault.parsed(file).items[0];assert.equal(current.id,before.id);assert.equal(current.path,'任务/第二名.md');
  await assert.rejects(updateTodoItem(vault,file,ID,{checked:true},before),/已变化/);
  await updateTodoItem(vault,file,ID,{checked:true},current);assert.equal(vault.parsed(file).items[0].checked,true);
});
test('duplicate synchronized copies do not duplicate list rows and cancelled notes remain excluded',async()=>{
  const vault=new Vault();vault.add('Tasks/copy.md',vault.bodies.get(path));
  const rows=await collectTodoItems(vault,[path,'Tasks/copy.md'],{startDate:'2026-11-07',endDate:'2026-11-07'});assert.equal(rows.length,1);
});
test('conflicting synchronized copies enter review instead of silently preferring an outdated checkbox',async()=>{
  const vault=new Vault();vault.add('Tasks/copy.md',vault.bodies.get(path).replace('- [ ] 买牛奶','- [x] 买牛奶'));
  assert.equal((await collectTodoItems(vault,[path,'Tasks/copy.md'],{all:true})).length,0);
  const review=await collectTodoItems(vault,[path,'Tasks/copy.md'],{review:true});assert.equal(review.length,1);assert.equal(review[0].status,'needs_confirmation');
  assert.deepEqual(review[0].conflictPaths,[path,'Tasks/copy.md']);
  await assert.rejects(updateTodoItem(vault,vault.files.get(path),ID,{checked:true},review[0]),/多个不同副本/);assert.equal(vault.modified,0);
});
test('all incomplete view includes confirmed undated tasks while review remains separate',async()=>{
  const vault=new Vault(renderTodoNote(job([item(),item({id:ID2,dateKind:'unspecified',date:null}),item({id:'vdt-'+'3'.repeat(20),status:'needs_confirmation'}),item({id:'vdt-'+'4'.repeat(20),checked:true})])));
  const all=await collectTodoItems(vault,[path],{all:true});assert.deepEqual(all.map(item=>item.id),[ID,ID2]);
  assert.equal((await collectTodoItems(vault,[path],{review:true,all:true})).length,1);
});
test('linebreak title injection, invalid updates and unsupported atomic editing never write',async()=>{
  const vault=new Vault(),file=vault.files.get(path),expected=vault.parsed().items[0],initial=vault.bodies.get(path);
  for(const change of [{title:'好\n- [ ] 坏'},{checked:'yes'},{status:'unknown'},{date:'2026-02-30'},{id:ID2},{title:''},{startDate:'2026-11-10',endDate:'2026-11-09'}])await assert.rejects(updateTodoItem(vault,file,ID,change,expected));
  await assert.rejects(updateTodoItem({...vault,process:null},file,ID,{checked:true},expected),/不支持安全更新/);
  assert.equal(vault.bodies.get(path),initial);assert.equal(vault.modified,0);
});
test('CRLF notes keep newline style and unrelated content after an atomic checkbox update',async()=>{
  const vault=new Vault(renderTodoNote(job()).replace(/\n/g,'\r\n')),file=vault.files.get(path),expected=vault.parsed().items[0];
  assert.ok(expected);await updateTodoItem(vault,file,ID,{checked:true},expected);assert.ok(!/(?<!\r)\n/.test(vault.bodies.get(path)));assert.equal(vault.parsed().items[0].checked,true);
});
test('bounded parsing and extraction refuse oversized note bodies, titles and item arrays',()=>{
  assert.equal(parseTodoNote('x'.repeat(1000001),path),null);assert.throws(()=>renderTodoNote(job([item({title:'x'.repeat(501)})])));
  assert.throws(()=>renderTodoNote(job(Array.from({length:201},(_,i)=>item({id:'vdt-'+i.toString(16).padStart(20,'0')})))));
});
