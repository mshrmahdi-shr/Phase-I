import {restoreProject} from './core.mjs';
import {normalizeCompanyProfile,snapshotCompanyProfile,validateCompanyProfile} from './company-profile.mjs';
import {buildCadDxf} from './cad-dxf.mjs';
import {allocateCadFilenames,buildCadManifest,CAD_RASTER_NORMALIZATION} from './cad-manifest.mjs';
import {createProjector} from './projection.mjs';
import {worldFileFromCorners} from './world-file.mjs';
import {sheetGeometry} from './sheet-layout.mjs';
import {historicalCode,historicalSheetGeometry,orderedHistoricalItems} from './historical-layout.mjs';
import {sourceForFigure} from './map-sources.mjs';
import {
  composeHistoricalImage as defaultComposeHistorical,
  composeMap as defaultComposeMap,
  historicalImageryPlan,
  loadHistoricalAssetSnapshot,
  revalidateHistoricalOfficialSource
} from './map-compositor.mjs';
import {exportCombinedPdf,planPdfExport} from './pdf-export.mjs';
import {decodeManualImage} from './imagery/manual-image.mjs';
import {validateImageryProvider} from './imagery/provider-registry.mjs';
import {ONTARIO_IMAGERY_PROVIDER} from './imagery/providers/ontario.mjs';
import {TORONTO_IMAGERY_PROVIDER} from './imagery/providers/toronto.mjs';
import {OTTAWA_IMAGERY_PROVIDER} from './imagery/providers/ottawa.mjs';

const ZIP_DATE=new Date(Date.UTC(1980,0,1));
const FIGURE_CODES=Object.freeze(['A','B','C','D','E']);
const DEFAULT_PROVIDERS=Object.freeze([ONTARIO_IMAGERY_PROVIDER,TORONTO_IMAGERY_PROVIDER,OTTAWA_IMAGERY_PROVIDER]);
const LOGO_FIELDS=Object.freeze(['blob','metadata']);
const ASSET_FIELDS=Object.freeze(['createdAt','height','id','kind','mime','sha256','size','width']);
const SELECTION_LIMIT=20,ENTRY_LIMIT=48,IMAGE_BYTE_LIMIT=16_000_000,TOTAL_IMAGE_BYTE_LIMIT=128_000_000;
const IMAGE_PIXEL_LIMIT=16_000_000,TOTAL_PIXEL_LIMIT=160_000_000,PDF_BYTE_LIMIT=64_000_000;
const UNCOMPRESSED_BYTE_LIMIT=256_000_000,ARCHIVE_BYTE_LIMIT=257_000_000,MANUAL_SNAPSHOT_LIMIT=32_000_000;
const TEXT_BYTE_LIMIT=8_000_000,SHA256=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_EXTENSION=Object.freeze({'image/png':'png','image/jpeg':'jpg'});
const FIGURE_LICENCE=Object.freeze({
  osm:'OpenStreetMap contributors; Open Database Licence',
  'esri-imagery':'Esri World Imagery source and use terms',
  toporama:'Open Government Licence - Canada'
});

