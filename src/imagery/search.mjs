import {
  normalizeProviderResult,
  validateAcquisitionYear,
  validateImageryProvider,
  validateImageryResult
} from './provider-registry.mjs';

export {validateImageryResult} from './provider-registry.mjs';
export const DEFAULT_PROVIDER_TIMEOUT_MS=12_000;

function fail(message){throw new TypeError(message);}
function throwIfAborted(signal){if(signal?.aborted)throw signal.reason??new DOMException('The operation was aborted','AbortError');}
function validateLocation(location){
  if(!location||typeof location!=='object'||Array.isArray(location))fail('Search location must be an object');
  if(typeof location.lat!=='number'||!Number.isFinite(location.lat)||location.lat < -90||location.lat > 90||
    typeof location.lng!=='number'||!Number.isFinite(location.lng)||location.lng < -180||location.lng > 180)fail('Search location must contain valid numeric lat and lng');
}
function providerMap(options){
  if(options instanceof Map)return options;
  if(Array.isArray(options))return new Map(options.map(provider=>[provider.id,provider]));
  return new Map();
}
function resultComparator(providers){
  return (left,right)=>{
    const leftResolution=left.resolutionMeters??Infinity,rightResolution=right.resolutionMeters??Infinity;
    if(leftResolution!==rightResolution)return leftResolution-rightResolution;
    const leftPriority=providers.get(left.providerId)?.priority??Infinity;
    const rightPriority=providers.get(right.providerId)?.priority??Infinity;
    if(leftPriority!==rightPriority)return leftPriority-rightPriority;
    return left.id.localeCompare(right.id,'en');
  };
}
function yearComparator(requestedYear){
  // When distances tie, the earlier acquisition year is shown first.
  return (left,right)=>Math.abs(left-requestedYear)-Math.abs(right-requestedYear)||left-right;
}

export function groupImageryResults(results,requestedYear,{providers:providerOptions}={}){
  if(!Array.isArray(results))fail('Imagery results must be an array');
  validateAcquisitionYear(requestedYear,'Requested year');
  const seen=new Set();
  for(const result of results){
    validateImageryResult(result);
    if(seen.has(result.id))fail(`Duplicate imagery result id: ${result.id}`);
    seen.add(result.id);
  }
  const providers=providerMap(providerOptions);
  const compareResults=resultComparator(providers);
  const compareYears=yearComparator(requestedYear);
  const years=[...new Set(results.filter(result=>result.year!==requestedYear).map(result=>result.year))].sort(compareYears);
  const nearbyYears=new Set(years.slice(0,3));
  const sort=(left,right)=>compareYears(left.year,right.year)||compareResults(left,right);
  return {
    exact:results.filter(result=>result.year===requestedYear).sort(compareResults),
    nearby:results.filter(result=>nearbyYears.has(result.year)).sort(sort),
    remaining:results.filter(result=>result.year!==requestedYear&&!nearbyYears.has(result.year)).sort(sort),
    errors:[]
  };
}

function abortError(reason){return reason??new DOMException('The operation was aborted','AbortError');}
function providerError(provider,reason){
  const error=reason instanceof Error?reason:new Error(String(reason));
  return {providerId:provider.id,message:error.message||String(error),name:error.name||'Error'};
}
function safeProgress(onProgress,event,signal){
  if(signal?.aborted)return;
  try{onProgress(event);}catch{}
}

async function runProvider(provider,{location,year,signal,fetchImpl,timeoutMs}){
  const controller=new AbortController();
  let timer;
  let rejectAbort;
  const rejectOnAbort=new Promise((resolve,reject)=>{rejectAbort=()=>reject(abortError(controller.signal.reason));});
  controller.signal.addEventListener('abort',rejectAbort,{once:true});
  const cancel=()=>controller.abort(abortError(signal.reason));
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    throwIfAborted(signal);
    const covered=provider.covers(location);
    if(typeof covered!=='boolean')fail(`Provider ${provider.id} covers() must return a boolean`);
    if(!covered)return {status:'skipped',results:[]};
    timer=setTimeout(()=>controller.abort(new DOMException(`Provider ${provider.id} timed out after ${timeoutMs} ms`,'TimeoutError')),timeoutMs);
    const pending=Promise.resolve().then(()=>provider.search({location,year,signal:controller.signal,fetchImpl}));
    const values=await Promise.race([pending,rejectOnAbort]);
    throwIfAborted(signal);
    if(!Array.isArray(values))fail(`Provider ${provider.id} search must return an array`);
    const normalized=values.map(value=>normalizeProviderResult(provider,value));
    const ids=new Set();
    for(const value of normalized){
      if(ids.has(value.id))fail(`Provider ${provider.id} returned duplicate result id ${value.id}`);
      ids.add(value.id);
    }
    return {status:'success',results:normalized};
  }finally{
    if(timer!==undefined)clearTimeout(timer);
    controller.signal.removeEventListener('abort',rejectAbort);
    signal?.removeEventListener('abort',cancel);
  }
}

export async function searchOfficialImagery({
  providers,location,year,signal,fetchImpl=globalThis.fetch,onProgress=()=>{},timeoutMs=DEFAULT_PROVIDER_TIMEOUT_MS
}={}){
  if(!Array.isArray(providers))fail('Search providers must be an array');
  validateLocation(location);validateAcquisitionYear(year,'Requested year');
  if(typeof fetchImpl!=='function')fail('fetchImpl must be a function');
  if(typeof onProgress!=='function')fail('onProgress must be a function');
  if(typeof timeoutMs!=='number'||!Number.isFinite(timeoutMs)||timeoutMs<=0)fail('Provider timeout must be a positive number');
  throwIfAborted(signal);
  const ids=new Set();
  for(const provider of providers){
    validateImageryProvider(provider);
    if(ids.has(provider.id))fail(`Duplicate imagery provider id: ${provider.id}`);
    ids.add(provider.id);
  }
  const settled=await Promise.allSettled(providers.map(provider=>runProvider(provider,{location,year,signal,fetchImpl,timeoutMs})));
  throwIfAborted(signal);
  const results=[],errors=[];
  for(let index=0;index<settled.length;index++){
    const provider=providers[index],entry=settled[index];
    if(entry.status==='fulfilled'){
      results.push(...entry.value.results);
      safeProgress(onProgress,{providerId:provider.id,status:entry.value.status},signal);
    }else{
      errors.push(providerError(provider,entry.reason));
      safeProgress(onProgress,{providerId:provider.id,status:'error'},signal);
    }
  }
  errors.sort((left,right)=>{
    const leftProvider=providers.find(provider=>provider.id===left.providerId);
    const rightProvider=providers.find(provider=>provider.id===right.providerId);
    return leftProvider.priority-rightProvider.priority||left.providerId.localeCompare(right.providerId,'en');
  });
  const grouped=groupImageryResults(results,year,{providers});
  grouped.errors=errors;
  throwIfAborted(signal);
  return grouped;
}
