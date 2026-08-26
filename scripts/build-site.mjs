import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));

export async function buildSite({output=path.join(root,'_site'),revision=process.env.GITHUB_SHA||'local-development'}={}){
  await fs.mkdir(output,{recursive:true});
  for(const name of ['index.html','app.js','styles.css','print-preflight.mjs'])await fs.copyFile(path.join(root,name),path.join(output,name));
  for(const name of ['src','data'])await fs.cp(path.join(root,name),path.join(output,name),{recursive:true});
  await fs.mkdir(path.join(output,'vendor'),{recursive:true});
  await fs.mkdir(path.join(output,'assets/fonts'),{recursive:true});
  for(const [from,to] of [['node_modules/jspdf/dist/jspdf.umd.min.js','vendor/jspdf.umd.min.js'],['node_modules/jspdf/LICENSE','vendor/jspdf.LICENSE'],['assets/fonts/DejaVuSans.ttf','assets/fonts/DejaVuSans.ttf'],['assets/fonts/LICENSE.txt','assets/fonts/LICENSE.txt']])await fs.copyFile(path.join(root,from),path.join(output,to));
  await fs.writeFile(path.join(output,'version.json'),JSON.stringify({revision,builtAt:new Date().toISOString()},null,2));
  console.log('Pages source staged in '+output);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await buildSite();
