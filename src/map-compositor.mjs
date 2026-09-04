import {sourceForFigure} from './map-sources.mjs';
import {mapPoint,MAX_RASTER_PIXELS,unprojectPoint} from './sheet-layout.mjs';
import {arcGisExportUrl} from './imagery/arcgis-client.mjs';
import {wmsGetMapUrl} from './imagery/wms-client.mjs';
import {validateImageryProvider,validateImageryResult,validateProviderUrl} from './imagery/provider-registry.mjs';
import {searchOfficialImagery} from './imagery/search.mjs';
import {placementCanvasTransform,placementCorners,projectWebMercator,validatePlacement} from './imagery/placement.mjs';
import {historicalCode,historicalSheetGeometry} from './historical-layout.mjs';
import {ONTARIO_IMAGERY_PROVIDER} from './imagery/providers/ontario.mjs';
import {TORONTO_IMAGERY_PROVIDER} from './imagery/providers/toronto.mjs';
import {OTTAWA_IMAGERY_PROVIDER} from './imagery/providers/ottawa.mjs';
import {NAPL_IMAGERY_PROVIDER} from './imagery/providers/napl.mjs';

const WORLD=2*Math.PI*6378137,MAX_TILES=36;
const DEFAULT_HISTORICAL_PROVIDERS=Object.freeze([ONTARIO_IMAGERY_PROVIDER,TORONTO_IMAGERY_PROVIDER,OTTAWA_IMAGERY_PROVIDER,NAPL_IMAGERY_PROVIDER]);
const SUPPORTED_OFFICIAL_EXPORT_KINDS=new Set(['arcgis-export','wms-export']);
// Historical official exports are fetched at the provider's approved native
// dimensions.  Do not impose an arbitrary byte ceiling here: large municipal
// rasters are valid inputs and are composed directly into the requested sheet.
const MAX_HISTORICAL_TILES=64,MAX_IMAGE_SEGMENTS=4096;
const MAX_MANUAL_ASSET_BYTES=16_000_000;
const HISTORICAL_ASSET_FIELDS=['createdAt','height','id','kind','mime','sha256','size','width'];
const HISTORICAL_ASSET_MIMES=new Set(['image/png','image/jpeg','image/tiff']);
export function throwIfAborted(signal){if(signal?.aborted)throw new DOMException('Export cancelled.','AbortError');}
export function imageryPlan(code,geometry){
  const source=sourceForFigure(code),b=geometry.projected,{width,height}=geometry.raster;
  if(source.kind==='wms'){
    const requestWidth=1536,requestHeight=Math.round(requestWidth*height/width),url=new URL(source.url);
    for(const [key,value] of Object.entries({SERVICE:'WMS',REQUEST:'GetMap',VERSION:source.version,LAYERS:source.layer,STYLES:'',SRS:source.crs,BBOX:[b.west,b.south,b.east,b.north].join(','),WIDTH:requestWidth,HEIGHT:requestHeight,FORMAT:'image/png',TRANSPARENT:'FALSE',EXCEPTIONS:'application/vnd.ogc.se_xml'}))url.searchParams.set(key,value);
    return [{url:url.href,x:0,y:0,width,height,expectedWidth:requestWidth,expectedHeight:requestHeight}];
  }
  // Request only visible native tiles, not a print-DPI zoom stack. B may overzoom.
  let zoom=Math.max(0,Math.min(source.maxNativeZoom,Math.floor(Math.log2(WORLD/(b.east-b.west)*(geometry.mapFrame.width/25.4*96)/256))));
  let tiles;
  do{
    const span=WORLD/2**zoom;
    const xmin=Math.floor((b.west+WORLD/2)/span),xmax=Math.ceil((b.east+WORLD/2)/span)-1;
    const ymin=Math.floor((WORLD/2-b.north)/span),ymax=Math.ceil((WORLD/2-b.south)/span)-1;
    tiles=[];
    for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++)tiles.push({url:source.url.replace('{z}',zoom).replace('{x}',x).replace('{y}',y),
      x:(x*span-WORLD/2-b.west)/(b.east-b.west)*width,y:(b.north-(WORLD/2-y*span))/(b.north-b.south)*height,
      width:span/(b.east-b.west)*width,height:span/(b.north-b.south)*height,expectedWidth:256,expectedHeight:256});
    if(tiles.length<=MAX_TILES)break;zoom--;
  }while(zoom>=0);
  return tiles;
}
async function decodeImage(blob,signal){
  throwIfAborted(signal);
  if(typeof createImageBitmap==='function'){
    // Native bitmap decoding has no AbortSignal support. Abandon our wait as
    // soon as it is cancelled, but retain a handler to close any late result.
    return new Promise((resolve,reject)=>{
      let abandoned=false;
      const abort=()=>{abandoned=true;signal?.removeEventListener('abort',abort);reject(new DOMException('Export cancelled.','AbortError'));};
      signal?.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>{throwIfAborted(signal);return createImageBitmap(blob);}).then(bitmap=>{
        signal?.removeEventListener('abort',abort);
        if(abandoned)bitmap.close();else resolve(bitmap);
      },error=>{
        signal?.removeEventListener('abort',abort);if(!abandoned)reject(error);
      });
      if(signal?.aborted)abort();
    });
  }
  const url=URL.createObjectURL(blob),img=new Image();
  try{
    await new Promise((resolve,reject)=>{
      const finish=fn=>value=>{signal?.removeEventListener('abort',abort);img.onload=img.onerror=null;fn(value);};
      const abort=finish(()=>{img.src='';reject(new DOMException('Export cancelled.','AbortError'));});
      signal?.addEventListener('abort',abort,{once:true});img.onload=finish(resolve);img.onerror=finish(()=>reject(new Error('Map image could not be decoded.')));img.src=url;
    });return img;
  }finally{URL.revokeObjectURL(url);}
}
function pathRing(ctx,ring,geometry){
  ring.forEach((point,i)=>{const [x,y]=mapPoint(point,geometry);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.closePath();
}
export function paintMapOverlays(ctx,{project,features=[],geometry}){
  const factor=geometry.dpi/25.4;
  for(const feature of features){
    ctx.beginPath();for(const ring of [feature.polygon,...(feature.holes||[])])pathRing(ctx,ring,geometry);
    ctx.fillStyle=/^#[0-9a-f]{6}$/i.test(feature.color)?feature.color:'#5fa8d3';ctx.globalAlpha=Number.isFinite(feature.fillOpacity)?Math.min(1,Math.max(0,feature.fillOpacity)):.6;
    ctx.fill('evenodd');ctx.globalAlpha=1;ctx.strokeStyle='#475569';ctx.lineWidth=.18*factor;ctx.stroke();
  }
  for(const [key,color,lineWidth,dash] of [['siteBoundary','#ef4444',.8,[]],['buildingBoundary','#111111',.5,[2*factor,1.5*factor]]]){
    if(!project[key]?.length)continue;
    ctx.beginPath();pathRing(ctx,project[key],geometry);ctx.strokeStyle=color;ctx.lineWidth=lineWidth*factor;ctx.setLineDash(dash);ctx.stroke();
  }
  ctx.setLineDash([]);const [x,y]=mapPoint([project.location.lng,project.location.lat],geometry);
  ctx.beginPath();ctx.arc(x,y,1.6*factor,0,Math.PI*2);ctx.fillStyle='#ef4444';ctx.fill();ctx.strokeStyle='#ffffff';ctx.lineWidth=.6*factor;ctx.stroke();
  ctx.font=`bold ${3.5*factor}px sans-serif`;ctx.lineWidth=.9*factor;ctx.strokeStyle='#ffffff';ctx.strokeText('SITE',x+3*factor,y-2*factor);ctx.fillStyle='#111111';ctx.fillText('SITE',x+3*factor,y-2*factor);
}
/** Independently sized raster, including map overlays. Never reads or mutates the editor. */
export async function composeMap({project,code,features=[],geometry,signal,onProgress=()=>{},requestTimeoutMs=30000}){
  throwIfAborted(signal);
  if(typeof document==='undefined')throw new Error('Map composition requires a browser canvas.');
  const {width,height}=geometry.raster;
  if(!(width>0&&height>0)||width*height>MAX_RASTER_PIXELS)throw new Error('Unsafe canvas size; choose 300 DPI.');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  // This visible, independent surface has real layout dimensions and source credit.
  // It never moves, resizes or reads the editor map.
  const preview=document.createElement('div'),caption=document.createElement('div');
  preview.setAttribute('aria-label',`Composing Figure ${code}`);
  Object.assign(preview.style,{position:'fixed',right:'16px',bottom:'16px',zIndex:'7000',width:'240px',background:'white',color:'#111',padding:'6px',border:'1px solid #475569',font:'11px sans-serif',pointerEvents:'none'});
  Object.assign(canvas.style,{display:'block',width:'240px',height:`${240*height/width}px`});
  caption.textContent=`Figure ${code} · ${sourceForFigure(code).credits}`;preview.append(canvas,caption);document.body.append(preview);
  let disposed=false;const dispose=()=>{if(!disposed){disposed=true;canvas.width=canvas.height=0;preview.remove();}};
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  let firstError;
  try{
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('The browser could not allocate a map canvas.');
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    const requests=imageryPlan(code,geometry);let cursor=0,complete=0;
    async function worker(){
      while(cursor<requests.length&&!controller.signal.aborted){
        const request=requests[cursor++];let image;
        const timeout=setTimeout(()=>{firstError??=new Error(`${sourceForFigure(code).label} image request timed out. Check your connection and retry.`);controller.abort();},Math.max(1,Math.min(45000,requestTimeoutMs||30000)));
        try{
          throwIfAborted(controller.signal);
          const response=await fetch(request.url,{mode:'cors',signal:controller.signal});
          if(!response.ok)throw new Error(`${sourceForFigure(code).label} image request failed (HTTP ${response.status}).`);
          if(!/^image\/(png|jpeg|webp)/i.test(response.headers.get('content-type')||''))throw new Error(`${sourceForFigure(code).label} returned an error instead of a map image.`);
          const blob=await response.blob();if(blob.size>16000000)throw new Error('Map image response exceeds the safe size.');
          image=await decodeImage(blob,controller.signal);throwIfAborted(controller.signal);
          if(image.width!==request.expectedWidth||image.height!==request.expectedHeight)throw new Error('Map service returned unexpected image dimensions.');
          ctx.drawImage(image,request.x,request.y,request.width,request.height);
          onProgress({phase:'imagery',code,completed:++complete,total:requests.length});
        }catch(error){firstError??=error;controller.abort();}finally{clearTimeout(timeout);image?.close?.();}
      }
    }
    await Promise.all(Array.from({length:Math.min(4,requests.length)},worker));
    throwIfAborted(signal);if(firstError)throw firstError;
    paintMapOverlays(ctx,{project,features,geometry});throwIfAborted(signal);
    const dataUrl=canvas.toDataURL('image/jpeg',.94);if(!dataUrl.startsWith('data:image/jpeg'))throw new Error('Map canvas encoding failed.');
    return {dataUrl,width,height,bounds:geometry.bounds,dispose};
  }catch(error){dispose();throw error;}finally{signal?.removeEventListener('abort',cancel);}
}

function containsBounds(coverage,bounds){return bounds.west>=coverage.west&&bounds.east<=coverage.east&&bounds.south>=coverage.south&&bounds.north<=coverage.north;}
function sameCoverage(left,right){return Boolean(left&&right&&['west','south','east','north'].every(key=>left[key]===right[key]));}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.getOwnPropertyDescriptor(value,key)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));}
function same(left,right){return JSON.stringify(left)===JSON.stringify(right);}
function providerMap(providers=DEFAULT_HISTORICAL_PROVIDERS){
  if(!Array.isArray(providers))throw new Error('Historical imagery providers must be an array.');
  const result=new Map();for(const provider of providers){validateImageryProvider(provider);if(result.has(provider.id))throw new Error(`Duplicate historical imagery provider: ${provider.id}.`);result.set(provider.id,provider);}return result;
}
function checkedHistorical({project,item,geometry}){
  const expected=historicalSheetGeometry(project,item,geometry?.dpi);
  for(const key of ['code','itemId','bounds','projected','raster'])if(!same(expected[key],geometry?.[key]))throw new Error(`${historicalCode(item)}: composition geometry no longer matches the approved crop.`);
  return expected;
}
function officialProvider(project,item,providers){
  const provider=providerMap(providers).get(item.providerId),code=historicalCode(item);
  if(item.mode!=='official'||item.policy!=='exportable'||item.placement!==null||item.assetId!==null||!item.officialExport)throw new Error(`${code}: only approved official exportable imagery can use the official compositor.`);
  if(!provider)throw new Error(`${code}: the saved official provider is no longer registered.`);
  if(provider.policy!=='exportable')throw new Error(`${code}: the current provider policy no longer permits export.`);
  let covers=false;try{covers=provider.covers(project.location)===true;}catch{}
  if(!covers||!containsBounds(provider.coverage,item.bounds))throw new Error(`${code}: the current official provider coverage does not include SITE and the approved crop.`);
  if(item.licenseUrl!==provider.licenseUrl)throw new Error(`${code}: the saved licence no longer matches the current provider policy.`);
  validateProviderUrl(item.sourceUrl,provider,{label:`${code} source URL`});validateProviderUrl(item.licenseUrl,provider,{label:`${code} licence URL`});validateProviderUrl(item.officialExport.url,provider,{label:`${code} export URL`});
  const exportUrl=new URL(item.officialExport.url);
  if(!SUPPORTED_OFFICIAL_EXPORT_KINDS.has(item.officialExport.kind))throw new Error(`${code}: the approved export descriptor kind is unsupported.`);
  if(item.officialExport.kind==='arcgis-export'){
    if(exportUrl.search||exportUrl.hash||!/\/MapServer\/export\/?$/.test(exportUrl.pathname))throw new Error(`${code}: the approved ArcGIS export descriptor is unsupported.`);
  }else if(item.officialExport.kind==='wms-export'){
    if(exportUrl.hash||!exportUrl.searchParams.get('LAYERS')||!exportUrl.searchParams.get('TIME'))throw new Error(`${code}: the approved WMS export descriptor is unsupported.`);
  }
  for(const key of ['maxWidth','maxHeight'])if(!Number.isSafeInteger(item.officialExport[key])||item.officialExport[key]<256)throw new Error(`${code}: the current official export dimensions are unsafe.`);
  if(typeof item.officialExport.resultId!=='string'||!item.officialExport.coverage||!item.officialExport.preview)throw new Error(`${code}: the approved source predates strict identity validation. Reopen and approve the official image again.`);
  return provider;
}