function fail(message){throw new Error(message);}
function throwIfAborted(signal){if(signal?.aborted)throw new DOMException('Export cancelled.','AbortError');}
function plainRecord(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} must be a plain record.`);
  let prototype;try{prototype=Object.getPrototypeOf(value);}catch{fail(`${label} must be inspectable.`);}
  if(prototype!==Object.prototype&&prototype!==null)fail(`${label} must be a plain record.`);return value;
}
function exactRecord(value,fields,label){
  plainRecord(value,label);let keys;try{keys=Reflect.ownKeys(value);}catch{fail(`${label} must be inspectable.`);}
  if(keys.some(key=>typeof key!=='string')||keys.length!==fields.length||keys.some(key=>!fields.includes(key))||fields.some(key=>!keys.includes(key)))fail(`${label} must contain exact fields.`);
  const result={};for(const key of fields){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail(`${label}.${key} must be an enumerable data field.`);result[key]=descriptor.value;}return result;
}
function deepFreeze(value,seen=new WeakSet()){
  if(!value||typeof value!=='object'||value instanceof Blob||seen.has(value))return value;seen.add(value);
  for(const key of Reflect.ownKeys(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(descriptor&&Object.hasOwn(descriptor,'value'))deepFreeze(descriptor.value,seen);}return Object.freeze(value);
}
function same(left,right){return JSON.stringify(left)===JSON.stringify(right);}
function utf8(value){return new TextEncoder().encode(value);}
function canonical(value){const result=value===0?0:Number(value.toPrecision(12));if(!Number.isFinite(result))fail('CAD package geometry exceeds numeric bounds.');return result===0?0:result;}
async function sha256(value,signal){
  throwIfAborted(signal);const bytes=value instanceof Uint8Array?value:new Uint8Array(value);if(!globalThis.crypto?.subtle)fail('CAD package hashing requires Web Crypto.');
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);throwIfAborted(signal);return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function toDataUrl(bytes,mime){
  if(!Object.hasOwn(MIME_EXTENSION,mime))fail('Only normalized PNG or JPEG raster bytes can be embedded in the PDF.');
  const encode=globalThis.btoa;if(typeof encode!=='function')fail('Base64 encoding is unavailable.');let binary='';for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));return `data:${mime};base64,${encode(binary)}`;
}
function dataUrlBlob(value){
  if(typeof value!=='string'||value.length>IMAGE_BYTE_LIMIT*2)fail('Composed raster data is missing or exceeds its encoded safety limit.');
  const match=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!match)fail('Composed raster must be a base64 PNG or JPEG data URL.');
  let binary;try{binary=atob(match[2]);}catch{fail('Composed raster base64 is invalid.');}if(!binary.length||binary.length>IMAGE_BYTE_LIMIT)fail('Composed raster exceeds the 16 MB byte limit.');
  const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return new Blob([bytes],{type:match[1]});
}
function pngWithoutPhysicalResolution(bytes){
  const signature=[137,80,78,71,13,10,26,10];if(bytes.length<20||signature.some((byte,index)=>bytes[index]!==byte))fail('Normalized PNG has an invalid signature.');
  const parts=[bytes.subarray(0,8)];let offset=8,ended=false;
  while(offset<bytes.length){if(offset>bytes.length-12)fail('Normalized PNG has a truncated chunk.');const view=new DataView(bytes.buffer,bytes.byteOffset+offset,bytes.length-offset),length=view.getUint32(0),end=offset+12+length;if(end>bytes.length)fail('Normalized PNG chunk exceeds its bytes.');
    const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));if(type!=='pHYs'&&type!=='eXIf')parts.push(bytes.subarray(offset,end));offset=end;if(type==='IEND'){ended=true;break;}}
  if(!ended||offset!==bytes.length)fail('Normalized PNG must end exactly after IEND.');const size=parts.reduce((sum,part)=>sum+part.length,0),result=new Uint8Array(size);let cursor=0;for(const part of parts){result.set(part,cursor);cursor+=part.length;}return result;
}
function jpegWithoutPhysicalResolution(bytes){
  if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)fail('Normalized JPEG has an invalid signature.');const parts=[bytes.subarray(0,2)];let offset=2,foundScan=false;
  while(offset<bytes.length){const start=offset;if(bytes[offset++]!==0xff)fail('Normalized JPEG marker stream is invalid.');while(offset<bytes.length&&bytes[offset]===0xff)offset++;const marker=bytes[offset++];
    if(marker===0xda){if(offset+2>bytes.length)fail('Normalized JPEG scan is truncated.');const length=bytes[offset]<<8|bytes[offset+1];if(length<2||offset+length>bytes.length)fail('Normalized JPEG scan header is invalid.');parts.push(bytes.subarray(start,bytes.length));offset=bytes.length;foundScan=true;break;}
    if(marker===0xd9){parts.push(bytes.subarray(start,offset));foundScan=true;if(offset!==bytes.length)fail('Normalized JPEG contains bytes after EOI.');break;}
    if(marker===0x01||marker>=0xd0&&marker<=0xd7){parts.push(bytes.subarray(start,offset));continue;}
    if(offset+2>bytes.length)fail('Normalized JPEG segment is truncated.');const length=bytes[offset]<<8|bytes[offset+1],end=offset+length;if(length<2||end>bytes.length)fail('Normalized JPEG segment length is invalid.');
    if(marker!==0xe0&&marker!==0xe1&&marker!==0xed)parts.push(bytes.subarray(start,end));offset=end;
  }
  if(!foundScan)fail('Normalized JPEG is incomplete.');const size=parts.reduce((sum,part)=>sum+part.length,0),result=new Uint8Array(size);let cursor=0;for(const part of parts){result.set(part,cursor);cursor+=part.length;}return result;
}
async function normalizeRaster(blob,{width,height,label,signal,decodeImage,decodeOptions}){
  throwIfAborted(signal);if(!(blob instanceof Blob)||!Object.hasOwn(MIME_EXTENSION,blob.type)||!Number.isSafeInteger(blob.size)||blob.size<=0||blob.size>IMAGE_BYTE_LIMIT)fail(`${label} must be a nonempty PNG or JPEG within the 16 MB byte limit.`);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width>Math.floor(IMAGE_PIXEL_LIMIT/height))fail(`${label} dimensions exceed the 16 million pixel limit.`);
  const source=new Uint8Array(await blob.arrayBuffer());throwIfAborted(signal);const normalized=blob.type==='image/png'?pngWithoutPhysicalResolution(source):jpegWithoutPhysicalResolution(source),output=new Blob([normalized],{type:blob.type});
  const decoded=await decodeImage(output,{...decodeOptions,signal,maxBytes:IMAGE_BYTE_LIMIT,maxPixels:IMAGE_PIXEL_LIMIT});throwIfAborted(signal);
  if(!decoded||!(decoded.blob instanceof Blob)||decoded.mime!==blob.type||decoded.blob.type!==blob.type||decoded.width!==width||decoded.height!==height)fail(`${label} complete decode dimensions or media type do not match its declared output.`);
  return Object.freeze({blob:output,bytes:normalized,mime:blob.type,width,height,sha256:await sha256(normalized,signal)});
}

function freezeProviders(providers){
  if(!Array.isArray(providers)||providers.length<1)fail('Historical imagery providers must be a nonempty array.');const ids=new Set(),result=[];
  for(const value of providers){validateImageryProvider(value);if(ids.has(value.id))fail(`Duplicate historical imagery provider: ${value.id}.`);ids.add(value.id);const provider={...value,coverage:Object.freeze({...value.coverage}),allowedOrigins:Object.freeze([...value.allowedOrigins]),allowedRoots:Object.freeze([...value.allowedRoots])};result.push(Object.freeze(provider));}
  return Object.freeze(result);
}
function selectionSnapshot(project,selection){
  if(!Array.isArray(selection)||selection.length<1||selection.length>SELECTION_LIMIT)fail(`CAD selection must contain between 1 and ${SELECTION_LIMIT} items.`);const keys=new Set(),figures=new Set(),historical=new Set();
  for(const [index,value] of selection.entries()){
    plainRecord(value,`CAD selection ${index+1}`);const kindDescriptor=Object.getOwnPropertyDescriptor(value,'kind');if(!kindDescriptor?.enumerable||!Object.hasOwn(kindDescriptor,'value'))fail(`CAD selection ${index+1}.kind must be an enumerable data field.`);const kind=kindDescriptor.value;let key;
    if(kind==='figure'){const row=exactRecord(value,['kind','code'],`CAD selection ${index+1}`);if(!FIGURE_CODES.includes(row.code))fail('CAD figure selection must be A through E.');key=`figure:${row.code}`;figures.add(row.code);}
    else if(kind==='historical'){const row=exactRecord(value,['kind','id'],`CAD selection ${index+1}`);if(typeof row.id!=='string'||!UUID.test(row.id))fail('CAD historical selection must contain a UUID.');key=`historical:${row.id}`;historical.add(row.id);}
    else fail('CAD selection kind must be figure or historical.');if(keys.has(key))fail(`CAD selection contains duplicate ${key}.`);keys.add(key);
  }
  const historicalItems=orderedHistoricalItems(project).filter(item=>historical.has(item.id));if(historicalItems.length!==historical.size)fail('A selected historical item is missing, legacy, stale, or duplicated in the project.');
  const normalized=[...FIGURE_CODES.filter(code=>figures.has(code)).map(code=>({kind:'figure',code})),...historicalItems.map(item=>({kind:'historical',id:item.id}))];return deepFreeze(normalized);
}
function checkedCompany(value){
  let profile;try{profile=normalizeCompanyProfile(structuredClone(value));}catch(error){throw new Error(`Company profile is invalid: ${error.message}`,{cause:error});}const errors=validateCompanyProfile(profile);if(errors.length)fail(`Company profile is incomplete: ${errors.map(error=>error.message).join(' ')}`);return snapshotCompanyProfile(profile);
}
async function checkedLogo(value,profile,{signal,decodeImage,decodeOptions}){
  const row=exactRecord(value,LOGO_FIELDS,'Company logo asset'),metadata=exactRecord(row.metadata,ASSET_FIELDS,'Company logo metadata');throwIfAborted(signal);
  if(metadata.id!==profile.logoAssetId||metadata.kind!=='company-logo'||metadata.mime!==profile.logoMime)fail('Company logo asset kind, identity, or media does not match the Company Profile.');
  if(!Number.isSafeInteger(metadata.size)||metadata.size<=0||metadata.size>IMAGE_BYTE_LIMIT||!(row.blob instanceof Blob)||row.blob.size!==metadata.size||row.blob.type!==metadata.mime)fail('Company logo asset exceeds the 16 MB byte limit or does not match its Blob metadata.');
  if(metadata.width!==profile.logoWidth||metadata.height!==profile.logoHeight||!Number.isSafeInteger(metadata.width)||!Number.isSafeInteger(metadata.height)||metadata.width<=0||metadata.height<=0||metadata.width>Math.floor(IMAGE_PIXEL_LIMIT/metadata.height))fail('Company logo dimensions do not match the Company Profile or pixel budget.');
  if(typeof metadata.sha256!=='string'||!SHA256.test(metadata.sha256))fail('Company logo SHA-256 metadata is invalid.');const bytes=new Uint8Array(await row.blob.arrayBuffer());if(await sha256(bytes,signal)!==metadata.sha256)fail('Company logo hash verification failed.');
  return normalizeRaster(new Blob([bytes],{type:metadata.mime}),{width:metadata.width,height:metadata.height,label:'Company logo',signal,decodeImage,decodeOptions});
}
function snapshotStore(assets){return Object.freeze({async get(id){const asset=assets.get(id);return asset?{metadata:{...asset.metadata},blob:asset.blob}:null;}});}
function cornerFrame(bounds,width,height,projector){
  const geographic=Object.freeze([[bounds.west,bounds.north],[bounds.east,bounds.north],[bounds.east,bounds.south],[bounds.west,bounds.south]].map(point=>Object.freeze(point)));
  const controls=geographic.map(point=>projector.forward(point)),west=Math.min(...controls.map(point=>point[0])),east=Math.max(...controls.map(point=>point[0])),south=Math.min(...controls.map(point=>point[1])),north=Math.max(...controls.map(point=>point[1]));
  const pixelSize=Math.ceil(Math.max((east-west)/width,(north-south)/height)*1000)/1000;if(!(pixelSize>0)||!Number.isFinite(pixelSize))fail('Projected raster transform is degenerate.');
  const left=Math.floor(west*1000)/1000,top=Math.ceil(north*1000)/1000,right=left+pixelSize*width,bottom=top-pixelSize*height;
  const projected=[[left,top],[right,top],[right,bottom],[left,bottom]].map(point=>Object.freeze(point.map(canonical))),rotation=0;
  const world=worldFileFromCorners({upperLeft:projected[0],upperRight:projected[1],lowerLeft:projected[3],pixelWidth:width,pixelHeight:height});return Object.freeze({geographicCorners:geographic,projectedCorners:Object.freeze(projected),rotation,world});
}
function sourceMetadata(project,selection,frame,raster,providerById){
  const pixelSize=Math.hypot(frame.projectedCorners[1][0]-frame.projectedCorners[0][0],frame.projectedCorners[1][1]-frame.projectedCorners[0][1])/raster.width;
  if(selection.kind==='figure'){
    const source=sourceForFigure(selection.code),latitude=project.location.lat*Math.PI/180,native=Math.cos(latitude)*2*Math.PI*6378137/(256*2**source.maxNativeZoom);
    return {code:selection.code,year:Number(project.date.slice(0,4)),provider:source.label,sourceResolutionMeters:Math.max(pixelSize,native),attribution:source.credits,license:FIGURE_LICENCE[source.id],redistributionEvidence:'approved-application-map-source'};
  }
  const item=project.historical.find(candidate=>candidate.id===selection.id),provider=item.mode==='official'?providerById.get(item.providerId)?.label:'Manual upload';
  const manualResolution=item.mode==='manual'?Math.max(item.placement.groundWidth/item.placement.sourceWidth,item.placement.groundHeight/item.placement.sourceHeight):0;
  return {code:historicalCode(item),year:item.year,provider,sourceResolutionMeters:item.resolutionMeters??Math.max(pixelSize,manualResolution),attribution:item.attribution,license:item.licenseUrl??'Manual reproduction permission acknowledged',redistributionEvidence:item.mode==='official'?'current-provider-exportable-policy':'manual-permission-confirmed'};
}
function fileRow(path,mime,content,{pixelWidth=null,pixelHeight=null,worldFilePath=null}={}){return {path,mime,content,pixelWidth,pixelHeight,worldFilePath};}
async function hashedFiles(rows,signal){
  const total=rows.reduce((sum,row)=>sum+row.content.byteLength,0);if(total>UNCOMPRESSED_BYTE_LIMIT)fail('CAD package uncompressed bytes exceed the 256 MB budget.');const result=[];
  for(const row of rows){throwIfAborted(signal);result.push({path:row.path,sha256:await sha256(row.content,signal),mime:row.mime,bytes:row.content.byteLength,pixelWidth:row.pixelWidth,pixelHeight:row.pixelHeight,worldFilePath:row.worldFilePath});}return result;
}
function logoFrameFromDxf(dxf){
  const pairs=dxf.trimEnd().split('\n'),entities=[];let current=null;
  for(let index=0;index<pairs.length;index+=2){const code=Number(pairs[index]),value=pairs[index+1];if(code===0){if(current)entities.push(current);current={type:value,layer:null,points:[]};continue;}if(!current)continue;if(code===8)current.layer=value;if(code===10){current.points.push([Number(value),null]);continue;}if(code===20&&current.points.length)current.points.at(-1)[1]=Number(value);}
  if(current)entities.push(current);const matches=entities.filter(entity=>entity.type==='LWPOLYLINE'&&entity.layer==='COMPANY_LOGO_FRAME');if(matches.length!==1||matches[0].points.length!==4)fail('Generated DXF must contain exactly one four-corner company logo frame.');const [lowerLeft,lowerRight,upperRight,upperLeft]=matches[0].points;return {projectedCorners:[upperLeft,upperRight,lowerRight,lowerLeft],rotation:0};
}
function safeFilename(project){let stem=project.projectNo.normalize('NFKD').replace(/\p{Mark}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80).replace(/-+$/,'')||'phase-i';if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem))stem=`project-${stem}`;return `${stem}-cad-package.zip`;}

/** Builds the complete package in memory. Downloading belongs to the UI after its own final abort check. */
export async function exportCadPackage({
  project,companyProfile,companyLogo,selection,datasets={},assetStore,dpi=300,signal,onProgress=()=>{},
  composeMap=defaultComposeMap,composeHistorical=defaultComposeHistorical,exportPdf=exportCombinedPdf,Zip=globalThis.JSZip,proj4Impl,
  providers=DEFAULT_PROVIDERS,revalidateOfficial=revalidateHistoricalOfficialSource,fetchImpl=globalThis.fetch,decodeImage=decodeManualImage,decodeOptions={}
}={}){
  throwIfAborted(signal);if(typeof Zip!=='function')fail('A JSZip-compatible constructor is required.');if(typeof composeMap!=='function'||typeof composeHistorical!=='function'||typeof exportPdf!=='function')fail('CAD package composers and PDF exporter must be functions.');if(typeof decodeImage!=='function')fail('A complete raster decoder is required.');if(!assetStore||typeof assetStore.get!=='function')fail('A historical asset store is required.');
  onProgress({phase:'preflight',completed:0,total:1});let snapshotProject;try{snapshotProject=restoreProject(structuredClone(project));}catch(error){throw new Error(`CAD package project preflight failed: ${error.message}`,{cause:error});}
  const snapshotProfile=checkedCompany(companyProfile),snapshotDatasets=deepFreeze(structuredClone(datasets)),snapshotSelection=selectionSnapshot(snapshotProject,selection),snapshotProviders=freezeProviders(providers),providerById=new Map(snapshotProviders.map(provider=>[provider.id,provider])),projector=createProjector(snapshotProject.location,{...(proj4Impl?{proj4Impl}:{})});deepFreeze(snapshotProject);
  const entryEstimate=8+snapshotSelection.length*2;if(entryEstimate>ENTRY_LIMIT)fail(`CAD package would exceed the ${ENTRY_LIMIT}-entry archive limit.`);
  const manualAssets=new Map(),officialResults=new Map(),geometryByKey=new Map();let manualBytes=0,estimatedBytes=0,estimatedPixels=0;
  for(const selected of snapshotSelection){
    throwIfAborted(signal);if(selected.kind==='figure'){
      const geometry=sheetGeometry(snapshotProject,selected.code,dpi);geometryByKey.set(`figure:${selected.code}`,deepFreeze(geometry));estimatedPixels+=geometry.raster.width*geometry.raster.height;estimatedBytes+=Math.min(IMAGE_BYTE_LIMIT,Math.ceil(geometry.raster.width*geometry.raster.height/2));continue;
    }
    const item=snapshotProject.historical.find(candidate=>candidate.id===selected.id),code=historicalCode(item),geometry=historicalSheetGeometry(snapshotProject,item,dpi);geometryByKey.set(`historical:${selected.id}`,deepFreeze(geometry));estimatedPixels+=geometry.raster.width*geometry.raster.height;estimatedBytes+=Math.min(IMAGE_BYTE_LIMIT,Math.ceil(geometry.raster.width*geometry.raster.height/2));
    if(item.mode==='manual'){
      const asset=await loadHistoricalAssetSnapshot({project:snapshotProject,item,assetStore,signal});if(!manualAssets.has(item.assetId)){manualBytes+=asset.metadata.size;if(manualBytes>MANUAL_SNAPSHOT_LIMIT)fail(`${code}: selected manual historical assets exceed the 32 MB resident snapshot limit.`);manualAssets.set(item.assetId,deepFreeze({metadata:{...asset.metadata},blob:asset.blob}));}
    }else{
      const current=deepFreeze(structuredClone(await revalidateOfficial({project:snapshotProject,item,providers:snapshotProviders,signal,fetchImpl})));historicalImageryPlan({project:snapshotProject,item,geometry,providers:snapshotProviders,currentResult:current});officialResults.set(item.id,current);
    }
  }
  if(estimatedPixels>TOTAL_PIXEL_LIMIT)fail('Selected CAD rasters exceed the 160 million pixel composition budget. Export fewer sheets together.');if(estimatedBytes>UNCOMPRESSED_BYTE_LIMIT-PDF_BYTE_LIMIT-TEXT_BYTE_LIMIT)fail('Selected CAD rasters exceed the estimated uncompressed package budget.');
  const normalizedLogo=await checkedLogo(companyLogo,snapshotProfile,{signal,decodeImage,decodeOptions}),historicalStore=snapshotStore(manualAssets),cachedOfficial=async({item})=>{const result=officialResults.get(item.id);if(!result)fail(`${historicalCode(item)}: current official result was not frozen during preflight.`);return result;};
  const planned=await planPdfExport({project:snapshotProject,selection:snapshotSelection,codes:snapshotSelection.filter(item=>item.kind==='figure').map(item=>item.code),datasets:snapshotDatasets,companyProfile:snapshotProfile,dpi,signal,providers:snapshotProviders,assetStore:historicalStore,revalidateOfficial:cachedOfficial,fetchImpl});throwIfAborted(signal);onProgress({phase:'preflight',completed:1,total:1});
  const rasters=new Map(),compositionRequests=new Set(),activeDisposals=new Set();let imageBytes=normalizedLogo.bytes.byteLength,pixels=normalizedLogo.width*normalizedLogo.height;
  const wrap=(kind,composer)=>async args=>{
    throwIfAborted(signal);const selected=kind==='figure'?{kind,code:args.code}:{kind:'historical',id:args.item.id},key=kind==='figure'?`figure:${args.code}`:`historical:${args.item.id}`,expectedGeometry=geometryByKey.get(key);if(!expectedGeometry||!same(expectedGeometry.bounds,args.geometry?.bounds)||!same(expectedGeometry.raster,args.geometry?.raster))fail(`${key}: PDF composition geometry drifted after preflight.`);
    if(compositionRequests.has(key))fail(`${key}: PDF exporter requested a duplicate CAD raster; every selection must compose exactly once.`);compositionRequests.add(key);
    let surface,disposed=false;const dispose=()=>{if(disposed)return;disposed=true;activeDisposals.delete(dispose);surface?.dispose?.();};
    try{
      surface=await composer(args);activeDisposals.add(dispose);throwIfAborted(signal);if(!surface||!Number.isSafeInteger(surface.width)||!Number.isSafeInteger(surface.height)||surface.width<=0||surface.height<=0||!same(surface.bounds,args.geometry.bounds))fail(`${key}: composition returned incomplete or drifting raster geometry.`);
      const normalized=await normalizeRaster(dataUrlBlob(surface.dataUrl),{width:surface.width,height:surface.height,label:key,signal,decodeImage,decodeOptions});imageBytes+=normalized.bytes.byteLength;pixels+=normalized.width*normalized.height;if(imageBytes>TOTAL_IMAGE_BYTE_LIMIT)fail('CAD package raster bytes exceed the 128 MB aggregate limit.');if(pixels>TOTAL_PIXEL_LIMIT)fail('CAD package decoded rasters exceed the 160 million pixel aggregate limit.');
      const frame=cornerFrame(args.geometry.bounds,normalized.width,normalized.height,projector),metadata=sourceMetadata(snapshotProject,selected,frame,normalized,providerById);rasters.set(key,Object.freeze({selected,geometry:expectedGeometry,normalized,frame,metadata}));
      return {...surface,dispose};
    }catch(error){dispose();throw error;}
  };
  let pdfResult;
  try{
    pdfResult=await exportPdf({project:snapshotProject,selection:snapshotSelection,codes:snapshotSelection.filter(item=>item.kind==='figure').map(item=>item.code),datasets:snapshotDatasets,companyProfile:snapshotProfile,companyLogoDataUrl:toDataUrl(normalizedLogo.bytes,normalizedLogo.mime),dpi,signal,providers:snapshotProviders,assetStore:historicalStore,revalidateOfficial:cachedOfficial,fetchImpl,compose:wrap('figure',composeMap),composeHistorical:wrap('historical',composeHistorical),onProgress:event=>{throwIfAborted(signal);onProgress({...event,phase:event.phase==='complete'?'pdf-complete':event.phase});}});throwIfAborted(signal);
  }finally{for(const dispose of [...activeDisposals])dispose();}
  if(!pdfResult||!(pdfResult.blob instanceof Blob)||pdfResult.blob.type!=='application/pdf'||!Number.isSafeInteger(pdfResult.pageCount)||pdfResult.pageCount!==planned.pageCount)fail('Combined PDF output or page count does not match the frozen preflight plan.');if(pdfResult.blob.size<=0||pdfResult.blob.size>PDF_BYTE_LIMIT)fail('Combined PDF exceeds the 64 MB package limit.');if(compositionRequests.size!==snapshotSelection.length||rasters.size!==snapshotSelection.length)fail('Combined PDF did not compose every selected CAD raster exactly once.');
  const pdfBytes=new Uint8Array(await pdfResult.blob.arrayBuffer()),pdfHeader=new TextDecoder('latin1').decode(pdfBytes.subarray(0,5)),pdfTail=new TextDecoder('latin1').decode(pdfBytes.subarray(Math.max(0,pdfBytes.length-1024)));if(pdfHeader!=='%PDF-'||!pdfTail.includes('%%EOF'))fail('Combined PDF output does not contain a valid PDF signature and end marker.');throwIfAborted(signal);
  let ordered=snapshotSelection.map(selected=>rasters.get(selected.kind==='figure'?`figure:${selected.code}`:`historical:${selected.id}`));if(ordered.some(value=>!value))fail('A selected CAD raster is missing after PDF composition.');
  const filenames=allocateCadFilenames(ordered.map(value=>({id:value.selected.kind==='figure'?`figure:${value.selected.code}`:`historical:${value.selected.id}`,label:value.selected.kind==='figure'?`Figure-${value.selected.code}`:value.metadata.code,mime:value.normalized.mime}))),filenameByKey=new Map(filenames.map(value=>[value.id,value]));
  ordered=ordered.map(value=>Object.freeze({...value,allocated:filenameByKey.get(value.selected.kind==='figure'?`figure:${value.selected.code}`:`historical:${value.selected.id}`)}));
  const imageFrames=ordered.map(value=>({selection:value.selected,corners:value.frame.projectedCorners})),dxf=buildCadDxf({project:snapshotProject,companyProfile:snapshotProfile,selection:snapshotSelection,imageFrames,projector}),dxfBytes=utf8(dxf);throwIfAborted(signal);
  const logoPath=`company/logo.${MIME_EXTENSION[normalizedLogo.mime]}`,coreRows=[fileRow('Project.dxf','application/dxf',dxfBytes),fileRow('Combined-Phase-I.pdf','application/pdf',pdfBytes),fileRow(logoPath,normalizedLogo.mime,normalizedLogo.bytes,{pixelWidth:normalizedLogo.width,pixelHeight:normalizedLogo.height})],manifestItems=[];
  for(const value of ordered){coreRows.push(fileRow(value.allocated.path,value.normalized.mime,value.normalized.bytes,{pixelWidth:value.normalized.width,pixelHeight:value.normalized.height,worldFilePath:value.allocated.worldFilePath}),fileRow(value.allocated.worldFilePath,'text/plain',utf8(value.frame.world.text)));manifestItems.push({...value.metadata,geographicCorners:value.frame.geographicCorners,projectedCorners:value.frame.projectedCorners,imagePath:value.allocated.path,rotation:value.frame.rotation});}
  const logoAttachment=logoFrameFromDxf(dxf),coreFiles=await hashedFiles(coreRows,signal),input={project:snapshotProject,companyProfile:snapshotProfile,crs:projector.crs,rasterNormalization:CAD_RASTER_NORMALIZATION,files:coreFiles,items:manifestItems,logoAttachment},provisional=buildCadManifest(input);
  const textRows=[fileRow('Attach-Images.scr','text/plain',utf8(provisional.attachScript)),fileRow('README.txt','text/plain',utf8(provisional.readmeText)),fileRow('Sources-and-Licences.txt','text/plain',utf8(provisional.sourcesText)),fileRow('Manifest.csv','text/csv',utf8(provisional.csv))],finalFiles=await hashedFiles([...coreRows,...textRows],signal),manifest=buildCadManifest({...input,files:finalFiles});
  if(manifest.attachScript!==provisional.attachScript||manifest.readmeText!==provisional.readmeText||manifest.sourcesText!==provisional.sourcesText||manifest.csv!==provisional.csv)fail('CAD manifest text outputs changed while final file hashes were assembled.');
  const entryRows=[fileRow('Project.dxf','application/dxf',dxfBytes),fileRow('Combined-Phase-I.pdf','application/pdf',pdfBytes),...textRows,fileRow('Manifest.json','application/json',utf8(manifest.json)),fileRow(logoPath,normalizedLogo.mime,normalizedLogo.bytes)];for(const value of ordered)entryRows.push(fileRow(value.allocated.path,value.normalized.mime,value.normalized.bytes),fileRow(value.allocated.worldFilePath,'text/plain',utf8(value.frame.world.text)));
  if(entryRows.length!==entryEstimate||entryRows.length>ENTRY_LIMIT)fail('CAD package entry cardinality changed after preflight.');const paths=new Set();let totalBytes=0;for(const entry of entryRows){if(paths.has(entry.path.toLowerCase()))fail(`Duplicate normalized CAD package path: ${entry.path}.`);paths.add(entry.path.toLowerCase());totalBytes+=entry.content.byteLength;}if(totalBytes>UNCOMPRESSED_BYTE_LIMIT)fail('CAD package uncompressed bytes exceed the 256 MB budget.');
  throwIfAborted(signal);onProgress({phase:'assembling',completed:entryRows.length,total:entryRows.length});const archive=new Zip(),options={date:ZIP_DATE,createFolders:false};for(const entry of entryRows)archive.file(entry.path,entry.content,options);let archiveBytes;
  try{archiveBytes=await archive.generateAsync({type:'uint8array',compression:'STORE',platform:'DOS',streamFiles:false},metadata=>{throwIfAborted(signal);onProgress({phase:'compressing',percent:metadata.percent,completed:metadata.percent,total:100});});}catch(error){if(signal?.aborted||error?.name==='AbortError')throw new DOMException('Export cancelled.','AbortError');throw error;}
  throwIfAborted(signal);if(!(archiveBytes instanceof Uint8Array)||archiveBytes.byteLength<=0||archiveBytes.byteLength>ARCHIVE_BYTE_LIMIT)fail('CAD ZIP compressed bytes exceed the 257 MB archive budget.');const result={blob:new Blob([archiveBytes],{type:'application/zip'}),filename:safeFilename(snapshotProject),pageCount:pdfResult.pageCount,imageCount:ordered.length,crs:Object.freeze({...projector.crs})};onProgress({phase:'complete',completed:entryRows.length,total:entryRows.length});throwIfAborted(signal);return Object.freeze(result);
}
