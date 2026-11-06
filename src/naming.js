// Titles are derived locally. This module never reads other notes or calls an API.
const pad=value=>String(value).padStart(2,'0');
function calendarDate(year,month,day) {
  const date=new Date(Date.UTC(year,month-1,day));
  return year>=1000&&year<=9999&&date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day
    ?`${year}-${pad(month)}-${pad(day)}`:null;
}
function diaryDate(date,hour,startHour) {
  if(hour===null||hour>=startHour)return date;
  const [year,month,day]=date.split('-').map(Number),previous=new Date(Date.UTC(year,month-1,day));
  // Calendar arithmetic preserves the intended wall-clock day across DST.
  previous.setUTCDate(previous.getUTCDate()-1);
  return `${previous.getUTCFullYear()}-${pad(previous.getUTCMonth()+1)}-${pad(previous.getUTCDate())}`;
}
function sourceDate(file,now=Date.now(),startHour=4) {
  const name=String(file.name||file.path?.split('/').pop()||'');
  const parts=name.match(/^voice-(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2})(\d{2})(?=[-.]|$)|(?=[-.]|$))/i);
  const date=parts&&calendarDate(Number(parts[1]),Number(parts[2]),Number(parts[3]));
  if(date) {
    const hasTime=parts[4]!==undefined,hour=hasTime?Number(parts[4]):null;
    if(!hasTime||hour<24&&Number(parts[5])<60&&Number(parts[6])<60)
      return {date:diaryDate(date,hour,startHour),source:'filename'};
  }
  const created=file.stat?.ctime;
  const validCreated=typeof created==='number'&&Number.isFinite(created)&&created>=0&&Number.isFinite(new Date(created).getTime());
  const local=new Date(validCreated?created:now);
  const fallback=calendarDate(local.getFullYear(),local.getMonth()+1,local.getDate());
  if(!fallback)throw Error('Invalid recording date');
  return {date:diaryDate(fallback,local.getHours(),startHour),source:validCreated?'created':'processed'};
}
function cleanTopic(value) {
  const cleaned=String(value||'').normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*\[\]#^]/gu,' ')
    .replace(/\s+/g,' ').replace(/^[\s.。·_-]+|[\s.。·_-]+$/g,'');
  return Array.from(cleaned).slice(0,24).join('').replace(/[\s.。·_-]+$/g,'')||'随记';
}
function topicFromText(text) {
  const prose=String(text||'').slice(0,12000).trim();
  const firstLines=prose.split(/\r?\n/).filter(line=>line.trim()).slice(0,4);
  for(const line of firstLines) {
    const explicit=line.match(/^\s*(?:#{1,6}\s+|(?:日记主题|主题|标题|今天的主题|这篇日记的标题)(?:\s*[:：]\s*|\s*是\s*))(.{1,100})$/u);
    if(explicit)return cleanTopic(explicit[1].replace(/[。！？!?]+$/u,''));
  }
  if(/出游|旅游|旅行|郊游|踏青|春游|秋游|一日游|游玩|出门玩/u.test(prose))return '出游';
  const sentences=prose.split(/[\r\n。！？!?；;]/u).map(part=>part.trim()).filter(Boolean);
  for(let sentence of sentences) {
    sentence=sentence.replace(/^(?:(?:嗯|啊|呃|那个|就是说)[，,\s]*)+/u,'').replace(/^[-*>\s]+/u,'');
    if(sentence&&!/^(?:谢谢|感谢)(?:大家|收听|观看)|^(?:今天|现在)是?\s*\d{4}年/u.test(sentence))return cleanTopic(sentence);
  }
  return '随记';
}
function namingSnapshot(file,config,now) {
  const dayStart=Number.isInteger(config.diaryDayStartHour)&&config.diaryDayStartHour>=0&&config.diaryDayStartHour<=23?config.diaryDayStartHour:4;
  const value=sourceDate(file,now,dayStart);
  return {mode:config.noteNaming==='source'?'source':'date-topic',includeYear:config.titleIncludeYear===true,date:value.date,dateSource:value.source,dayStartHour:dayStart};
}
function diaryFilename(naming,text) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(naming.date))throw Error('Invalid recording date');
  const [year,month,day]=naming.date.split('-');
  return `${naming.includeYear?year+'.':''}${month}.${day}日记_${topicFromText(text)}.md`;
}
module.exports={sourceDate,cleanTopic,topicFromText,namingSnapshot,diaryFilename};
