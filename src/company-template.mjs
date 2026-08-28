import {normalizeCompanyProfile,validateCompanyProfile} from './company-profile.mjs';

const TEMPLATE_SCHEMA_VERSION=1;
const MAX_DECOMPRESSED_BYTES=8*1024*1024;
const README='Phase I company template\n\nImport this file with Import Company Template, review the preview, and confirm replacement.\n';
const ZIP_DATE=new Date(Date.UTC(1980,0,1,0,0,0,0));
const LOGO_FILES=new Map([['image/png','logo.png'],['image/jpeg','logo.jpg']]);
const RESERVED_WINDOWS_NAMES=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

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
  let base=companyName.normalize('NFKD').replace(/\p{Mark}/gu,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80).replace(/-+$/g,'')||'company';
  if(RESERVED_WINDOWS_NAMES.test(base)) base=`company-${base}`;
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
  if(blob.type!==metadata.mime) throw new Error('Logo Blob MIME type does not match its metadata.');
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

function zipBytes(source){
  if(source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer,source.byteOffset,source.byteLength);
}

function findEndOfCentralDirectory(bytes,view){
  const first=Math.max(0,bytes.byteLength-65_557);
  for(let offset=bytes.byteLength-22;offset>=first;offset--){
    if(view.getUint32(offset,true)!==0x06054b50) continue;
    if(offset+22+view.getUint16(offset+20,true)===bytes.byteLength) return offset;
  }
  throw new Error('Company template ZIP has no valid central directory.');
}

function asciiPath(bytes){
  let result='';
  for(const byte of bytes){
    if(byte<0x20||byte>0x7e) throw new Error('Template ZIP paths must use printable ASCII characters.');
    result+=String.fromCharCode(byte);
  }
  return result;
}

