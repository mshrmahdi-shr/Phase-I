import {normalizeCompanyProfile,snapshotCompanyProfile,validateCompanyProfile} from './company-profile.mjs';
import {projectWebMercator,validatePlacement} from './imagery/placement.mjs';
import {validateProviderUrl} from './imagery/provider-registry.mjs';

const HISTORICAL_FIELDS=['id','year','sequence','title','mode','providerId','sourceUrl','licenseUrl','attribution','policy','resolutionMeters','bounds','placement','assetId','officialExport','createdAt','updatedAt'];
const LEGACY_HISTORICAL_FIELDS=['id','year','name','size','dataUrl'];
const HISTORICAL_BOUNDS_FIELDS=['north','south','east','west'];
const LEGACY_OFFICIAL_EXPORT_FIELDS=['kind','url','layer','maxWidth','maxHeight'];
const OFFICIAL_EXPORT_FIELDS=[...LEGACY_OFFICIAL_EXPORT_FIELDS,'resultId','coverage','preview'];
const OFFICIAL_PREVIEW_FIELDS=['kind','url','layer','tileTemplate'];
const PLACEMENT_FIELDS=['center','groundWidth','groundHeight','sourceWidth','sourceHeight','rotationDegrees'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID=/^[a-z][a-z0-9-]{0,63}$/;
const KIND=/^[a-z][a-z0-9-]{0,63}$/;
const RESULT_ID=/^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
export const HISTORICAL_A3_RATIO=420/297;
// 100 ppm is wider than JSON/double round-trip error while rejecting any visible crop distortion.
export const HISTORICAL_A3_ASPECT_TOLERANCE=1e-4;

function exactRecord(value,fields,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be a plain record.`);
  let prototype,keys;try{prototype=Object.getPrototypeOf(value);keys=Reflect.ownKeys(value);}catch{throw new Error(`${label} must be inspectable.`);}
  if(prototype!==Object.prototype&&prototype!==null||keys.some(key=>typeof key==='symbol'))throw new Error(`${label} must be a plain record.`);
  const strings=keys.filter(key=>typeof key==='string');
  if(strings.length!==fields.length||strings.some(key=>!fields.includes(key))||fields.some(key=>!strings.includes(key)))throw new Error(`${label} must have exact fields.`);
  const copy={};
  for(const key of fields){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)throw new Error(`${label}.${key} must be an enumerable data field.`);copy[key]=descriptor.value;}
  return copy;
}

function historicalText(value,label,{maximum=1000,nullable=false}={}){
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||!value.trim()||value.length>maximum||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`${label} must be nonempty bounded text.`);
  return value.trim();
}

function historicalYear(value,label='Historical imagery year'){
  const maximum=new Date().getUTCFullYear();
  if(!Number.isInteger(value)||value<1850||value>maximum)throw new Error(`${label} must be a four-digit integer from 1850 through ${maximum}.`);
  return value;
}

function safeHistoricalUrl(value,label,{nullable=false}={}){
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||!value.trim()||value.length>8192||value.startsWith('//')||/[\u0000-\u001f\u007f\\]/.test(value))throw new Error(`${label} must be a safe HTTPS URL.`);
  try{validateProviderUrl(value,null,{label});}catch(error){throw new Error(`${label} must be a safe HTTPS URL: ${error.message}`);}
  let url;try{url=new URL(value);}catch{throw new Error(`${label} must be a safe HTTPS URL.`);}
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error(`${label} must be a safe HTTPS URL.`);
  return url.href;
}

function historicalBounds(value,location){
  const fields=exactRecord(value,HISTORICAL_BOUNDS_FIELDS,'Historical imagery bounds');
  const bounds={north:fields.north,south:fields.south,east:fields.east,west:fields.west};
  if(!validFigureBounds(bounds,location))throw new Error('Historical imagery bounds are invalid or do not contain SITE.');
  if(!validHistoricalA3Bounds(bounds))throw new Error('Historical imagery bounds must retain the approved projected A3 landscape crop aspect. Reopen the crop editor and approve the image again.');
  return bounds;
}

function historicalPlacement(value,location){
  const fields=exactRecord(value,PLACEMENT_FIELDS,'Historical imagery placement');
  if(!Array.isArray(fields.center)||fields.center.length!==2)throw new Error('Historical imagery placement centre is invalid.');
  const placement={center:[...fields.center],groundWidth:fields.groundWidth,groundHeight:fields.groundHeight,
    sourceWidth:fields.sourceWidth,sourceHeight:fields.sourceHeight,rotationDegrees:fields.rotationDegrees};
  try{validatePlacement(placement,{location});}catch(error){throw new Error(`Historical imagery placement is invalid: ${error.message}`);}
  return placement;
}

function historicalTimestamp(value,label){
  if(typeof value!=='string'||value.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||Number.isNaN(Date.parse(value)))throw new Error(`${label} must be an ISO timestamp.`);
  return value;
}

function officialExport(value){
  let keyCount;try{keyCount=Reflect.ownKeys(value).length;}catch{throw new Error('Historical imagery official export must be inspectable.');}
  const legacy=keyCount===LEGACY_OFFICIAL_EXPORT_FIELDS.length,fields=exactRecord(value,legacy?LEGACY_OFFICIAL_EXPORT_FIELDS:OFFICIAL_EXPORT_FIELDS,'Historical imagery official export');
  if(typeof fields.kind!=='string'||!KIND.test(fields.kind))throw new Error('Historical imagery official export kind is invalid.');
  const layer=fields.layer;
  if(layer!==null&&!(typeof layer==='string'&&layer.trim())&&!(Number.isInteger(layer)&&layer>=0))throw new Error('Historical imagery official export layer is invalid.');
  for(const key of ['maxWidth','maxHeight'])if(!Number.isSafeInteger(fields[key])||fields[key]<=0||fields[key]>32767)throw new Error(`Historical imagery official export ${key} is invalid.`);
  const base={kind:fields.kind,url:safeHistoricalUrl(fields.url,'Historical imagery official export URL'),layer,maxWidth:fields.maxWidth,maxHeight:fields.maxHeight};
  if(legacy)return {...base,resultId:null,coverage:null,preview:null};
  if(fields.resultId===null&&fields.coverage===null&&fields.preview===null)return {...base,resultId:null,coverage:null,preview:null};
  if(typeof fields.resultId!=='string'||!RESULT_ID.test(fields.resultId))throw new Error('Historical imagery official result ID is invalid.');
  const coverageFields=exactRecord(fields.coverage,HISTORICAL_BOUNDS_FIELDS,'Historical imagery official source coverage'),coverage={north:coverageFields.north,south:coverageFields.south,east:coverageFields.east,west:coverageFields.west};
  if(!validFigureBounds(coverage))throw new Error('Historical imagery official source coverage is invalid.');
  const previewFields=exactRecord(fields.preview,OFFICIAL_PREVIEW_FIELDS,'Historical imagery official preview');
  if(typeof previewFields.kind!=='string'||!KIND.test(previewFields.kind))throw new Error('Historical imagery official preview kind is invalid.');
  const previewLayer=previewFields.layer;if(previewLayer!==null&&!(typeof previewLayer==='string'&&previewLayer.trim())&&!(Number.isInteger(previewLayer)&&previewLayer>=0))throw new Error('Historical imagery official preview layer is invalid.');
  let tileTemplate=null;if(previewFields.tileTemplate!==null){validateProviderUrl(previewFields.tileTemplate,null,{label:'Historical imagery official preview tile URL',template:true});tileTemplate=previewFields.tileTemplate;}
  return {...base,resultId:fields.resultId,coverage,preview:{kind:previewFields.kind,url:safeHistoricalUrl(previewFields.url,'Historical imagery official preview URL'),layer:previewLayer,tileTemplate}};
}

function approvedHistoricalItem(value,location){
  const fields=exactRecord(value,HISTORICAL_FIELDS,'Historical imagery item');
  if(typeof fields.id!=='string'||!UUID.test(fields.id))throw new Error('Historical imagery item ID must be a UUID.');
  const year=historicalYear(fields.year);
  if(!Number.isSafeInteger(fields.sequence)||fields.sequence<=0||fields.sequence>1_000_000)throw new Error('Historical imagery sequence must be a positive stable integer.');
  const mode=fields.mode;if(mode!=='official'&&mode!=='manual')throw new Error('Historical imagery mode must be official or manual.');
  if(fields.policy!=='exportable')throw new Error('Approved historical imagery policy must be exportable.');
  if(fields.resolutionMeters!==null&&(!(fields.resolutionMeters>0)||!Number.isFinite(fields.resolutionMeters)))throw new Error('Historical imagery resolution must be positive or null.');
  const common={id:fields.id,year,sequence:fields.sequence,title:historicalText(fields.title,'Historical imagery title',{maximum:240}),mode,
    attribution:historicalText(fields.attribution,'Historical imagery attribution'),policy:'exportable',resolutionMeters:fields.resolutionMeters,
    bounds:historicalBounds(fields.bounds,location),createdAt:historicalTimestamp(fields.createdAt,'Historical imagery createdAt'),updatedAt:historicalTimestamp(fields.updatedAt,'Historical imagery updatedAt')};
  if(Date.parse(common.updatedAt)<Date.parse(common.createdAt))throw new Error('Historical imagery updatedAt cannot precede createdAt.');
  if(mode==='official'){
    if(typeof fields.providerId!=='string'||!PROVIDER_ID.test(fields.providerId))throw new Error('Official historical imagery provider ID is invalid.');
    if(fields.placement!==null||fields.assetId!==null)throw new Error('Official historical imagery cannot contain manual placement or asset fields.');
    const snapshot=officialExport(fields.officialExport);
    if(snapshot.resultId!==null&&!snapshot.resultId.startsWith(`${fields.providerId}:`))throw new Error('Historical imagery official result ID does not match its provider.');
    if(snapshot.coverage&&(common.bounds.west<snapshot.coverage.west||common.bounds.east>snapshot.coverage.east||common.bounds.south<snapshot.coverage.south||common.bounds.north>snapshot.coverage.north))throw new Error('Historical imagery approved crop is outside its official source coverage.');
    return {...common,providerId:fields.providerId,sourceUrl:safeHistoricalUrl(fields.sourceUrl,'Historical imagery source URL'),
      licenseUrl:safeHistoricalUrl(fields.licenseUrl,'Historical imagery license URL'),placement:null,assetId:null,officialExport:snapshot};
  }
  if(fields.providerId!==null||fields.officialExport!==null)throw new Error('Manual historical imagery cannot contain official provider or export fields.');
  if(typeof fields.assetId!=='string'||!UUID.test(fields.assetId))throw new Error('Manual historical imagery asset ID must be a UUID.');
  return {...common,providerId:null,sourceUrl:safeHistoricalUrl(fields.sourceUrl,'Historical imagery source URL',{nullable:true}),
    licenseUrl:safeHistoricalUrl(fields.licenseUrl,'Historical imagery license URL',{nullable:true}),placement:historicalPlacement(fields.placement,location),assetId:fields.assetId,officialExport:null};
}

function legacyHistoricalItem(value){
  const fields=exactRecord(value,LEGACY_HISTORICAL_FIELDS,'Legacy historical imagery item');
  historicalText(fields.id,'Legacy historical imagery ID',{maximum:200});historicalYear(fields.year);historicalText(fields.name,'Legacy historical imagery filename',{maximum:255});
  if(!Number.isSafeInteger(fields.size)||fields.size<=0||fields.size>64_000_000)throw new Error('Legacy historical imagery size is invalid.');
  if(typeof fields.dataUrl!=='string'||fields.dataUrl.length>90_000_000||!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]*={0,2}$/i.test(fields.dataUrl))throw new Error('Legacy historical imagery data URL is invalid.');
  return {id:fields.id,year:fields.year,name:fields.name,size:fields.size,dataUrl:fields.dataUrl};
}

function restoredHistorical(items,location){
  const restored=[],ids=new Set(),sequences=new Set();
  for(const item of items){
    const isLegacy=item&&typeof item==='object'&&Object.hasOwn(item,'dataUrl');
    const normalized=isLegacy?legacyHistoricalItem(item):approvedHistoricalItem(item,location);
    const idKey=`${isLegacy?'legacy':'approved'}:${normalized.id}`;if(ids.has(idKey))throw new Error('Historical imagery IDs must be unique.');ids.add(idKey);
    if(!isLegacy){const sequenceKey=`${normalized.year}:${normalized.sequence}`;if(sequences.has(sequenceKey))throw new Error('Historical imagery sequences must be unique within each year.');sequences.add(sequenceKey);}
    restored.push(normalized);
  }
  return restored;
}

function restoredHistoricalCounters(value,items){
  if(value===undefined)value={};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('Historical imagery sequence counters are invalid.');
  const counters={};
  for(const key of Reflect.ownKeys(value)){
    const descriptor=typeof key==='string'?Object.getOwnPropertyDescriptor(value,key):null;
    if(typeof key!=='string'||!/^(?:18|19|20)\d{2}$/.test(key)||!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable||!Number.isSafeInteger(descriptor.value)||descriptor.value<0||descriptor.value>1_000_000)throw new Error('Historical imagery sequence counters must contain enumerable data fields with valid integers.');
    counters[key]=descriptor.value;
  }
  for(const item of items)if(Object.hasOwn(item,'sequence'))counters[item.year]=Math.max(counters[item.year]||0,item.sequence);
  return counters;
}

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
    siteBoundary:[], buildingBoundary:[], historical:[],historicalSequenceCounters:{},
    geology:{surficial:null,bedrock:null},
    dpi:300,
    companyProfileSnapshot:null,
    exportPreferences:{codes:[],selection:[],sources:{A:'osm',B:'esri-imagery',C:'toporama',D:'osm',E:'osm'}},
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
  p.historical=restoredHistorical(p.historical,p.location);
  p.historicalSequenceCounters=restoredHistoricalCounters(value.historicalSequenceCounters,p.historical);
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
  const figureCodes=Object.keys(figureDefaults()),savedCodes=Array.isArray(value.exportPreferences?.codes)?value.exportPreferences.codes:[];
  const codes=figureCodes.filter(code=>savedCodes.includes(code));
  const rawSelection=Array.isArray(value.exportPreferences?.selection)?value.exportPreferences.selection:codes.map(code=>({kind:'figure',code}));
  const selectedFigures=new Set(),selectedHistorical=new Set(),historicalIds=new Set(p.historical.map(item=>item.id));
  for(const entry of rawSelection){
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||(Object.getPrototypeOf(entry)!==Object.prototype&&Object.getPrototypeOf(entry)!==null))continue;
    const keys=Reflect.ownKeys(entry);if(keys.some(key=>typeof key!=='string'))continue;
    const values={};let safe=true;
    for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(entry,key);if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable){safe=false;break;}values[key]=descriptor.value;}
    if(!safe)continue;
    if(keys.length===2&&keys.includes('kind')&&values.kind==='figure'&&keys.includes('code')&&figureCodes.includes(values.code))selectedFigures.add(values.code);
    if(keys.length===2&&keys.includes('kind')&&values.kind==='historical'&&keys.includes('id')&&historicalIds.has(values.id))selectedHistorical.add(values.id);
  }
  const selection=[...figureCodes.filter(code=>selectedFigures.has(code)).map(code=>({kind:'figure',code})),
    ...p.historical.filter(item=>selectedHistorical.has(item.id)).sort((a,b)=>a.year-b.year||a.sequence-b.sequence||a.id.localeCompare(b.id,'en')).map(item=>({kind:'historical',id:item.id}))];
  p.exportPreferences={codes,selection,
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
  p.schemaVersion=6;
  return p;
}

export function validHistoricalA3Bounds(bounds){
  if(!validFigureBounds(bounds))return false;
  try{
    const southwest=projectWebMercator([bounds.west,bounds.south]),northeast=projectWebMercator([bounds.east,bounds.north]);
    const width=northeast[0]-southwest[0],height=northeast[1]-southwest[1],ratio=width/height;
    return Number.isFinite(ratio)&&Math.abs(ratio/HISTORICAL_A3_RATIO-1)<=HISTORICAL_A3_ASPECT_TOLERANCE;
  }catch{return false;}
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

function dxfTextTokens(value){
  const content=String(value??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
  return [...content].map(character=>{
    const code=character.codePointAt(0);
    if(code>=32&&code<=126&&code!==92)return {value:character,width:1};
    const escaped=code<=0xffff
      ?`\\U+${code.toString(16).toUpperCase().padStart(4,'0')}`
      :(()=>{const offset=code-0x10000,high=0xd800+(offset>>10),low=0xdc00+(offset&0x3ff);return `\\U+${high.toString(16).toUpperCase()}\\U+${low.toString(16).toUpperCase()}`;})();
    return {value:escaped,width:1};
  });
}

function dxfTextChunks(value,maxEncodedLength=240){
  const chunks=[];let encoded='',width=0;
  for(const token of dxfTextTokens(value)){
    if(encoded&&encoded.length+token.value.length>maxEncodedLength){chunks.push({encoded,width});encoded='';width=0;}
    encoded+=token.value;width+=token.width;
  }
  if(encoded)chunks.push({encoded,width});
  return chunks;
}

function dxfTextBlock(layer,value,x,y,extent,preferredHeight){
  const chunks=dxfTextChunks(value);if(!chunks.length)return {content:'',nextY:y};
  const widest=Math.max(...chunks.map(chunk=>chunk.width));
  const height=Math.max(extent*.001,Math.min(extent*preferredHeight,extent*1.2/(Math.max(widest,1)*.65)));
  const rowStep=Math.max(height*1.5,extent*.025);
  return {
    content:chunks.map((chunk,index)=>`0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${y-index*rowStep}\n40\n${height}\n1\n${chunk.encoded}\n`).join(''),
    nextY:y-chunks.length*rowStep
  };
}

function dxfDrawingFrame(siteBoundary,buildingBoundary,location){
  const points=[...(siteBoundary||[]),...(buildingBoundary||[])].filter(point=>Array.isArray(point)&&Number.isFinite(point[0])&&Number.isFinite(point[1]));
  if(!points.length&&Number.isFinite(location?.lng)&&Number.isFinite(location?.lat))points.push([location.lng,location.lat]);
  if(!points.length)points.push([0,0]);
  const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const measured=Math.max(maxX-minX,maxY-minY);
  return {minX,maxX,minY,maxY,extent:measured>0?Math.max(measured,1e-9):.001};
}

export function buildDxf({siteBoundary=[],buildingBoundary=[],name='',projectNo='',location=null}={}, {companyProfile}={}){
  let company;
  try{company=normalizeCompanyProfile(companyProfile||{});}catch(error){throw new Error(`Company profile is invalid: ${error.message}`,{cause:error});}
  const companyErrors=validateCompanyProfile(company);
  if(companyErrors.length)throw new Error(`Company profile is incomplete: ${companyErrors.map(error=>error.message).join(' ')}`);
  const title=String(name??'').trim();
  if(title.length>180)throw new Error('Project title is too long to fit the DXF title block.');
  const contacts=[company.address,company.phone,company.email,company.website];
  if(company.companyName.length>160||contacts.some(value=>value.length>220)||contacts.join(' | ').length>500){
    throw new Error('Company contact text is too long to fit the DXF title block.');
  }
  const frame=dxfDrawingFrame(siteBoundary,buildingBoundary,location);let cursor=frame.minY-frame.extent*.06,text='';
  for(const [layer,value,height] of [
    ['COMPANY_TEXT',company.companyName,.04],['COMPANY_TEXT',contacts.join(' | '),.018],
    ['TITLE_BLOCK',title,.03],['TITLE_BLOCK',projectNo,.022]
  ]){
    const block=dxfTextBlock(layer,value,frame.minX,cursor,frame.extent,height);text+=block.content;cursor=block.nextY-frame.extent*.01;
  }
  const header='0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1021\n9\n$DWGCODEPAGE\n3\nANSI_1252\n0\nENDSEC\n';
  return `${header}0\nSECTION\n2\nENTITIES\n${dxfPolyline('SITE_BOUNDARY',siteBoundary)}${dxfPolyline('BUILDING_BOUNDARY',buildingBoundary)}${text}0\nENDSEC\n0\nEOF\n`;
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
