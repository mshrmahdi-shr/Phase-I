import {figureBounds,restoreProject} from './core.mjs';
import {decodeManualImage,parseWorldFile} from './imagery/manual-image.mjs';
import {createCanvasImageOverlay} from './imagery/canvas-overlay.mjs';
import {geographicPlacementCorners,placementCorners,placementFromExtent,placementFromGeoReference,projectWebMercator,unprojectWebMercator,validatePlacement} from './imagery/placement.mjs';
import {groupImageryResults,searchOfficialImagery} from './imagery/search.mjs';
import {validateAcquisitionYear,validateImageryProvider,validateImageryResult,validateProviderUrl} from './imagery/provider-registry.mjs';

const A3_RATIO=420/297;
const CROP_FILL=.9;
const MIN_OFFICIAL_EXPORT_DIMENSION=256;

function fail(message){throw new Error(message);}
function aborted(error){return error?.name==='AbortError';}
function abortError(){return new DOMException('Cancelled','AbortError');}
function clone(value){return JSON.parse(JSON.stringify(value));}
function uuid(factory){const value=factory?.();if(typeof value!=='string')fail('A secure UUID generator is required.');return value;}
function iso(factory){const value=factory?.();if(typeof value!=='string'||Number.isNaN(Date.parse(value)))fail('A valid clock is required.');return value;}
function objectBounds(bounds){return {north:bounds.getNorth(),south:bounds.getSouth(),east:bounds.getEast(),west:bounds.getWest()};}
function boundsPair(bounds){return [[bounds.south,bounds.west],[bounds.north,bounds.east]];}
function containsBounds(coverage,bounds){return bounds.west>=coverage.west&&bounds.east<=coverage.east&&bounds.south>=coverage.south&&bounds.north<=coverage.north;}
function containsSite(bounds,location){return location&&location.lat>=bounds.south&&location.lat<=bounds.north&&location.lng>=bounds.west&&location.lng<=bounds.east;}
function sourceName(filename){return String(filename||'').replace(/\.[^.]+$/,'').toLocaleLowerCase('en');}
function formatResolution(value){return value===null?'Not published':value<1?`${Math.round(value*100)} cm`:`${value} m`;}
function cropText(bounds){return `${bounds.west.toFixed(5)}, ${bounds.south.toFixed(5)} to ${bounds.east.toFixed(5)}, ${bounds.north.toFixed(5)}`;}
function nextSequence(project,year){
  const current=project.historicalSequenceCounters?.[year]||0;
  const existing=Math.max(0,...(project.historical||[]).filter(item=>item.year===year&&Number.isSafeInteger(item.sequence)).map(item=>item.sequence));
  return Math.max(current,existing)+1;
}
function safeOptionalUrl(value){
  const text=String(value??'').trim();if(!text)return null;
  if(text.length>8192||text.startsWith('//')||/[\u0000-\u001f\u007f\\]/.test(text))fail('Source URL must be a safe HTTPS URL.');
  let url;try{url=new URL(text);}catch{fail('Source URL must be a safe HTTPS URL.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash)fail('Source URL must be a safe HTTPS URL.');
  return url.href;
}

async function sha256(blob){
  if(!globalThis.crypto?.subtle?.digest)fail('Secure asset hashing is unavailable in this browser.');
  const digest=await globalThis.crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}

function dataUrlFile(item){
  const match=/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(item.dataUrl||'');
  if(!match)fail(`Legacy image ${item.name} has an invalid data URL.`);
  let binary;try{binary=globalThis.atob(match[2]);}catch{fail(`Legacy image ${item.name} has invalid base64 data.`);}
  if(binary.length!==item.size)fail(`Legacy image ${item.name} does not match its saved byte size.`);
  const bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));
  return {name:item.name,type:match[1].toLowerCase(),size:bytes.byteLength,arrayBuffer:async()=>bytes.slice().buffer};
}

function sitePlacement(project,image){
  if(!project.location)fail('Set SITE before migrating or placing historical imagery.');
  const initial=placementFromExtent({bounds:figureBounds(project.location,100),width:image.width,height:image.height});
  const placement={...initial,groundHeight:initial.groundWidth*image.height/image.width};
  validatePlacement(placement,{location:project.location});return placement;
}

function a3CropForPlacement(placement,location){
  const centre=projectWebMercator([location.lng,location.lat]),polygon=placementCorners(placement);
  let low=0,high=Math.max(placement.groundWidth,placement.groundHeight);
  for(let pass=0;pass<80;pass++){
    const halfWidth=(low+high)/2,halfHeight=halfWidth/A3_RATIO;
    const corners=[[-halfWidth,halfHeight],[halfWidth,halfHeight],[halfWidth,-halfHeight],[-halfWidth,-halfHeight]].map(([x,y])=>[centre[0]+x,centre[1]+y]);
    if(corners.every(point=>pointInConvex(point,polygon)))low=halfWidth;else high=halfWidth;
  }
  if(low<.05)fail('The legacy image does not provide a usable A3 crop around SITE.');
  const sw=unprojectWebMercator([centre[0]-low,centre[1]-low/A3_RATIO]),ne=unprojectWebMercator([centre[0]+low,centre[1]+low/A3_RATIO]);
  return {north:ne[1],south:sw[1],east:ne[0],west:sw[0]};
}

