import fs from 'node:fs/promises';
import path from 'node:path';
import { extractHrefValues, cachePathForMrd128Url, rewriteKmlLinks, assertCompleteCache } from '../src/mrd128-cache.mjs';

const ROOT='https://www.geologyontario.mndm.gov.on.ca/mines/data/google/mrd128/polygons/doc.kml';
const MAX_DOCS=600;
const BATCH=8;
const queue=[ROOT];
const seen=new Set();
let saved=0, failed=0;

async function fetchOfficial(url){
  const candidates=[];
  const u=new URL(url);
  if(u.protocol==='http:'){const v=new URL(u);v.protocol='https:';candidates.push(v.href)}
  candidates.push(u.href);
  if(u.protocol==='https:'){const v=new URL(u);v.protocol='http:';candidates.push(v.href)}
  let last;
  for(const candidate of [...new Set(candidates)]){
    try{
      const r=await fetch(candidate,{redirect:'follow',signal:AbortSignal.timeout(10000),headers:{'user-agent':'Phase-I-ESA-MRD128-cache/1.0','accept':'application/vnd.google-earth.kml+xml,application/xml,text/xml,*/*'}});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return {response:r,url:candidate};
    }catch(e){last=e}
  }
  throw last||new Error('Fetch failed');
}

async function mirrorOne(requested){
  if(seen.has(requested) || seen.size>=MAX_DOCS) return [];
  seen.add(requested);
  try{
    const {response,url}=await fetchOfficial(requested);
    const isKmz=/\.kmz(?:$|\?)/i.test(url);
    const outPath=cachePathForMrd128Url(url);
    await fs.mkdir(path.dirname(outPath),{recursive:true});
    if(isKmz){
      await fs.writeFile(outPath,Buffer.from(await response.arrayBuffer()));
      saved++;
      return [];
    }
    const text=await response.text();
    await fs.writeFile(outPath,rewriteKmlLinks(text,url),'utf8');
    saved++;
    const children=[];
    for(const href of extractHrefValues(text)){
      let child;
      try{child=new URL(href,url)}catch{continue}
      const p=child.pathname.toLowerCase();
      if(!p.includes('/mines/data/google/mrd128/polygons/')) continue;
      if(!/\.(?:kml|kmz)$/i.test(p)) continue;
      if(!seen.has(child.href)) children.push(child.href);
    }
    return children;
  }catch(e){
    failed++;
    console.warn(`MRD128 mirror skipped ${requested}: ${e.message}`);
    if(requested===ROOT) throw e;
    return [];
  }
}

while(queue.length && seen.size<MAX_DOCS){
  const batch=queue.splice(0,BATCH);
  const results=await Promise.all(batch.map(mirrorOne));
  for(const children of results) for(const child of children) if(!seen.has(child) && queue.length<MAX_DOCS) queue.push(child);
}

assertCompleteCache({saved,failed,pending:queue.length});

try{
  const indexPath='data/mrd128.kml';
  let index=await fs.readFile(indexPath,'utf8');
  index=index.replace(/https?:\/\/www\.geologyontario\.mndm\.gov\.on\.ca\/mines\/data\/google\/mrd128\/polygons\/doc\.kml/gi,'../mrd128-cache/polygons/doc.kml');
  await fs.writeFile(indexPath,index,'utf8');
}catch(e){
  throw new Error(`Could not prepare local MRD128 index: ${e.message}`);
}

await fs.mkdir('mrd128-cache',{recursive:true});
await fs.writeFile('mrd128-cache/status.json',JSON.stringify({source:'Ontario Geological Survey MRD128-REV',root:ROOT,files:saved,failed,cachedAt:new Date().toISOString()},null,2));
console.log(`MRD128 cache ready: ${saved} file(s), ${failed} skipped`);
