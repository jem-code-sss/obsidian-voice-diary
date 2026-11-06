import { build } from 'esbuild';
import { mkdir, copyFile, realpath, lstat, rm, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const dist = path.resolve(root,'dist');
await mkdir(dist,{recursive:true});
const realRoot=await realpath(root),realDist=await realpath(dist);
if(realDist!==path.join(realRoot,'dist'))throw new Error('Build directory must stay inside this workspace');
const output=path.join(dist,'voice-diary-unified');
if(path.dirname(output)!==dist||path.basename(output)!=='voice-diary-unified')throw new Error('Unexpected build target');
const existing=await lstat(output).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
if(existing?.isSymbolicLink())throw new Error('Refusing to replace a linked output directory');
await rm(output,{recursive:true,force:true});
await mkdir(`${output}/runtime`, { recursive: true });
await build({ entryPoints: ['src/main.js'], outfile: `${output}/main.js`, bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2020', logLevel: 'info',
  loader:{'.py':'text'},
  external: ['obsidian', ...builtinModules, ...builtinModules.map(x => `node:${x}`)],
  legalComments: 'inline', banner: {js:'/* Voice Diary Processor; MIT. Third-party notices: THIRD-PARTY-NOTICES.md. */'} });
for (const f of ['manifest.json', 'styles.css', 'README.md', 'README.zh-CN.md', 'PRIVACY.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) await copyFile(f, `${output}/${f}`);
await mkdir(`${output}/docs`,{recursive:true});
for(const file of ['SETUP.md','MARKETPLACE.md','VOICE-TODOS.md'])await copyFile(`docs/${file}`,`${output}/docs/${file}`);
const releaseFiles=JSON.parse(await readFile('scripts/release-files.json','utf8'));
for(const file of releaseFiles.runtime) {
  if(typeof file!=='string'||path.basename(file)!==file)throw new Error('Invalid runtime release file');
  await copyFile(`runtime/${file}`,`${output}/runtime/${file}`);
}