function inspectCentralDirectory(source){
  const bytes=zipBytes(source);
  if(bytes.byteLength<22) throw new Error('Company template is not a valid ZIP archive.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const end=findEndOfCentralDirectory(bytes,view);
  const disk=view.getUint16(end+4,true);
  const centralDisk=view.getUint16(end+6,true);
  const diskEntries=view.getUint16(end+8,true);
  const entryCount=view.getUint16(end+10,true);
  const centralSize=view.getUint32(end+12,true);
  const centralOffset=view.getUint32(end+16,true);
  if(disk!==0||centralDisk!==0||diskEntries!==entryCount) throw new Error('Multi-disk template ZIPs are not supported.');
  if(entryCount===0xffff||centralSize===0xffffffff||centralOffset===0xffffffff) throw new Error('ZIP64 company templates are not supported.');
  if(centralOffset+centralSize!==end) throw new Error('Company template ZIP has an invalid central directory boundary.');

  const records=[];
  const names=new Set();
  let total=0;
  let offset=centralOffset;
  for(let index=0;index<entryCount;index++){
    if(offset+46>end||view.getUint32(offset,true)!==0x02014b50) throw new Error('Company template ZIP has an invalid central directory record.');
    const flags=view.getUint16(offset+8,true);
    const compressedSize=view.getUint32(offset+20,true);
    const declaredSize=view.getUint32(offset+24,true);
    const nameLength=view.getUint16(offset+28,true);
    const extraLength=view.getUint16(offset+30,true);
    const commentLength=view.getUint16(offset+32,true);
    const localOffset=view.getUint32(offset+42,true);
    const next=offset+46+nameLength+extraLength+commentLength;
    if(next>end) throw new Error('Company template ZIP has a truncated central directory record.');
    if((flags&1)!==0) throw new Error('Encrypted company template ZIP entries are not supported.');
    if(compressedSize===0xffffffff||declaredSize===0xffffffff||localOffset===0xffffffff) throw new Error('ZIP64 company template entries are not supported.');
    const original=asciiPath(bytes.subarray(offset+46,offset+46+nameLength));
    const name=decodedPath(original);
    if(names.has(name)) throw new Error(`Template ZIP contains duplicate normalized path "${name}".`);
    names.add(name);
    total+=declaredSize;
    if(total>MAX_DECOMPRESSED_BYTES) throw new Error('Template ZIP decompressed content exceeds 8 MiB.');
    records.push({name,original,declaredSize});
    offset=next;
  }
  if(offset!==end) throw new Error('Company template ZIP has unexpected central directory data.');
  const logos=records.filter(({name})=>name==='logo.png'||name==='logo.jpg');
  if(logos.length>1) throw new Error('Template ZIP contains multiple logos.');
  if(records.some(({name})=>name.endsWith('.svg'))) throw new Error('SVG logos are not supported; use PNG or JPEG.');
  const allowed=new Set(['template.json','readme.txt','logo.png','logo.jpg']);
  const unexpected=records.find(({name})=>!allowed.has(name));
  if(unexpected) throw new Error(`Template ZIP contains unexpected file "${unexpected.name}".`);
  if(records.length!==3||!names.has('template.json')||!names.has('readme.txt')||logos.length!==1){
    throw new Error('Template ZIP must contain template.json, README.txt, and exactly one PNG or JPEG logo.');
  }
  return {records,logo:logos[0]};
}

function attachEntries(zip,records){
  const entries=new Map();
  for(const entry of Object.values(zip.files)){
    const name=decodedPath(entry.unsafeOriginalName??entry.name);
    if(entries.has(name)) throw new Error(`Template ZIP contains duplicate normalized path "${name}".`);
    if(entry.dir) throw new Error(`Template ZIP contains unexpected directory "${name}".`);
    entries.set(name,entry);
  }
  if(entries.size!==records.length) throw new Error('Template ZIP records do not match the loaded archive.');
  return records.map(record=>{
    const entry=entries.get(record.name);
    if(!entry) throw new Error(`Template ZIP record "${record.name}" could not be loaded.`);
    return {...record,entry};
  });
}

function entryBytes(item,total){
  return new Promise((resolve,reject)=>{
    const chunks=[];
    let length=0;
    let settled=false;
    const stream=item.entry.internalStream('uint8array');
    const fail=error=>{
      if(settled) return;
      settled=true;
      chunks.length=0;
      try{stream.pause();}catch{}
      reject(error);
    };
    stream
      .on('data',chunk=>{
        if(settled) return;
        if(chunk.byteLength>MAX_DECOMPRESSED_BYTES-total.value){
          fail(new Error('Template ZIP decompressed content exceeds 8 MiB.'));
          return;
        }
        total.value+=chunk.byteLength;
        length+=chunk.byteLength;
        chunks.push(chunk);
      })
      .on('error',fail)
      .on('end',()=>{
        if(settled) return;
        if(length!==item.declaredSize){
          fail(new Error(`Template ZIP entry "${item.name}" inflated size does not match its central directory record.`));
          return;
        }
        settled=true;
        const bytes=new Uint8Array(length);
        let offset=0;
        for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
        resolve(bytes);
      })
      .resume();
  });
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
  const preflight=inspectCentralDirectory(source);
  let archive;
  try{
    archive=await Constructor.loadAsync(source,{createFolders:false});
  }catch(error){
    throw new Error('Company template is not a valid ZIP archive.',{cause:error});
  }
  const entries=attachEntries(archive,preflight.records);
  const logo=entries.find(item=>item.name===preflight.logo.name);
  const byName=new Map(entries.map(item=>[item.name,item]));
  const total={value:0};
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
  if(!assetStore||typeof assetStore.put!=='function') throw new Error('An asset store with atomic put support is required.');
  const profile=checkedProfile(candidate.profile);
  const logoMetadata=normalizeMetadata(candidate.logoMetadata);
  assertMetadataMatchesProfile(logoMetadata,profile);
  await checkedLogo(candidate.logoBlob,logoMetadata);
  if(typeof globalThis.crypto?.randomUUID!=='function') throw new Error('Secure random asset IDs are unavailable.');
  const id=`company-logo-${globalThis.crypto.randomUUID()}`;
  const persistedMetadata={...logoMetadata,id};
  const persistedProfile=normalizeCompanyProfile({...profile,logoAssetId:id});
  await assetStore.put({metadata:persistedMetadata,blob:candidate.logoBlob});
  return persistedProfile;
}
