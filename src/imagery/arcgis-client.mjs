import {validateProviderUrl} from './provider-registry.mjs';

const MAX_JSON_BYTES=1_048_576;
const DEFAULT_TIMEOUT_MS=10_000;
const MAX_URL_LENGTH=8_192;
const MAX_EXPORT_DIMENSION=4_096;
const WEB_MERCATOR_LIMIT=20_037_508.342789244;
const MAX_LATITUDE=85.0511287798066;
const SAFE_QUERY_PARAMETERS=new Set([
  'f','where','geometry','geometryType','spatialRel','inSR','outSR','outFields',
  'returnGeometry','returnExtentOnly','resultRecordCount','resultOffset'
]);
const EXPORT_FORMATS=new Set(['png','png8','png24','png32','jpg','jpeg']);

function fail(message){throw new TypeError(message);}
function abortReason(signal){return signal?.reason??new DOMException('The operation was aborted','AbortError');}
function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value))fail(`${label} must be a finite number`);}
function positiveInteger(value,label){if(typeof value!=='number'||!Number.isInteger(value)||value<=0)fail(`${label} must be a positive integer`);}

function trustedContext(allowedOrigins,allowedRoots){
  if(!Array.isArray(allowedOrigins)||allowedOrigins.length===0)fail('allowedOrigins must list official ArcGIS origins');
  if(!Array.isArray(allowedRoots)||allowedRoots.length===0)fail('allowedRoots must list official ArcGIS roots');
  const origins=allowedOrigins.map((value,index)=>{
    if(typeof value!=='string')fail(`allowedOrigins[${index}] must be an https origin`);
    let url;
    try{url=new URL(value);}catch{fail(`allowedOrigins[${index}] must be an https origin`);}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==value){
      fail(`allowedOrigins[${index}] must be an exact normalized https origin`);
    }
    return value;
  });
  if(new Set(origins).size!==origins.length)fail('allowedOrigins must be unique');
  const roots=allowedRoots.map((value,index)=>{
    if(typeof value!=='string')fail(`allowedRoots[${index}] must be an official directory root`);
    let url;
    try{url=new URL(value);}catch{fail(`allowedRoots[${index}] must be an official directory root`);}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/')||
      (url.pathname!=='/'&&url.pathname.includes('//'))||url.href!==value){
      fail(`allowedRoots[${index}] must be an exact normalized https directory root`);
    }
    if(!origins.includes(url.origin))fail(`allowedRoots[${index}] is outside allowedOrigins`);
    validateProviderUrl(value,{allowedOrigins:origins,allowedRoots:[value]},{label:`allowedRoots[${index}]`});
    return value;
  });
  if(new Set(roots).size!==roots.length)fail('allowedRoots must be unique');
  return {allowedOrigins:origins,allowedRoots:roots};
}

function safeRequestUrl(value,context,label='ArcGIS request URL'){
  validateProviderUrl(value,context,{label});
  const url=new URL(value);
  const seen=new Set();
  for(const [name] of url.searchParams){
    if(!SAFE_QUERY_PARAMETERS.has(name))fail(`${label} contains an unsupported query parameter: ${name}`);
    if(seen.has(name))fail(`${label} contains a duplicate query parameter: ${name}`);
    seen.add(name);
  }
  url.searchParams.set('f','json');
  if(url.href.length>MAX_URL_LENGTH)fail(`${label} exceeds the URL length limit`);
  return url;
}

function jsonContentType(value){
  const type=(value??'').split(';',1)[0].trim().toLowerCase();
  return type==='application/json'||type.endsWith('+json')||type==='text/plain';
}

