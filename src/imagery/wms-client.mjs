import {validateProviderUrl} from './provider-registry.mjs';

const MAX_XML_BYTES=2_097_152;
const DEFAULT_TIMEOUT_MS=10_000;
const MAX_URL_LENGTH=8_192;
const MAX_EXPORT_DIMENSION=4_096;
const WEB_MERCATOR_LIMIT=20_037_508.342789244;
const MAX_LATITUDE=85.0511287798066;
const SAFE_QUERY_PARAMETERS=new Set(['request','service','version','layers','legend_format','feature_info_type']);

function fail(message){throw new TypeError(message);}
function abortReason(signal){return signal?.reason??new DOMException('The operation was aborted','AbortError');}
function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value))fail(`${label} must be a finite number`);}
function positiveInteger(value,label){if(typeof value!=='number'||!Number.isInteger(value)||value<=0)fail(`${label} must be a positive integer`);}
function text(value,label){if(typeof value!=='string'||!value.trim())fail(`${label} must be a non-empty string`);}

function safeRequestUrl(value,context,label='WMS request URL'){
  validateProviderUrl(value,context,{label});
  const url=new URL(value);
  const seen=new Set();
  for(const [name] of url.searchParams){
    const lower=name.toLowerCase();
    if(!SAFE_QUERY_PARAMETERS.has(lower))fail(`${label} contains an unsupported query parameter: ${name}`);
    if(seen.has(lower))fail(`${label} contains a duplicate query parameter: ${name}`);
    seen.add(lower);
  }
  if(url.href.length>MAX_URL_LENGTH)fail(`${label} exceeds the URL length limit`);
  return url;
}

function xmlContentType(value){
  const type=(value??'').split(';',1)[0].trim().toLowerCase();
  return type==='text/xml'||type==='application/xml'||type.endsWith('+xml');
}

async function readBoundedText(response,{controller,label}){
  if(!response.body||typeof response.body.getReader!=='function')fail(`${label} response body streaming is unavailable`);
  const reader=response.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let body='',byteLength=0,complete=false;
  try{
    while(true){
      const chunk=await reader.read();
      if(!chunk||typeof chunk!=='object'||typeof chunk.done!=='boolean')fail(`${label} response body stream returned an invalid chunk`);
      if(chunk.done){complete=true;try{body+=decoder.decode();}catch{fail(`${label} response contains malformed UTF-8`);}return body;}
      if(!(chunk.value instanceof Uint8Array))fail(`${label} response body chunks must be Uint8Array bytes`);
      byteLength+=chunk.value.byteLength;
      if(byteLength>MAX_XML_BYTES){const error=new TypeError(`${label} response exceeds the ${MAX_XML_BYTES}-byte size limit`);controller.abort(error);throw error;}
      try{body+=decoder.decode(chunk.value,{stream:true});}catch{fail(`${label} response contains malformed UTF-8`);}
    }
  }finally{
    if(!complete){try{await reader.cancel(controller.signal.reason);}catch{}}
    try{reader.releaseLock();}catch{}
  }
}

export async function fetchWmsCapabilitiesXml(url,{signal,fetchImpl=globalThis.fetch,allowedOrigins,allowedRoots,domParserImpl}={}){
  if(typeof fetchImpl!=='function')fail('fetchImpl must be a function');
  const parse=domParserImpl??(typeof DOMParser==='function'?value=>new DOMParser().parseFromString(value,'application/xml'):null);
  if(typeof parse!=='function')fail('A DOMParser implementation is required to read WMS capabilities');
  if(signal?.aborted)throw abortReason(signal);
  const context={allowedOrigins,allowedRoots};
  const requestUrl=safeRequestUrl(url,context);
  const controller=new AbortController();
  const onAbort=()=>controller.abort(abortReason(signal));
  signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>controller.abort(new DOMException(`WMS capabilities request timed out after ${DEFAULT_TIMEOUT_MS} ms`,'TimeoutError')),DEFAULT_TIMEOUT_MS);
  try{
    const response=await fetchImpl(requestUrl.href,{method:'GET',credentials:'omit',redirect:'follow',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'text/xml, application/xml;q=0.9'}});
    if(!response||typeof response!=='object')fail('WMS capabilities response is invalid');
    if(!response.ok)throw new Error(`WMS capabilities request failed with HTTP status ${response.status}`);
    if(!xmlContentType(response.headers?.get?.('content-type')))fail('WMS capabilities response has an unsupported content-type');
    const declared=response.headers?.get?.('content-length');
    if(declared!==null&&declared!==undefined&&declared!==''){
      const bytes=Number(declared);
      if(!Number.isFinite(bytes)||bytes<0)fail('WMS capabilities response has an invalid content length');
      if(bytes>MAX_XML_BYTES)fail(`WMS capabilities response exceeds the ${MAX_XML_BYTES}-byte size limit`);
    }
    const body=await readBoundedText(response,{controller,label:'WMS capabilities'});
    const doc=parse(body,'application/xml');
    if(!doc||doc.getElementsByTagName('parsererror').length>0)fail('WMS capabilities response contains malformed XML');
    return doc;
  }finally{
    clearTimeout(timer);
    signal?.removeEventListener('abort',onAbort);
  }
}

function leafLayers(doc){
  return [...doc.getElementsByTagName('Layer')].filter(node=>![...node.children].some(child=>child.tagName==='Layer'));
}