function manualItem({id,assetId,year,sequence,title,citation,sourceUrl,bounds,placement,createdAt}){
  return {id,year,sequence,title,mode:'manual',providerId:null,sourceUrl,licenseUrl:null,attribution:citation,policy:'exportable',
    resolutionMeters:null,bounds,placement,assetId,officialExport:null,createdAt,updatedAt:createdAt};
}

export function historicalFigureCode(items,itemId){
  if(!Array.isArray(items))fail('Historical imagery items must be an array.');
  const item=items.find(value=>value?.id===itemId);
  if(!item)fail('Historical imagery item was not found.');
  if(!Number.isInteger(item.year)||!Number.isSafeInteger(item.sequence)||item.sequence<=0)fail('Historical imagery item has no stable figure sequence.');
  return `H-${item.year}-${item.sequence}`;
}

export async function migrateLegacyHistoricalImagery({
  project,assetStore,saveProject,decodeImage=decodeManualImage,uuid:uuidFactory=()=>globalThis.crypto?.randomUUID?.(),now=()=>new Date().toISOString()
}={}){
  if(!project||!Array.isArray(project.historical)||!assetStore||typeof assetStore.put!=='function'||typeof assetStore.delete!=='function'||typeof saveProject!=='function')fail('Legacy imagery migration dependencies are incomplete.');
  const legacy=project.historical.filter(item=>item&&typeof item==='object'&&Object.hasOwn(item,'dataUrl'));
  if(!legacy.length)return {project,migrated:false};
  const candidate=clone(project),createdAssetIds=[];
  candidate.historical=candidate.historical.filter(item=>!Object.hasOwn(item,'dataUrl'));
  candidate.historicalSequenceCounters={...(candidate.historicalSequenceCounters||{})};
  try{
    for(const old of legacy){
      const file=dataUrlFile(old),decoded=await decodeImage(file),assetId=uuid(uuidFactory),itemId=uuid(uuidFactory),createdAt=iso(now);
      const placement=decoded.geo?placementFromGeoReference({geo:decoded.geo,width:decoded.width,height:decoded.height}):sitePlacement(candidate,decoded);
      validatePlacement(placement,{location:candidate.location});
      const bounds=a3CropForPlacement(placement,candidate.location),sequence=nextSequence(candidate,old.year);
      const asset={metadata:{id:assetId,kind:'historical-image',mime:decoded.mime,size:decoded.blob.size,width:decoded.width,height:decoded.height,
        sha256:await sha256(decoded.blob),createdAt},blob:decoded.blob};
      await assetStore.put(asset);createdAssetIds.push(assetId);
      candidate.historical.push(manualItem({id:itemId,assetId,year:old.year,sequence,title:old.name,citation:`Legacy local upload: ${old.name}`,
        sourceUrl:null,bounds,placement,createdAt}));
      candidate.historicalSequenceCounters[old.year]=sequence;
    }
    const normalized=restoreProject(candidate);
    const saved=await saveProject(normalized);if(saved===false)fail('Project metadata could not be saved.');
    return {project:normalized,migrated:true,assetIds:[...createdAssetIds]};
  }catch(error){
    await Promise.allSettled(createdAssetIds.map(id=>assetStore.delete(id)));
    throw new Error(`Legacy imagery migration failed: ${error.message} Export a project backup before retrying; the original project remains unchanged.`,{cause:error});
  }
}

function cropPixelSize(map){
  const size=map.getSize?.();
  if(size&&Number.isFinite(size.x)&&Number.isFinite(size.y)&&size.x>0&&size.y>0&&typeof map.containerPointToLatLng==='function'){
    const width=Math.min(size.x*CROP_FILL,size.y*CROP_FILL*A3_RATIO),height=width/A3_RATIO;
    return {mapWidth:size.x,mapHeight:size.y,width,height};
  }
  return null;
}

function currentCropBounds(map){
  const size=cropPixelSize(map);
  if(size){
    const {mapWidth,mapHeight,width,height}=size,left=(mapWidth-width)/2,top=(mapHeight-height)/2;
    const nw=map.containerPointToLatLng([left,top]),se=map.containerPointToLatLng([left+width,top+height]);
    const bounds={north:nw.lat,south:se.lat,east:se.lng,west:nw.lng};
    if(Object.values(bounds).every(Number.isFinite)&&bounds.north>bounds.south&&bounds.east>bounds.west)return bounds;
  }
  return objectBounds(map.getBounds());
}

function pointInConvex(point,polygon){
  let sign=0;
  for(let index=0;index<polygon.length;index++){
    const a=polygon[index],b=polygon[(index+1)%polygon.length],cross=(b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0]);
    if(Math.abs(cross)<1e-6)continue;const next=Math.sign(cross);if(sign&&next!==sign)return false;sign=next;
  }
  return true;
}

