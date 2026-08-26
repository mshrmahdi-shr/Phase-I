import {closeRing,normalizeMrd128Unit,getMrd128Legend,kmlColorToCss,pointInPolygon,validLocation} from './core.mjs';
import {shouldFollowSurficialLink} from './mrd128-cache.mjs';

function xml(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror')||doc.documentElement.localName!=='kml') throw new Error('The file is not valid KML/XML.');
  return doc;
}
function strip(text){
  const doc=new DOMParser().parseFromString(text,'text/html');
  doc.querySelectorAll('script,style').forEach(e=>e.remove());
  return (doc.body.textContent||'').replace(/\s+/g,' ').trim();
}
function coordinates(node){
  if(!node) return [];
  const points=node.textContent.trim().split(/\s+/).map(v=>v.split(',')).filter(v=>
    v.length>=2&&v[0].trim()!==''&&v[1].trim()!==''&&validLocation({lng:Number(v[0]),lat:Number(v[1])})
  ).map(v=>[Number(v[0]),Number(v[1])]);
  return new Set(points.map(p=>p.join(','))).size>=3?closeRing(points):[];
}

export function parsePolys(text,kind='surficial'){
  const doc=xml(text),styles=new Map(),styleMaps=new Map();
  for(const s of doc.querySelectorAll('Style[id]')){
    const c=kmlColorToCss(s.querySelector('PolyStyle color')?.textContent||'');
    if(c) styles.set(s.id,c);
  }
  for(const sm of doc.querySelectorAll('StyleMap[id]')){
    const pair=[...sm.querySelectorAll('Pair')].find(p=>p.querySelector('key')?.textContent.trim()==='normal');
    styleMaps.set(sm.id,pair?.querySelector('styleUrl')?.textContent.trim().replace(/^#/,''));
  }
  function style(id,seen=new Set()){
    if(seen.has(id)) return null;
    seen.add(id);
    return styles.get(id)||(styleMaps.has(id)?style(styleMaps.get(id),seen):null);
  }
  const out=[];
  for(const pm of doc.querySelectorAll('Placemark')){
    const name=pm.querySelector(':scope > name')?.textContent.trim()||'Geology unit';
    const description=strip(pm.querySelector(':scope > description')?.textContent||'');
    const props={};
    for(const p of pm.querySelectorAll('ExtendedData Data, ExtendedData SimpleData')){
      props[(p.getAttribute('name')||'').toLowerCase()]=p.querySelector('value')?.textContent.trim()||p.textContent.trim();
    }
    const candidate=props.unit_code||props.unit||props.sgu||props.map_unit||name;
    const code=kind==='surficial'?normalizeMrd128Unit(candidate):null;
    const official=code?getMrd128Legend(code):null;
    const inline=kmlColorToCss(pm.querySelector(':scope > Style PolyStyle color')?.textContent||'');
    const sourceStyle=inline||style(pm.querySelector(':scope > styleUrl')?.textContent.trim().replace(/^#/,'')||'');
    for(const polygon of pm.querySelectorAll('Polygon')){
      const outer=coordinates(polygon.querySelector('outerBoundaryIs LinearRing coordinates'));
      if(!outer.length) continue;
      const inner=[...polygon.querySelectorAll('innerBoundaryIs LinearRing coordinates')].map(coordinates);
      if(inner.some(r=>!r.length)) throw new Error('A geology polygon has an invalid inner boundary.');
      out.push({name:official?`${code.toUpperCase()} — ${official.title}`:name,
        description:official?[...new Set([official.material,official.detail].filter(Boolean))].join('; '):description,
        unitCode:code||(props.unit_code||props.unit||null),official,polygon:outer,holes:inner,
        color:official?.color||sourceStyle?.color||'#5fa8d3',fillOpacity:official?.color?0.6:(sourceStyle?.opacity??0.5)});
    }
  }
  return out;
}

export function netLinks(text){
  return [...xml(text).querySelectorAll('NetworkLink')].map(n=>{
    const box=n.querySelector('Region LatLonAltBox, LatLonAltBox');
    const values=['north','south','east','west'].map(k=>box?.querySelector(k)?.textContent.trim());
    const bounds=values.every(v=>v!==undefined&&v!==''&&Number.isFinite(Number(v)))?
      Object.fromEntries(['north','south','east','west'].map((k,i)=>[k,Number(values[i])])):null;
    return {name:n.querySelector(':scope > name')?.textContent.trim()||'',href:n.querySelector('Link href, Url href, href')?.textContent.trim()||'',bounds};
  }).filter(l=>l.href);
}
export function intersects(a,b){return !a||!b||(a.west<=b.east&&a.east>=b.west&&a.south<=b.north&&a.north>=b.south);}
export function containsBounds(outer,inner){return !outer||(outer.west<=inner.west&&outer.east>=inner.east&&outer.south<=inner.south&&outer.north>=inner.north);}
function featureBounds(g){
  const b={west:Infinity,east:-Infinity,south:Infinity,north:-Infinity};
  for(const [x,y] of g.polygon){b.west=Math.min(b.west,x);b.east=Math.max(b.east,x);b.south=Math.min(b.south,y);b.north=Math.max(b.north,y);}
  return b;
}
function segmentIntersects(a,b,r){
  let t0=0,t1=1; const dx=b[0]-a[0],dy=b[1]-a[1];
  for(const [p,q] of [[-dx,a[0]-r.west],[dx,r.east-a[0]],[-dy,a[1]-r.south],[dy,r.north-a[1]]]){
    if(p===0){if(q<0)return false;continue;}
    const t=q/p;if(p<0)t0=Math.max(t0,t);else t1=Math.min(t1,t);
    if(t0>t1)return false;
  }
  return true;
}
export function relevantFeatures(features,bounds){
  if(!bounds)return features;
  const corners=[[bounds.west,bounds.south],[bounds.east,bounds.south],[bounds.east,bounds.north],[bounds.west,bounds.north]];
  return features.filter(g=>intersects(featureBounds(g),bounds)&&(
    corners.some(p=>pointInPolygon(p,g.polygon,g.holes))||
    [g.polygon,...(g.holes||[])].some(ring=>ring.some((p,i)=>i>0&&segmentIntersects(ring[i-1],p,bounds)))));
}
export function relevantUnits(features,bounds){return [...new Map(relevantFeatures(features,bounds).map(g=>[g.unitCode||g.name,g])).values()];}
export function siteFeature(features,location){
  if(!validLocation(location))return null;
  return features.find(g=>pointInPolygon([location.lng,location.lat],g.polygon,g.holes))||null;
}
export async function readKmz(input,JSZip){
  const zip=await JSZip.loadAsync(input);
  const files=Object.values(zip.files).filter(f=>!f.dir&&/\.kml$/i.test(f.name));
  const main=files.find(f=>f.name.toLowerCase()==='doc.kml')||files[0];
  if(!main)throw new Error('No KML document was found in this KMZ file.');
  return main.async('text');
}
export async function resolveLinks({text,base,cacheRoot,kind='surficial',bounds,fetchFn=fetch,JSZip,progress=()=>{}}){
  const queue=[{text,url:base,depth:0}],seen=new Set([base]);
  const features=parsePolys(text,kind);let docs=1;const cache=new URL(cacheRoot);
  while(queue.length){
    const current=queue.shift();
    for(const link of netLinks(current.text)){
      if(!intersects(link.bounds,bounds))continue;
      const url=new URL(link.href,current.url);
      if(kind==='surficial'&&!shouldFollowSurficialLink({...link,href:url.href}))continue;
      const marker='/mines/data/google/mrd128/polygons/';
      if(/(^|\.)geologyontario\./i.test(url.hostname)&&url.pathname.includes(marker)) url.href=new URL('polygons/'+url.pathname.split(marker)[1],cache).href;
      if(url.origin!==cache.origin||!url.pathname.startsWith(cache.pathname+'polygons/')) throw new Error('MRD128 must load from the local deployment cache.');
      if(seen.has(url.href))continue;
      if(current.depth>=6||docs>=150)throw new Error('The geology file contains too many nested links.');
      seen.add(url.href);progress(`Loading local geology section ${docs}…`);
      const response=await fetchFn(url.href,{signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(`Cached geology section is unavailable (HTTP ${response.status}).`);
      const child=/\.kmz$/i.test(url.pathname)?await readKmz(await response.arrayBuffer(),JSZip):await response.text();
      docs++;features.push(...parsePolys(child,kind));queue.push({text:child,url:url.href,depth:current.depth+1});
    }
  }
  return {features,docs};
}
