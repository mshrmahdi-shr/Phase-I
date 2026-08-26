import {normalizeCompanyProfile,validateCompanyProfile} from './company-profile.mjs';

const TEMPLATE_SCHEMA_VERSION=1;
const MAX_DECOMPRESSED_BYTES=8*1024*1024;
const README='Phase I company template\n\nImport this file with Import Company Template, review the preview, and confirm replacement.\n';
const ZIP_DATE=new Date(1980,0,1,0,0,0,0);
const LOGO_FILES=new Map([['image/png','logo.png'],['image/jpeg','logo.jpg']]);

function plainObject(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null) throw new Error(`${label} must be a plain object.`);
  return value;
}

function zipConstructor(Zip){
  if(typeof Zip!=='function') throw new Error('A JSZip-compatible constructor is required.');
  return Zip;
}

function stableValue(value){
  if(Array.isArray(value)) return value.map(stableValue);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableValue(value[key])]));
  }
  return value;
}

function stableJson(value){
  return JSON.stringify(stableValue(value));
}

function safeFilename(companyName){
  const base=companyName.normalize('NFKD').replace(/\p{Mark}/gu,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'company';
  return `${base}.phasei-template.zip`;
}

async function sha256(value){
  const bytes=value instanceof ArrayBuffer?value:value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

function normalizeMetadata(value){
  plainObject(value,'Logo metadata');
  for(const field of ['id','kind','mime','sha256','createdAt']){
    if(typeof value[field]!=='string'||!value[field].trim()) throw new Error(`Logo metadata ${field} must be a non-empty string.`);
  }
  for(const field of ['size','width','height']){
    if(!Number.isSafeInteger(value[field])||value[field]<=0) throw new Error(`Logo metadata ${field} must be a positive whole number.`);
  }
  if(value.kind!=='company-logo') throw new Error('Template logo kind must be company-logo.');
  if(!LOGO_FILES.has(value.mime)) throw new Error('Template logo must be a PNG or JPEG image.');
  if(!/^[a-f0-9]{64}$/i.test(value.sha256)) throw new Error('Logo SHA-256 must contain 64 hexadecimal characters.');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.createdAt)||Number.isNaN(Date.parse(value.createdAt))){
    throw new Error('Logo createdAt must be an ISO timestamp.');
  }
  return {
    id:value.id,kind:value.kind,mime:value.mime,size:value.size,width:value.width,height:value.height,
    sha256:value.sha256.toLowerCase(),createdAt:value.createdAt
  };
}

function checkedProfile(value){
  const profile=normalizeCompanyProfile(value);
  const errors=validateCompanyProfile(profile);
  if(errors.length) throw new Error(`Company profile is incomplete: ${errors.map(error=>error.field).join(', ')}.`);
  return profile;
}

function assertMetadataMatchesProfile(metadata,profile){
  if(metadata.id!==profile.logoAssetId) throw new Error('Logo metadata ID does not match the company profile.');
  if(metadata.mime!==profile.logoMime) throw new Error('Logo metadata MIME type does not match the company profile.');
  if(metadata.width!==profile.logoWidth||metadata.height!==profile.logoHeight){
    throw new Error('Logo metadata dimensions do not match the company profile.');
  }
}

function assertSignature(bytes,mime){
  const png=bytes.length>=8&&[137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte);
  const jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if((mime==='image/png'&&!png)||(mime==='image/jpeg'&&!jpeg)){
    throw new Error(`Logo byte signature does not match ${mime}.`);
  }
}

async function checkedLogo(blob,metadata){
  if(!(blob instanceof Blob)) throw new Error('Template logo data must be a Blob.');
  if(blob.size!==metadata.size) throw new Error('Logo size does not match its metadata.');
  if(blob.type&&blob.type!==metadata.mime) throw new Error('Logo Blob MIME type does not match its metadata.');
  const bytes=new Uint8Array(await blob.arrayBuffer());
  assertSignature(bytes,metadata.mime);
  if(await sha256(bytes)!==metadata.sha256) throw new Error('Logo SHA-256 hash does not match its bytes.');
  return bytes;
}

