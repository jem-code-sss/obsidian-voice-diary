// A task's visible Markdown is authoritative. Hidden markers identify blocks;
// they never contain a second copy of editable dates, titles or completion.
const ID=/^vdt-[a-f0-9]{20}$/;
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_NOTE=1000000,MAX_ITEMS=200,MAX_FIELD=6000;
const REGION_START='<!-- voice-diary-tasks:items -->',REGION_END='<!-- /voice-diary-tasks:items -->';
const STATUS={confirmed:'已确认',needs_confirmation:'待确认',cancelled:'已取消'};
const FIELD={status:'状态',date:'日期',timeText:'时间',evidence:'原话',timeExpression:'时间原话',method:'提取',reason:'待确认原因'};
function fail(message='待办笔记格式无效，未修改文件'){throw new Error(message);}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00.000Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value&&Number(value.slice(0,4))>=1000;}
function plain(value,max=MAX_FIELD){if(typeof value!=='string'||value.length>max)fail();return value.replace(/[\r\n\t\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim();}
function escape(value){return plain(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()!#|~^]/g,'\\$&');}
function unescape(value){return value.replace(/\\([\\`*_{}\[\]()!#|~^])/g,'$1').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
function vaultPath(value){return typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\\\x00-\x1f\x7f:]/.test(value)&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..');}
function dateText(item){
  if(item.dateKind==='unspecified'&&item.date==null&&item.startDate==null&&item.endDate==null)return '未指定';
  if((item.dateKind==='scheduled'||item.dateKind==='deadline')&&date(item.date)&&item.startDate==null&&item.endDate==null)return `${item.dateKind==='scheduled'?'执行':'截止'} ${item.date}`;
  if(item.dateKind==='window'&&item.date==null&&date(item.startDate)&&date(item.endDate)&&item.startDate<=item.endDate)return `范围 ${item.startDate} ~ ${item.endDate}`;
  fail('待办日期无效，未修改文件');
}
function parseDate(value){
  const empty={dateKind:'unspecified',date:null,startDate:null,endDate:null};
  if(value==='未指定')return empty;
  const one=value.match(/^(执行|截止) (\d{4}-\d{2}-\d{2})$/);
  if(one&&date(one[2]))return {...empty,dateKind:one[1]==='执行'?'scheduled':'deadline',date:one[2]};
  const range=value.match(/^范围 (\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/);
  if(range&&date(range[1])&&date(range[2])&&range[1]<=range[2])return {...empty,dateKind:'window',startDate:range[1],endDate:range[2]};
  return null;
}
function todoFilename(context){
  const capture=context?.capture||context;
  if(!capture||!date(capture.localDate)||!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(capture.localTime)||!UUID.test(capture.recordingId))fail('缺少有效的待办录音时间');
  return `${capture.localDate.replace(/-/g,'.')}待办_${capture.localTime.replace(/:/g,'')}_${capture.recordingId.slice(0,8).toLowerCase()}.md`;
}
function renderItem(item){
  if(!item||!ID.test(item.id)||!Object.hasOwn(STATUS,item.status)||!['local','api'].includes(item.method))fail();
  const title=plain(item.title,500);if(!title)fail();
  const first=item.status==='cancelled'?`- 已取消：${escape(title)} ^${item.id}`:`- [${item.checked===true?'x':' '}] ${escape(title)} ^${item.id}`;
  return [`<!-- voice-diary-task:v1 ${item.id} -->`,first,
    `  - 状态：${STATUS[item.status]}`,`  - 日期：${dateText(item)}`,`  - 时间：${escape(item.timeText||'')||'未指定'}`,
    `  - 原话：${escape(item.evidence||'')}`,`  - 时间原话：${escape(item.timeExpression||'')||'未指定'}`,
    `  - 提取：${item.method==='api'?'API':'本地规则'}`,`  - 待确认原因：${escape(item.reason||'')||'无'}`,
    `<!-- /voice-diary-task:v1 ${item.id} -->`].join('\n');
}
function renderTodoNote(job){
  const capture=job?.capture,items=job?.todoResult?.items;
  if(!SHA.test(job?.sha)||!vaultPath(job?.path)||job?.todoResult?.version!==1||!Array.isArray(items)||items.length>MAX_ITEMS||!capture||!UUID.test(capture.recordingId))fail();
  todoFilename(capture);
  const recorded=new Date(capture.recordedAt);if(!Number.isFinite(recorded.getTime()))fail();
  if(typeof job.raw!=='string')fail();
  const raw=job.raw;if(raw.length>500000)fail('转写内容过长，无法生成待办笔记');
  const seen=new Set();for(const item of items){if(seen.has(item.id))fail();seen.add(item.id);}
  const audio=job.path.split('/').map(part=>encodeURIComponent(part)).join('/');
  const body=['---','voice_diary_kind: tasks','voice_diary_tasks_version: 1',`voice_diary_source_sha: "${job.sha}"`,
    `voice_diary_recording_id: "${capture.recordingId}"`,`voice_diary_recorded_at: "${recorded.toISOString()}"`,
    `voice_diary_source_audio: ${JSON.stringify(job.path)}`,'---',
    `<!-- voice-diary-tasks:v1 ${job.sha} -->`,'',`# ${capture.localDate} 语音待办`,'',
    `录音时间：${capture.localDate} ${capture.localTime}；相对日期以录音当天为准。`,`[原始录音](<${audio}>)`,'',
    '可直接勾选完成、修改标题及日期。日期格式：执行 YYYY-MM-DD、截止 YYYY-MM-DD、范围 YYYY-MM-DD ~ YYYY-MM-DD 或未指定。','',
    REGION_START,items.length?items.map(renderItem).join('\n\n'):'暂无已提取事项。',REGION_END,'',
    '## 原始转写','',...raw.replace(/\r\n?/g,'\n').split('\n').map(line=>'    '+line),'',
    `<!-- /voice-diary-tasks:v1 ${job.sha} ${capture.recordingId} -->`,''].join('\n');
  if(body.length>MAX_NOTE)fail();return body;
}
function linesWithOffsets(text){const output=[];let start=0;for(const part of text.split('\n')){const text=part.endsWith('\r')?part.slice(0,-1):part;output.push({text,start,end:start+text.length});start+=part.length+1;}return output;}
function parseBlock(block,path,offset){
  const lines=linesWithOffsets(block),id=lines[0].text.match(/^<!-- voice-diary-task:v1 (vdt-[a-f0-9]{20}) -->$/)?.[1];
  if(!id||lines.at(-1).text!==`<!-- /voice-diary-task:v1 ${id} -->`)return null;
  const first=lines[1]?.text,active=first?.match(/^- \[([ xX])\] (.+) \^(vdt-[a-f0-9]{20})$/),cancelled=first?.match(/^- 已取消：(.+) \^(vdt-[a-f0-9]{20})$/);
  if(!active&&!cancelled||active&&active[3]!==id||cancelled&&cancelled[2]!==id)return null;
  const rawTitle=active?active[2]:cancelled[1],title=unescape(rawTitle);if(!title.trim()||title.length>500)return null;
  const values={},positions={title:lines[1]};
  for(const [key,label]of Object.entries(FIELD)){
    const matched=lines.filter(line=>line.text.startsWith(`  - ${label}：`));if(matched.length!==1)return null;
    const line=matched[0],value=line.text.slice(label.length+5);if(value.length>MAX_FIELD)return null;
    values[key]=unescape(value);positions[key]=line;
  }
  const status=Object.keys(STATUS).find(key=>STATUS[key]===values.status);if(!status||Boolean(cancelled)!==(status==='cancelled'))return null;
  const method=values.method==='本地规则'?'local':values.method==='API'?'api':null;if(!method)return null;
  const parsed=parseDate(values.date),parseIssues=[];
  if(!parsed)parseIssues.push('日期格式无效，请检查原笔记中的日期');
  if(/[\r\n\x00-\x1f\x7f]/.test(title))parseIssues.push('标题含有无效控制字符');
  return {id,title,checked:Boolean(active&&/[xX]/.test(active[1])),status:parseIssues.length&&status!=='cancelled'?'needs_confirmation':status,
    ...(parsed||{dateKind:'unspecified',date:null,startDate:null,endDate:null}),timeText:values.timeText==='未指定'?'':values.timeText,
    evidence:values.evidence,timeExpression:values.timeExpression==='未指定'?'':values.timeExpression,method,
    reason:parseIssues.length?parseIssues.join('；'):values.reason==='无'?'':values.reason,parseIssues,dateText:values.date,
    path,anchor:id,revision:block,_start:offset,_end:offset+block.length,_positions:positions,_storedStatus:status};
}
function parseTodoNote(body,path=''){
  if(typeof body!=='string'||body.length>MAX_NOTE||!body.startsWith('---\n')&&!body.startsWith('---\r\n'))return null;
  const front=body.match(/^---\r?\n([\s\S]{0,8192}?)\r?\n---\r?\n/);if(!front)return null;
  const fields={};for(const line of front[1].split(/\r?\n/)){
    const match=line.match(/^(voice_diary_(?:kind|tasks_version|source_sha|recording_id|recorded_at|source_audio)): (.+)$/);if(!match)continue;
    if(Object.hasOwn(fields,match[1]))return null;
    try{fields[match[1]]=match[2].startsWith('"')?JSON.parse(match[2]):match[2];}catch{return null;}
  }
  const sha=fields.voice_diary_source_sha,recordingId=fields.voice_diary_recording_id,recordedAt=fields.voice_diary_recorded_at;
  const sourcePath=fields.voice_diary_source_audio;
  if(fields.voice_diary_kind!=='tasks'||fields.voice_diary_tasks_version!=='1'||!SHA.test(sha)||!UUID.test(recordingId)||!vaultPath(sourcePath)||typeof recordedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(recordedAt)||!Number.isFinite(new Date(recordedAt).getTime())||new Date(recordedAt).toISOString()!==recordedAt)return null;
  const endMarker=`<!-- /voice-diary-tasks:v1 ${sha} ${recordingId} -->`;
  const tail=body.slice(front[0].length),marker=`<!-- voice-diary-tasks:v1 ${sha} -->`;
  if(!tail.startsWith(marker+'\n')&&!tail.startsWith(marker+'\r\n'))return null;
  const lines=linesWithOffsets(body),starts=lines.filter(line=>line.text===REGION_START),ends=lines.filter(line=>line.text===REGION_END),completed=lines.filter(line=>line.text.startsWith('<!-- /voice-diary-tasks:v'));
  if(starts.length!==1||ends.length!==1||completed.length!==1||completed[0].text!==endMarker||starts[0].start>=ends[0].start||ends[0].start>=completed[0].start)return null;
  const transcriptHeadings=lines.filter(line=>line.text==='## 原始转写'&&line.start>ends[0].start&&line.start<completed[0].start);
  if(transcriptHeadings.length!==1)return null;
  const regionStart=starts[0].end+(body[starts[0].end]==='\r'?2:1),regionEnd=ends[0].start;
  const region=body.slice(regionStart,regionEnd),regionLines=linesWithOffsets(region),items=[],seen=new Set();let current=null;
  for(const line of regionLines){
    if(line.text.startsWith('<!-- voice-diary-task:')){
      if(current!==null||!/^<!-- voice-diary-task:v1 vdt-[a-f0-9]{20} -->$/.test(line.text))return null;current=line.start;
    }else if(line.text.startsWith('<!-- /voice-diary-task:')){
      if(current===null)return null;const block=region.slice(current,line.end),item=parseBlock(block,path,regionStart+current);
      if(!item||seen.has(item.id)||items.length>=MAX_ITEMS)return null;seen.add(item.id);items.push(item);current=null;
    }
  }
  if(current!==null)return null;
  return {version:1,sha,recordingId,recordedAt,sourcePath,source_audio:sourcePath,path,items};
}
function matchesTodoNote(body,sha,recordingId){const note=SHA.test(sha)&&parseTodoNote(body);return Boolean(note&&note.sha===sha&&(recordingId===undefined||note.recordingId===recordingId));}
function inWindow(item,window){
  if(window?.review===true)return item.status==='needs_confirmation';
  if(item.status!=='confirmed'||item.checked)return false;
  if(window?.all===true)return true;
  if(!date(window?.startDate)||!date(window?.endDate)||window.startDate>window.endDate)fail('待办查询日期无效');
  const start=item.dateKind==='window'?item.startDate:item.date,end=item.dateKind==='window'?item.endDate:item.date;
  return Boolean(start&&end&&start<=window.endDate&&end>=window.startDate);
}
async function collectTodoItems(vault,paths,window){
  if(!Array.isArray(paths)||paths.length>10000)fail('待办笔记数量过多');
  if(window?.review!==true&&window?.all!==true&&(!date(window?.startDate)||!date(window?.endDate)||window.startDate>window.endDate))fail('待办查询日期无效');
  const known=new Map();
  for(const path of new Set(paths)){
    if(!vaultPath(path)||!path.toLowerCase().endsWith('.md'))continue;
    const file=vault.getAbstractFileByPath(path);if(!file||Array.isArray(file.children)||file.stat?.size>MAX_NOTE*4)continue;
    let parsed;try{parsed=parseTodoNote(await vault.read(file),path);}catch{continue;}if(!parsed)continue;
    for(const item of parsed.items){
      const identity=`${parsed.recordingId}:${parsed.sha}:${item.id}`;
      const existing=known.get(identity);
      if(existing){
        existing.notePaths.push(path);
        if(existing.revision!==item.revision||existing.conflictPaths){
          existing.conflictPaths=[...existing.notePaths];
          existing.status='needs_confirmation';existing.reason='同一事项有多个不同副本，请在原笔记中处理';
          existing.parseIssues=[...new Set([...existing.parseIssues,existing.reason])];
        }
        continue;
      }
      known.set(identity,{...item,sha:parsed.sha,recordingId:parsed.recordingId,recordedAt:parsed.recordedAt,sourcePath:parsed.sourcePath,notePaths:[path]});
    }
  }
  return [...known.values()].filter(item=>inWindow(item,window)).sort((a,b)=>(a.date||a.startDate||'9999').localeCompare(b.date||b.startDate||'9999')||a.path.localeCompare(b.path)||a.id.localeCompare(b.id));
}
async function updateTodoItem(vault,file,id,changes,expectedItem){
  if(typeof vault?.process!=='function')fail('当前版本不支持安全更新，请直接编辑待办笔记');
  if(expectedItem?.conflictPaths?.length)fail('同一事项有多个不同副本，请在原笔记中处理');
  if(!file||Array.isArray(file.children)||!ID.test(id)||expectedItem?.id!==id||expectedItem.path!==file.path||typeof expectedItem.revision!=='string')fail('待办内容已变化，请重新打开清单');
  const allowed=['checked','title','date','startDate','endDate','dateKind','status','timeText'];
  if(!changes||Array.isArray(changes)||typeof changes!=='object'||Object.keys(changes).some(key=>!allowed.includes(key)))fail();
  let updated;
  await vault.process(file,body=>{
    const note=parseTodoNote(body,file.path),item=note?.items.find(item=>item.id===id);
    if(!item||item.revision!==expectedItem.revision)fail('待办内容已变化，请重新打开清单');
    const next={...item,...changes};
    if(Object.hasOwn(changes,'checked')&&typeof changes.checked!=='boolean'||!Object.hasOwn(STATUS,next.status))fail();
    if(Object.hasOwn(changes,'title')){next.title=plain(changes.title,500);if(!next.title||/[\r\n]/.test(changes.title))fail('待办标题必须是一行文字');}
    const patches=[],replace=(key,value)=>{const position=item._positions[key];patches.push({start:position.start,end:position.end,text:value});};
    if(Object.hasOwn(changes,'timeText')){
      next.timeText=plain(changes.timeText,240);if(/[\r\n]/.test(changes.timeText))fail('待办时间必须是一行文字');
      replace('timeText',`  - 时间：${escape(next.timeText)||'未指定'}`);
    }
    const touchesDate=['date','startDate','endDate','dateKind'].some(key=>Object.hasOwn(changes,key));
    if(touchesDate){
      if(!Object.hasOwn(changes,'dateKind')){
        if(changes.startDate!=null||changes.endDate!=null)next.dateKind='window';
        else if(changes.date!=null)next.dateKind=item.dateKind==='deadline'?'deadline':'scheduled';
        else if(next.date==null&&next.startDate==null&&next.endDate==null)next.dateKind='unspecified';
      }
      if(next.dateKind==='window')next.date=null;else if(['scheduled','deadline'].includes(next.dateKind)){next.startDate=null;next.endDate=null;}
      replace('date',`  - 日期：${dateText(next)}`);
    }else if(item.parseIssues.length&&changes.status==='confirmed')fail('请先修正日期或标题后再确认');
    if(next.status==='cancelled')next.checked=false;
    if(next.checked&&next.status!=='confirmed')fail('请先确认待办后再标记完成');
    if(['title','checked','status'].some(key=>Object.hasOwn(changes,key))){
      const header=next.status==='cancelled'?`- 已取消：${escape(next.title)} ^${id}`:`- [${next.checked?'x':' '}] ${escape(next.title)} ^${id}`;
      replace('title',header);
    }
    if(Object.hasOwn(changes,'status'))replace('status',`  - 状态：${STATUS[next.status]}`);
    let block=item.revision;for(const patch of patches.sort((a,b)=>b.start-a.start))block=block.slice(0,patch.start)+patch.text+block.slice(patch.end);
    const result=body.slice(0,item._start)+block+body.slice(item._end),parsed=parseTodoNote(result,file.path);
    updated=parsed?.items.find(item=>item.id===id);if(!updated)fail();return result;
  });
  return updated;
}
module.exports={renderTodoNote,parseTodoNote,collectTodoItems,updateTodoItem,todoFilename,matchesTodoNote};
