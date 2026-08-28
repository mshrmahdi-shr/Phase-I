import {restoreProject} from './core.mjs';
import {normalizeCompanyProfile,validateCompanyProfile} from './company-profile.mjs';

const PACKAGE_SCHEMA_VERSION=1;
const PACKAGE_FORMAT='phasei-project';
const ZIP_DATE=new Date(Date.UTC(1980,0,1,0,0,0,0));
const MAX_ARCHIVE_BYTES=72*1024*1024;
const MAX_TOTAL_BYTES=64*1024*1024;
const MAX_ENTRY_BYTES=16*1024*1024;
const MAX_JSON_BYTES=4*1024*1024;
const MAX_ENTRIES=68;
const MAX_COMPRESSION_RATIO=200;
const MAX_PIXELS=16_000_000;
const README='Phase I project package\n\nImport this .phasei-project.zip file with Import Project Package, review the project and company summary, then confirm replacement. JSON import remains available only for legacy projects.\n';
const PROJECT_FIELDS=['address','buildingBoundary','company','companyProfileSnapshot','createdAt','date','dpi','exportPreferences','figures','geology','historical','historicalSequenceCounters','id','location','name','projectNo','schemaVersion','siteBoundary','updatedAt'];
const PROFILE_FIELDS=['address','companyName','email','id','logoAssetId','logoHeight','logoMime','logoPlacement','logoWidth','phone','preparedBy','reviewedBy','schemaVersion','updatedAt','website'];
const PLACEMENT_FIELDS=['align','scale'];
const MANIFEST_FIELDS=['companyProfileId','entries','format','projectId','schemaVersion'];
const ENTRY_FIELDS=['assetId','createdAt','height','kind','mediaType','owner','path','redistribution','referenceIds','sha256','size','width'];
const OWNER_FIELDS=['id','type'];
const REDISTRIBUTION_FIELDS=['evidence','policy'];
const ASSET_FIELDS=['blob','metadata'];
const ASSET_METADATA_FIELDS=['createdAt','height','id','kind','mime','sha256','size','width'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256=/^[a-f0-9]{64}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const IMAGE_EXTENSIONS=new Map([['image/png','png'],['image/jpeg','jpg'],['image/tiff','tif']]);
const INSPECTED_CANDIDATES=new WeakSet();

function fail(message){throw new Error(message);}
function throwIfAborted(signal){if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('Cancelled','AbortError');}
function zipConstructor(Zip){if(typeof Zip!=='function')fail('A JSZip-compatible constructor is required.');return Zip;}
function plainObject(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} must be a plain object.`);
  const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)fail(`${label} must be a plain object.`);return value;
}
function exactObject(value,fields,label){
  plainObject(value,label);const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=='string')||keys.length!==fields.length||keys.some(key=>!fields.includes(key))||fields.some(key=>!keys.includes(key)))fail(`${label} must have exact fields.`);
  const result={};for(const key of fields){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail(`${label}.${key} must be an enumerable data field.`);result[key]=descriptor.value;}return result;
}
function boundedText(value,label,{maximum=1000,nullable=false}={}){
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||!value.trim()||value.length>maximum||/[\u0000-\u001f\u007f]/.test(value))fail(`${label} must be nonempty bounded text.`);return value;
}
function isoTimestamp(value,label){if(typeof value!=='string'||!ISO.test(value)||Number.isNaN(Date.parse(value)))fail(`${label} must be an ISO timestamp.`);return value;}
function stableValue(value){
  if(Array.isArray(value))return value.map(stableValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableValue(value[key])]));
  return value;
}
function stableJson(value){return JSON.stringify(stableValue(value));}
function equalValue(left,right){return stableJson(left)===stableJson(right);}
function utf8(value){return new TextEncoder().encode(value);}
async function sha256(bytes){
  const view=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes.buffer??bytes,bytes.byteOffset??0,bytes.byteLength??bytes.length);
  const digest=await globalThis.crypto.subtle.digest('SHA-256',view);return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function safeFilename(project){
  let base=String(project.projectNo||project.name||'phase-i-project').normalize('NFKD').replace(/\p{Mark}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80).replace(/-+$/,'')||'phase-i-project';
  if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base))base=`project-${base}`;return `${base}.phasei-project.zip`;
}
function deepFreeze(value,seen=new Set()){
  if(!value||typeof value!=='object'||value instanceof Blob||seen.has(value))return value;seen.add(value);
  for(const key of Reflect.ownKeys(value))deepFreeze(value[key],seen);return Object.freeze(value);
}

function checkedProfile(value,{strict=false}={}){
  if(strict){exactObject(value,PROFILE_FIELDS,'Company profile');exactObject(value.logoPlacement,PLACEMENT_FIELDS,'Company logo placement');}
  const profile=normalizeCompanyProfile(value),errors=validateCompanyProfile(profile);
  if(errors.length)fail(`Company profile is incomplete: ${errors.map(error=>error.field).join(', ')}.`);
  if(!SAFE_ID.test(profile.id)||!SAFE_ID.test(profile.logoAssetId))fail('Company profile and logo asset IDs must use safe bounded characters.');
  if(strict&&!equalValue(profile,value))fail('Company profile JSON is not canonical or contains unsupported values.');return profile;
}
function checkedProject(value,profile,{strict=false}={}){
  if(strict)exactObject(value,PROJECT_FIELDS,'Project package project');
  const candidate={...value,companyProfileSnapshot:profile},project=restoreProject(candidate);
  if(!SAFE_ID.test(project.id))fail('Project ID must use safe bounded characters.');
  isoTimestamp(project.createdAt,'Project createdAt');isoTimestamp(project.updatedAt,'Project updatedAt');
  if(Date.parse(project.updatedAt)<Date.parse(project.createdAt))fail('Project updatedAt cannot precede createdAt.');
  if(![150,300].includes(project.dpi))fail('Project DPI must be 150 or 300.');
  if(project.schemaVersion!==6)fail('Project package requires project schema version 6.');
  project.companyProfileSnapshot=profile;
  if(strict&&!equalValue(project,value))fail('Project JSON is not canonical, has unsupported fields, or attempts a legacy trust upgrade.');
  return project;
}

function pngDimensions(bytes){
  if(bytes.length<24||![137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte)||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR')fail('PNG asset has an invalid byte signature or header.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return {width:view.getUint32(16),height:view.getUint32(20)};
}
function jpegDimensions(bytes){
  if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8||bytes[2]!==0xff)fail('JPEG asset has an invalid byte signature.');
  let offset=2,segments=0;while(offset<bytes.length&&segments++<4096){
    while(offset<bytes.length&&bytes[offset]===0xff)offset++;const marker=bytes[offset++];if(marker===0xd9||marker===0xda)break;if(marker===0||marker===undefined)break;
    if(marker>=0xd0&&marker<=0xd7)continue;if(offset+2>bytes.length)break;const length=bytes[offset]<<8|bytes[offset+1];
    if(length<2||offset+length>bytes.length)break;
    if(new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]).has(marker)&&length>=7)return {height:bytes[offset+3]<<8|bytes[offset+4],width:bytes[offset+5]<<8|bytes[offset+6]};
    offset+=length;
  }
  fail('JPEG asset has no valid bounded frame header.');
}
function tiffDimensions(bytes){
  if(bytes.length<8)fail('TIFF asset has an invalid byte signature or header.');const little=bytes[0]===0x49&&bytes[1]===0x49,big=bytes[0]===0x4d&&bytes[1]===0x4d;
  if(!little&&!big)fail('TIFF asset has an invalid byte-order signature.');const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint16(2,little)!==42)fail('Only bounded classic TIFF assets are supported.');const directory=view.getUint32(4,little);if(directory<8||directory+2>bytes.length)fail('TIFF asset directory is invalid.');
  const count=view.getUint16(directory,little);if(count>128||directory+2+count*12+4>bytes.length)fail('TIFF asset directory exceeds its bounded structure.');let width,height;
  for(let index=0;index<count;index++){const offset=directory+2+index*12,tag=view.getUint16(offset,little),type=view.getUint16(offset+2,little),values=view.getUint32(offset+4,little);if((tag===256||tag===257)&&values===1&&(type===3||type===4)){const value=type===3?view.getUint16(offset+8,little):view.getUint32(offset+8,little);if(tag===256)width=value;else height=value;}}
  if(!width||!height)fail('TIFF asset does not declare valid dimensions.');return {width,height};
}
function imageDimensions(bytes,mime){
  if(bytes.length>=4&&bytes[0]===0x50&&bytes[1]===0x4b&&(bytes[2]===3||bytes[2]===5||bytes[2]===7)&&[4,6,8].includes(bytes[3]))fail('Nested archive assets are not allowed.');
  if(mime==='image/png')return pngDimensions(bytes);if(mime==='image/jpeg')return jpegDimensions(bytes);if(mime==='image/tiff')return tiffDimensions(bytes);fail('Project package image media type is not supported.');
}
function checkedMetadata(value,expectedKind){
  const metadata=exactObject(value,ASSET_METADATA_FIELDS,'Asset metadata');
  if(!SAFE_ID.test(metadata.id))fail('Asset ID must use safe bounded characters.');
  if(metadata.kind!==expectedKind)fail(`Asset kind must be ${expectedKind}.`);
  const allowed=expectedKind==='company-logo'?new Set(['image/png','image/jpeg']):new Set(['image/png','image/jpeg','image/tiff']);if(!allowed.has(metadata.mime))fail(`Asset media type is invalid for ${expectedKind}.`);
  if(!Number.isSafeInteger(metadata.size)||metadata.size<=0||metadata.size>MAX_ENTRY_BYTES)fail('Asset size exceeds the 16 MiB safety limit.');
  if(!Number.isSafeInteger(metadata.width)||metadata.width<=0||!Number.isSafeInteger(metadata.height)||metadata.height<=0||metadata.width>Math.floor(MAX_PIXELS/metadata.height))fail('Asset dimensions exceed the 16 million pixel limit.');
  if(typeof metadata.sha256!=='string'||!SHA256.test(metadata.sha256))fail('Asset SHA-256 must contain 64 lowercase hexadecimal characters.');isoTimestamp(metadata.createdAt,'Asset createdAt');return {...metadata};
}
async function checkedAsset(value,{kind,id,width,height,signal}={}){
  throwIfAborted(signal);const fields=exactObject(value,ASSET_FIELDS,'Asset'),metadata=checkedMetadata(fields.metadata,kind);
  if(metadata.id!==id)fail('Asset metadata ID does not match its owning reference.');if(!(fields.blob instanceof Blob)||fields.blob.type!==metadata.mime||fields.blob.size!==metadata.size)fail('Asset Blob does not match its metadata.');
  const bytes=new Uint8Array(await fields.blob.arrayBuffer());throwIfAborted(signal);const dimensions=imageDimensions(bytes,metadata.mime);
  if(dimensions.width!==metadata.width||dimensions.height!==metadata.height)fail('Asset decoded header dimensions do not match its metadata.');
  if(width!==undefined&&(metadata.width!==width||metadata.height!==height))fail('Asset dimensions do not match the owning project reference.');
  if(await sha256(bytes)!==metadata.sha256)fail('Asset SHA-256 hash does not match its bytes.');throwIfAborted(signal);return {metadata,blob:new Blob([bytes],{type:metadata.mime}),bytes};
}

function projectReferences(project,profile){
  const references=new Map([[profile.logoAssetId,{kind:'company-logo',owner:{type:'company-profile',id:profile.id},referenceIds:[profile.id],width:profile.logoWidth,height:profile.logoHeight,evidence:'company-profile-logo'}]]);
  for(const item of project.historical){
    if(item.mode==='official')continue;
    if(item.policy!=='exportable')fail('Manual historical imagery must retain explicit exportable permission; project packages never upgrade policy.');
    const existing=references.get(item.assetId);if(existing&&existing.kind!=='historical-image')fail('Company and historical records cannot claim the same asset ID with different ownership.');
    if(existing){if(existing.width!==item.placement.sourceWidth||existing.height!==item.placement.sourceHeight)fail('Shared historical asset references disagree on source dimensions.');existing.referenceIds.push(item.id);}
    else references.set(item.assetId,{kind:'historical-image',owner:{type:'project',id:project.id},referenceIds:[item.id],width:item.placement.sourceWidth,height:item.placement.sourceHeight,evidence:'manual-permission-confirmed'});
  }
  for(const reference of references.values())reference.referenceIds.sort((left,right)=>left.localeCompare(right,'en'));return references;
}
function metadataEntry({path,kind,bytes,asset=null,owner,referenceIds,policy,evidence}){
  return {path,kind,mediaType:asset?.metadata.mime??(kind==='readme'?'text/plain; charset=utf-8':'application/json'),size:bytes.byteLength,sha256:null,assetId:asset?.metadata.id??null,
    width:asset?.metadata.width??null,height:asset?.metadata.height??null,createdAt:asset?.metadata.createdAt??null,owner,referenceIds:[...referenceIds],redistribution:{policy,evidence}};
}
async function hashEntries(entries){for(const entry of entries)entry.sha256=await sha256(entry.bytes);return entries;}

export async function exportProjectPackage({project,companyProfile,assetStore,Zip=globalThis.JSZip,signal,onProgress=()=>{}}={}){
  const Constructor=zipConstructor(Zip);throwIfAborted(signal);if(!assetStore||typeof assetStore.get!=='function')fail('An asset store is required.');
  const profile=checkedProfile(companyProfile),snapshot=checkedProject(project,profile),references=projectReferences(snapshot,profile),assets=[];
  let completed=0;for(const [id,reference] of references){
    throwIfAborted(signal);const stored=await assetStore.get(id);throwIfAborted(signal);if(!stored)fail(`Referenced ${reference.kind} asset "${id}" is missing.`);
    const asset=await checkedAsset(stored,{...reference,id,signal});assets.push({...asset,reference});onProgress({phase:'reading-assets',completed:++completed,total:references.size,assetId:id});
  }
  const profileBytes=utf8(stableJson(profile)),projectBytes=utf8(stableJson(snapshot)),readmeBytes=utf8(README),payload=[];
  payload.push({...metadataEntry({path:'project.json',kind:'project-json',bytes:projectBytes,owner:{type:'project',id:snapshot.id},referenceIds:[snapshot.id],policy:'metadata',evidence:'required-project-data'}),bytes:projectBytes});
  payload.push({...metadataEntry({path:'company-profile.json',kind:'company-profile-json',bytes:profileBytes,owner:{type:'company-profile',id:profile.id},referenceIds:[profile.id],policy:'metadata',evidence:'required-company-profile'}),bytes:profileBytes});
  const logo=assets.find(value=>value.metadata.id===profile.logoAssetId),historical=assets.filter(value=>value.metadata.id!==profile.logoAssetId).sort((a,b)=>a.metadata.id.localeCompare(b.metadata.id,'en'));
  for(const asset of [logo,...historical]){
    const extension=IMAGE_EXTENSIONS.get(asset.metadata.mime),path=`assets/${asset.metadata.id}.${extension}`;
    payload.push({...metadataEntry({path,kind:asset.metadata.kind,bytes:asset.bytes,asset,owner:asset.reference.owner,referenceIds:asset.reference.referenceIds,
      policy:'exportable',evidence:asset.reference.evidence}),bytes:asset.bytes});
  }
  payload.push({...metadataEntry({path:'README.txt',kind:'readme',bytes:readmeBytes,owner:{type:'project',id:snapshot.id},referenceIds:[snapshot.id],policy:'metadata',evidence:'import-instructions'}),bytes:readmeBytes});
  await hashEntries(payload);const entries=payload.map(({bytes,...entry})=>entry),manifest={schemaVersion:PACKAGE_SCHEMA_VERSION,format:PACKAGE_FORMAT,projectId:snapshot.id,companyProfileId:profile.id,entries},manifestBytes=utf8(stableJson(manifest));
  const archive=new Constructor(),options={date:ZIP_DATE,createFolders:false};archive.file('manifest.json',manifestBytes,options);for(const item of payload)archive.file(item.path,item.bytes,options);
  throwIfAborted(signal);let bytes;try{bytes=await archive.generateAsync({type:'uint8array',compression:'STORE',platform:'DOS',streamFiles:false},metadata=>{throwIfAborted(signal);onProgress({phase:'compressing',percent:metadata.percent});});}catch(error){throw error;}
  throwIfAborted(signal);return {blob:new Blob([bytes],{type:'application/zip'}),filename:safeFilename(snapshot),manifest:deepFreeze(structuredClone(manifest))};
}

function sourceBytes(source){
  if(source instanceof ArrayBuffer)return new Uint8Array(source);if(ArrayBuffer.isView(source))return new Uint8Array(source.buffer,source.byteOffset,source.byteLength);return null;
}
async function readArchiveSource(source,signal){
  throwIfAborted(signal);const direct=sourceBytes(source);if(direct){if(direct.byteLength>MAX_ARCHIVE_BYTES)fail('Project package compressed size exceeds the 72 MiB limit.');return new Uint8Array(direct);}
  if(!(source instanceof Blob))fail('Project package must be a ZIP Blob or byte buffer.');if(source.size>MAX_ARCHIVE_BYTES)fail('Project package compressed size exceeds the 72 MiB limit.');
  if(typeof source.stream!=='function'){const bytes=new Uint8Array(await source.arrayBuffer());throwIfAborted(signal);return bytes;}
  const reader=source.stream().getReader(),chunks=[];let total=0;try{
    while(true){throwIfAborted(signal);const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array))fail('Project package stream returned invalid bytes.');if(total>MAX_ARCHIVE_BYTES-value.byteLength)fail('Project package compressed size exceeds the 72 MiB limit.');total+=value.byteLength;chunks.push(value);}
  }catch(error){try{await reader.cancel(error);}catch{}throw error;}finally{try{reader.releaseLock();}catch{}}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}throwIfAborted(signal);return bytes;
}
function findEnd(bytes,view){
  const first=Math.max(0,bytes.byteLength-65_557);for(let offset=bytes.byteLength-22;offset>=first;offset--)if(view.getUint32(offset,true)===0x06054b50&&offset+22+view.getUint16(offset+20,true)===bytes.byteLength)return offset;
  fail('Project package ZIP has no valid central directory.');
}
function decodeName(bytes,flags){
  try{
    if((flags&0x800)!==0)return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if([...bytes].some(byte=>byte<0x20||byte>0x7e))fail('Project package ZIP paths must be printable ASCII or flagged UTF-8.');return String.fromCharCode(...bytes);
  }catch(error){if(error instanceof Error&&/paths/.test(error.message))throw error;throw new Error('Project package ZIP contains an invalid UTF-8 path.',{cause:error});}
}
function normalizedPath(original){
  if(typeof original!=='string'||original.includes('\0')||/[\u0000-\u001f\u007f]/.test(original))fail('Project package ZIP path contains NUL or control characters.');
  if(original.includes('\\'))fail('Project package ZIP paths cannot contain backslashes.');let decoded=original;
  try{for(let count=0;count<4;count++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}}catch{fail('Project package ZIP contains an invalid encoded path.');}
  const compatibility=decoded.normalize('NFKC');if(compatibility.includes('\\')||/[\u0000-\u001f\u007f]/.test(compatibility))fail('Project package ZIP path becomes unsafe after Unicode normalization.');
  if(compatibility.startsWith('/')||/^[A-Za-z]:\//.test(compatibility))fail('Project package ZIP contains an absolute path.');const segments=compatibility.split('/');
  if(segments.some(segment=>!segment||segment==='.'||segment==='..'))fail('Project package ZIP contains path traversal or an empty segment.');
  return {original,path:compatibility,key:compatibility.toLocaleLowerCase('en-US')};
}
function rawArchive(bytes){
  if(bytes.byteLength<22)fail('Project package is not a valid ZIP archive.');const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=findEnd(bytes,view);
  const disk=view.getUint16(end+4,true),centralDisk=view.getUint16(end+6,true),diskEntries=view.getUint16(end+8,true),count=view.getUint16(end+10,true),centralSize=view.getUint32(end+12,true),centralOffset=view.getUint32(end+16,true),commentLength=view.getUint16(end+20,true);
  if(disk!==0||centralDisk!==0||diskEntries!==count)fail('Multi-disk project package ZIPs are not supported.');if(commentLength!==0)fail('Project package ZIP comments are not supported.');
  if(count===0||count>MAX_ENTRIES)fail(`Project package ZIP entry count exceeds the ${MAX_ENTRIES} entry limit.`);if(count===0xffff||centralSize===0xffffffff||centralOffset===0xffffffff)fail('ZIP64 project packages are not supported.');
  if(centralOffset+centralSize!==end)fail('Project package ZIP has an invalid central directory boundary.');
  const records=[],names=new Set();let offset=centralOffset,total=0;
  for(let index=0;index<count;index++){
    if(offset+46>end||view.getUint32(offset,true)!==0x02014b50)fail('Project package ZIP has an invalid central directory record.');const madeBy=view.getUint16(offset+4,true),flags=view.getUint16(offset+8,true),method=view.getUint16(offset+10,true),compressedSize=view.getUint32(offset+20,true),declaredSize=view.getUint32(offset+24,true),nameLength=view.getUint16(offset+28,true),extraLength=view.getUint16(offset+30,true),entryComment=view.getUint16(offset+32,true),external=view.getUint32(offset+38,true),localOffset=view.getUint32(offset+42,true),next=offset+46+nameLength+extraLength+entryComment;
    if(next>end)fail('Project package ZIP has a truncated central directory record.');
    const nameBytes=bytes.subarray(offset+46,offset+46+nameLength),normalized=normalizedPath(decodeName(nameBytes,flags));if(names.has(normalized.key))fail(`Project package ZIP contains duplicate normalized path "${normalized.key}".`);names.add(normalized.key);
    if((flags&1)!==0)fail('Encrypted project package entries are not supported.');if((flags&~0x800)!==0)fail('Project package ZIP entry flags are unsupported.');if(method!==0&&method!==8)fail('Project package ZIP compression method is unsupported.');
    if(extraLength||entryComment)fail('Project package ZIP entry extra fields and comments are unsupported.');
    const creator=madeBy>>>8,ordinaryDosArchive=creator===0&&external===0x20;
    if(external!==0&&!ordinaryDosArchive){const type=external>>>28;if(type===0xa)fail('Project package ZIP symlink entries are not supported.');fail(`Project package ZIP external attributes are unsupported (creator ${creator}, type ${type}).`);}
    if(compressedSize===0xffffffff||declaredSize===0xffffffff||localOffset===0xffffffff)fail('ZIP64 project package entries are not supported.');if(declaredSize>MAX_ENTRY_BYTES)fail('Project package ZIP entry size exceeds the 16 MiB limit.');
    if(compressedSize===0&&declaredSize!==0||compressedSize>0&&declaredSize/compressedSize>MAX_COMPRESSION_RATIO)fail('Project package ZIP compression ratio indicates a possible ZIP bomb.');
    if(total>MAX_TOTAL_BYTES-declaredSize)fail('Project package decompressed content exceeds the 64 MiB limit.');total+=declaredSize;
    if(localOffset+30>centralOffset||view.getUint32(localOffset,true)!==0x04034b50)fail('Project package ZIP has an invalid local file header.');const localFlags=view.getUint16(localOffset+6,true),localMethod=view.getUint16(localOffset+8,true),localCompressed=view.getUint32(localOffset+18,true),localDeclared=view.getUint32(localOffset+22,true),localNameLength=view.getUint16(localOffset+26,true),localExtraLength=view.getUint16(localOffset+28,true);
    if(localFlags!==flags||localMethod!==method||localCompressed!==compressedSize||localDeclared!==declaredSize||localExtraLength!==0||localNameLength!==nameLength)fail('Project package ZIP local and central records do not match.');
    const localName=bytes.subarray(localOffset+30,localOffset+30+localNameLength);if(localName.length!==nameBytes.length||localName.some((byte,position)=>byte!==nameBytes[position]))fail('Project package ZIP local and central paths do not match.');
    const dataStart=localOffset+30+localNameLength,dataEnd=dataStart+compressedSize;if(dataEnd>centralOffset)fail('Project package ZIP entry data escapes its declared boundary.');
    records.push({...normalized,flags,method,compressedSize,declaredSize,localOffset,dataStart,dataEnd,index});offset=next;
  }
  if(offset!==end)fail('Project package ZIP has unexpected central directory data.');const regions=[...records].sort((a,b)=>a.localOffset-b.localOffset);let boundary=0;
  for(const record of regions){if(record.localOffset!==boundary)fail('Project package ZIP contains hidden, overlapping, or unsupported local data.');boundary=record.dataEnd;}if(boundary!==centralOffset)fail('Project package ZIP contains hidden data before its central directory.');return records;
}
function attachEntries(archive,records){
  const loaded=new Map();for(const entry of Object.values(archive.files)){const normalized=normalizedPath(entry.unsafeOriginalName??entry.name);if(loaded.has(normalized.key))fail(`Project package ZIP contains duplicate normalized path "${normalized.key}".`);if(entry.dir)fail(`Project package ZIP contains unexpected directory "${normalized.path}".`);loaded.set(normalized.key,entry);}
  if(loaded.size!==records.length)fail('Project package ZIP records do not match the loaded archive.');return records.map(record=>{const entry=loaded.get(record.key);if(!entry)fail(`Project package ZIP record "${record.path}" could not be loaded.`);return {...record,entry};});
}
async function inflate(item,budget,signal){
  throwIfAborted(signal);const chunks=[];let length=0,settled=false;return new Promise((resolve,reject)=>{
    const stream=item.entry.internalStream('uint8array'),failStream=error=>{if(settled)return;settled=true;chunks.length=0;try{stream.pause();}catch{}reject(error);};
    const abort=()=>failStream(signal.reason instanceof Error?signal.reason:new DOMException('Cancelled','AbortError'));signal?.addEventListener('abort',abort,{once:true});
    stream.on('data',chunk=>{if(settled)return;if(!(chunk instanceof Uint8Array)||chunk.byteLength>MAX_TOTAL_BYTES-budget.value){failStream(new Error('Project package decompressed content exceeds the 64 MiB limit.'));return;}budget.value+=chunk.byteLength;length+=chunk.byteLength;chunks.push(chunk);})
      .on('error',failStream).on('end',()=>{if(settled)return;signal?.removeEventListener('abort',abort);if(length!==item.declaredSize){failStream(new Error(`Project package entry "${item.path}" inflated size does not match its central directory record.`));return;}settled=true;const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}resolve(bytes);}).resume();
  });
}
function parseJson(bytes,label){
  if(bytes.byteLength>MAX_JSON_BYTES)fail(`${label} exceeds the 4 MiB JSON limit.`);let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(text);}catch(error){throw new Error(`${label} contains invalid JSON.`,{cause:error});}
  if(text!==stableJson(value))fail(`${label} must use canonical deterministic JSON.`);return value;
}
function checkedOwner(value){const owner=exactObject(value,OWNER_FIELDS,'Manifest entry owner');if(!['project','company-profile'].includes(owner.type)||!SAFE_ID.test(owner.id))fail('Manifest entry owner is invalid.');return owner;}
function checkedRedistribution(value){const policy=exactObject(value,REDISTRIBUTION_FIELDS,'Manifest entry redistribution');if(!['metadata','exportable'].includes(policy.policy)||!['required-project-data','required-company-profile','company-profile-logo','manual-permission-confirmed','import-instructions'].includes(policy.evidence))fail('Manifest entry redistribution evidence is invalid.');return policy;}
function checkedEntry(value){
  const entry=exactObject(value,ENTRY_FIELDS,'Project package manifest entry');const path=normalizedPath(boundedText(entry.path,'Manifest entry path',{maximum:300}));if(path.path!==entry.path||path.key!==entry.path.toLocaleLowerCase('en-US'))fail('Manifest entry path must be canonical and case preserving.');
  if(!['project-json','company-profile-json','company-logo','historical-image','readme'].includes(entry.kind))fail('Manifest entry kind is invalid.');if(typeof entry.mediaType!=='string'||entry.mediaType.length>100)fail('Manifest entry media type is invalid.');
  if(!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>MAX_ENTRY_BYTES)fail('Manifest entry size is invalid.');if(typeof entry.sha256!=='string'||!SHA256.test(entry.sha256))fail('Manifest entry SHA-256 is invalid.');
  if(!Array.isArray(entry.referenceIds)||!entry.referenceIds.length||new Set(entry.referenceIds).size!==entry.referenceIds.length||entry.referenceIds.some(id=>!SAFE_ID.test(id)))fail('Manifest entry reference IDs are invalid or duplicated.');
  const owner=checkedOwner(entry.owner),redistribution=checkedRedistribution(entry.redistribution);
  if(entry.assetId===null){if(entry.width!==null||entry.height!==null||entry.createdAt!==null)fail('Non-asset manifest entries cannot contain asset dimensions or timestamps.');}
  else{if(!SAFE_ID.test(entry.assetId)||!Number.isSafeInteger(entry.width)||entry.width<=0||!Number.isSafeInteger(entry.height)||entry.height<=0||entry.width>Math.floor(MAX_PIXELS/entry.height))fail('Manifest asset identity or dimensions are invalid.');isoTimestamp(entry.createdAt,'Manifest asset createdAt');}
  return {...entry,owner,referenceIds:[...entry.referenceIds],redistribution};
}
function checkedManifest(value,records){
  const fields=exactObject(value,MANIFEST_FIELDS,'Project package manifest');if(fields.schemaVersion!==PACKAGE_SCHEMA_VERSION||fields.format!==PACKAGE_FORMAT)fail('Unsupported project package schema version or format.');if(!SAFE_ID.test(fields.projectId)||!SAFE_ID.test(fields.companyProfileId))fail('Project package manifest owner IDs are invalid.');
  if(!Array.isArray(fields.entries)||fields.entries.length<3||fields.entries.length>MAX_ENTRIES-1)fail('Project package manifest entries are invalid.');const entries=fields.entries.map(checkedEntry),paths=new Set();for(const entry of entries){if(paths.has(entry.path.toLocaleLowerCase('en-US')))fail('Project package manifest paths are duplicated.');paths.add(entry.path.toLocaleLowerCase('en-US'));}
  const centralPaths=records.map(record=>record.path);if(centralPaths[0]!=='manifest.json'||!equalValue(centralPaths.slice(1),entries.map(entry=>entry.path)))fail('Project package manifest has missing, extra, or out-of-order archive entries.');return {schemaVersion:fields.schemaVersion,format:fields.format,projectId:fields.projectId,companyProfileId:fields.companyProfileId,entries};
}
function expectedMetadataEntry(entry,{kind,path,mediaType,owner,referenceIds,policy,evidence}){
  if(entry.kind!==kind||entry.path!==path||entry.mediaType!==mediaType||entry.assetId!==null||!equalValue(entry.owner,owner)||!equalValue(entry.referenceIds,referenceIds)||entry.redistribution.policy!==policy||entry.redistribution.evidence!==evidence)fail(`Manifest ${kind} entry does not match its required ownership, media, reference, or redistribution contract.`);
}
function entryMetadata(entry){return {id:entry.assetId,kind:entry.kind,mime:entry.mediaType,size:entry.size,width:entry.width,height:entry.height,sha256:entry.sha256,createdAt:entry.createdAt};}

export async function inspectProjectPackage(file,{Zip=globalThis.JSZip,signal}={}){
  const Constructor=zipConstructor(Zip),source=await readArchiveSource(file,signal),records=rawArchive(source);throwIfAborted(signal);let archive;
  try{archive=await Constructor.loadAsync(source,{createFolders:false,checkCRC32:true});}catch(error){throw new Error('Project package is not a valid ZIP archive or has a CRC mismatch.',{cause:error});}
  const items=attachEntries(archive,records),byPath=new Map(items.map(item=>[item.path,item])),budget={value:0};
  const manifestBytes=await inflate(byPath.get('manifest.json')??fail('Project package is missing manifest.json.'),budget,signal),manifest=checkedManifest(parseJson(manifestBytes,'manifest.json'),records);
  const payload=new Map();for(const entry of manifest.entries){const bytes=await inflate(byPath.get(entry.path)??fail(`Project package is missing "${entry.path}".`),budget,signal);if(bytes.byteLength!==entry.size)fail(`Project package entry "${entry.path}" size does not match its manifest.`);if(await sha256(bytes)!==entry.sha256)fail(`Project package entry "${entry.path}" hash does not match its manifest.`);payload.set(entry.path,bytes);throwIfAborted(signal);}
  const projectEntry=manifest.entries.find(entry=>entry.kind==='project-json'),profileEntry=manifest.entries.find(entry=>entry.kind==='company-profile-json'),readmeEntry=manifest.entries.find(entry=>entry.kind==='readme');
  if(!projectEntry||!profileEntry||!readmeEntry)fail('Project package is missing required project, company profile, or README entries.');
  const profile=checkedProfile(parseJson(payload.get(profileEntry.path),'company-profile.json'),{strict:true}),project=checkedProject(parseJson(payload.get(projectEntry.path),'project.json'),profile,{strict:true});
  if(manifest.projectId!==project.id||manifest.companyProfileId!==profile.id)fail('Project package manifest owner IDs do not match project/profile data.');
  expectedMetadataEntry(projectEntry,{kind:'project-json',path:'project.json',mediaType:'application/json',owner:{type:'project',id:project.id},referenceIds:[project.id],policy:'metadata',evidence:'required-project-data'});
  expectedMetadataEntry(profileEntry,{kind:'company-profile-json',path:'company-profile.json',mediaType:'application/json',owner:{type:'company-profile',id:profile.id},referenceIds:[profile.id],policy:'metadata',evidence:'required-company-profile'});
  expectedMetadataEntry(readmeEntry,{kind:'readme',path:'README.txt',mediaType:'text/plain; charset=utf-8',owner:{type:'project',id:project.id},referenceIds:[project.id],policy:'metadata',evidence:'import-instructions'});
  new TextDecoder('utf-8',{fatal:true}).decode(payload.get(readmeEntry.path));const references=projectReferences(project,profile),assetEntries=manifest.entries.filter(entry=>entry.assetId!==null);
  if(assetEntries.length!==references.size)fail('Project package manifest has missing or extra asset entries.');const assets=[];
  for(const entry of assetEntries){
    const reference=references.get(entry.assetId);if(!reference)fail(`Manifest asset "${entry.assetId}" is not owned by the project or company profile.`);const extension=IMAGE_EXTENSIONS.get(entry.mediaType),expectedPath=`assets/${entry.assetId}.${extension}`;
    if(entry.kind!==reference.kind||entry.path!==expectedPath||!equalValue(entry.owner,reference.owner)||!equalValue(entry.referenceIds,reference.referenceIds)||entry.redistribution.policy!=='exportable'||entry.redistribution.evidence!==reference.evidence)fail(`Manifest asset "${entry.assetId}" has the wrong kind, media, ownership, reference, or redistribution evidence.`);
    const metadata=entryMetadata(entry),blob=new Blob([payload.get(entry.path)],{type:entry.mediaType}),asset=await checkedAsset({metadata,blob},{...reference,id:entry.assetId,signal});assets.push({metadata:asset.metadata,blob:asset.blob});
  }
  assets.sort((left,right)=>{if(left.metadata.id===profile.logoAssetId)return -1;if(right.metadata.id===profile.logoAssetId)return 1;return left.metadata.id.localeCompare(right.metadata.id,'en');});
  const candidate=deepFreeze({schemaVersion:PACKAGE_SCHEMA_VERSION,project,companyProfile:profile,assets,manifest,warnings:[]});INSPECTED_CANDIDATES.add(candidate);return candidate;
}

function referencedAssetIds(state){
  const ids=new Set();const profile=state?.companyProfile;if(profile?.logoAssetId)ids.add(profile.logoAssetId);for(const item of state?.project?.historical??[])if(item?.assetId)ids.add(item.assetId);return ids;
}
async function sameStoredAsset(existing,expected,signal){
  try{const checked=await checkedAsset(existing,{kind:expected.metadata.kind,id:expected.metadata.id,width:expected.metadata.width,height:expected.metadata.height,signal});return equalValue(checked.metadata,expected.metadata)&&await sha256(await checked.blob.arrayBuffer())===expected.metadata.sha256;}catch(error){if(error?.name==='AbortError')throw error;return false;}
}
async function cleanupAdded(added,{assetStore,readState,isAssetReferenced,signal}){
  const errors=[];let state=null;try{state=await readState?.();}catch(error){errors.push(error);}const referenced=referencedAssetIds(state);
  for(const asset of [...added].reverse()){
    try{
      if(referenced.has(asset.metadata.id)||await isAssetReferenced?.(asset.metadata.id,state))continue;const current=await assetStore.get(asset.metadata.id);if(!current||!await sameStoredAsset(current,asset,signal))continue;await assetStore.delete(asset.metadata.id);
    }catch(error){errors.push(error);}
  }
  return errors;
}

export async function commitProjectPackage(candidate,{assetStore,signal,readState=async()=>null,persistState=null,initialize=null,isAssetReferenced=async()=>false}={}){
  if(!candidate||!INSPECTED_CANDIDATES.has(candidate))fail('Project package candidate must come directly from mutation-free inspection.');if(!assetStore||typeof assetStore.get!=='function'||typeof assetStore.put!=='function'||typeof assetStore.delete!=='function')fail('An asset store with get, put, and delete support is required.');
  throwIfAborted(signal);const added=[],reused=[],next={project:structuredClone(candidate.project),companyProfile:structuredClone(candidate.companyProfile)},errors=[];let pending=null,previousAtPublish=null,persistAttempted=false,initializeAttempted=false;
  try{
    for(const asset of candidate.assets){
      throwIfAborted(signal);const existing=await assetStore.get(asset.metadata.id);throwIfAborted(signal);
      if(existing){if(!await sameStoredAsset(existing,asset,signal))fail(`Asset ID collision: "${asset.metadata.id}" already exists with different bytes or ownership.`);reused.push(asset.metadata.id);continue;}
      pending=asset;await assetStore.put({metadata:{...asset.metadata},blob:asset.blob});added.push(asset);pending=null;throwIfAborted(signal);
    }
    previousAtPublish=await readState();throwIfAborted(signal);
    if(persistState){persistAttempted=true;const saved=await persistState(structuredClone(next),{phase:'commit',previous:structuredClone(previousAtPublish)});if(saved===false)fail('Project/profile metadata persistence failed.');}
    throwIfAborted(signal);if(initialize){initializeAttempted=true;const initialized=await initialize(structuredClone(next),{phase:'commit'});if(initialized===false)fail('Imported project UI initialization failed.');}throwIfAborted(signal);
    return {project:next.project,companyProfile:next.companyProfile,addedAssetIds:added.map(asset=>asset.metadata.id),reusedAssetIds:reused};
  }catch(error){
    if(pending){try{const current=await assetStore.get(pending.metadata.id);if(current&&await sameStoredAsset(current,pending,null))added.push(pending);}catch(cleanupError){errors.push(cleanupError);}pending=null;}
    if(persistAttempted&&persistState){
      try{const current=await readState();const restored=await persistState(structuredClone(previousAtPublish),{phase:'rollback',expected:structuredClone(next),current:structuredClone(current)});if(restored===false)fail('Project/profile metadata rollback failed.');}catch(rollbackError){errors.push(rollbackError);}
    }
    if(initializeAttempted&&initialize&&previousAtPublish){try{const restored=await initialize(structuredClone(previousAtPublish),{phase:'rollback'});if(restored===false)fail('Restored project UI initialization failed.');}catch(initializeError){errors.push(initializeError);}}
    errors.push(...await cleanupAdded(added,{assetStore,readState,isAssetReferenced,signal:null}));if(errors.length)throw new AggregateError([error,...errors],error.message,{cause:error});throw error;
  }
}