export async function fetchArcGisJson(url,{signal,fetchImpl=globalThis.fetch,allowedOrigins,allowedRoots}={}){
  if(typeof fetchImpl!=='function')fail('fetchImpl must be a function');
  if(signal?.aborted)throw abortReason(signal);
  const context=trustedContext(allowedOrigins,allowedRoots);
  const requestUrl=safeRequestUrl(url,context);
  const controller=new AbortController();
  let timer,rejectAbort;
  const onAbort=()=>controller.abort(abortReason(signal));
  const aborted=new Promise((resolve,reject)=>{rejectAbort=()=>reject(abortReason(controller.signal));});
  controller.signal.addEventListener('abort',rejectAbort,{once:true});
  signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>controller.abort(new DOMException(`ArcGIS metadata request timed out after ${DEFAULT_TIMEOUT_MS} ms`,'TimeoutError')),DEFAULT_TIMEOUT_MS);
  try{
    const response=await Promise.race([
      Promise.resolve().then(()=>fetchImpl(requestUrl.href,{
        method:'GET',credentials:'omit',redirect:'follow',referrerPolicy:'no-referrer',signal:controller.signal,
        headers:{accept:'application/json, text/plain;q=0.9'}
      })),
      aborted
    ]);
    if(!response||typeof response!=='object')fail('ArcGIS metadata response is invalid');
    if(typeof response.url!=='string'||!response.url)fail('ArcGIS metadata response did not expose its final redirect URL');
    const rawFinalUrl=new URL(response.url);
    const finalFormats=rawFinalUrl.searchParams.getAll('f');
    if(finalFormats.length!==1||finalFormats[0]!=='json')fail('ArcGIS final redirect URL did not preserve f=json');
    safeRequestUrl(response.url,context,'ArcGIS final redirect URL');
    if(!response.ok)throw new Error(`ArcGIS metadata request failed with HTTP status ${response.status}`);
    if(!jsonContentType(response.headers?.get?.('content-type')))fail('ArcGIS metadata response has an unsupported JSON content-type');
    const declared=response.headers?.get?.('content-length');
    if(declared!==null&&declared!==undefined&&declared!==''){
      const bytes=Number(declared);
      if(!Number.isFinite(bytes)||bytes<0)fail('ArcGIS metadata response has an invalid content length');
      if(bytes>MAX_JSON_BYTES)fail(`ArcGIS metadata response exceeds the ${MAX_JSON_BYTES}-byte size limit`);
    }
    const body=await Promise.race([Promise.resolve().then(()=>response.text()),aborted]);
    if(new TextEncoder().encode(body).byteLength>MAX_JSON_BYTES)fail(`ArcGIS metadata response exceeds the ${MAX_JSON_BYTES}-byte size limit`);
    if(/^\s*[A-Za-z_$][\w$.[\]]*\s*\(/.test(body))fail('ArcGIS JSONP responses are not accepted');
    let value;
    try{value=JSON.parse(body);}catch{fail('ArcGIS metadata response contains malformed JSON');}
    if(value===null||typeof value!=='object'||Array.isArray(value))fail('ArcGIS metadata response must be a JSON object');
    if(value.error&&typeof value.error==='object'){
      const code=Number.isFinite(value.error.code)?` ${value.error.code}`:'';
      const message=typeof value.error.message==='string'&&value.error.message.trim()?`: ${value.error.message}`:'';
      const details=Array.isArray(value.error.details)&&value.error.details.length?` (${value.error.details.join('; ')})`:'';
      throw new Error(`ArcGIS error${code}${message}${details}`);
    }
    return value;
  }finally{
    clearTimeout(timer);
    controller.signal.removeEventListener('abort',rejectAbort);
    signal?.removeEventListener('abort',onAbort);
  }
}

function exactBounds(bounds){
  if(bounds===null||typeof bounds!=='object'||Array.isArray(bounds))fail('ArcGIS export bounds must be an object');
  const keys=Reflect.ownKeys(bounds);
  if(keys.some(key=>typeof key!=='string')||keys.length!==4||!['west','south','east','north'].every(key=>keys.includes(key))){
    fail('ArcGIS export bounds must have exact west, south, east and north fields');
  }
  for(const key of keys){
    const descriptor=Object.getOwnPropertyDescriptor(bounds,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)fail(`ArcGIS export bounds.${key} must be an enumerable data property`);
  }
  for(const key of ['west','south','east','north'])finite(bounds[key],`ArcGIS export bounds.${key}`);
  if(bounds.west < -180||bounds.east > 180||bounds.south < -MAX_LATITUDE||bounds.north > MAX_LATITUDE||
    bounds.west>=bounds.east||bounds.south>=bounds.north)fail('ArcGIS export bounds are not normalized for Web Mercator');
}

function serviceRoot(value){
  if(typeof value!=='string'||!value)fail('ArcGIS service URL must be a non-empty string');
  let url;
  try{url=new URL(value);}catch{fail('ArcGIS service URL must be an absolute https URL');}
  const origin=url.origin;
  validateProviderUrl(value,{allowedOrigins:[origin],allowedRoots:[`${origin}/`]},{label:'ArcGIS service URL'});
  if(url.search||url.hash||url.username||url.password)fail('ArcGIS service URL must not contain credentials, a query or fragment');
  if(url.pathname.includes('//'))fail('ArcGIS service URL path must be normalized without empty segments');
  if(!/\/MapServer\/?$/.test(url.pathname))fail('ArcGIS service URL must be an exact MapServer root');
  url.pathname=url.pathname.replace(/\/$/,'');
  return url;
}

