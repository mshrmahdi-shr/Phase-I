import {normalizeCompanyProfile,snapshotCompanyProfile,validateCompanyProfile} from './company-profile.mjs';

export function figureDefaults(){
  return {
    A:{title:'SITE LOCATION MAP',extentMeters:500,status:'Not Started'},
    B:{title:'CURRENT AERIAL / SITE PLAN',extentMeters:100,status:'Not Started'},
    C:{title:'TOPOGRAPHICAL MAP',extentMeters:1000,status:'Not Started'},
    D:{title:'SURFICIAL GEOLOGY',extentMeters:2000,status:'Not Started'},
    E:{title:'BEDROCK GEOLOGY',extentMeters:20000,status:'Not Started'}
  };
}

export function createProject({name='',projectNo='',address='',date='',company=''}={}){
  return {
    id: (globalThis.crypto?.randomUUID?.() || `p-${Date.now()}`),
    name, projectNo, address, date, company,
    location:null,
    siteBoundary:[], buildingBoundary:[], historical:[],
    geology:{surficial:null,bedrock:null},
    dpi:300,
    companyProfileSnapshot:null,
    exportPreferences:{codes:[],sources:{A:'osm',B:'esri-imagery',C:'toporama',D:'osm',E:'osm'}},
    figures:figureDefaults(),
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
  };
}

export function closeRing(points){
  if(!points?.length) return [];
  const out=points.map(p=>[Number(p[0]),Number(p[1])]);
  const a=out[0], b=out[out.length-1];
  if(a[0]!==b[0] || a[1]!==b[1]) out.push([...a]);
  return out;
}

function onSegment([x,y], [ax,ay], [bx,by]){
  const dx=bx-ax, dy=by-ay, length=Math.hypot(dx,dy);
  if(!length) return Math.hypot(x-ax,y-ay)<1e-10;
  return Math.abs((x-ax)*dy-(y-ay)*dx)<=1e-10*length &&
    x>=Math.min(ax,bx)-1e-10 && x<=Math.max(ax,bx)+1e-10 &&
    y>=Math.min(ay,by)-1e-10 && y<=Math.max(ay,by)+1e-10;
}

export function pointInPolygon(point, polygon, holes=[]){
  if(!Array.isArray(polygon)||polygon.length<3) return false;
  if(holes.some(h=>pointInPolygon(point,h))) return false;
  const [x,y]=point; let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [xi,yi]=polygon[i], [xj,yj]=polygon[j];
    if(onSegment(point,polygon[i],polygon[j])) return true;
    const intersects=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||Number.EPSILON)+xi);
    if(intersects) inside=!inside;
  }
  return inside;
}

export function validLocation(p){
  return Boolean(p && typeof p.lat==='number' && typeof p.lng==='number' &&
    Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat)<=90 && Math.abs(p.lng)<=180);
}

export function validFigureBounds(bounds,location=null){
  if(!bounds||typeof bounds!=='object'||Array.isArray(bounds))return false;
  const {north,south,east,west}=bounds;
  if(![north,south,east,west].every(Number.isFinite)||north<=south||east<=west||south< -85||north>85||west< -180||east>180)return false;
  return !location||(validLocation(location)&&location.lat>=south&&location.lat<=north&&location.lng>=west&&location.lng<=east);
}

// extentMeters is the minimum ground span; the longer sheet dimension adds context.
export function figureBounds(location,extentMeters){
  if(!validLocation(location)||Math.abs(location.lat)>85||!Number.isFinite(extentMeters)||extentMeters<=0) throw new Error('Set a valid SITE and figure extent.');
  const dLat=extentMeters/2/6371000*180/Math.PI;
  const dLng=dLat/Math.cos(location.lat*Math.PI/180);
  return {north:location.lat+dLat,south:location.lat-dLat,east:location.lng+dLng,west:location.lng-dLng};
}