function decodedPath(value){
  let path=value.normalize('NFKC');
  try{
    for(let count=0;count<4;count++){
      const decoded=decodeURIComponent(path);
      if(decoded===path) break;
      path=decoded;
    }
  }catch{
    throw new Error('Template ZIP contains an invalid encoded path.');
  }
  path=path.replace(/\\/g,'/');
  if(path.startsWith('/')||/^[a-z]:\//i.test(path)) throw new Error('Template ZIP contains an absolute path.');
  const segments=path.split('/');
  if(segments.some(segment=>segment==='.'||segment==='..')) throw new Error('Template ZIP contains path traversal.');
  if(segments.some(segment=>!segment)) throw new Error('Template ZIP contains an invalid path.');
  return segments.join('/').toLowerCase();
}

function inspectEntries(zip){
  const entries=[];
  const names=new Set();
  let total=0;
  for(const entry of Object.values(zip.files)){
    const original=entry.unsafeOriginalName??entry.name;
    const name=decodedPath(original);
    if(names.has(name)) throw new Error(`Template ZIP contains duplicate normalized path "${name}".`);
    names.add(name);
    if(entry.dir) throw new Error(`Template ZIP contains unexpected directory "${name}".`);
    const size=entry?._data?.uncompressedSize;
    if(size!==undefined&&(!Number.isSafeInteger(size)||size<0)) throw new Error('Template ZIP contains invalid decompressed size metadata.');
    if(size!==undefined){
      total+=size;
      if(total>MAX_DECOMPRESSED_BYTES) throw new Error('Template ZIP decompressed content exceeds 8 MiB.');
    }
    entries.push({name,entry,size});
  }
  const logos=entries.filter(({name})=>name==='logo.png'||name==='logo.jpg');
  if(logos.length>1) throw new Error('Template ZIP contains multiple logos.');
  if(entries.some(({name})=>name.endsWith('.svg'))) throw new Error('SVG logos are not supported; use PNG or JPEG.');
  const allowed=new Set(['template.json','readme.txt','logo.png','logo.jpg']);
  const unexpected=entries.find(({name})=>!allowed.has(name));
  if(unexpected) throw new Error(`Template ZIP contains unexpected file "${unexpected.name}".`);
  if(entries.length!==3||!names.has('template.json')||!names.has('readme.txt')||logos.length!==1){
    throw new Error('Template ZIP must contain template.json, README.txt, and exactly one PNG or JPEG logo.');
  }
  return {entries,logo:logos[0],metadataTotal:total};
}

async function entryBytes(item,total){
  const bytes=await item.entry.async('uint8array');
  if(!Number.isSafeInteger(item.size)){
    total.value+=bytes.byteLength;
    if(total.value>MAX_DECOMPRESSED_BYTES) throw new Error('Template ZIP decompressed content exceeds 8 MiB.');
  }
  return bytes;
}

export async function exportCompanyTemplate({profile,assetStore,Zip=globalThis.JSZip}={}){
  const Constructor=zipConstructor(Zip);
  const normalized=checkedProfile(profile);
  if(!assetStore||typeof assetStore.get!=='function') throw new Error('An asset store is required.');
  const asset=await assetStore.get(normalized.logoAssetId);
  if(!asset) throw new Error(`Company logo asset "${normalized.logoAssetId}" was not found.`);
  const metadata=normalizeMetadata(asset.metadata);
  assertMetadataMatchesProfile(metadata,normalized);
  const logoBytes=await checkedLogo(asset.blob,metadata);
  const logoName=LOGO_FILES.get(metadata.mime);
  const archive=new Constructor();
  const options={date:ZIP_DATE,createFolders:false};
  archive.file('template.json',stableJson({schemaVersion:TEMPLATE_SCHEMA_VERSION,profile:normalized,logo:metadata}),options);
  archive.file(logoName,logoBytes,options);
  archive.file('README.txt',README,options);
  const bytes=await archive.generateAsync({type:'uint8array',compression:'STORE',platform:'DOS',streamFiles:false});
  return {blob:new Blob([bytes],{type:'application/zip'}),filename:safeFilename(normalized.companyName)};
}

export async function inspectCompanyTemplate(file,{Zip=globalThis.JSZip}={}){
  const Constructor=zipConstructor(Zip);
  if(!(file instanceof Blob)&&!(file instanceof ArrayBuffer)&&!ArrayBuffer.isView(file)) throw new Error('Company template must be a ZIP Blob or byte buffer.');
  const source=file instanceof Blob?await file.arrayBuffer():file;
  let archive;
  try{
    archive=await Constructor.loadAsync(source,{createFolders:false});
  }catch(error){
    throw new Error('Company template is not a valid ZIP archive.',{cause:error});
  }
  const {entries,logo,metadataTotal}=inspectEntries(archive);
  const byName=new Map(entries.map(item=>[item.name,item]));
  const total={value:metadataTotal};
  const templateBytes=await entryBytes(byName.get('template.json'),total);
  let template;
  try{
    template=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(templateBytes));
  }catch(error){
    throw new Error('template.json contains invalid JSON.',{cause:error});
  }
  plainObject(template,'Template manifest');
  if(template.schemaVersion!==TEMPLATE_SCHEMA_VERSION) throw new Error('Unsupported company template schema version.');
  const profile=checkedProfile(template.profile);
  const logoMetadata=normalizeMetadata(template.logo);
  assertMetadataMatchesProfile(logoMetadata,profile);
  if(LOGO_FILES.get(logoMetadata.mime)!==logo.name) throw new Error('Logo filename extension does not match its MIME type.');
  const logoBytes=await entryBytes(logo,total);
  const logoBlob=new Blob([logoBytes],{type:logoMetadata.mime});
  await checkedLogo(logoBlob,logoMetadata);
  await entryBytes(byName.get('readme.txt'),total);
  return {profile,logoBlob,logoMetadata,warnings:[]};
}

export async function commitCompanyTemplate(candidate,{assetStore}={}){
  plainObject(candidate,'Company template candidate');
  if(!assetStore||typeof assetStore.replace!=='function') throw new Error('An asset store with atomic replace support is required.');
  const profile=checkedProfile(candidate.profile);
  const logoMetadata=normalizeMetadata(candidate.logoMetadata);
  assertMetadataMatchesProfile(logoMetadata,profile);
  await checkedLogo(candidate.logoBlob,logoMetadata);
  await assetStore.replace({
    removeIds:[profile.logoAssetId],
    put:{metadata:logoMetadata,blob:candidate.logoBlob}
  });
  return profile;
}
