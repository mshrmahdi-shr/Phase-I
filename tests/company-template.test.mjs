import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  commitCompanyTemplate,
  exportCompanyTemplate,
  inspectCompanyTemplate
} from '../src/company-template.mjs';

const PNG_BYTES=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const JPEG_BYTES=new Uint8Array([255,216,255,224,0,0]);
const UPDATED_AT='2026-08-26T12:34:56Z';

async function digest(bytes){
  return Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
}

async function fixture({mime='image/png',bytes=PNG_BYTES,companyName='Acme & Sons'}={}){
  const blob=new Blob([bytes],{type:mime});
  const metadata={
    id:'logo-1',kind:'company-logo',mime,size:blob.size,width:320,height:160,
    sha256:await digest(bytes),createdAt:UPDATED_AT
  };
  const profile={
    schemaVersion:1,id:'company-1',companyName,address:'1 Main Street',phone:'555-0100',
    email:'info@example.com',website:'https://example.com',preparedBy:'A. Person',reviewedBy:'R. Person',
    logoAssetId:metadata.id,logoMime:mime,logoWidth:metadata.width,logoHeight:metadata.height,
    logoPlacement:{align:'left',scale:1.25},updatedAt:UPDATED_AT
  };
  return {profile,asset:{metadata,blob}};
}

function readStore(asset){
  let reads=0;
  return {
    get reads(){return reads;},
    async get(id){reads++;return id===asset.metadata.id?asset:null;}
  };
}

function centralDirectory(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let eocd=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65_557);offset--){
    if(view.getUint32(offset,true)===0x06054b50&&offset+22+view.getUint16(offset+20,true)===bytes.length){eocd=offset;break;}
  }
  assert.notEqual(eocd,-1);
  const count=view.getUint16(eocd+10,true);
  let offset=view.getUint32(eocd+16,true);
  const records=[];
  for(let index=0;index<count;index++){
    assert.equal(view.getUint32(offset,true),0x02014b50);
    const nameLength=view.getUint16(offset+28,true);
    const recordLength=46+nameLength+view.getUint16(offset+30,true)+view.getUint16(offset+32,true);
    const name=new TextDecoder().decode(bytes.subarray(offset+46,offset+46+nameLength));
    records.push({name,offset,length:recordLength});
    offset+=recordLength;
  }
  return {view,eocd,records};
}

async function duplicateCentralRecord(blob,name){
  const bytes=new Uint8Array(await blob.arrayBuffer());
  const {view,eocd,records}=centralDirectory(bytes);
  const record=records.find(value=>value.name===name);
  assert.ok(record);
  const result=new Uint8Array(bytes.length+record.length);
  result.set(bytes.subarray(0,eocd));
  result.set(bytes.subarray(record.offset,record.offset+record.length),eocd);
  result.set(bytes.subarray(eocd),eocd+record.length);
  const output=new DataView(result.buffer);
  const nextEocd=eocd+record.length;
  output.setUint16(nextEocd+8,view.getUint16(eocd+8,true)+1,true);
  output.setUint16(nextEocd+10,view.getUint16(eocd+10,true)+1,true);
  output.setUint32(nextEocd+12,view.getUint32(eocd+12,true)+record.length,true);
  return new Blob([result],{type:'application/zip'});
}

async function declareCentralSize(blob,name,size){
  const bytes=new Uint8Array(await blob.arrayBuffer());
  const {records}=centralDirectory(bytes);
  const record=records.find(value=>value.name===name);
  assert.ok(record);
  new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).setUint32(record.offset+24,size,true);
  return new Blob([bytes],{type:'application/zip'});
}

async function zipBlob(files){
  const zip=new JSZip();
  for(const [name,value] of files) zip.file(name,value);
  return new Blob([await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})],{type:'application/zip'});
}

async function validFiles(options={}){
  const {profile,asset}=await fixture(options);
  const template={schemaVersion:1,profile,logo:asset.metadata};
  return {profile,asset,files:[
    ['template.json',JSON.stringify(template)],
    [asset.metadata.mime==='image/png'?'logo.png':'logo.jpg',new Uint8Array(await asset.blob.arrayBuffer())],
    ['README.txt','Import this file in Phase I.']
  ]};
}

