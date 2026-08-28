import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import * as core from '../src/core.mjs';
import {createProject} from '../src/core.mjs';
import {projectWebMercator,unprojectWebMercator} from '../src/imagery/placement.mjs';
import {decodeManualImage} from '../src/imagery/manual-image.mjs';
import {
  commitProjectPackage,
  exportProjectPackage,
  inspectProjectPackage
} from '../src/project-package.mjs';

const STAMP='2026-08-27T12:00:00.000Z';
const SITE={lat:43.65,lng:-79.38};
const IDS={
  firstItem:'74f14168-4de6-4c5f-88f4-87db8ec731c2',
  secondItem:'8208cb6e-2ba9-46d1-9b99-3f4bc753c857',
  officialItem:'2e4d62e8-3aeb-43d1-b299-36703300d6c5',
  firstAsset:'3caa1022-b2e7-4c63-8ca8-12f4845e1be1',
  secondAsset:'d9a64b75-571c-4142-ae5d-cc8ee35f36fa'
};

function a3Bounds(location,halfWidth=40){
  const [x,y]=projectWebMercator([location.lng,location.lat]),halfHeight=halfWidth/(420/297);
  const southwest=unprojectWebMercator([x-halfWidth,y-halfHeight]),northeast=unprojectWebMercator([x+halfWidth,y+halfHeight]);
  return {west:southwest[0],south:southwest[1],east:northeast[0],north:northeast[1]};
}