function previewSnapshot(value){return {kind:value.kind,url:value.url,layer:Object.hasOwn(value,'layer')?value.layer:null,tileTemplate:Object.hasOwn(value,'tileTemplate')?value.tileTemplate:null};}
function exportSnapshot(value){return {kind:value.kind,url:value.url,layer:Object.hasOwn(value,'layer')?value.layer:null,maxWidth:value.maxWidth,maxHeight:value.maxHeight};}
function validateCurrentOfficialResult(project,item,provider,currentResult){
  const code=historicalCode(item);try{validateImageryResult(currentResult,provider);}catch(error){throw new Error(`${code}: the current official result is invalid: ${error.message}`,{cause:error});}
  const expected=item.officialExport,currentExport=currentResult.export;
  if(currentResult.id!==expected.resultId)throw new Error(`${code}: the current official source identity no longer matches the approval.`);
  if(currentResult.year!==item.year||currentResult.title!==item.title||currentResult.resolutionMeters!==item.resolutionMeters)throw new Error(`${code}: the current official year, title, or resolution changed. Reopen and approve the source again.`);
  if(currentResult.policy!=='exportable'||currentResult.sourceUrl!==item.sourceUrl||currentResult.licenseUrl!==item.licenseUrl||currentResult.attribution!==item.attribution)throw new Error(`${code}: the current official source policy, licence, attribution, or URL changed. Reopen and approve the source again.`);
  if(!sameCoverage(currentResult.coverage,expected.coverage)||!containsBounds(currentResult.coverage,item.bounds))throw new Error(`${code}: the current official source footprint changed or no longer covers the approved crop.`);
  if(!same(previewSnapshot(currentResult.preview),expected.preview))throw new Error(`${code}: the current official preview service changed. Reopen and approve the source again.`);
  if(!currentExport||!same(exportSnapshot(currentExport),{kind:expected.kind,url:expected.url,layer:expected.layer,maxWidth:expected.maxWidth,maxHeight:expected.maxHeight}))throw new Error(`${code}: the current official export service, layer, or dimensions changed. Reopen and approve the source again.`);
  for(const [url,label,template] of [[currentResult.sourceUrl,'current source URL',false],[currentResult.licenseUrl,'current licence URL',false],[currentResult.preview.url,'current preview URL',false],[currentResult.preview.tileTemplate,'current preview tile URL',true],[currentExport.url,'current export URL',false]])if(url!==undefined&&url!==null)validateProviderUrl(url,provider,{label:`${code} ${label}`,template});
  let siteCovered=false;try{siteCovered=provider.covers(project.location)===true;}catch{}if(!siteCovered)throw new Error(`${code}: the current official provider no longer covers SITE.`);
  return currentResult;
}

