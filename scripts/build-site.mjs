import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));

export async function buildSite({output=path.join(root,'_site'),revision=process.env.GITHUB_SHA||'local-development'}={}){
  await fs.mkdir(output,{recursive:true});
  for(const name of ['index.html','app.js','styles.css','print-preflight.mjs'])await fs.copyFile(path.join(root,name),path.join(output,name));
  for(const name of ['src','data'])await fs.cp(path.join(root,name),path.join(output,name),{recursive:true});
  await fs.writeFile(path.join(output,'version.json'),JSON.stringify({revision,builtAt:new Date().toISOString()},null,2));
  console.log('Pages source staged in '+output);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await buildSite();
