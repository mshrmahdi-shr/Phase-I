import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
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
    .replace(/(new URL\(\s*['\"])(\.\.\/(?:vendor|assets\/fonts)\/[^'\"]+)(['\"]\s*,\s*import\.meta\.url\s*\))/g,(_,before,url,after)=>before+versioned(url)+after);
}

async function versionModuleTree(directory,revision){
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await versionModuleTree(file,revision);
    else if(entry.name.endsWith('.mjs'))await fs.writeFile(file,releaseModuleSource(await fs.readFile(file,'utf8'),revision));
  }
}

export async function buildSite({output=path.join(root,'_site'),revision=process.env.GITHUB_SHA||'local-development'}={}){
  await fs.mkdir(output,{recursive:true});
  const index=await fs.readFile(path.join(root,'index.html'),'utf8');
  await fs.writeFile(path.join(output,'index.html'),index
    .replace('href="styles.css"',`href="${releaseUrl('styles.css',revision)}"`)
    .replace('src="app.js"',`src="${releaseUrl('app.js',revision)}"`));
  for(const name of ['app.js','styles.css','print-preflight.mjs'])await fs.copyFile(path.join(root,name),path.join(output,name));
  for(const name of ['src','data'])await fs.cp(path.join(root,name),path.join(output,name),{recursive:true});
  await fs.writeFile(path.join(output,'app.js'),releaseModuleSource(await fs.readFile(path.join(output,'app.js'),'utf8'),revision));
  await fs.writeFile(path.join(output,'print-preflight.mjs'),releaseModuleSource(await fs.readFile(path.join(output,'print-preflight.mjs'),'utf8'),revision));
  await versionModuleTree(path.join(output,'src'),revision);
  await fs.mkdir(path.join(output,'vendor'),{recursive:true});
  await fs.mkdir(path.join(output,'assets/fonts'),{recursive:true});
  for(const [from,to] of [['node_modules/jspdf/dist/jspdf.umd.min.js','vendor/jspdf.umd.min.js'],['node_modules/jspdf/LICENSE','vendor/jspdf.LICENSE'],['assets/fonts/DejaVuSans.ttf','assets/fonts/DejaVuSans.ttf'],['assets/fonts/LICENSE.txt','assets/fonts/LICENSE.txt']])await fs.copyFile(path.join(root,from),path.join(output,to));
  await fs.writeFile(path.join(output,'version.json'),JSON.stringify({revision,builtAt:new Date().toISOString()},null,2));
  console.log('Pages source staged in '+output);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await buildSite();