export async function revalidateHistoricalOfficialSource({project,item,providers,signal,fetchImpl=globalThis.fetch}={}){
  throwIfAborted(signal);const provider=officialProvider(project,item,providers),code=historicalCode(item),grouped=await searchOfficialImagery({providers:[provider],location:project.location,year:item.year,signal,fetchImpl});throwIfAborted(signal);
  const current=[...grouped.exact,...grouped.nearby,...grouped.remaining].find(result=>result.id===item.officialExport.resultId);
  if(!current){const detail=grouped.errors?.[0]?.message?` ${grouped.errors[0].message}`:'';throw new Error(`${code}: the approved official source is no longer returned by its current provider.${detail} Reopen and approve a source again.`);}
  return validateCurrentOfficialResult(project,item,provider,current);
}

export function historicalImageryPlan({project,item,geometry,providers,currentResult}={}){
  checkedHistorical({project,item,geometry});const provider=officialProvider(project,item,providers);validateCurrentOfficialResult(project,item,provider,currentResult);const descriptor=item.officialExport,{width,height}=geometry.raster;
  const columns=Math.ceil(width/descriptor.maxWidth),rows=Math.ceil(height/descriptor.maxHeight);
  if(columns*rows>MAX_HISTORICAL_TILES)throw new Error(`${historicalCode(item)}: the official source would require too many bounded export pieces.`);
  const requests=[],serviceUrl=descriptor.url.replace(/\/export\/?$/,'');
  for(let row=0,y=0;row<rows;row++){
    const tileHeight=Math.min(descriptor.maxHeight,height-y);
    for(let column=0,x=0;column<columns;column++){
      const tileWidth=Math.min(descriptor.maxWidth,width-x),west=geometry.projected.west+(geometry.projected.east-geometry.projected.west)*x/width,east=geometry.projected.west+(geometry.projected.east-geometry.projected.west)*(x+tileWidth)/width;
      const north=geometry.projected.north-(geometry.projected.north-geometry.projected.south)*y/height,south=geometry.projected.north-(geometry.projected.north-geometry.projected.south)*(y+tileHeight)/height;
      const [westLng,southLat]=unprojectPoint([west,south]),[eastLng,northLat]=unprojectPoint([east,north]),bounds={west:westLng,south:southLat,east:eastLng,north:northLat};
      let url;
      if(descriptor.kind==='wms-export'){
        url=wmsGetMapUrl({serviceUrl:descriptor.url,bounds,width:tileWidth,height:tileHeight,maxWidth:descriptor.maxWidth,maxHeight:descriptor.maxHeight});
      }else{
        url=arcGisExportUrl({serviceUrl,bounds,width:tileWidth,height:tileHeight,maxWidth:descriptor.maxWidth,maxHeight:descriptor.maxHeight});
        if(descriptor.layer!==null&&descriptor.layer!==undefined){const parsed=new URL(url);parsed.searchParams.set('layers',`show:${descriptor.layer}`);url=parsed.href;}
      }
      validateProviderUrl(url,provider,{label:`${historicalCode(item)} bounded export URL`});
      requests.push({url,x,y,width:tileWidth,height:tileHeight,expectedWidth:tileWidth,expectedHeight:tileHeight,bounds});x+=tileWidth;
    }
    y+=tileHeight;
  }
  return requests;
}