async function sha256(bytes){
  return Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
function canonicalJson(value){return JSON.stringify(canonical(value));}
async function decodePackageImage(file,options){return decodeManualImage(file,{...options,decodeBitmap:async()=>({width:3,height:2,close(){}})});}
function inspectPackage(file,options={}){return inspectProjectPackage(file,{Zip:JSZip,decodeImage:decodePackageImage,...options});}

function companyProfile(){
  return {schemaVersion:1,id:'company-acme',companyName:'Acme Environmental',address:'22 King Street',phone:'416-555-0110',
    email:'hello@acme.test',website:'https://acme.test',preparedBy:'Pat Lee',reviewedBy:'Sam Roy',logoAssetId:'company-logo-acme',
    logoMime:'image/png',logoWidth:3,logoHeight:2,logoPlacement:{align:'left',scale:1},updatedAt:STAMP};
}

function companyProfileB(){
  return {...companyProfile(),id:'company-bravo',companyName:'Bravo Environmental',address:'90 B Street',email:'hello@bravo.test',website:'https://bravo.test',
    logoAssetId:'company-logo-bravo',updatedAt:'2026-08-27T12:00:00Z'};
}

function manualItem({id,assetId,year,sequence,title}){
  return {id,year,sequence,title,mode:'manual',providerId:null,sourceUrl:null,licenseUrl:null,attribution:`Archive permission for ${title}`,
    policy:'exportable',resolutionMeters:null,bounds:a3Bounds(SITE),placement:{center:projectWebMercator([SITE.lng,SITE.lat]),groundWidth:100,
      groundHeight:80,sourceWidth:3,sourceHeight:2,rotationDegrees:0},assetId,officialExport:null,createdAt:STAMP,updatedAt:STAMP};
}

function officialItem(){
  return {id:IDS.officialItem,year:1972,sequence:1,title:'Official Toronto 1972',mode:'official',providerId:'toronto',
    sourceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer',
    licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy:'exportable',resolutionMeters:.2,
    bounds:a3Bounds(SITE),placement:null,assetId:null,officialExport:{kind:'arcgis-export',
      url:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer/export',layer:null,maxWidth:4096,maxHeight:4096,
      resultId:'toronto:cot_historic_aerial_1972',coverage:{west:-80,south:43,east:-79,north:44},preview:{kind:'arcgis-map-service',
        url:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer',layer:null,
        tileTemplate:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer/tile/{z}/{y}/{x}'}},
    createdAt:STAMP,updatedAt:STAMP};
}

function projectFixture(){
  const project=createProject({name:'Historical package <safe>',projectNo:'AB-12345',address:'Toronto',date:'2026-08-27'});
  project.id='project-historical-1';project.createdAt=STAMP;project.updatedAt=STAMP;project.location={...SITE};
  project.historical=[
    manualItem({id:IDS.firstItem,assetId:IDS.firstAsset,year:1960,sequence:1,title:'scan one.png'}),
    manualItem({id:IDS.secondItem,assetId:IDS.secondAsset,year:1960,sequence:2,title:'scan two.png'}),officialItem()
  ];
  project.historicalSequenceCounters={'1960':2,'1972':1};
  project.companyProfileSnapshot=structuredClone(companyProfile());
  return project;
}

function memoryStore(initial=[]){
  const values=new Map(initial.map(value=>[value.metadata.id,value])),owners=new Map(),operations=[];
  return {values,owners,operations,
    async get(id){operations.push(`get:${id}`);return values.get(id)||null;},
    async put(value){operations.push(`put:${value.metadata.id}`);if(values.has(value.metadata.id))throw Error(`duplicate ${value.metadata.id}`);values.set(value.metadata.id,value);},
    async addIfAbsent(value,{ownerToken}){operations.push(`add:${value.metadata.id}`);if(values.has(value.metadata.id))throw Error(`duplicate ${value.metadata.id}`);values.set(value.metadata.id,value);owners.set(value.metadata.id,ownerToken);return Object.freeze({assetId:value.metadata.id,ownerToken});},
    async delete(id){operations.push(`delete:${id}`);return values.delete(id);},
    async deleteOwned(receipt){operations.push(`delete-owned:${receipt.assetId}`);if(owners.get(receipt.assetId)!==receipt.ownerToken)return false;owners.delete(receipt.assetId);return values.delete(receipt.assetId);},
    async list(){operations.push('list');return [...values.values()];}
  };
}

async function fixture(){
  const png=new Uint8Array(await fs.readFile(new URL('./fixtures/imagery/manual/valid-3x2.png',import.meta.url)));
  const logoBlob=new Blob([png],{type:'image/png'}),firstBlob=new Blob([png],{type:'image/png'}),secondBlob=new Blob([png],{type:'image/png'});
  const metadata=async(id,kind,blob)=>({id,kind,mime:'image/png',size:blob.size,width:3,height:2,sha256:await sha256(await blob.arrayBuffer()),createdAt:STAMP});
  const assets=[
    {metadata:await metadata('company-logo-acme','company-logo',logoBlob),blob:logoBlob},
    {metadata:await metadata(IDS.firstAsset,'historical-image',firstBlob),blob:firstBlob},
    {metadata:await metadata(IDS.secondAsset,'historical-image',secondBlob),blob:secondBlob},
    {metadata:await metadata('orphan-company-logo','company-logo',logoBlob),blob:logoBlob}
  ];
  return {project:projectFixture(),profile:companyProfile(),assets,store:memoryStore(assets)};
}

async function exported(){
  const value=await fixture();return {...value,output:await exportProjectPackage({project:value.project,companyProfile:value.profile,assetStore:value.store,Zip:JSZip})};
}

function zipBytes(source){return source instanceof Uint8Array?source:new Uint8Array(source);}
function centralDirectory(source){
  const bytes=zipBytes(source),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65_557);offset--){
    if(view.getUint32(offset,true)===0x06054b50&&offset+22+view.getUint16(offset+20,true)===bytes.length){end=offset;break;}
  }
  assert.notEqual(end,-1);const count=view.getUint16(end+10,true),records=[];let offset=view.getUint32(end+16,true);
  for(let index=0;index<count;index++){
    assert.equal(view.getUint32(offset,true),0x02014b50);const nameLength=view.getUint16(offset+28,true),extraLength=view.getUint16(offset+30,true),commentLength=view.getUint16(offset+32,true);
    const name=new TextDecoder().decode(bytes.subarray(offset+46,offset+46+nameLength));records.push({name,offset,localOffset:view.getUint32(offset+42,true),length:46+nameLength+extraLength+commentLength});
    offset+=records.at(-1).length;
  }
  return {bytes,view,end,records};
}

async function regenerate(blob,mutate,{compression='STORE'}={}){
  const zip=await JSZip.loadAsync(await blob.arrayBuffer());await mutate(zip);
  return new Blob([await zip.generateAsync({type:'uint8array',compression,platform:'DOS',streamFiles:false})],{type:'application/zip'});
}

async function duplicateCentralRecord(blob,path){
  const source=new Uint8Array(await blob.arrayBuffer()),{view,end,records}=centralDirectory(source),record=records.find(value=>value.name===path);assert.ok(record);
  const output=new Uint8Array(source.length+record.length);output.set(source.subarray(0,end));output.set(source.subarray(record.offset,record.offset+record.length),end);output.set(source.subarray(end),end+record.length);
  const nextView=new DataView(output.buffer),nextEnd=end+record.length;nextView.setUint16(nextEnd+8,view.getUint16(end+8,true)+1,true);nextView.setUint16(nextEnd+10,view.getUint16(end+10,true)+1,true);
  nextView.setUint32(nextEnd+12,view.getUint32(end+12,true)+record.length,true);return new Blob([output],{type:'application/zip'});
}

async function patchRecord(blob,path,patch){
  const bytes=new Uint8Array(await blob.arrayBuffer()),directory=centralDirectory(bytes),record=directory.records.find(value=>value.name===path);assert.ok(record);patch(directory,record);return new Blob([bytes],{type:'application/zip'});
}

async function addManifestDeclaredMetadata(blob,{path,kind,mediaType,bytes,evidence}){
  return regenerate(blob,async zip=>{
    const manifest=JSON.parse(await zip.file('manifest.json').async('text')),project=JSON.parse(await zip.file('project.json').async('text'));
    zip.file(path,bytes);manifest.entries.push({assetId:null,createdAt:null,height:null,kind,mediaType,owner:{id:project.id,type:'project'},path,
      redistribution:{evidence,policy:'metadata'},referenceIds:[project.id],sha256:await sha256(bytes),size:bytes.byteLength,width:null});
    zip.file('manifest.json',canonicalJson(manifest));
  });
}

test('exports a deterministic versioned package and round-trips two manual images, branding, and metadata-only official imagery',async()=>{
  const value=await fixture(),first=await exportProjectPackage({project:value.project,companyProfile:value.profile,assetStore:value.store,Zip:JSZip});
  const second=await exportProjectPackage({project:value.project,companyProfile:value.profile,assetStore:value.store,Zip:JSZip});
  assert.equal(first.filename,'ab-12345.phasei-project.zip');assert.deepEqual(new Uint8Array(await first.blob.arrayBuffer()),new Uint8Array(await second.blob.arrayBuffer()));
  assert.deepEqual(value.store.operations.filter(entry=>entry==='list'),[],'export reads referenced assets directly instead of enumerating unrelated assets');
  assert.equal(value.store.operations.includes('get:orphan-company-logo'),false);
  const candidate=await inspectPackage(first.blob,{Zip:JSZip});
  assert.equal(candidate.schemaVersion,1);assert.equal(candidate.project.historical.length,3);assert.equal(candidate.companyProfile.companyName,'Acme Environmental');
  assert.deepEqual(candidate.project.companyProfileSnapshot,candidate.companyProfile);assert.deepEqual(candidate.assets.map(value=>value.metadata.id),['company-logo-acme',IDS.firstAsset,IDS.secondAsset]);
  const archive=await JSZip.loadAsync(await first.blob.arrayBuffer()),manifest=JSON.parse(await archive.file('manifest.json').async('text'));
  assert.deepEqual(Object.keys(archive.files),['manifest.json','project.json','company-profile.json',`assets/company-logo-acme.png`,`assets/${IDS.firstAsset}.png`,`assets/${IDS.secondAsset}.png`,'README.txt']);
  assert.deepEqual(manifest.entries.map(entry=>entry.path),Object.keys(archive.files).slice(1));
  assert.deepEqual(manifest.entries.filter(entry=>entry.kind==='historical-image').map(entry=>entry.redistribution.evidence),['manual-permission-confirmed','manual-permission-confirmed']);
  assert.equal(manifest.entries.some(entry=>entry.referenceIds.includes(IDS.officialItem)),false,'official imagery remains metadata-only');
  assert.match(await archive.file('project.json').async('text'),/Official Toronto 1972/);
});

test('project package preserves archived Company A when reusable Company B changes until explicit apply',async()=>{
  const value=await fixture(),companyB=companyProfileB();
  value.store.values.set(companyB.logoAssetId,{metadata:{...value.assets[0].metadata,id:companyB.logoAssetId},blob:value.assets[0].blob});
  const unchanged=await exportProjectPackage({project:value.project,companyProfile:companyB,assetStore:value.store,Zip:JSZip});
  const importedA=await inspectPackage(unchanged.blob,{Zip:JSZip});
  assert.equal(importedA.companyProfile.companyName,'Acme Environmental');
  assert.equal(importedA.companyProfile.logoAssetId,'company-logo-acme');
  assert.equal(importedA.assets[0].metadata.id,'company-logo-acme','the current template logo cannot substitute for the project logo');

  const applied=core.applyCompanyProfileToProject(value.project,companyB,{updatedAt:'2026-08-28T12:00:00Z'});
  const changed=await exportProjectPackage({project:applied,companyProfile:companyB,assetStore:value.store,Zip:JSZip});
  const importedB=await inspectPackage(changed.blob,{Zip:JSZip});
  assert.equal(importedB.companyProfile.companyName,'Bravo Environmental');
  assert.equal(importedB.companyProfile.logoAssetId,'company-logo-bravo');
});

test('export fails closed for missing, foreign-kind, mismatched-hash, unpermitted, stale, and aborted assets without producing a partial package',async()=>{
  const cases=[
    async value=>value.store.values.delete(IDS.firstAsset),
    async value=>{value.store.values.get(IDS.firstAsset).metadata.kind='company-logo';},
    async value=>{value.store.values.get(IDS.firstAsset).metadata.sha256='0'.repeat(64);},
    async value=>{value.project.historical[0].policy='link-only';},
    async value=>{value.project.historical[0].assetId='54a168fe-619a-4da1-aedc-d5aed3cfd08a';}
  ];
  for(const prepare of cases){const value=await fixture();await prepare(value);await assert.rejects(()=>exportProjectPackage({project:value.project,companyProfile:value.profile,assetStore:value.store,Zip:JSZip}),/asset|historical|policy|hash|missing|project/i);}
  const value=await fixture(),controller=new AbortController();controller.abort(new DOMException('User cancelled','AbortError'));
  await assert.rejects(()=>exportProjectPackage({project:value.project,companyProfile:value.profile,assetStore:value.store,Zip:JSZip,signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(value.store.operations,[]);
});

test('inspection is mutation-free and rejects extra, missing, tampered, wrong-kind, wrong-media, nested, and trust-upgraded contents',async()=>{
  const {output}=await exported();let mutations=0;const trapStore={put(){mutations++;},delete(){mutations++;}};
  const clean=await inspectPackage(output.blob,{Zip:JSZip,assetStore:trapStore});assert.equal(mutations,0);assert.equal(clean.assets.length,3);
  const adversaries=[
    await regenerate(output.blob,zip=>zip.file('unexpected.js','alert(1)')),
    await regenerate(output.blob,zip=>zip.remove('README.txt')),
    await regenerate(output.blob,async zip=>{zip.file(`assets/${IDS.firstAsset}.png`,'tampered');}),
    await regenerate(output.blob,async zip=>{const manifest=JSON.parse(await zip.file('manifest.json').async('text'));manifest.entries.find(entry=>entry.assetId===IDS.firstAsset).kind='company-logo';zip.file('manifest.json',JSON.stringify(manifest));}),
    await regenerate(output.blob,async zip=>{const manifest=JSON.parse(await zip.file('manifest.json').async('text'));manifest.entries.find(entry=>entry.assetId===IDS.firstAsset).mediaType='image/jpeg';zip.file('manifest.json',JSON.stringify(manifest));}),
    await regenerate(output.blob,async zip=>{const manifest=JSON.parse(await zip.file('manifest.json').async('text'));manifest.entries.find(entry=>entry.assetId===IDS.firstAsset).redistribution.evidence='official-policy-guessed';zip.file('manifest.json',JSON.stringify(manifest));}),
    await regenerate(output.blob,async zip=>{const project=JSON.parse(await zip.file('project.json').async('text'));project.historical[0].policy='link-only';zip.file('project.json',JSON.stringify(project));}),
    await regenerate(output.blob,async zip=>{const manifest=JSON.parse(await zip.file('manifest.json').async('text'));const entry=manifest.entries.find(value=>value.assetId===IDS.firstAsset);entry.referenceIds=[IDS.officialItem];zip.file('manifest.json',JSON.stringify(manifest));}),
    await regenerate(output.blob,zip=>zip.file(`assets/${IDS.firstAsset}.zip`,new Uint8Array([0x50,0x4b,3,4])))
  ];
  for(const file of adversaries)await assert.rejects(()=>inspectPackage(file,{Zip:JSZip}),/unexpected|missing|hash|kind|media|redistribution|policy|reference|archive|manifest|project/i);
  assert.equal(mutations,0);
});

test('inspection rejects manifest-declared extra metadata, duplicate roles, and nested archives',async()=>{
  const {output}=await exported(),nested=new Uint8Array([0x50,0x4b,0x03,0x04,0,0,0,0]);
  const adversaries=[
    await addManifestDeclaredMetadata(output.blob,{path:'nested.zip',kind:'readme',mediaType:'application/zip',bytes:nested,evidence:'import-instructions'}),
    await addManifestDeclaredMetadata(output.blob,{path:'second-readme.txt',kind:'readme',mediaType:'text/plain; charset=utf-8',bytes:new TextEncoder().encode('extra'),evidence:'import-instructions'}),
    await addManifestDeclaredMetadata(output.blob,{path:'project-copy.json',kind:'project-json',mediaType:'application/json',bytes:new TextEncoder().encode('{}'),evidence:'required-project-data'}),
    await regenerate(output.blob,async zip=>{const manifest=JSON.parse(await zip.file('manifest.json').async('text')),source=manifest.entries.find(value=>value.assetId===IDS.firstAsset),duplicate=structuredClone(source);duplicate.path='assets/duplicate-role.png';zip.file(duplicate.path,await zip.file(source.path).async('uint8array'),{createFolders:false});manifest.entries.splice(-1,0,duplicate);zip.file('manifest.json',canonicalJson(manifest));})
  ];
  for(const file of adversaries)await assert.rejects(()=>inspectPackage(file,{Zip:JSZip}),/extra|exact|role|cardinality|unexpected|nested|archive|manifest/i);
});

test('inspection completely validates image bytes instead of trusting a matching header, hash, and dimensions',async()=>{
  const {output}=await exported(),forgedBytes=new Uint8Array(24);forgedBytes.set([137,80,78,71,13,10,26,10]);forgedBytes.set([73,72,68,82],12);
  new DataView(forgedBytes.buffer).setUint32(16,3);new DataView(forgedBytes.buffer).setUint32(20,2);
  const forged=await regenerate(output.blob,async zip=>{
    const manifest=JSON.parse(await zip.file('manifest.json').async('text')),entry=manifest.entries.find(value=>value.assetId===IDS.firstAsset);
    zip.file(entry.path,forgedBytes,{createFolders:false});entry.size=forgedBytes.byteLength;entry.sha256=await sha256(forgedBytes);zip.file('manifest.json',canonicalJson(manifest));
  });
  const decodedSizes=[];
  await assert.rejects(()=>inspectPackage(forged,{Zip:JSZip,decodeImage:(file,options)=>{decodedSizes.push(file.size);return decodeManualImage(file,{...options,decodeBitmap:async()=>({width:3,height:2,close(){}})});}}),/PNG|decode|image data|structure|CRC/i);
  assert.ok(decodedSizes.includes(forgedBytes.byteLength),'the forged image reaches the bounded complete decoder');
});

test('raw archive preflight rejects traversal, absolute/backslash/NUL paths, normalized duplicates, symlinks, encryption, unsupported methods, duplicate records, size abuse, and compression bombs',async()=>{
  const {output}=await exported();
  const pathCases=['../project.json','/project.json','C:/project.json','folder\\project.json','bad\u0000name','ＭＡＮＩＦＥＳＴ.json'];
  for(const path of pathCases){const file=await regenerate(output.blob,zip=>zip.file(path,'x'));await assert.rejects(()=>inspectPackage(file,{Zip:JSZip}),/path|absolute|backslash|NUL|normalized|unexpected|duplicate/i,path);}
  const caseDuplicate=await regenerate(output.blob,zip=>zip.file('MANIFEST.JSON','{}'));
  await assert.rejects(()=>inspectPackage(caseDuplicate,{Zip:JSZip}),/duplicate normalized path/i);
  const duplicate=await duplicateCentralRecord(output.blob,'project.json');
  await assert.rejects(()=>inspectPackage(duplicate,{Zip:JSZip}),/duplicate normalized path|central directory/i);
  const symlink=await patchRecord(output.blob,'project.json',({view},record)=>{view.setUint16(record.offset+4,0x031e,true);view.setUint32(record.offset+38,0xa1ff0000,true);});
  await assert.rejects(()=>inspectPackage(symlink,{Zip:JSZip}),/symlink|external attribute/i);
  const encrypted=await patchRecord(output.blob,'project.json',({view},record)=>{view.setUint16(record.offset+8,view.getUint16(record.offset+8,true)|1,true);view.setUint16(record.localOffset+6,view.getUint16(record.localOffset+6,true)|1,true);});
  await assert.rejects(()=>inspectPackage(encrypted,{Zip:JSZip}),/encrypted/i);
  const method=await patchRecord(output.blob,'project.json',({view},record)=>{view.setUint16(record.offset+10,99,true);view.setUint16(record.localOffset+8,99,true);});
  await assert.rejects(()=>inspectPackage(method,{Zip:JSZip}),/compression|unsupported/i);
  const oversized=await patchRecord(output.blob,'project.json',({view},record)=>view.setUint32(record.offset+24,70*1024*1024,true));
  await assert.rejects(()=>inspectPackage(oversized,{Zip:JSZip}),/size|decompressed|limit/i);
  const bomb=await regenerate(output.blob,zip=>zip.file('README.txt','A'.repeat(2_000_000)),{compression:'DEFLATE'});
  await assert.rejects(()=>inspectPackage(bomb,{Zip:JSZip}),/compression ratio|bomb/i);
});

test('raw archive preflight rejects every security-relevant local and central header disagreement',async()=>{
  const {output}=await exported(),mutations=[
    ['version needed',(view,record)=>view.setUint16(record.localOffset+4,view.getUint16(record.localOffset+4,true)+1,true)],
    ['flags',(view,record)=>view.setUint16(record.localOffset+6,view.getUint16(record.localOffset+6,true)^0x800,true)],
    ['method',(view,record)=>view.setUint16(record.localOffset+8,view.getUint16(record.localOffset+8,true)===0?8:0,true)],
    ['modification time',(view,record)=>view.setUint16(record.localOffset+10,view.getUint16(record.localOffset+10,true)^1,true)],
    ['modification date',(view,record)=>view.setUint16(record.localOffset+12,view.getUint16(record.localOffset+12,true)^1,true)],
    ['CRC32',(view,record)=>view.setUint32(record.localOffset+14,view.getUint32(record.localOffset+14,true)^1,true)],
    ['compressed size',(view,record)=>view.setUint32(record.localOffset+18,view.getUint32(record.localOffset+18,true)+1,true)],
    ['uncompressed size',(view,record)=>view.setUint32(record.localOffset+22,view.getUint32(record.localOffset+22,true)+1,true)],
    ['name length',(view,record)=>view.setUint16(record.localOffset+26,view.getUint16(record.localOffset+26,true)-1,true)],
    ['extra length',(view,record)=>view.setUint16(record.localOffset+28,1,true)]
  ];
  for(const [label,mutate] of mutations){const file=await patchRecord(output.blob,'project.json',({view},record)=>mutate(view,record));await assert.rejects(()=>inspectPackage(file,{Zip:JSZip}),/local and central|header|record|match|boundary/i,label);}
  const diskStart=await patchRecord(output.blob,'project.json',({view},record)=>view.setUint16(record.offset+34,1,true));await assert.rejects(()=>inspectPackage(diskStart,{Zip:JSZip}),/disk|header|unsupported/i);
  const internalAttributes=await patchRecord(output.blob,'project.json',({view},record)=>view.setUint16(record.offset+36,1,true));await assert.rejects(()=>inspectPackage(internalAttributes,{Zip:JSZip}),/attribute|header|unsupported/i);
});

test('commit stages assets, reuses byte-identical pre-existing records, and publishes state only after every asset is durable',async()=>{
  const {output}=await exported(),candidate=await inspectPackage(output.blob,{Zip:JSZip}),preExisting=candidate.assets[0];
  const store=memoryStore([preExisting]),previous={project:{id:'current'},companyProfile:{id:'current-company'}},events=[];let state=structuredClone(previous);
  const result=await commitProjectPackage(candidate,{assetStore:store,readState:async()=>structuredClone(state),persistState:async(next,context)=>{assert.deepEqual(store.operations.filter(value=>value.startsWith('add:')),[`add:${IDS.firstAsset}`,`add:${IDS.secondAsset}`],'all atomic adds precede persistence');events.push({kind:'persist',context});state=structuredClone(next);},initialize:async next=>events.push({kind:'initialize',id:next.project.id})});
  assert.deepEqual(result.reusedAssetIds,[preExisting.metadata.id]);assert.deepEqual(result.addedAssetIds,[IDS.firstAsset,IDS.secondAsset]);
  assert.deepEqual(store.operations.filter(value=>value.startsWith('add:')),[`add:${IDS.firstAsset}`,`add:${IDS.secondAsset}`]);
  assert.equal(state.project.id,'project-historical-1');assert.equal(state.companyProfile.logoAssetId,'company-logo-acme');
  assert.equal(events.at(-1).kind,'initialize');
});

test('commit compensates asset, persistence, initialization, cancellation, and stale-state failures without deleting pre-existing or shared assets',async()=>{
  const {output}=await exported(),candidate=await inspectPackage(output.blob,{Zip:JSZip}),old={project:{id:'old-project'},companyProfile:{id:'old-company',logoAssetId:'shared-old'}};
  for(const phase of ['asset','persist','initialize','abort']){
    const shared=candidate.assets[0],store=memoryStore([shared,{metadata:{...shared.metadata,id:'shared-old'},blob:shared.blob}]);let state=structuredClone(old),puts=0,persists=0,controller=new AbortController(),initialized=[];
    const originalAdd=store.addIfAbsent.bind(store);store.addIfAbsent=async(value,options)=>{puts++;if(phase==='asset'&&puts===2)throw Error('second asset write failed');const receipt=await originalAdd(value,options);if(phase==='abort'&&puts===1)controller.abort(new DOMException('Cancelled','AbortError'));return receipt;};
    await assert.rejects(()=>commitProjectPackage(candidate,{assetStore:store,signal:controller.signal,readState:async()=>structuredClone(state),
      persistState:async next=>{persists++;if(phase==='persist'&&persists===1)throw Error('metadata persistence failed');state=structuredClone(next);},
      initialize:async(next,context)=>{initialized.push({id:next.project.id,phase:context?.phase??'commit'});if(phase==='initialize'&&context?.phase!=='rollback')throw Error('UI initialization failed');}
    }),phase==='abort'?{name:'AbortError'}:/failed|initialization/i);
    assert.deepEqual(state,old,`${phase}: prior state restored`);assert.ok(store.values.has(shared.metadata.id),`${phase}: pre-existing imported logo preserved`);
    assert.ok(store.values.has('shared-old'),`${phase}: unrelated shared asset preserved`);assert.equal(store.values.has(IDS.firstAsset),false);assert.equal(store.values.has(IDS.secondAsset),false);
    if(phase==='initialize')assert.deepEqual(initialized,[{id:'project-historical-1',phase:'commit'},{id:'old-project',phase:'rollback'}],'failed UI initialization is compensated by reinitializing the restored state');
  }
  let live={project:{id:'initial'},companyProfile:{id:'initial-company'}},writeCount=0;const target=memoryStore();
  const originalAdd=target.addIfAbsent.bind(target);target.addIfAbsent=async(value,options)=>{const receipt=await originalAdd(value,options);if(++writeCount===1)live={project:{id:'edited-during-import'},companyProfile:{id:'edited-company'}};return receipt;};
  await assert.rejects(()=>commitProjectPackage(candidate,{assetStore:target,readState:async()=>structuredClone(live),persistState:async next=>{live=structuredClone(next);},initialize:async()=>{throw Error('initialize after concurrent edit');}}),/initialize/i);
  assert.deepEqual(live,{project:{id:'edited-during-import'},companyProfile:{id:'edited-company'}},'compensation restores the state re-read immediately before publish');
});

test('commit refuses an ID collision with different bytes and never overwrites or deletes the pre-existing asset',async()=>{
  const {output}=await exported(),candidate=await inspectPackage(output.blob,{Zip:JSZip}),colliding=candidate.assets.find(value=>value.metadata.id===IDS.firstAsset);
  const blob=new Blob(['different'],{type:'image/png'}),store=memoryStore([{metadata:{...colliding.metadata,size:blob.size,sha256:await sha256(await blob.arrayBuffer()),width:1,height:1},blob}]);
  await assert.rejects(()=>commitProjectPackage(candidate,{assetStore:store}),/collision|different|already exists/i);
  assert.equal(await (await store.get(IDS.firstAsset)).blob.text(),'different');assert.equal(store.operations.includes(`delete:${IDS.firstAsset}`),false,'the colliding pre-existing asset is never deleted');
});

test('cancellation while verifying a reusable pre-existing asset remains AbortError and never becomes a collision',async()=>{
  const {output}=await exported(),candidate=await inspectPackage(output.blob,{Zip:JSZip}),existing=candidate.assets[0],controller=new AbortController(),bytes=await existing.blob.arrayBuffer();
  const delayed=new Blob([bytes],{type:existing.blob.type});Object.defineProperty(delayed,'arrayBuffer',{value:async()=>{controller.abort(new DOMException('Cancelled while hashing','AbortError'));return bytes;}});
  const store=memoryStore([{metadata:existing.metadata,blob:delayed}]);
  await assert.rejects(()=>commitProjectPackage(candidate,{assetStore:store,signal:controller.signal}),{name:'AbortError'});assert.deepEqual(store.operations.filter(value=>value.startsWith('add:')),[]);assert.deepEqual(store.operations.filter(value=>value.startsWith('delete-owned:')),[]);
});

test('cancellation thrown after an asset write compensates that pending asset and remains AbortError',async()=>{
  const {output}=await exported(),candidate=await inspectPackage(output.blob,{Zip:JSZip}),controller=new AbortController(),store=memoryStore(),add=store.addIfAbsent.bind(store);
  store.addIfAbsent=async(value,options)=>{const receipt=await add(value,options),error=new DOMException('Cancelled after durable write','AbortError');Object.defineProperty(error,'ownershipReceipt',{value:receipt});controller.abort(error);throw error;};
  await assert.rejects(()=>commitProjectPackage(candidate,{assetStore:store,signal:controller.signal}),{name:'AbortError'});
  assert.equal(store.values.size,0,'the asset written immediately before cancellation is compensated');assert.deepEqual(store.operations.filter(value=>value.startsWith('delete-owned:')),[`delete-owned:${candidate.assets[0].metadata.id}`]);
});

test('an ambiguous add collision preserves a concurrent same-byte asset because the import has no ownership receipt',async()=>{
  const {output}=await exported(),candidate=await inspectPackage(output.blob),store=memoryStore(),concurrentOwners=new Map();
  const collide=async value=>{store.operations.push(`ambiguous:${value.metadata.id}`);store.values.set(value.metadata.id,value);concurrentOwners.set(value.metadata.id,'another-operation');throw new DOMException('Concurrent insert','ConstraintError');};
  store.put=collide;store.addIfAbsent=collide;
  store.deleteOwned=async receipt=>{store.operations.push(`delete-owned:${receipt.assetId}`);if(concurrentOwners.get(receipt.assetId)!==receipt.ownerToken)return false;concurrentOwners.delete(receipt.assetId);return store.values.delete(receipt.assetId);};
  await assert.rejects(()=>commitProjectPackage(candidate,{assetStore:store}),/Concurrent insert|already exists/i);
  assert.ok(store.values.has(candidate.assets[0].metadata.id),'the concurrent asset survives the ambiguous write outcome');
  assert.deepEqual(store.operations.filter(value=>value.startsWith('delete:')||value.startsWith('delete-owned:')),[],'cleanup cannot run without an exact ownership receipt');
});

test('rollback after publication is conditional and never overwrites state edited after the imported state was published',async()=>{
  const {output}=await exported(),candidate=await inspectPackage(output.blob),store=memoryStore(),before={project:{id:'before'},companyProfile:{id:'before-company'}},edited={project:{id:'edited-after-publish'},companyProfile:{id:'edited-company'}};
  let state=structuredClone(before);const persistPhases=[],initializePhases=[];
  await assert.rejects(()=>commitProjectPackage(candidate,{assetStore:store,readState:async()=>structuredClone(state),
    persistState:async(next,context)=>{persistPhases.push(context);state=structuredClone(next);},
    initialize:async(next,context)=>{initializePhases.push({id:next.project.id,phase:context.phase});if(context.phase==='commit'){state=structuredClone(edited);throw Error('initialize failed after later edit');}}
  }),/initialize|rollback conflict/i);
  assert.deepEqual(state,edited,'later state remains authoritative');
  assert.deepEqual(persistPhases.map(value=>value.phase),['commit'],'rollback persistence is skipped after a conflict');
  assert.deepEqual(initializePhases,[{id:candidate.project.id,phase:'commit'}],'the old UI is not reinitialized over later edits');
});
