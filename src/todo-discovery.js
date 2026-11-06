// Only plugin-marked notes and the dedicated task destinations are read.
const isTaskName=path=>/(?:^|\/)\d{4}\.\d{2}\.\d{2}待办_\d{6}_[a-f0-9]{8}(?:-\d+)?\.md$/i.test(path);
function todoNotePaths(vault,state={},config={},metadataCache) {
  const jobs=Object.values(state.jobs||{}).filter(job=>job.mode==='todo');
  const known=new Set([...(state.todoNotes||[]),...jobs.flatMap(job=>[job.output,job.target,...(job.incompleteOutputs||[])])].filter(value=>typeof value==='string'));
  const folders=new Set([config.todoFolder||'Voice Diary/Tasks',...(state.todoFolders||[]),...jobs.map(job=>job.targetFolder)].filter(value=>typeof value==='string'&&value.length).map(value=>value.replace(/\/+$/,'')+'/'));
  const paths=[];
  for(const file of vault.getFiles()) {
    if(!/\.md$/i.test(file.path))continue;
    const marked=metadataCache?.getFileCache?.(file)?.frontmatter?.voice_diary_kind==='tasks';
    if(known.has(file.path)||marked||isTaskName(file.path)&&[...folders].some(folder=>file.path.startsWith(folder)))paths.push(file.path);
  }
  return paths;
}
module.exports={todoNotePaths};