async function abortable(promise,signal){
  throwIfAborted(signal);if(!signal)return promise;
  return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(new DOMException('Export cancelled.','AbortError'));};signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});if(signal.aborted)abort();});
}
function declaredByteLength(headers,code){
  const value=headers?.get?.('content-length');if(value===null||value===undefined||value==='')return null;
  if(!/^(?:0|[1-9]\d*)$/.test(value))throw new Error(`${code}: the official service returned an invalid Content-Length.`);
  const length=Number(value);if(!Number.isSafeInteger(length))throw new Error(`${code}: the official response byte length is unsafe.`);return length;
}
async function readImageResponse(response,{signal,code}){
  const declared=declaredByteLength(response.headers,code);
  const reader=response.body?.getReader?.();if(!reader)throw new Error(`${code}: the official image response is not a readable byte stream.`);
  const chunks=[];let bytes=0,segments=0,complete=false,cancelled=false;
  const cancelReader=async reason=>{if(cancelled)return;cancelled=true;try{await reader.cancel(reason);}catch{}};
  try{
    while(true){
      const part=await abortable(reader.read(),signal);throwIfAborted(signal);if(!part||typeof part.done!=='boolean')throw new Error(`${code}: the official image stream returned an invalid segment.`);if(part.done){complete=true;break;}
      if(!(part.value instanceof Uint8Array))throw new Error(`${code}: the official image stream returned non-byte data.`);
      if(++segments>MAX_IMAGE_SEGMENTS)throw new Error(`${code}: the official image response has too many stream segments.`);
      bytes+=part.value.byteLength;
      chunks.push(part.value);
    }
    if(declared!==null&&bytes!==declared)throw new Error(`${code}: the official image response did not match its declared byte length.`);
    return new Blob(chunks,{type:response.headers.get('content-type')});
  }catch(error){await cancelReader(error);throw error;}
  finally{if(!complete&&signal?.aborted)await cancelReader(signal.reason);try{reader.releaseLock?.();}catch{}}
}
async function sha256(blob,signal){
  if(!globalThis.crypto?.subtle)throw new Error('Historical imagery integrity verification requires Web Crypto.');
  const bytes=await abortable(blob.arrayBuffer(),signal),digest=await abortable(globalThis.crypto.subtle.digest('SHA-256',bytes),signal);
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
function validateHistoricalAsset(asset,item){
  const code=historicalCode(item);
  if(!exactKeys(asset,['blob','metadata'])||!exactKeys(asset.metadata,HISTORICAL_ASSET_FIELDS))throw new Error(`${code}: the saved file is not a strict historical imagery asset.`);
  const metadata=asset.metadata;
  if(metadata.id!==item.assetId||metadata.kind!=='historical-image')throw new Error(`${code}: the saved asset belongs to another feature.`);
  if(!(asset.blob instanceof Blob)||!HISTORICAL_ASSET_MIMES.has(metadata.mime)||asset.blob.type!==metadata.mime||asset.blob.size!==metadata.size||!Number.isSafeInteger(metadata.size)||metadata.size<=0||metadata.size>MAX_MANUAL_ASSET_BYTES)throw new Error(`${code}: historical asset metadata does not match its Blob.`);
  if(!Number.isSafeInteger(metadata.width)||metadata.width<=0||!Number.isSafeInteger(metadata.height)||metadata.height<=0||metadata.width>Math.floor(MAX_RASTER_PIXELS/metadata.height))throw new Error(`${code}: historical asset dimensions are invalid.`);
  if(!/^[a-f0-9]{64}$/.test(metadata.sha256)||typeof metadata.createdAt!=='string'||Number.isNaN(Date.parse(metadata.createdAt)))throw new Error(`${code}: historical asset integrity metadata is invalid.`);
  if(item.mode!=='manual'||item.providerId!==null||item.officialExport!==null||item.assetId===null||!item.placement)throw new Error(`${code}: the approved manual imagery record is invalid.`);
  if(metadata.width!==item.placement.sourceWidth||metadata.height!==item.placement.sourceHeight)throw new Error(`${code}: historical asset dimensions do not match the immutable placement.`);
  return asset;
}
function pointInConvex(point,polygon){let sign=0;for(let index=0;index<polygon.length;index++){const a=polygon[index],b=polygon[(index+1)%polygon.length],cross=(b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0]);if(Math.abs(cross)<1e-6)continue;const next=Math.sign(cross);if(sign&&next!==sign)return false;sign=next;}return true;}
function validateManualCrop(project,item){
  const code=historicalCode(item);validatePlacement(item.placement,{location:project.location});const corners=placementCorners(item.placement),crop=[[item.bounds.west,item.bounds.north],[item.bounds.east,item.bounds.north],[item.bounds.east,item.bounds.south],[item.bounds.west,item.bounds.south]].map(projectWebMercator);
  if(crop.some(point=>!pointInConvex(point,corners)))throw new Error(`${code}: the approved crop is outside the immutable manual placement.`);
}
export async function loadHistoricalAssetSnapshot({project,item,assetStore,signal}={}){
  if(!assetStore||typeof assetStore.get!=='function')throw new Error(`${historicalCode(item)}: a historical asset store is required.`);
  validateManualCrop(project,item);const asset=await abortable(assetStore.get(item.assetId),signal);throwIfAborted(signal);
  if(!asset)throw new Error(`${historicalCode(item)}: Missing historical image asset. Restore the project package or re-add the image.`);
  validateHistoricalAsset(asset,item);if(await sha256(asset.blob,signal)!==asset.metadata.sha256)throw new Error(`${historicalCode(item)}: historical asset hash verification failed.`);
  return {metadata:{...asset.metadata},blob:asset.blob};
}

