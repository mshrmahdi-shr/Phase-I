import {BEDROCK_SOURCE, validateBedrockRing} from './bedrock.mjs';
import {intersects} from './geology.mjs';

export const BEDROCK_POLYGON_INDEX = 'https://www.geologyontario.mndm.gov.on.ca/mines/data/google/MRD126/files/paleo/doc.kml';
const SOURCE_ROOT = new URL('.',BEDROCK_POLYGON_INDEX);
const CACHE_VERSION = 1;
const BROWSER_CONCURRENCY = 4;

/** Permit only the supplied With Lowlands polygon branch, including HTTP→HTTPS. */
export function resolveBedrockSourceUrl(href, base=BEDROCK_POLYGON_INDEX) {
  const raw = String(href).trim();
  if (/[\\%?#]/.test(raw) || raw.split('/').includes('..')) throw new Error('Invalid bedrock source path.');
  let url;
  try { url=new URL(raw,base); } catch { throw new Error('Invalid bedrock source URL.'); }
  if (url.protocol==='http:') url.protocol='https:';
  if (url.origin!==SOURCE_ROOT.origin || !url.pathname.startsWith(SOURCE_ROOT.pathname) ||
    url.username || url.password || !/\.(kml|kmz)$/i.test(url.pathname)) {
    throw new Error('URL is outside the official With Lowlands polygon source branch.');
  }
  return url.href;
}

export function validBedrockBounds(bounds) {
  return !!bounds && ['west','south','east','north'].every(k=>Number.isFinite(bounds[k])) &&
    bounds.west>=-180 && bounds.east<=180 && bounds.south>=-90 && bounds.north<=90 &&
    bounds.west<bounds.east && bounds.south<bounds.north;
}

/** Bounds of complete geometry, never NetworkLink Region or label coordinates. */
export function bedrockGeometryBounds(features) {
  if (!features.length) return null;
  const bounds={west:Infinity,south:Infinity,east:-Infinity,north:-Infinity};
  for (const feature of features) for (const ring of [feature.polygon,...(feature.holes||[])]) for (const [x,y] of ring) {
    bounds.west=Math.min(bounds.west,x); bounds.east=Math.max(bounds.east,x);
    bounds.south=Math.min(bounds.south,y); bounds.north=Math.max(bounds.north,y);
  }
  return bounds;
}

/** A rejecting worker aborts its peers; wait for their cleanup before returning. */
export async function mapBedrockConcurrent(items, task, {signal, concurrency=4}={}) {
  signal?.throwIfAborted();
  if (!Number.isInteger(concurrency) || concurrency<1 || concurrency>8) throw new Error('Invalid bedrock concurrency limit.');
  const controller=new AbortController();
  const activeSignal=signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  const results=new Array(items.length); let next=0, error;
  const workers=Array.from({length:Math.min(items.length,concurrency)},async()=>{
    try {
      while (next<items.length) {
        activeSignal.throwIfAborted();
        const i=next++;
        results[i]=await task(items[i],i,activeSignal);
        activeSignal.throwIfAborted();
      }
    } catch (e) { error ??= e; controller.abort(e); }
  });
  await Promise.all(workers);
  signal?.throwIfAborted();
  if (error) throw error;
  return results;
}

function cacheRoot(baseUrl) {
  const page = globalThis.location?.href || globalThis.document?.baseURI;
  let root;
  try { root=new URL(baseUrl,page); } catch { throw new Error('A local absolute cache URL is required outside the browser.'); }
  if (!['http:','https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash ||
    !root.pathname.endsWith('/') || (page && new URL(page).protocol!=='about:' && root.origin!==new URL(page).origin)) {
    throw new Error('Bedrock must load from a same-origin local cache directory.');
  }
  return root;
}

function safeCachePath(path) {
  if (typeof path!=='string' || !/^files\/[A-Za-z0-9_-]+\.json$/.test(path)) throw new Error('Invalid bedrock cache file path.');
  return path;
}

function validateManifest(manifest) {
  const counts=manifest?.counts;
  if (manifest?.version!==CACHE_VERSION || manifest.source!==BEDROCK_SOURCE.id || manifest.complete!==true ||
    !Number.isFinite(Date.parse(manifest.cachedAt)) || !Array.isArray(manifest.files) || !counts ||
    !Number.isInteger(counts.expected) || counts.expected<1 || counts.saved!==counts.expected ||
    counts.saved!==manifest.files.length || counts.failed!==0 || counts.pending!==0) {
    throw new Error('Incomplete or invalid MRD126 cache manifest.');
  }
  const paths=new Set();
  for (const file of manifest.files) {
    safeCachePath(file.path);
    if (paths.has(file.path)) throw new Error('Duplicate bedrock cache manifest path.');
    paths.add(file.path);
    if (!Number.isInteger(file.featureCount) || file.featureCount<0 ||
      (file.featureCount ? !validBedrockBounds(file.bounds) : file.bounds!==null)) {
      throw new Error('Invalid geometry bounds or count in bedrock cache manifest.');
    }
  }
  return manifest;
}

function validateFeatures(data,entry) {
  if (!Array.isArray(data?.features) || data.features.length!==entry.featureCount) throw new Error('Incomplete bedrock cache polygon data.');
  for (const feature of data.features) {
    validateBedrockRing(feature.polygon);
    if (!Array.isArray(feature.holes)) throw new Error('Invalid bedrock polygon holes.');
    feature.holes.forEach(validateBedrockRing);
    if (typeof feature.name!=='string' || typeof feature.description!=='string' ||
      (feature.unitCode!==null && typeof feature.unitCode!=='string') || !/^#[0-9a-f]{6}$/i.test(feature.color) ||
      !Number.isFinite(feature.fillOpacity) || feature.fillOpacity<0 || feature.fillOpacity>1) {
      throw new Error('Invalid bedrock cache feature.');
    }
  }
  const actual=bedrockGeometryBounds(data.features);
  if (actual && ['west','south','east','north'].some(k=>actual[k]!==entry.bounds[k])) {
    throw new Error('Bedrock cache geometry bounds do not match the manifest.');
  }
  return data.features;
}

export async function loadBedrockCache(bounds,{fetchImpl=fetch,signal,baseUrl='./mrd126-cache/'}={}) {
  signal?.throwIfAborted();
  if (!validBedrockBounds(bounds)) throw new Error('Invalid requested bedrock bounds.');
  const root=cacheRoot(baseUrl);
  async function fetchJson(path,activeSignal) {
    activeSignal?.throwIfAborted();
    const url=new URL(path,root).href;
    const timeout=AbortSignal.timeout(30000);
    const requestSignal=activeSignal ? AbortSignal.any([activeSignal,timeout]) : timeout;
    const response=await fetchImpl(url,{signal:requestSignal,redirect:'error',credentials:'same-origin'});
    requestSignal.throwIfAborted();
    if (!response.ok) throw new Error(`Bedrock cache is unavailable (HTTP ${response.status}).`);
    if (response.url && response.url!==url) throw new Error('Bedrock cache redirected outside the requested local file.');
    const data=await response.json();
    requestSignal.throwIfAborted();
    return data;
  }
  const manifest=validateManifest(await fetchJson('manifest.json',signal));
  const selected=manifest.files.filter(file=>file.bounds && intersects(file.bounds,bounds));
  const groups=await mapBedrockConcurrent(selected,async(entry,i,activeSignal)=>
    validateFeatures(await fetchJson(entry.path,activeSignal),entry),{signal,concurrency:BROWSER_CONCURRENCY});
  signal?.throwIfAborted();
  return {features:groups.flat(),coverage:{...bounds},source:BEDROCK_SOURCE,docs:selected.length};
}