export function createHistoricalImageryUI({
  document,map,L,assetStore,providers,getProject,saveProject,onChanged=()=>{},fetchImpl=globalThis.fetch,
  decodeImage=decodeManualImage,overlayFactory=createCanvasImageOverlay,confirm=message=>globalThis.confirm(message),
  uuid:uuidFactory=()=>globalThis.crypto?.randomUUID?.(),now=()=>new Date().toISOString()
}={}){
  if(!document||!map||!L||!assetStore||typeof getProject!=='function'||typeof saveProject!=='function'||!Array.isArray(providers))fail('Historical imagery UI dependencies are incomplete.');
  for(const provider of providers)validateImageryProvider(provider);
  const providerById=new Map(providers.map(provider=>[provider.id,provider]));
  const ids=['historicalDialog','closeHistorical','historicalOfficialMode','historicalManualMode','historicalOfficialPanel','historicalManualPanel','historicalYear','searchHistorical','cancelHistoricalSearch','historicalSearchProgress','historicalProviderErrors','showAllHistorical','manualHistoricalYear','manualHistoricalFile','manualWorldFile','manualWorldCrs','manualCitation','manualSourceUrl','manualPermission','previewManualHistorical','manualPlacementControls','manualCenterLat','manualCenterLng','manualGroundWidth','manualGroundHeight','manualRotation','applyManualPlacement','drawManualExtent','historicalCropControls','historicalCropTitle','useHistoricalCrop','resetHistoricalCrop','cancelHistoricalCrop','commitHistorical','historicalStatus','historicalCropFrame','historicalApprovedList','aerialCount'];
  const elements=Object.fromEntries(ids.map(id=>{const element=document.getElementById(id);if(!element)fail(`Historical imagery UI is missing #${id}.`);return [id,element];}));
  const $=id=>elements[id],WindowAbortController=document.defaultView?.AbortController||globalThis.AbortController,bindings=new WindowAbortController();
  let alive=true,open=false,mode='official',lastFocus=null,searchController=null,searchGeneration=0,previewGeneration=0,refreshGeneration=0;
  let results=new Map(),errors=new Map(),requestedYear=null,active=null,pending=Promise.resolve(),mutating=false,extentPoints=[];

  function track(operation){const current=Promise.resolve(operation).catch(error=>{if(!aborted(error))showStatus(error.message,'error');});pending=current;return current;}
  function showStatus(message,kind=''){$('historicalStatus').textContent=message||'';$('historicalStatus').dataset.kind=kind;}
  function setSearchBusy(value){$('searchHistorical').disabled=value;$('cancelHistoricalSearch').hidden=!value;}
  function textElement(tag,text,className){const element=document.createElement(tag);if(className)element.className=className;element.textContent=String(text??'');return element;}
  function safeAnchor(label,url){const anchor=textElement('a',label);anchor.href=url;anchor.target='_blank';anchor.rel='noopener noreferrer';return anchor;}
  function mapSnapshot(){return {center:map.getCenter?.(),zoom:map.getZoom?.(),bounds:objectBounds(map.getBounds())};}
  function restoreMap(snapshot){if(snapshot?.center&&Number.isFinite(snapshot.zoom)&&typeof map.setView==='function')map.setView(snapshot.center,snapshot.zoom,{animate:false});else if(snapshot?.bounds)map.fitBounds(boundsPair(snapshot.bounds),{animate:false});}
  function removeLayer(layer){try{layer?.remove?.();if(layer&&map.hasLayer?.(layer))map.removeLayer(layer);}catch{}}
  function removeExtentListener(){map.off?.('click',onExtentClick);extentPoints=[];$('drawManualExtent').dataset.active='false';}
  function removeActive({restore=false}={}){
    previewGeneration++;removeExtentListener();
    if(active){active.controller?.abort(abortError());removeLayer(active.layer);removeLayer(active.overlay);if(restore)restoreMap(active.before);}
    active=null;$('historicalDialog').classList.remove('historical-cropping');$('historicalCropControls').hidden=true;$('historicalCropFrame').hidden=true;$('manualPlacementControls').hidden=true;$('commitHistorical').disabled=true;$('commitHistorical').textContent='Add to package';
  }
  function resetBoundsFor(item){
    const project=getProject();if(item?.bounds)return item.bounds;
    const saved=project.figures?.B?.bounds;if(saved&&containsSite(saved,project.location))return saved;
    return figureBounds(project.location,100);
  }
  function syncCropFrame(){
    const size=cropPixelSize(map),frame=$('historicalCropFrame');
    if(!size){frame.style.removeProperty('width');frame.style.removeProperty('height');return;}
    frame.style.width=`${size.width}px`;frame.style.height=`${size.height}px`;
  }
  function showCrop(item){syncCropFrame();$('historicalDialog').classList.add('historical-cropping');$('historicalCropControls').hidden=false;$('historicalCropFrame').hidden=false;$('commitHistorical').textContent=item?'Update approved crop':'Add to package';$('commitHistorical').disabled=true;}

  function officialPreviewLayer(result){
    if(result.preview?.tileTemplate&&typeof L.tileLayer==='function')return L.tileLayer(result.preview.tileTemplate,{attribution:result.attribution,maxNativeZoom:24}).addTo(map);
    return null;
  }

  async function beginOfficial(result,item=null){
    const provider=providerById.get(result.providerId);validateImageryResult(result,provider);
    removeActive({restore:true});const before=mapSnapshot(),token=++previewGeneration;
    active={kind:'official',result,item,before,provider,layer:officialPreviewLayer(result),crop:null,token};
    map.fitBounds(boundsPair(resetBoundsFor(item)),{animate:false,padding:[0,0]});showCrop(item);showStatus(`Previewing ${result.title}. Pan or zoom, then choose Use current crop.`,'ok');
  }

  function storedOfficialResult(item){
    const provider=providerById.get(item.providerId);if(!provider)fail('The saved official provider is no longer registered.');
    for(const [url,label] of [[item.sourceUrl,'Saved source URL'],[item.licenseUrl,'Saved license URL'],[item.officialExport.url,'Saved export URL']])validateProviderUrl(url,provider,{label});
    if(item.licenseUrl!==provider.licenseUrl)fail('The saved imagery license no longer matches its provider.');
    return {id:`${item.providerId}:saved-${item.id}`,providerId:item.providerId,title:item.title,year:item.year,resolutionMeters:item.resolutionMeters,
      coverage:{...provider.coverage},preview:{kind:'official-link',url:item.sourceUrl},export:{kind:item.officialExport.kind,url:item.officialExport.url,
        ...(item.officialExport.layer===null?{}:{layer:item.officialExport.layer}),maxWidth:item.officialExport.maxWidth,maxHeight:item.officialExport.maxHeight},
      policy:'exportable',sourceUrl:item.sourceUrl,licenseUrl:item.licenseUrl,attribution:item.attribution};
  }

  async function beginStoredOfficial(item){
    const stored=storedOfficialResult(item),provider=providerById.get(item.providerId),project=getProject();removeActive({restore:true});
    const before=mapSnapshot(),controller=new AbortController(),token=++previewGeneration;active={kind:'loading',item,before,controller,token};showStatus('Refreshing official source coverage before editing…');
    try{
      const grouped=await searchOfficialImagery({providers:[provider],location:project.location,year:item.year,signal:controller.signal,fetchImpl});
      if(!alive||token!==previewGeneration)return;
      const current=[...grouped.exact,...grouped.nearby,...grouped.remaining].find(value=>value.sourceUrl===stored.sourceUrl&&value.export?.url===stored.export.url);
      if(!current)fail('The approved official source could not be revalidated for editing. Its saved crop remains unchanged.');
      removeActive({restore:false});await beginOfficial(current,item);
    }catch(error){if(active?.token===token)removeActive({restore:true});throw error;}
  }

  function renderCard(result){
    const card=document.createElement('article');card.className='historical-result';card.dataset.resultId=result.id;
    card.append(textElement('div','Official preview','historical-result-thumbnail'));
    card.append(textElement('h4',result.title,'historical-result-title'));
    const metadata=textElement('div','', 'historical-result-meta');
    for(const line of [`Year: ${result.year}`,`Source: ${providerById.get(result.providerId)?.label||result.providerId}`,`Resolution: ${formatResolution(result.resolutionMeters)}`,`Policy: ${result.policy}`,`Attribution: ${result.attribution}`])metadata.append(textElement('span',line));
    metadata.append(safeAnchor('Official source',result.sourceUrl),' · ',safeAnchor('License',result.licenseUrl));card.append(metadata);
    if(result.policy==='exportable'){
      const button=textElement('button','Preview and crop');button.type='button';button.addEventListener('click',()=>track(beginOfficial(result)),{signal:bindings.signal});card.append(button);
    }else{
      const message=result.policy==='link-only'?'This record is link-only; image bytes are not available for export.':'Export permission or a reproducible image endpoint is unavailable.';
      card.append(textElement('p',message,'historical-policy-note'),safeAnchor('Open official source',result.sourceUrl));
    }
    return card;
  }

  function renderErrors(){
    const host=$('historicalProviderErrors');host.replaceChildren();
    for(const error of [...errors.values()]){
      const row=document.createElement('div');row.className='historical-provider-error';row.append(textElement('span',`${providerById.get(error.providerId)?.label||error.providerId}: ${error.message}`));
      const retry=textElement('button','Retry');retry.type='button';retry.dataset.retryProvider=error.providerId;retry.addEventListener('click',()=>track(retryProvider(error.providerId)),{signal:bindings.signal});row.append(retry);host.append(row);
    }
  }

  function renderResults(){
    const grouped=groupImageryResults([...results.values()],requestedYear,{providers});
    for(const key of ['exact','nearby','remaining']){const host=document.querySelector(`[data-result-group="${key}"]`);host.replaceChildren(...grouped[key].map(renderCard));}
    const hasRemaining=grouped.remaining.length>0;$('showAllHistorical').hidden=!hasRemaining;
    const remaining=document.querySelector('[data-result-group="remaining"]'),section=document.querySelector('[data-result-group="remaining-section"]');remaining.hidden=true;section.hidden=true;
    renderErrors();
  }

  async function search(){
    const project=getProject();if(!project.location)fail('Set SITE before searching official imagery.');
    const year=validateAcquisitionYear(Number($('historicalYear').value),'Requested year');
    searchController?.abort(abortError());const controller=new AbortController(),generation=++searchGeneration;searchController=controller;setSearchBusy(true);
    results=new Map();errors=new Map();requestedYear=year;renderResults();$('historicalSearchProgress').textContent='Searching official providers…';
    try{
      const grouped=await searchOfficialImagery({providers,location:project.location,year,signal:controller.signal,fetchImpl,onProgress:event=>{
        if(alive&&generation===searchGeneration)$('historicalSearchProgress').textContent=`${providerById.get(event.providerId)?.label||event.providerId}: ${event.status}`;
      }});
      if(!alive||generation!==searchGeneration)return;
      for(const value of [...grouped.exact,...grouped.nearby,...grouped.remaining])results.set(value.id,value);
      for(const error of grouped.errors)errors.set(error.providerId,error);renderResults();
      $('historicalSearchProgress').textContent=`Found ${results.size} official record${results.size===1?'':'s'}.`;showStatus(results.size?'Choose an exportable record to preview and crop.':'No matching official imagery was found.');
    }finally{if(generation===searchGeneration){searchController=null;setSearchBusy(false);}}
  }

  async function retryProvider(providerId){
    const provider=providerById.get(providerId);if(!provider||requestedYear===null)fail('The provider retry is no longer available.');
    const project=getProject(),controller=new AbortController(),generation=searchGeneration;searchController?.abort(abortError());searchController=controller;setSearchBusy(true);
    try{
      const grouped=await searchOfficialImagery({providers:[provider],location:project.location,year:requestedYear,signal:controller.signal,fetchImpl});
      if(!alive||generation!==searchGeneration)return;
      for(const [id,value] of results)if(value.providerId===providerId)results.delete(id);
      for(const value of [...grouped.exact,...grouped.nearby,...grouped.remaining])results.set(value.id,value);
      errors.delete(providerId);for(const error of grouped.errors)errors.set(error.providerId,error);renderResults();
    }finally{if(generation===searchGeneration){searchController=null;setSearchBusy(false);}}
  }

  function updatePlacementFields(placement){
    const [lng,lat]=unprojectWebMercator(placement.center);$('manualCenterLat').value=String(lat);$('manualCenterLng').value=String(lng);
    $('manualGroundWidth').value=String(placement.groundWidth);$('manualGroundHeight').value=String(placement.groundHeight);$('manualRotation').value=String(placement.rotationDegrees);
  }

  async function replaceManualOverlay(placement){
    if(!active||active.kind!=='manual')return;const token=++previewGeneration;removeLayer(active.overlay);active.placement=placement;
    const overlay=overlayFactory({L,map,image:active.image,placement,signal:active.controller.signal});active.overlay=overlay.addTo(map);await active.overlay.ready;
    if(!alive||token!==previewGeneration){removeLayer(overlay);return;}updatePlacementFields(placement);
  }

  async function previewManual(){
    const project=getProject();if(!project.location)fail('Set SITE before placing manual imagery.');
    const year=validateAcquisitionYear(Number($('manualHistoricalYear').value),'Manual imagery year'),citation=$('manualCitation').value.trim();
    if(!citation)fail('A source or citation is required for manual imagery.');if(!$('manualPermission').checked)fail('Confirm reproduction permission before previewing manual imagery.');
    const file=$('manualHistoricalFile').files?.[0];if(!file)fail('Choose a manual image file.');
    const world=$('manualWorldFile').files?.[0];if(world&&sourceName(world.name)!==sourceName(file.name))fail('The world file basename must match the image basename.');
    if(world&&(!Number.isSafeInteger(world.size)||world.size<=0||world.size>64_000))fail('World file must be nonempty and no larger than 64 KB.');
    const sourceUrl=safeOptionalUrl($('manualSourceUrl').value),controller=new AbortController();removeActive({restore:true});const before=mapSnapshot(),token=++previewGeneration;
    active={kind:'manual',before,controller,file,image:null,placement:null,overlay:null,crop:null,item:null,year,citation,sourceUrl,token};showStatus('Decoding and validating the selected image…');
    try{
      const image=await decodeImage(file,{signal:controller.signal});if(!alive||token!==previewGeneration)return;
      if(world&&image.geo)fail('Do not attach a world file to an already georeferenced GeoTIFF.');
      let placement;
      if(image.geo)placement=placementFromGeoReference({geo:image.geo,width:image.width,height:image.height});
      else if(world)placement=placementFromGeoReference({geo:{crs:$('manualWorldCrs').value,transform:parseWorldFile(await world.text())},width:image.width,height:image.height});
      else placement=sitePlacement(project,image);
      validatePlacement(placement,{location:project.location});active.image=image;active.placement=placement;
      map.fitBounds(boundsPair(extentForPlacement(placement)),{animate:false,padding:[0,0]});showCrop(null);$('manualPlacementControls').hidden=false;
      await replaceManualOverlay(placement);showStatus('Image placement is ready. Adjust it if needed, then choose Use current crop.','ok');
    }catch(error){if(active?.token===token)removeActive({restore:true});throw error;}
  }

  function extentForPlacement(placement){
    const corners=geographicPlacementCorners(placement),lng=corners.map(point=>point[0]),lat=corners.map(point=>point[1]);
    return {west:Math.min(...lng),south:Math.min(...lat),east:Math.max(...lng),north:Math.max(...lat)};
  }

  async function applyPlacement(){
    if(!active||active.kind!=='manual')fail('Open a manual image before changing placement.');
    const placement={...active.placement,center:projectWebMercator([Number($('manualCenterLng').value),Number($('manualCenterLat').value)]),
      groundWidth:Number($('manualGroundWidth').value),groundHeight:Number($('manualGroundHeight').value),rotationDegrees:Number($('manualRotation').value)};
    validatePlacement(placement,{location:getProject().location});await replaceManualOverlay(placement);active.crop=null;$('commitHistorical').disabled=true;showStatus('Placement updated. Choose Use current crop again.','ok');
  }

  function onExtentClick(event){
    const point=event?.latlng;if(!Number.isFinite(point?.lat)||!Number.isFinite(point?.lng))return;extentPoints.push({lat:point.lat,lng:point.lng});
    if(extentPoints.length<2){showStatus('Select the opposite corner of the image extent.');return;}
    const [a,b]=extentPoints;removeExtentListener();
    try{
      const bounds={west:Math.min(a.lng,b.lng),south:Math.min(a.lat,b.lat),east:Math.max(a.lng,b.lng),north:Math.max(a.lat,b.lat)};
      const placement=placementFromExtent({bounds,width:active.image.width,height:active.image.height});validatePlacement(placement,{location:getProject().location});track(replaceManualOverlay(placement));active.crop=null;$('commitHistorical').disabled=true;
    }catch(error){showStatus(error.message,'error');}
  }

  function drawExtent(){if(!active||active.kind!=='manual')fail('Open a manual image before drawing its extent.');removeExtentListener();extentPoints=[];$('drawManualExtent').dataset.active='true';map.on('click',onExtentClick);showStatus('Select two opposite image-extent corners on the map.');}

  function validateManualCrop(bounds,placement){
    validatePlacement(placement,{location:getProject().location});if(!containsSite(bounds,getProject().location))fail('The A3 crop must contain SITE.');
    const imagePolygon=placementCorners(placement),cropCorners=[[bounds.west,bounds.north],[bounds.east,bounds.north],[bounds.east,bounds.south],[bounds.west,bounds.south]].map(projectWebMercator);
    if(cropCorners.some(point=>!pointInConvex(point,imagePolygon)))fail('The A3 crop must stay inside the placed manual image.');
  }

  function useCrop(){
    if(!active)fail('Open an image before saving a crop.');const bounds=currentCropBounds(map);if(!containsSite(bounds,getProject().location))fail('The A3 crop must contain SITE.');
    if(active.kind==='official'){
      validateImageryResult(active.result,active.provider);if(!containsBounds(active.result.coverage,bounds))fail('The requested crop is outside this official source coverage.');
      if(active.result.export.maxWidth<MIN_OFFICIAL_EXPORT_DIMENSION||active.result.export.maxHeight<MIN_OFFICIAL_EXPORT_DIMENSION)fail('The official provider maximum export dimensions are too small for an A3 crop.');
    }else validateManualCrop(bounds,active.placement);
    active.crop={...bounds};$('commitHistorical').disabled=false;showStatus(`Crop selected: ${cropText(bounds)}`,'ok');
  }

  function resetCrop(){if(!active)fail('Open an image before resetting the crop.');map.fitBounds(boundsPair(resetBoundsFor(active.item)),{animate:false,padding:[0,0]});active.crop=null;$('commitHistorical').disabled=true;showStatus('Crop reset to SITE. Choose Use current crop to approve it.');}

  async function persist(next){const normalized=restoreProject(next),saved=await saveProject(normalized);if(saved===false)fail('Project metadata could not be saved.');await onChanged(normalized);return normalized;}

  async function commitActive(){
    if(mutating)return;if(!active?.crop)fail('Choose Use current crop before adding the image.');mutating=true;$('commitHistorical').disabled=true;
    let rollbackAssetId=null;
    try{
      const project=clone(getProject()),stamp=iso(now),existing=active.item,year=existing?.year??(active.kind==='official'?active.result.year:active.year);
      project.historical=project.historical||[];project.historicalSequenceCounters={...(project.historicalSequenceCounters||{})};
      const sequence=existing?.sequence??nextSequence(project,year),id=existing?.id??uuid(uuidFactory),createdAt=existing?.createdAt??stamp;
      let item;
      if(active.kind==='official'){
        const descriptor=active.result.export;
        item={id,year,sequence,title:active.result.title,mode:'official',providerId:active.result.providerId,sourceUrl:active.result.sourceUrl,
          licenseUrl:active.result.licenseUrl,attribution:active.result.attribution,policy:'exportable',resolutionMeters:active.result.resolutionMeters,
          bounds:{...active.crop},placement:null,assetId:null,officialExport:{kind:descriptor.kind,url:descriptor.url,layer:Object.hasOwn(descriptor,'layer')?descriptor.layer:null,maxWidth:descriptor.maxWidth,maxHeight:descriptor.maxHeight},createdAt,updatedAt:stamp};
      }else{
        let assetId=existing?.assetId;
        if(!assetId){
          assetId=uuid(uuidFactory);const asset={metadata:{id:assetId,kind:'historical-image',mime:active.image.mime,size:active.image.blob.size,width:active.image.width,height:active.image.height,
            sha256:await sha256(active.image.blob),createdAt:stamp},blob:active.image.blob};
          await assetStore.put(asset);rollbackAssetId=assetId;
        }
        item=manualItem({id,assetId,year,sequence,title:existing?.title??active.file.name,citation:active.citation,sourceUrl:active.sourceUrl,bounds:{...active.crop},placement:{...active.placement,center:[...active.placement.center]},createdAt});item.updatedAt=stamp;
      }
      const index=project.historical.findIndex(value=>value.id===id);if(index<0)project.historical.push(item);else project.historical[index]=item;
      project.historicalSequenceCounters[year]=Math.max(project.historicalSequenceCounters[year]||0,sequence);await persist(project);rollbackAssetId=null;
      removeActive({restore:false});await refresh();showStatus(`${historicalFigureCode(getProject().historical,id)} saved.`, 'ok');
    }catch(error){if(rollbackAssetId)await assetStore.delete(rollbackAssetId).catch(()=>{});throw error;}finally{mutating=false;if(active?.crop)$('commitHistorical').disabled=false;}
  }

  async function manualEdit(item){
    removeActive({restore:true});const before=mapSnapshot(),asset=await assetStore.get(item.assetId);if(!asset)fail('The manual image asset is missing. Restore it from a project backup before editing.');
    const controller=new AbortController(),token=++previewGeneration,image={blob:asset.blob,mime:asset.metadata.mime,width:asset.metadata.width,height:asset.metadata.height,geo:null};
    active={kind:'manual',item,before,controller,file:{name:item.title},image,placement:clone(item.placement),overlay:null,crop:null,year:item.year,citation:item.attribution,sourceUrl:item.sourceUrl,token};
    $('manualHistoricalYear').value=String(item.year);$('manualCitation').value=item.attribution;$('manualSourceUrl').value=item.sourceUrl||'';$('manualPermission').checked=true;setMode('manual');
    map.fitBounds(boundsPair(item.bounds),{animate:false});showCrop(item);$('manualPlacementControls').hidden=false;await replaceManualOverlay(active.placement);showStatus(`Editing ${historicalFigureCode(getProject().historical,item.id)}. Approved bounds change only after Update.`,'ok');
  }

  function officialViewUrl(item){
    const provider=providerById.get(item.providerId);storedOfficialResult(item);
    const southwest=projectWebMercator([item.bounds.west,item.bounds.south]),northeast=projectWebMercator([item.bounds.east,item.bounds.north]);
    let width=Math.min(1600,item.officialExport.maxWidth),height=Math.round(width/A3_RATIO);
    if(height>item.officialExport.maxHeight){height=item.officialExport.maxHeight;width=Math.round(height*A3_RATIO);}
    if(width<MIN_OFFICIAL_EXPORT_DIMENSION||height<MIN_OFFICIAL_EXPORT_DIMENSION)fail('The saved provider export dimensions are too small to preview.');
    const url=new URL(item.officialExport.url);url.searchParams.set('f','image');url.searchParams.set('bbox',[southwest[0],southwest[1],northeast[0],northeast[1]].join(','));
    url.searchParams.set('bboxSR','3857');url.searchParams.set('imageSR','3857');url.searchParams.set('size',`${width},${height}`);url.searchParams.set('format','png32');url.searchParams.set('transparent','true');
    validateProviderUrl(url.href,provider,{label:'Saved imagery preview URL'});return url.href;
  }

  async function viewItem(item){
    removeActive({restore:true});map.fitBounds(boundsPair(item.bounds),{animate:false,padding:[0,0]});
    if(item.mode==='manual'){
      const asset=await assetStore.get(item.assetId);if(!asset){showStatus('Missing asset. Restore this image from a project backup.','error');return;}
      const controller=new AbortController(),image={blob:asset.blob,mime:asset.metadata.mime,width:asset.metadata.width,height:asset.metadata.height,geo:null};
      active={kind:'view',controller,before:null,overlay:overlayFactory({L,map,image,placement:item.placement,signal:controller.signal}).addTo(map)};await active.overlay.ready;
    }else{const layer=L.imageOverlay(officialViewUrl(item),boundsPair(item.bounds),{attribution:item.attribution}).addTo(map);active={kind:'view',before:null,layer};}
    showStatus(`Viewing ${historicalFigureCode(getProject().historical,item.id)}.`,'ok');
  }

  async function deleteItem(item){
    if(mutating)return;if(!confirm(`Delete ${historicalFigureCode(getProject().historical,item.id)}? This cannot be undone.`))return;mutating=true;
    try{
      const project=clone(getProject());project.historical=project.historical.filter(value=>value.id!==item.id);await persist(project);
      if(item.assetId)await assetStore.delete(item.assetId).catch(()=>{});await refresh();showStatus('Historical imagery item deleted.','ok');
    }finally{mutating=false;}
  }

  function officialReady(item){
    try{storedOfficialResult(item);return true;}catch{return false;}
  }

  async function refresh(){
    const generation=++refreshGeneration,project=getProject(),sorted=[...(project.historical||[])].filter(item=>!Object.hasOwn(item,'dataUrl')).sort((a,b)=>a.year-b.year||a.sequence-b.sequence||a.id.localeCompare(b.id,'en'));
    const states=await Promise.all(sorted.map(async item=>item.mode==='manual'?Boolean(await assetStore.get(item.assetId).catch(()=>null)):officialReady(item)));
    if(!alive||generation!==refreshGeneration)return;
    $('aerialCount').textContent=String(sorted.length);const host=$('historicalApprovedList');host.replaceChildren();
    if(!sorted.length){host.append(textElement('p','No historical imagery approved.'));return;}
    let currentYear;
    sorted.forEach((item,index)=>{
      if(item.year!==currentYear){currentYear=item.year;host.append(textElement('h4',String(item.year),'historical-year-heading'));}
      const row=document.createElement('article');row.className='historical-approved-item';row.dataset.historicalId=item.id;
      const code=historicalFigureCode(sorted,item.id),ready=states[index];row.append(textElement('strong',`${code} · ${item.title}`),textElement('span',ready?'Ready':item.mode==='manual'?'Missing asset · Not ready':'Source unavailable · Not ready','historical-readiness'));
      row.append(textElement('span',`Source: ${item.attribution}`),textElement('span',`Crop: ${cropText(item.bounds)}`));
      const actions=document.createElement('div');actions.className='historical-approved-actions';
      for(const [action,label,handler] of [['view','View',()=>viewItem(item)],['edit','Edit',()=>item.mode==='manual'?manualEdit(item):beginStoredOfficial(item)],['delete','Delete',()=>deleteItem(item)]]){
        const button=textElement('button',label);button.type='button';button.dataset.action=action;button.disabled=!ready&&action!=='delete';button.addEventListener('click',()=>track(handler()),{signal:bindings.signal});actions.append(button);
      }
      row.append(actions);host.append(row);
    });
  }

  function setMode(next){
    if(next!==mode)removeActive({restore:true});mode=next;const official=mode==='official';$('historicalOfficialPanel').hidden=!official;$('historicalManualPanel').hidden=official;
    $('historicalOfficialMode').setAttribute('aria-selected',String(official));$('historicalManualMode').setAttribute('aria-selected',String(!official));
    (official?$('historicalYear'):$('manualHistoricalYear')).focus();
  }
  function openDialog(){if(!alive||open)return;open=true;lastFocus=document.activeElement;$('historicalDialog').hidden=false;document.body.classList.add('historical-open');track(refresh());(mode==='official'?$('historicalYear'):$('manualHistoricalYear')).focus();}
  function closeDialog(){if(!open)return;searchController?.abort(abortError());searchGeneration++;setSearchBusy(false);removeActive({restore:true});$('historicalDialog').hidden=true;document.body.classList.remove('historical-open');open=false;lastFocus?.focus?.();}
  function showAll(){document.querySelector('[data-result-group="remaining"]').hidden=false;document.querySelector('[data-result-group="remaining-section"]').hidden=false;$('showAllHistorical').hidden=true;}

  $('closeHistorical').addEventListener('click',closeDialog,{signal:bindings.signal});$('historicalOfficialMode').addEventListener('click',()=>setMode('official'),{signal:bindings.signal});$('historicalManualMode').addEventListener('click',()=>setMode('manual'),{signal:bindings.signal});
  $('searchHistorical').addEventListener('click',()=>track(search()),{signal:bindings.signal});$('cancelHistoricalSearch').addEventListener('click',()=>searchController?.abort(abortError()),{signal:bindings.signal});$('showAllHistorical').addEventListener('click',showAll,{signal:bindings.signal});
  $('previewManualHistorical').addEventListener('click',()=>track(previewManual()),{signal:bindings.signal});$('applyManualPlacement').addEventListener('click',()=>track(applyPlacement()),{signal:bindings.signal});$('drawManualExtent').addEventListener('click',()=>{try{drawExtent();}catch(error){showStatus(error.message,'error');}},{signal:bindings.signal});
  $('useHistoricalCrop').addEventListener('click',()=>{try{useCrop();}catch(error){showStatus(error.message,'error');}},{signal:bindings.signal});$('resetHistoricalCrop').addEventListener('click',()=>{try{resetCrop();}catch(error){showStatus(error.message,'error');}},{signal:bindings.signal});$('cancelHistoricalCrop').addEventListener('click',()=>removeActive({restore:true}),{signal:bindings.signal});$('commitHistorical').addEventListener('click',()=>track(commitActive()),{signal:bindings.signal});
  document.addEventListener('keydown',event=>{
    if(!open)return;
    if(event.key==='Escape'){event.preventDefault();closeDialog();return;}
    if(event.key!=='Tab')return;
    const focusable=[...$('historicalDialog').querySelectorAll('button,input,select,textarea,a[href]')].filter(element=>!element.disabled&&!element.closest('[hidden]'));
    if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  },{signal:bindings.signal});
  map.on?.('resize',syncCropFrame);

  return {open:openDialog,close:closeDialog,refresh,whenIdle:()=>pending,destroy(){if(!alive)return;alive=false;searchController?.abort(abortError());searchGeneration++;refreshGeneration++;removeActive({restore:false});map.off?.('resize',syncCropFrame);bindings.abort();$('historicalDialog').hidden=true;document.body.classList.remove('historical-open');}};
}