/** Independently composes the exact approved historical crop and shared project overlays. */
export async function composeHistoricalImage({project,item,geometry,assetStore,providers,currentOfficialResult,signal,onProgress=()=>{},fetchImpl=globalThis.fetch,requestTimeoutMs=30000}={}){
  throwIfAborted(signal);checkedHistorical({project,item,geometry});let requests=null,asset=null;
  if(item.mode==='official'){const current=currentOfficialResult??await revalidateHistoricalOfficialSource({project,item,providers,signal,fetchImpl});requests=historicalImageryPlan({project,item,geometry,providers,currentResult:current});}else asset=await loadHistoricalAssetSnapshot({project,item,assetStore,signal});
  throwIfAborted(signal);if(typeof document==='undefined')throw new Error('Historical image composition requires a browser canvas.');
  const {width,height}=geometry.raster;if(!(width>0&&height>0)||width*height>MAX_RASTER_PIXELS)throw new Error('Unsafe historical canvas size; choose 300 DPI.');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const preview=document.createElement('div'),caption=document.createElement('div'),code=historicalCode(item);
  preview.setAttribute('aria-label',`Composing ${code}`);Object.assign(preview.style,{position:'fixed',right:'16px',bottom:'16px',zIndex:'7000',width:'240px',background:'white',color:'#111',padding:'6px',border:'1px solid #475569',font:'11px sans-serif',pointerEvents:'none'});
  Object.assign(canvas.style,{display:'block',width:'240px',height:`${240*height/width}px`});caption.textContent=`${code} · ${item.title}`;preview.append(canvas,caption);document.body.append(preview);
  let disposed=false;const dispose=()=>{if(!disposed){disposed=true;canvas.width=canvas.height=0;preview.remove();}},controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  try{
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('The browser could not allocate a historical image canvas.');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    if(requests){
      let cursor=0,complete=0,firstError;
      async function worker(){while(cursor<requests.length&&!controller.signal.aborted){const request=requests[cursor++];let image;const timeout=setTimeout(()=>{firstError??=new Error(`${code}: official image request timed out. Check your connection and retry.`);controller.abort();},Math.max(1,Math.min(45000,requestTimeoutMs||30000)));try{
        throwIfAborted(controller.signal);const response=await fetchImpl(request.url,{mode:'cors',credentials:'omit',redirect:'error',signal:controller.signal});if(!response.ok)throw new Error(`${code}: official image request failed (HTTP ${response.status}).`);
        if(!/^image\/(png|jpeg|webp)/i.test(response.headers.get('content-type')||''))throw new Error(`${code}: the official service returned an error instead of an image.`);
        const blob=await readImageResponse(response,{signal:controller.signal,code});
        image=await decodeImage(blob,controller.signal);throwIfAborted(controller.signal);if(image.width!==request.expectedWidth||image.height!==request.expectedHeight)throw new Error(`${code}: the official service returned unexpected image dimensions.`);
        ctx.drawImage(image,request.x,request.y,request.width,request.height);onProgress({phase:'imagery',code,completed:++complete,total:requests.length});
      }catch(error){firstError??=error;controller.abort();}finally{clearTimeout(timeout);image?.close?.();}}}
      await Promise.all(Array.from({length:Math.min(4,requests.length)},worker));throwIfAborted(signal);if(firstError)throw firstError;
    }else{
      let image;try{image=await decodeImage(asset.blob,controller.signal);throwIfAborted(controller.signal);if(image.width!==asset.metadata.width||image.height!==asset.metadata.height)throw new Error(`${code}: decoded asset dimensions do not match its integrity metadata.`);
        const [a,b,c,d,e,f]=placementCanvasTransform(item.placement),scaleX=width/(geometry.projected.east-geometry.projected.west),scaleY=height/(geometry.projected.north-geometry.projected.south);
        ctx.save();ctx.setTransform(a*scaleX,-b*scaleY,c*scaleX,-d*scaleY,(e-geometry.projected.west)*scaleX,(geometry.projected.north-f)*scaleY);ctx.drawImage(image,0,0);ctx.restore();onProgress({phase:'imagery',code,completed:1,total:1});
      }finally{image?.close?.();}
    }
    paintMapOverlays(ctx,{project,geometry});throwIfAborted(signal);const dataUrl=canvas.toDataURL('image/jpeg',.94);if(!dataUrl.startsWith('data:image/jpeg'))throw new Error('Historical image canvas encoding failed.');return {dataUrl,width,height,bounds:{...geometry.bounds},dispose};
  }catch(error){dispose();if(signal?.aborted||error?.name==='AbortError')throw new DOMException('Export cancelled.','AbortError');throw error;}finally{signal?.removeEventListener('abort',cancel);}
}
