import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const PROJ4_VERSION='2.21.0';
const PROJ4_SHA256='c3a3a85c5b52e012873fe13db6253e40e3c9cde124523965c57eec7f7c4cd756';
const PROJ4_UMD_WRAPPER='!function(t,s){"object"==typeof exports&&"undefined"!=typeof module?module.exports=s():"function"==typeof define&&define.amd?define(s):(t="undefined"!=typeof globalThis?globalThis:t||self).proj4=s()}(this,function(){';
const relativeStaticModuleSpecifier=/\b(?:from\s*|import\s*)(['\"])(\.{1,2}\/[^'\"]+)\1/g;

function releaseRevision(revision){
  return encodeURIComponent(String(revision).toWellFormed()).replace(/'/g,'%27');
}
function releaseUrl(url,revision){
  return `${url}${url.includes('?')?'&':'?'}v=${releaseRevision(revision)}`;
}

export function relativeModuleSpecifiers(source){
  return [...source.matchAll(relativeStaticModuleSpecifier)].map(([, ,specifier])=>specifier);
}

export function releaseModuleSource(source,revision){
  const versioned=url=>releaseUrl(url,revision);
  return source
    .replace(relativeStaticModuleSpecifier,(match,_quote,url)=>match.replace(url,versioned(url)))
    .replace(/(new URL\(\s*['\"])((?:\.\.\/)+(?:vendor|assets\/fonts)\/[^'\"]+)(['\"]\s*,\s*import\.meta\.url\s*\))/g,(_,before,url,after)=>before+versioned(url)+after);
}

export function proj4BrowserModuleSource(source,declaredVersion){
  if(declaredVersion!==PROJ4_VERSION)throw new Error(`proj4 browser build requires the exact ${PROJ4_VERSION} package pin.`);
  if(typeof source!=='string'||!source.startsWith(PROJ4_UMD_WRAPPER)||source.split(PROJ4_UMD_WRAPPER).length!==2)throw new Error('proj4 browser build found an unexpected UMD wrapper.');
  if((source.match(/version:"2\.21\.0"/g)||[]).length!==1)throw new Error(`proj4 browser build found an unexpected library version; expected ${PROJ4_VERSION}.`);
  const digest=createHash('sha256').update(source,'utf8').digest('hex');
  if(digest!==PROJ4_SHA256)throw new Error('proj4 browser source integrity does not match the exact pinned artifact.');
  const scoped='const __proj4Sandbox={};\n!function(t,s){t.proj4=s()}(__proj4Sandbox,function(){'+source.slice(PROJ4_UMD_WRAPPER.length);
  return scoped+`\nconst proj4=__proj4Sandbox.proj4;\nif(typeof proj4!=='function'||proj4.version!=='${PROJ4_VERSION}')throw new Error('The scoped projection browser module did not initialize.');\nexport default proj4;\n`;
}

async function versionModuleTree(directory,revision){
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await versionModuleTree(file,revision);
    else if(entry.name.endsWith('.mjs'))await fs.writeFile(file,releaseModuleSource(await fs.readFile(file,'utf8'),revision));
  }
}

export async function buildSite({output=path.join(root,'_site'),revision=process.env.GITHUB_SHA||'local-development'}={}){
  const packageManifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const proj4Source=await fs.readFile(path.join(root,'node_modules/proj4/dist/proj4.js'),'utf8');
  const proj4Module=proj4BrowserModuleSource(proj4Source,packageManifest.dependencies?.proj4);
  await fs.mkdir(output,{recursive:true});
  const index=await fs.readFile(path.join(root,'index.html'),'utf8');
  await fs.writeFile(path.join(output,'index.html'),index
    .replace('href="styles.css"',`href="${releaseUrl('styles.css',revision)}"`)
    .replace('src="app.js"',`src="${releaseUrl('app.js',revision)}"`));
  for(const name of ['app.js','styles.css','print-preflight.mjs'])await fs.copyFile(path.join(root,name),path.join(output,name));
  for(const name of ['src','data'])await fs.cp(path.join(root,name),path.join(output,name),{recursive:true});
  await fs.rm(path.join(output,'src/proj4-runtime.mjs'),{force:true});
  await fs.writeFile(path.join(output,'app.js'),releaseModuleSource(await fs.readFile(path.join(output,'app.js'),'utf8'),revision));
  await fs.writeFile(path.join(output,'print-preflight.mjs'),releaseModuleSource(await fs.readFile(path.join(output,'print-preflight.mjs'),'utf8'),revision));
  await versionModuleTree(path.join(output,'src'),revision);
  await fs.mkdir(path.join(output,'vendor'),{recursive:true});
  for(const stale of ['proj4.js','proj4.umd.mjs'])await fs.rm(path.join(output,'vendor',stale),{force:true});
  await fs.writeFile(path.join(output,'vendor/proj4.esm.mjs'),proj4Module);
  await fs.mkdir(path.join(output,'assets/fonts'),{recursive:true});
  for(const [from,to] of [['node_modules/jspdf/dist/jspdf.umd.min.js','vendor/jspdf.umd.min.js'],['node_modules/jspdf/LICENSE','vendor/jspdf.LICENSE'],['node_modules/geotiff/dist-browser/geotiff.js','vendor/geotiff.js'],['node_modules/geotiff/LICENSE','vendor/geotiff.LICENSE'],['node_modules/proj4/LICENSE.md','vendor/proj4.LICENSE.md'],['assets/fonts/DejaVuSans.ttf','assets/fonts/DejaVuSans.ttf'],['assets/fonts/LICENSE.txt','assets/fonts/LICENSE.txt']])await fs.copyFile(path.join(root,from),path.join(output,to));
  await fs.writeFile(path.join(output,'version.json'),JSON.stringify({revision,builtAt:new Date().toISOString()},null,2));
  console.log('Pages source staged in '+output);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await buildSite();