export function restoreProject(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!value.figures) throw new Error('This file is not a Phase I project.');
  const p={...createProject(),...value};
  for(const key of ['name','projectNo','date','address']) if(typeof p[key]!=='string') throw new Error('Project fields must contain text.');
  if(p.location!==null&&!validLocation(p.location)) throw new Error('The project has invalid SITE coordinates.');
  for(const key of ['siteBoundary','buildingBoundary']) if(!Array.isArray(p[key])||(p[key].length&&!validBoundary(p[key]))) throw new Error('The project contains an invalid boundary.');
  if(!Array.isArray(p.historical)) throw new Error('The project has an invalid aerial image list.');
  p.figures=Object.fromEntries(Object.entries(figureDefaults()).map(([code,defaults])=>{
    const f={...defaults,...value.figures[code]};
    if(typeof f.title!=='string'||!Number.isFinite(f.extentMeters)||f.extentMeters<=0) throw new Error('The project contains invalid figure settings.');
    if(f.bounds!=null&&!validFigureBounds(f.bounds,p.location))throw new Error(`Figure ${code} has an invalid saved figure view.`);
    if(code==='B'&&(value.schemaVersion==null||value.schemaVersion<3)&&f.extentMeters===250) f.extentMeters=100;
    return [code,f];
  }));
  p.geology={surficial:null,bedrock:null,...(p.geology&&typeof p.geology==='object'?p.geology:{})};
  for(const kind of ['surficial','bedrock']){
    const metadata=p.geology[kind];
    if(!metadata?.source&&typeof metadata?.name==='string'&&/\.km[zl]$/i.test(metadata.name)){
      p.geology[kind]={...metadata,source:{id:'custom',name:`Custom import: ${metadata.name}`}};
    }
  }
  const savedCodes=Array.isArray(value.exportPreferences?.codes)?value.exportPreferences.codes:[];
  p.exportPreferences={codes:Object.keys(figureDefaults()).filter(code=>savedCodes.includes(code)),
    sources:{A:'osm',B:'esri-imagery',C:'toporama',D:'osm',E:'osm'}};
  if(value.companyProfileSnapshot==null){
    p.companyProfileSnapshot=null;
  }else{
    try{
      const profile=normalizeCompanyProfile(value.companyProfileSnapshot);
      if(validateCompanyProfile(profile).length) throw new Error('missing required company profile fields');
      p.companyProfileSnapshot=snapshotCompanyProfile(profile);
    }catch(error){
      throw new Error(`The project contains an invalid company profile snapshot: ${error.message}`);
    }
  }
  p.schemaVersion=4;
  return p;
}

export function validBoundary(ring){
  if(!Array.isArray(ring)||ring.length<4||ring.length>5000) return false;
  if(!ring.every(p=>Array.isArray(p)&&p.length>=2&&validLocation({lng:p[0],lat:p[1]}))) return false;
  const [x,y]=ring[0], last=ring.at(-1);
  if(x!==last[0]||y!==last[1]) return false;
  const vertices=ring.slice(0,-1);
  if(new Set(vertices.map(p=>p.join(','))).size!==vertices.length) return false;
  let area=0;
  for(let i=0;i<ring.length-1;i++) area+=(ring[i][0]-x)*(ring[i+1][1]-y)-(ring[i+1][0]-x)*(ring[i][1]-y);
  if(Math.abs(area)<1e-14) return false;
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let i=0;i<vertices.length;i++) for(let j=i+2;j<vertices.length;j++){
    if(i===0&&j===vertices.length-1) continue;
    const a=ring[i],b=ring[i+1],c=ring[j],d=ring[j+1];
    if(onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b)||
      (cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)) return false;
  }
  return true;
}

function dxfPolyline(layer, points){
  if(!points?.length) return '';
  const ring=closeRing(points);
  let s=`0\nLWPOLYLINE\n8\n${layer}\n90\n${ring.length}\n70\n1\n`;
  for(const [x,y] of ring) s+=`10\n${x}\n20\n${y}\n`;
  return s;
}

export function buildDxf({siteBoundary=[],buildingBoundary=[]}={}){
  return `0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${dxfPolyline('SITE_BOUNDARY',siteBoundary)}${dxfPolyline('BUILDING_BOUNDARY',buildingBoundary)}0\nENDSEC\n0\nEOF\n`;
}