test('exports a deterministic three-file ZIP and inspects an identical normalized profile and logo hash',async()=>{
  const {profile,asset}=await fixture();
  const assetStore=readStore(asset);

  const first=await exportCompanyTemplate({profile,assetStore,Zip:JSZip});
  const second=await exportCompanyTemplate({profile,assetStore,Zip:JSZip});
  assert.equal(first.filename,'acme-sons.phasei-template.zip');
  assert.deepEqual(new Uint8Array(await first.blob.arrayBuffer()),new Uint8Array(await second.blob.arrayBuffer()));

  const archive=await JSZip.loadAsync(await first.blob.arrayBuffer());
  assert.deepEqual(Object.keys(archive.files),['template.json','logo.png','README.txt']);
  const serialized=await archive.file('template.json').async('text');
  assert.match(serialized,/^\{"logo":\{"createdAt":.*,"height":160,"id":"logo-1","kind":"company-logo","mime":"image\/png","sha256":.*,"size":12,"width":320\},"profile":\{/);

  const candidate=await inspectCompanyTemplate(first.blob,{Zip:JSZip});
  assert.deepEqual(candidate.profile,profile);
  assert.equal(candidate.logoMetadata.sha256,asset.metadata.sha256);
  assert.equal(await digest(await candidate.logoBlob.arrayBuffer()),asset.metadata.sha256);
  assert.deepEqual(candidate.warnings,[]);
  assert.equal(assetStore.reads,2);
});

test('inspection does not mutate storage and commit atomically persists the inspected logo',async()=>{
  const {files}=await validFiles();
  let mutations=0;
  let replacement;
  const assetStore={
    async put(value){mutations++;replacement=value;}
  };
  const candidate=await inspectCompanyTemplate(await zipBlob(files),{Zip:JSZip});
  assert.equal(mutations,0);

  const saved=await commitCompanyTemplate(candidate,{assetStore});
  assert.equal(mutations,1);
  assert.notEqual(saved.logoAssetId,candidate.profile.logoAssetId);
  assert.equal(replacement.metadata.id,saved.logoAssetId);
  assert.equal(replacement.metadata.sha256,candidate.logoMetadata.sha256);
  assert.deepEqual(saved,{...candidate.profile,logoAssetId:saved.logoAssetId});
});

test('an imported asset ID collision leaves the current profile and logo intact',async()=>{
  const {files}=await validFiles();
  const candidate=await inspectCompanyTemplate(await zipBlob(files),{Zip:JSZip});
  const currentProfile={companyName:'Current Company',logoAssetId:'logo-1'};
  const oldBlob=new Blob(['old logo'],{type:'image/png'});
  const assets=new Map([['logo-1',{metadata:{id:'logo-1'},blob:oldBlob}]]);
  const assetStore={
    async put(asset){
      if(assets.has(asset.metadata.id)) throw new DOMException('collision','ConstraintError');
      assets.set(asset.metadata.id,asset);
    },
    async replace({removeIds,put}){
      for(const id of removeIds) assets.delete(id);
      assets.set(put.metadata.id,put);
    }
  };

  const saved=await commitCompanyTemplate(candidate,{assetStore});
  assert.notEqual(saved.logoAssetId,'logo-1');
  assert.equal(assets.get('logo-1').blob,oldBlob);
  assert.equal(assets.get(saved.logoAssetId).metadata.sha256,candidate.logoMetadata.sha256);
  assert.deepEqual(currentProfile,{companyName:'Current Company',logoAssetId:'logo-1'});
});

test('a failed collision-safe put leaves existing asset state and the candidate untouched',async()=>{
  const {files}=await validFiles();
  const candidate=await inspectCompanyTemplate(await zipBlob(files),{Zip:JSZip});
  const original=structuredClone(candidate.profile);
  let replacements=0;
  const assetStore={
    async put(){throw new DOMException('quota','QuotaExceededError');},
    async replace(){replacements++;}
  };

  await assert.rejects(()=>commitCompanyTemplate(candidate,{assetStore}),{name:'QuotaExceededError'});
  assert.equal(replacements,0);
  assert.deepEqual(candidate.profile,original);
});

for(const [label,name] of [
  ['POSIX absolute paths','/template.json'],
  ['Windows absolute paths','C:\\template.json'],
  ['parent traversal','../template.json'],
  ['backslash traversal','..\\template.json'],
  ['encoded traversal','%2e%2e%2ftemplate.json'],
  ['double-encoded traversal','%252e%252e%255ctemplate.json']
]){
  test(`rejects ${label}`,async()=>{
    const {files}=await validFiles();
    files[0][0]=name;
    await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(files),{Zip:JSZip}),/path|traversal|absolute/i);
  });
}

test('rejects duplicate normalized paths',async()=>{
  const {files}=await validFiles();
  files.push(['%74emplate.json','{}']);
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(files),{Zip:JSZip}),/duplicate/i);
});