function layerDescriptorFromNode(layer){
  const nameNode=[...layer.children].find(child=>child.tagName==='Name');
  if(!nameNode||!nameNode.textContent.trim())return null;
  const name=nameNode.textContent.trim();
  const titleNode=[...layer.children].find(child=>child.tagName==='Title');
  const title=(titleNode?.textContent.trim()||name).split(' / ')[0].trim();
  const box=layer.getElementsByTagName('EX_GeographicBoundingBox')[0];
  if(!box)return null;
  const field=tag=>{const node=box.getElementsByTagName(tag)[0];return node?Number(node.textContent):NaN;};
  const coverage={west:field('westBoundLongitude'),south:field('southBoundLatitude'),east:field('eastBoundLongitude'),north:field('northBoundLatitude')};
  if(!Object.values(coverage).every(Number.isFinite)||coverage.west>=coverage.east||coverage.south>=coverage.north)return null;
  const dimension=[...layer.children].find(child=>child.tagName==='Dimension'&&child.getAttribute('name')==='time');
  if(!dimension)return null;
  const dates=dimension.textContent.split(',').map(value=>value.trim()).filter(Boolean);
  if(!dates.length)return null;
  const times=[];
  for(const value of dates){
    const parsed=Date.parse(value);
    if(!Number.isFinite(parsed))return null;
    times.push({iso:value,year:new Date(parsed).getUTCFullYear()});
  }
  return {name,title,coverage,times};
}

/** Returns {name, coverage, times} for every requestable (leaf) layer in a WMS capabilities document, skipping folder layers that only group children. Used to auto-discover every published NAPL region from a single capabilities fetch instead of requiring a hardcoded region list. */
export function wmsAllLayerDescriptors(doc){
  const results=[];
  for(const layer of leafLayers(doc)){const descriptor=layerDescriptorFromNode(layer);if(descriptor)results.push(descriptor);}
  return results;
}

export function wmsLayerDescriptor(doc,layerName){
  text(layerName,'WMS layer name');
  const match=wmsAllLayerDescriptors(doc).find(descriptor=>descriptor.name===layerName);
  if(!match)fail(`WMS capabilities document does not describe layer ${layerName}`);
  return {coverage:match.coverage,times:match.times};
}

function mercatorX(longitude){return longitude*WEB_MERCATOR_LIMIT/180;}
function mercatorY(latitude){return Math.log(Math.tan((90+latitude)*Math.PI/360))*WEB_MERCATOR_LIMIT/Math.PI;}

function exactBounds(bounds){
  if(bounds===null||typeof bounds!=='object'||Array.isArray(bounds))fail('WMS export bounds must be an object');
  for(const key of ['west','south','east','north'])finite(bounds[key],`WMS export bounds.${key}`);
  if(bounds.west < -180||bounds.east > 180||bounds.south < -MAX_LATITUDE||bounds.north > MAX_LATITUDE||
    bounds.west>=bounds.east||bounds.south>=bounds.north)fail('WMS export bounds are not normalized for Web Mercator');
}

export function wmsGetMapUrl({serviceUrl,bounds,width,height,maxWidth=MAX_EXPORT_DIMENSION,maxHeight=MAX_EXPORT_DIMENSION}={}){
  let url;try{url=new URL(serviceUrl);}catch{fail('WMS export service URL must be an absolute https URL');}
  if(url.protocol!=='https:'||url.username||url.password)fail('WMS export service URL must be an https URL without credentials');
  const layer=url.searchParams.get('LAYERS'),time=url.searchParams.get('TIME');
  const extra=[...url.searchParams.keys()].filter(name=>name!=='LAYERS'&&name!=='TIME');
  if(extra.length)fail(`WMS export service URL must only preset LAYERS and TIME, found: ${extra.join(', ')}`);
  text(layer,'WMS export service URL LAYERS');text(time,'WMS export service URL TIME');
  if(!Number.isFinite(Date.parse(time)))fail('WMS export service URL TIME must be a parseable ISO 8601 date');
  exactBounds(bounds);
  positiveInteger(width,'WMS export width');positiveInteger(height,'WMS export height');
  positiveInteger(maxWidth,'WMS service maximum width');positiveInteger(maxHeight,'WMS service maximum height');
  if(maxWidth>MAX_EXPORT_DIMENSION||maxHeight>MAX_EXPORT_DIMENSION)fail(`WMS service dimensions cannot exceed the provider maximum of ${MAX_EXPORT_DIMENSION}`);
  if(width>maxWidth||height>maxHeight)fail('WMS export dimensions exceed the service maximum width or height');
  url.searchParams.set('SERVICE','WMS');url.searchParams.set('VERSION','1.3.0');url.searchParams.set('REQUEST','GetMap');
  url.searchParams.set('STYLES','');url.searchParams.set('CRS','EPSG:3857');
  url.searchParams.set('BBOX',[mercatorX(bounds.west),mercatorY(bounds.south),mercatorX(bounds.east),mercatorY(bounds.north)].join(','));
  url.searchParams.set('WIDTH',String(width));url.searchParams.set('HEIGHT',String(height));
  url.searchParams.set('FORMAT','image/png');url.searchParams.set('TRANSPARENT','FALSE');
  if(url.href.length>MAX_URL_LENGTH)fail('WMS export URL exceeds the URL length limit');
  return url.href;
}