const MRD128_LEGEND = {
  '21': {title:'Man-made deposits', detail:'Fill, sewage lagoon, landfill, urban development', color:'#6c2893'},
  '20': {title:'Organic deposits', detail:'Peat, muck, marl', color:'#b2b1b1'},
  '19': {title:'Modern alluvial deposits', detail:'Clay, silt, sand, gravel, may contain organic remains', color:'#b9652d'},
  '18': {title:'Colluvial deposits', detail:'Boulders, scree, talus, undifferentiated landslide materials', color:'#811d8f'},
  '17': {title:'Eolian deposits', detail:'Fine to very fine sand and silt', color:'#f7f2b8'},
  '16': {title:'Coarse-textured marine deposits', detail:'Sand, gravel, minor silt and clay', color:'#e9d613'},
  '16a': {title:'Coarse-textured marine deposits', detail:'Deltaic deposits', color:'#e9d613'},
  '16b': {title:'Coarse-textured marine deposits', detail:'Littoral deposits', color:'#e9d613'},
  '16c': {title:'Coarse-textured marine deposits', detail:'Foreshore and basinal deposits', color:'#e9d613'},
  '15': {title:'Fine-textured marine deposits', detail:'Silt and clay, minor sand and gravel', color:'#2e3696'},
  '14': {title:'Coarse-textured lacustrine deposits', detail:'Sand, gravel, minor silt and clay', color:'#f4ea18'},
  '14a': {title:'Coarse-textured lacustrine deposits', detail:'Deltaic deposit', color:'#f4ea18'},
  '14b': {title:'Coarse-textured lacustrine deposits', detail:'Littoral deposits', color:'#f4ea18'},
  '14c': {title:'Coarse-textured lacustrine deposits', detail:'Foreshore and basinal deposits', color:'#f4ea18'},
  '13': {title:'Fine-textured lacustrine deposits', detail:'Silt and clay, minor sand and gravel', color:'#4bbab6'},
  '12': {title:'Older alluvial deposits', detail:'Clay, silt, sand, gravel, may contain organic remains', color:'#b9652d'},
  '11': {title:'Coarse-textured glaciomarine deposits', detail:'Sand, gravel, minor silt and clay', color:'#e9d613'},
  '11a': {title:'Coarse-textured glaciomarine deposits', detail:'Deltaic deposits', color:'#e9d613'},
  '11b': {title:'Coarse-textured glaciomarine deposits', detail:'Littoral deposits', color:'#e9d613'},
  '11c': {title:'Coarse-textured glaciomarine deposits', detail:'Foreshore and basinal deposits', color:'#e9d613'},
  '10': {title:'Fine-textured glaciomarine deposits', detail:'Silt and clay, minor sand and gravel', color:'#57c7c6'},
  '10a': {title:'Fine-textured glaciomarine deposits', detail:'Massive to well laminated', color:'#57c7c6'},
  '10b': {title:'Fine-textured glaciomarine deposits', detail:'Interbedded silt and clay and gritty, pebbly flow till and rainout deposits', color:'#57c7c6'},
  '9': {title:'Coarse-textured glaciolacustrine deposits', detail:'Sand, gravel, minor silt and clay', color:'#f4ea18'},
  '9a': {title:'Coarse-textured glaciolacustrine deposits', detail:'Deltaic deposits', color:'#f4ea18'},
  '9b': {title:'Coarse-textured glaciolacustrine deposits', detail:'Littoral deposits', color:'#f4ea18'},
  '9c': {title:'Coarse-textured glaciolacustrine deposits', detail:'Foreshore and basinal deposits', color:'#f4ea18'},
  '8': {title:'Fine-textured glaciolacustrine deposits', detail:'Silt and clay, minor sand and gravel', color:'#9eded4'},
  '8a': {title:'Fine-textured glaciolacustrine deposits', detail:'Massive to well laminated', color:'#9eded4'},
  '8b': {title:'Fine-textured glaciolacustrine deposits', detail:'Interbedded silt and clay and gritty, pebbly flow till and rainout deposits', color:'#9eded4'},
  '7': {title:'Glaciofluvial deposits', detail:'River deposits and delta topset facies', color:'#fad465'},
  '7a': {title:'Glaciofluvial deposits', detail:'Sandy deposits', color:'#fad465'},
  '7b': {title:'Glaciofluvial deposits', detail:'Gravelly deposits', color:'#fad465'},
  '6': {title:'Ice-contact stratified deposits', detail:'Sand and gravel, minor silt, clay and till', color:'#f69c19'},
  '6a': {title:'Ice-contact stratified deposits', detail:'In moraines, eskers, kames and crevasse fills', color:'#f69c19'},
  '6b': {title:'Ice-contact stratified deposits', detail:'In subaquatic fans', color:'#f69c19'},
  '5': {title:'Till', detail:'Silty sand to sand-textured till on Precambrian terrain', color:'#9cd867'},
  '5a': {title:'Till', detail:'Silty sand to sand-textured till on Precambrian terrain', color:'#9cd867'},
  '5b': {title:'Till', detail:'Stone-poor, sandy silt to silty sand-textured till on Paleozoic terrain', color:'#8fcc26'},
  '5c': {title:'Till', detail:'Stony, sandy silt to silty sand-textured till on Paleozoic terrain', color:'#94d226'},
  '5d': {title:'Till', detail:'Clay to silt-textured till (derived from glaciolacustrine deposits or shale)', color:'#2aad43'},
  '5e': {title:'Till', detail:'Undifferentiated older tills, may include stratified deposits', color:'#219b45'},
  '4': {title:'Bedrock-drift complex in Paleozoic terrain', detail:'', color:'#d390cc'},
  '4a': {title:'Bedrock-drift complex in Paleozoic terrain', detail:'Primarily till cover', color:'#d390cc'},
  '4b': {title:'Bedrock-drift complex in Paleozoic terrain', detail:'Primarily stratified drift cover', color:'#d390cc'},
  '3': {title:'Paleozoic bedrock', detail:'Sedimentary (Paleozoic) bedrock', color:'#d390cc'},
  '2': {title:'Bedrock-drift complex in Precambrian terrain', detail:'', color:'#f8bec4'},
  '2a': {title:'Bedrock-drift complex in Precambrian terrain', detail:'Primarily till cover', color:'#f8bec4'},
  '2b': {title:'Bedrock-drift complex in Precambrian terrain', detail:'Primarily stratified drift cover', color:'#f8bec4'},
  '1': {title:'Precambrian bedrock', detail:'Precambrian bedrock', color:'#f8bec4'}
};

