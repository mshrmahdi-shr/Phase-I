/**
 * Build the static MRD126-REV1 With Lowlands cache, without a runtime OGS request.
 * From _site: node ../scripts/cache-mrd126.mjs
 * Or: node scripts/cache-mrd126.mjs --output _site/mrd126-cache
 * Default output: <cwd>/mrd126-cache. Generated files must not be committed.
 * JSON retains full precision, full polygons and inner rings; no simplification.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import JSZip from 'jszip';
import {BEDROCK_SOURCE,parseBedrockKml} from '../src/bedrock.mjs';
import {netLinks} from '../src/geology.mjs';
import {BEDROCK_POLYGON_INDEX,bedrockGeometryBounds,mapBedrockConcurrent,resolveBedrockSourceUrl} from '../src/bedrock-cache.mjs';

const MAX_CACHE_BYTES=512*1024*1024; // Reserve >400 MiB for the rest of a <1 GB Pages artifact.
const MAX_RESPONSE_BYTES=32*1024*1024;
const MAX_KML_BYTES=128*1024*1024;
const EXPECTED_FILES=468;
const ATTEMPTS=3;

async function readBounded(response,limit,signal) {
  if (Number(response.headers.get('content-length'))>limit) throw new Error('Bedrock download byte limit exceeded.');
  const chunks=[];let bytes=0;
  for await (const chunk of response.body) {
    signal.throwIfAborted(); bytes+=chunk.byteLength;
    if(bytes>limit) throw new Error('Bedrock download byte limit exceeded.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,bytes);
}

async function unzipKml(buffer,signal) {
  // CRC validation during loadAsync inflates every entry before we can enforce
  // limits. Inspect metadata first, then stream only the selected KML below.
  const zip=await JSZip.loadAsync(buffer);
  const entries=Object.values(zip.files).filter(file=>!file.dir && /\.kml$/i.test(file.name));
  // Never silently choose one KML and discard another document's polygons.
  if(entries.length!==1) throw new Error('An official bedrock KMZ must contain exactly one KML document.');
  const file=entries[0];
  if(!Number.isSafeInteger(file._data.uncompressedSize) || file._data.uncompressedSize>MAX_KML_BYTES) throw new Error('Bedrock KML byte limit exceeded.');
  const chunks=[];let bytes=0;
  const stream=file.internalStream('nodebuffer');
  await new Promise((resolve,reject)=>{
    let finished=false;
    const fail=error=>{
      if(finished)return;
      finished=true;stream.pause();chunks.length=0;
      signal.removeEventListener('abort',abort);reject(error);
    };
    const abort=()=>fail(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    stream.on('data',chunk=>{
      if(finished)return;
      bytes+=chunk.byteLength;
      if(bytes>MAX_KML_BYTES)fail(new Error('Bedrock KML byte limit exceeded.'));
      else chunks.push(chunk);
    }).on('error',fail).on('end',()=>{
      if(finished)return;
      finished=true;signal.removeEventListener('abort',abort);resolve();
    });
    if(signal.aborted)abort();else stream.resume();
  });
  return Buffer.concat(chunks,bytes).toString('utf8');
}

function pause(ms,signal) {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}

export async function buildBedrockCache({outputDir=path.resolve('mrd126-cache'),fetchImpl=fetch,
  signal,expectedFiles=EXPECTED_FILES,maxBytes=MAX_CACHE_BYTES,retryDelayMs=300,log=()=>{}}={}) {
  signal?.throwIfAborted();
  if(!Number.isInteger(expectedFiles)||expectedFiles<1||expectedFiles>1000||!Number.isFinite(maxBytes)||maxBytes<=0||maxBytes>MAX_CACHE_BYTES) {
    throw new Error('Invalid bedrock cache count or byte limit.');
  }
  const parserDOM = typeof globalThis.DOMParser==='undefined' ? new JSDOM('') : null;
  if(parserDOM)globalThis.DOMParser=parserDOM.window.DOMParser;
  const output=path.resolve(outputDir);
  await fs.mkdir(path.join(output,'files'),{recursive:true});
  const manifest={version:1,source:BEDROCK_SOURCE.id,root:BEDROCK_POLYGON_INDEX,cachedAt:new Date().toISOString(),complete:false,
    counts:{expected:expectedFiles,saved:0,failed:0,pending:expectedFiles},totalBytes:0,files:[]};
  const writeManifest=()=>fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
  // Invalidate an older cache before doing anything that could fail.
  await writeManifest();
  const buildSignal=signal || new AbortController().signal;
  async function download(url,activeSignal) {
    let last;
    for(let attempt=0;attempt<ATTEMPTS;attempt++) {
      activeSignal.throwIfAborted();
      try {
        const requestSignal=AbortSignal.any([activeSignal,AbortSignal.timeout(30000)]);
        const response=await fetchImpl(url,{signal:requestSignal,redirect:'error',headers:{'accept':'application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,application/xml,*/*'}});
        if(!response.ok)throw new Error(`MRD126 download failed (HTTP ${response.status}): ${url}`);
        if(response.url && response.url!==url)throw new Error('Official bedrock source redirected outside the requested URL.');
        const bytes=await readBounded(response,MAX_RESPONSE_BYTES,requestSignal);
        requestSignal.throwIfAborted();
        return bytes;
      } catch(error) {
        activeSignal.throwIfAborted(); last=error;
        if(attempt+1<ATTEMPTS)await pause(retryDelayMs*(attempt+1),activeSignal);
      }
    }
    throw last;
  }
  try {
    const index=(await download(BEDROCK_POLYGON_INDEX,buildSignal)).toString('utf8');
    const urls=netLinks(index).map(link=>resolveBedrockSourceUrl(link.href,BEDROCK_POLYGON_INDEX));
    if(urls.length!==expectedFiles || new Set(urls).size!==urls.length) throw new Error(`Bedrock polygon index count is ${urls.length}; expected ${expectedFiles} unique files.`);
    const entries=await mapBedrockConcurrent(urls,async(url,i,activeSignal)=>{
      try {
        const buffer=await download(url,activeSignal);
        const text=/\.kmz$/i.test(url) ? await unzipKml(buffer,activeSignal) : buffer.toString('utf8');
        activeSignal.throwIfAborted();
        // The selected official index has leaf polygon files. Changed topology
        // must be reviewed; never omit an unexpected descendant silently.
        if(netLinks(text).length) throw new Error('Unexpected nested link in official bedrock polygon leaf.');
        const features=parseBedrockKml(text);
        const content=JSON.stringify({version:1,source:BEDROCK_SOURCE.id,features})+'\n';
        const bytes=Buffer.byteLength(content);
        if(manifest.totalBytes+bytes>maxBytes)throw new Error('Bedrock cache output byte limit exceeded; no geometry was truncated.');
        manifest.totalBytes+=bytes;
        const file={path:`files/${String(i+1).padStart(4,'0')}.json`,bounds:bedrockGeometryBounds(features),featureCount:features.length,bytes};
        activeSignal.throwIfAborted();
        await fs.writeFile(path.join(output,file.path),content,'utf8');
        manifest.counts.saved++;manifest.counts.pending--;
        log(`MRD126 ${manifest.counts.saved}/${expectedFiles}: ${features.length} polygons`);
        return file;
      } catch(error) { manifest.counts.failed++; throw error; }
    },{signal:buildSignal,concurrency:4});
    buildSignal.throwIfAborted();
    manifest.files=entries;
    if(manifest.counts.saved!==expectedFiles || manifest.counts.failed || manifest.counts.pending) throw new Error('Incomplete bedrock cache.');
    // Measure actual output, including stale files from a previous failed build.
    // Do not delete unknown existing files from a user-provided output directory.
    async function diskBytes(dir) {
      let total=0;
      for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
        const file=path.join(dir,entry.name);
        if(entry.isSymbolicLink())throw new Error('Symlinks are not allowed in a bedrock cache output.');
        total+=entry.isDirectory()?await diskBytes(file):(await fs.stat(file)).size;
      }
      return total;
    }
    const measured=await diskBytes(output);
    manifest.complete=true;
    manifest.totalBytes=measured+Buffer.byteLength(JSON.stringify(manifest,null,2))+256;
    if(manifest.totalBytes>maxBytes)throw new Error('Bedrock cache measured output byte limit exceeded.');
    await writeManifest();
    log(`MRD126 complete: ${expectedFiles} files; ${manifest.totalBytes} bytes (conservative manifest-inclusive measurement).`);
    return manifest;
  } catch(error) {
    manifest.complete=false;
    await writeManifest();
    throw error;
  } finally {
    if(parserDOM){delete globalThis.DOMParser;parserDOM.window.close();}
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  if(args.length && (args.length!==2 || args[0]!=='--output')) {
    console.error('Usage: node scripts/cache-mrd126.mjs [--output <cache-directory>]');process.exitCode=1;
  } else {
    try {await buildBedrockCache({outputDir:args[1] || path.resolve('mrd126-cache'),log:console.log});}
    catch(error){console.error(error.message);process.exitCode=1;}
  }
}