test('rejects exact duplicate manifest and logo records hidden by the JSZip file map',async()=>{
  for(const name of ['template.json','logo.png']){
    const {files}=await validFiles();
    const archive=await zipBlob(files);
    const duplicate=await duplicateCentralRecord(archive,name);
    const loaded=await JSZip.loadAsync(await duplicate.arrayBuffer());
    assert.equal(Object.keys(loaded.files).length,3);
    await assert.rejects(()=>inspectCompanyTemplate(duplicate,{Zip:JSZip}),/duplicate/i);
  }
});

test('rejects unexpected executable files and multiple logos',async()=>{
  const executable=await validFiles();
  executable.files.push(['run.exe','MZ']);
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(executable.files),{Zip:JSZip}),/unexpected|executable/i);

  const multiple=await validFiles();
  multiple.files.push(['logo.jpg',JPEG_BYTES]);
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(multiple.files),{Zip:JSZip}),/multiple|logo/i);
});

test('rejects more than 8 MiB of decompressed content from ZIP metadata',async()=>{
  const {files}=await validFiles();
  files[2][1]=new Uint8Array(8*1024*1024);
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(files),{Zip:JSZip}),/8 MiB|decompressed|size/i);
});

test('aborts streamed inflation above 8 MiB when central metadata understates the actual bytes',async()=>{
  const {files}=await validFiles();
  files[2][1]=new Uint8Array(8*1024*1024);
  const understated=await declareCentralSize(await zipBlob(files),'README.txt',1);
  await assert.rejects(()=>inspectCompanyTemplate(understated,{Zip:JSZip}),/8 MiB/i);
});

test('rejects invalid JSON and unsupported template schemas',async()=>{
  const invalid=await validFiles();
  invalid.files[0][1]='{broken';
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(invalid.files),{Zip:JSZip}),/JSON/i);

  const unsupported=await validFiles();
  const data=JSON.parse(unsupported.files[0][1]);
  data.schemaVersion=2;
  unsupported.files[0][1]=JSON.stringify(data);
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(unsupported.files),{Zip:JSZip}),/schema version/i);
});

test('rejects SVG logos and MIME, extension, or byte-signature mismatches',async()=>{
  const svg=await validFiles();
  svg.files[1]=['logo.svg','<svg xmlns="http://www.w3.org/2000/svg"/>'];
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(svg.files),{Zip:JSZip}),/SVG|PNG or JPEG|logo/i);

  const mismatch=await validFiles();
  mismatch.files[1][0]='logo.jpg';
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(mismatch.files),{Zip:JSZip}),/MIME|match/i);

  const spoofed=await validFiles();
  spoofed.files[1][1]=new TextEncoder().encode('<script>');
  const data=JSON.parse(spoofed.files[0][1]);
  data.logo.size=spoofed.files[1][1].byteLength;
  data.logo.sha256=await digest(spoofed.files[1][1]);
  spoofed.files[0][1]=JSON.stringify(data);
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(spoofed.files),{Zip:JSZip}),/signature|MIME|PNG/i);
});

test('rejects a logo whose declared SHA-256 does not match its bytes',async()=>{
  const {files}=await validFiles();
  const data=JSON.parse(files[0][1]);
  data.logo.sha256='0'.repeat(64);
  files[0][1]=JSON.stringify(data);
  await assert.rejects(async()=>inspectCompanyTemplate(await zipBlob(files),{Zip:JSZip}),/SHA-256|hash/i);
});

test('rejects an untyped logo Blob even when its bytes and metadata describe PNG',async()=>{
  const {profile,asset}=await fixture();
  const untyped=new Blob([await asset.blob.arrayBuffer()]);
  await assert.rejects(
    ()=>exportCompanyTemplate({profile,assetStore:readStore({...asset,blob:untyped}),Zip:JSZip}),
    /Blob MIME|MIME type/i
  );
});

test('uses cross-time-zone deterministic timestamps and Windows-safe filenames',async()=>{
  const previous=process.env.TZ;
  try{
    const outputs=[];
    for(const [index,zone] of ['Pacific/Kiritimati','America/Toronto'].entries()){
      process.env.TZ=zone;
      const module=await import(`../src/company-template.mjs?timezone=${index}`);
      const {profile,asset}=await fixture({companyName:'CON'});
      outputs.push(await module.exportCompanyTemplate({profile,assetStore:readStore(asset),Zip:JSZip}));
    }
    assert.deepEqual(
      new Uint8Array(await outputs[0].blob.arrayBuffer()),
      new Uint8Array(await outputs[1].blob.arrayBuffer())
    );
    assert.equal(outputs[0].filename,'company-con.phasei-template.zip');
  }finally{
    if(previous===undefined) delete process.env.TZ;
    else process.env.TZ=previous;
  }
});