function mercatorX(longitude){return longitude*WEB_MERCATOR_LIMIT/180;}
function mercatorY(latitude){return Math.log(Math.tan((90+latitude)*Math.PI/360))*WEB_MERCATOR_LIMIT/Math.PI;}

export function arcGisExportUrl({
  serviceUrl,bounds,width,height,format='png32',maxWidth=MAX_EXPORT_DIMENSION,maxHeight=MAX_EXPORT_DIMENSION
}={}){
  const url=serviceRoot(serviceUrl);
  exactBounds(bounds);
  positiveInteger(width,'ArcGIS export width');positiveInteger(height,'ArcGIS export height');
  positiveInteger(maxWidth,'ArcGIS service maximum width');positiveInteger(maxHeight,'ArcGIS service maximum height');
  if(maxWidth>MAX_EXPORT_DIMENSION||maxHeight>MAX_EXPORT_DIMENSION)fail(`ArcGIS service dimensions cannot exceed the provider maximum of ${MAX_EXPORT_DIMENSION}`);
  if(width>maxWidth||height>maxHeight)fail('ArcGIS export dimensions exceed the service maximum width or height');
  if(typeof format!=='string'||!EXPORT_FORMATS.has(format.toLowerCase()))fail('ArcGIS export format is not supported');
  const normalizedFormat=format.toLowerCase()==='jpeg'?'jpg':format.toLowerCase();
  url.pathname=`${url.pathname}/export`;
  url.searchParams.set('f','image');
  url.searchParams.set('bbox',[mercatorX(bounds.west),mercatorY(bounds.south),mercatorX(bounds.east),mercatorY(bounds.north)].join(','));
  url.searchParams.set('bboxSR','3857');
  url.searchParams.set('imageSR','3857');
  url.searchParams.set('size',`${width},${height}`);
  url.searchParams.set('format',normalizedFormat);
  url.searchParams.set('transparent',normalizedFormat.startsWith('png')?'true':'false');
  if(url.href.length>MAX_URL_LENGTH)fail('ArcGIS export URL exceeds the URL length limit');
  return url.href;
}

function webMercatorSpatialReference(spatialReference){
  if(!spatialReference||typeof spatialReference!=='object'||Array.isArray(spatialReference))return false;
  return spatialReference.latestWkid===3857||spatialReference.wkid===3857||spatialReference.wkid===102100||spatialReference.wkid===102113;
}

export function arcGisExtentToCoverage(extent){
  if(!extent||typeof extent!=='object'||Array.isArray(extent))fail('ArcGIS footprint extent must be an object');
  if(!webMercatorSpatialReference(extent.spatialReference))fail('ArcGIS footprint spatial reference must be EPSG:3857 Web Mercator');
  for(const key of ['xmin','ymin','xmax','ymax'])finite(extent[key],`ArcGIS footprint ${key}`);
  if(extent.xmin < -WEB_MERCATOR_LIMIT||extent.xmax > WEB_MERCATOR_LIMIT||extent.ymin < -WEB_MERCATOR_LIMIT||extent.ymax > WEB_MERCATOR_LIMIT||
    extent.xmin>=extent.xmax||extent.ymin>=extent.ymax)fail('ArcGIS footprint is outside normalized EPSG:3857 bounds');
  const longitude=x=>x*180/WEB_MERCATOR_LIMIT;
  const latitude=y=>(Math.atan(Math.exp(y/WEB_MERCATOR_LIMIT*Math.PI))*360/Math.PI)-90;
  return {west:longitude(extent.xmin),south:latitude(extent.ymin),east:longitude(extent.xmax),north:latitude(extent.ymax)};
}

export function arcGisServiceExport(metadata,{providerMaxWidth=MAX_EXPORT_DIMENSION,providerMaxHeight=MAX_EXPORT_DIMENSION}={}){
  const capabilities=typeof metadata?.capabilities==='string'?metadata.capabilities.split(',').map(value=>value.trim()):[];
  if(!capabilities.includes('Map'))return null;
  const formats=typeof metadata.supportedImageFormatTypes==='string'?metadata.supportedImageFormatTypes.split(',').map(value=>value.trim().toLowerCase()):[];
  if(!formats.some(value=>EXPORT_FORMATS.has(value)))return null;
  const maxWidth=Math.min(metadata.maxImageWidth,providerMaxWidth),maxHeight=Math.min(metadata.maxImageHeight,providerMaxHeight);
  if(!Number.isInteger(maxWidth)||maxWidth<=0||!Number.isInteger(maxHeight)||maxHeight<=0)return null;
  return {maxWidth,maxHeight};
}
