import fs from 'node:fs/promises';
import path from 'node:path';
import { extractHrefValues, cachePathForMrd128Url, rewriteKmlLinks } from '../src/mrd128-cache.mjs';

const ROOT='https://www.geologyontario.mndm.gov.on.ca/mines/data/google/mrd128/polygons/doc.kml';
const MAX_DOCS=1200;
const queue=[ROOT];
const seen=new Set();
let saved=0;

async function fetchOfficial(url){
  const candidates=[];
  const u=new URL(url);
  if(u.protocol==='http:'){const v=new URL(u);v.protocol='https:';candidates.push(v.href)}
  candidates.push(u.href);
  if(u.protocol==='https:'){const v=new URL(u);v.protocol='http:';candidates.push(v.href)}
  let last;
  for(const candidate of [...new Set(candidates)]){
    try{
      const r=await fetch(candidate,{redirect:'follow',headers:{'user-agent':'Phase-I-ESA-MRD128-cache/1.0','accept':'application/vnd.google-earth.kml+xml,application/xml,text/xml,*/*'}});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return {response:r,url:candidate};
    }catch(e){last=e}
  }
  throw last||new Error('Fetch failed');
}

while(queue.length && seen.size<MAX_DOCS){
  const requested=queue.shift();
  if(seen.has(requested)) continue;
  seen.add(requested);
  const {response,url}=await fetchOfficial(requested);
  const isKmz=/\.kmz(?:$|\?)/i.test(url);
  const outPath=cachePathForMrd128Url(url);
  await fs.mkdir(path.dirname(outPath),{recursive:true});
  if(isKmz){
    await fs.writeFile(outPath,Buffer.from(await response.arrayBuffer()));
    saved++;
    continue;
  }
  const text=await response.text();
  const rewritten=rewriteKmlLinks(text,url);
  await fs.writeFile(outPath,rewritten,'utf8');
  saved++;
  for(const href of extractHrefValues(text)){
    let child;
    try{child=new URL(href,url)}catch{continue}
    const p=child.pathname.toLowerCase();
    if(!p.includes('/mines/data/google/mrd128/polygons/')) continue;
    if(!/\.(?:kml|kmz)$/i.test(p)) continue;
    if(!seen.has(child.href)) queue.push(child.href);
  }
}

await fs.mkdir('mrd128-cache',{recursive:true});
await fs.writeFile('mrd128-cache/status.json',JSON.stringify({source:'Ontario Geological Survey MRD128-REV',root:ROOT,files:saved,cachedAt:new Date().toISOString()},null,2));
console.log(`MRD128 cache ready: ${saved} file(s)`);