export function extractNetworkLinks(kml=''){
  const links=[];
  const re=/<NetworkLink\b[\s\S]*?<\/NetworkLink>/gi;
  for(const block of kml.match(re)||[]){
    const name=(block.match(/<name>([\s\S]*?)<\/name>/i)?.[1]||'').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const href=(block.match(/<href>([\s\S]*?)<\/href>/i)?.[1]||'').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    if(href) links.push({name,href});
  }
  return links;
}

export function normalizeMrd128Unit(value=''){
  const text=String(value).trim().toLowerCase();
  const match=text.match(/(?:^|\b)(21|20|19|18|17|16[abc]?|15|14[abc]?|13|12|11[abc]?|10[ab]?|9[abc]?|8[ab]?|7[ab]?|6[ab]?|5[abcde]?|4[ab]?|3|2[ab]?|1)(?=\b|[^a-z0-9])/i);
  return match ? match[1].toLowerCase() : null;
}

export function getMrd128Legend(unit){
  const code=normalizeMrd128Unit(unit);
  if(!code||!MRD128_LEGEND[code]) return null;
  const parent=code.replace(/[a-z]$/,'');
  return {code,...MRD128_LEGEND[code],material:parent!==code&&parent!=='5'?MRD128_LEGEND[parent]?.detail||'':''};
}

export function listMrd128Legend(){
  return Object.entries(MRD128_LEGEND).map(([code,v])=>({code,...v}));
}

export function kmlColorToCss(kmlColor=''){
  const s=String(kmlColor).trim().replace(/^#/,'');
  if(!/^[0-9a-f]{8}$/i.test(s)) return null;
  const aa=s.slice(0,2), bb=s.slice(2,4), gg=s.slice(4,6), rr=s.slice(6,8);
  return {color:`#${rr}${gg}${bb}`.toLowerCase(), opacity:parseInt(aa,16)/255};
}
