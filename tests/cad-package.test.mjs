import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import JSZip from 'jszip';
import {createProject} from '../src/core.mjs';
import {projectPoint,unprojectPoint} from '../src/sheet-layout.mjs';
import {pixelToGround} from '../src/world-file.mjs';
import {exportCadPackage} from '../src/cad-package.mjs';
import {TORONTO_IMAGERY_PROVIDER} from '../src/imagery/providers/toronto.mjs';

const STAMP='2026-08-28T12:00:00.000Z';
const IDS=Object.freeze({item:'74f14168-4de6-4c5f-88f4-87db8ec731c2',asset:'237589d9-3d5d-4817-9d0a-a5fb2d151286'});

function chunk(type,data){
  const payload=Buffer.concat([Buffer.from(type),Buffer.from(data)]),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
  length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(payload));return Buffer.concat([length,payload,checksum]);
}
function png({width=1,height=1,marker=80,resolution=true}={}){
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rows=[];for(let row=0;row<height;row++){rows.push(0);for(let column=0;column<width;column++)rows.push(marker,column,row,255);}
  const chunks=[chunk('IHDR',header)];
  if(resolution){const physical=Buffer.alloc(9);physical.writeUInt32BE(11811,0);physical.writeUInt32BE(11811,4);physical[8]=1;chunks.push(chunk('pHYs',physical));}
  chunks.push(chunk('IDAT',deflateSync(Buffer.from(rows))),chunk('IEND',Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),...chunks]));
}
function dataUrl(bytes,mime='image/png'){return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function pngDimensions(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return {width:view.getUint32(16),height:view.getUint32(20)};}
function hasPngChunk(bytes,name){for(let offset=8;offset+12<=bytes.length;){const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset),type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));if(type===name)return true;offset+=12+length;}return false;}

function a3Bounds(location,halfWidth=12_000){
  const [x,y]=projectPoint([location.lng,location.lat]),halfHeight=halfWidth/(420/297),southwest=unprojectPoint([x-halfWidth,y-halfHeight]),northeast=unprojectPoint([x+halfWidth,y+halfHeight]);
  return {west:southwest[0],south:southwest[1],east:northeast[0],north:northeast[1]};
}
function companyProfile(overrides={}){
  return {schemaVersion:1,id:'company-1',companyName:'Acme Environmental',address:'22 King Street',phone:'416-555-0110',email:'hello@acme.test',website:'https://acme.test',preparedBy:'Pat Lee',reviewedBy:'Sam Roy',logoAssetId:'logo-1',logoMime:'image/png',logoWidth:3,logoHeight:2,logoPlacement:{align:'left',scale:1},updatedAt:STAMP,...overrides};
}
function projectFixture(){
  const location={lat:43.7,lng:-79.3},project={...createProject({name:'Phase I Environmental Site Assessment',projectNo:'AB-12345',address:'92 Orchard Road',date:'2026-08-28'}),id:'project-cad-1',location,createdAt:STAMP,updatedAt:STAMP};
  const [cx,cy]=projectPoint([location.lng,location.lat]),item={
    id:IDS.item,year:1960,sequence:1,title:'Archive scan 1960',mode:'manual',providerId:null,sourceUrl:'https://archive.example.test/scan-1960',licenseUrl:null,
    attribution:'Municipal archive; reproduction permission on file',policy:'exportable',resolutionMeters:.4,bounds:a3Bounds(location),
    placement:{center:[cx,cy],groundWidth:30_000,groundHeight:22_000,sourceWidth:3,sourceHeight:2,rotationDegrees:0},assetId:IDS.asset,officialExport:null,createdAt:STAMP,updatedAt:STAMP
  };
  project.historical=[item];project.historicalSequenceCounters={'1960':1};return project;
}
const OFFICIAL_SOURCE='https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer',OFFICIAL_COVERAGE={west:-79.5,south:43.5,east:-79.1,north:43.9};
function officialItem(){return {id:IDS.item,year:1972,sequence:1,title:'City of Toronto aerial imagery 1972',mode:'official',providerId:'toronto',sourceUrl:OFFICIAL_SOURCE,licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy:'exportable',resolutionMeters:.2,bounds:a3Bounds({lat:43.7,lng:-79.3}),placement:null,assetId:null,officialExport:{kind:'arcgis-export',url:`${OFFICIAL_SOURCE}/export`,layer:null,maxWidth:4096,maxHeight:4096,resultId:'toronto:cot-historic-aerial-1972',coverage:{...OFFICIAL_COVERAGE},preview:{kind:'arcgis-map-service',url:OFFICIAL_SOURCE,layer:null,tileTemplate:`${OFFICIAL_SOURCE}/tile/{z}/{y}/{x}`}},createdAt:STAMP,updatedAt:STAMP};}
function currentOfficial(item){return {id:item.officialExport.resultId,providerId:item.providerId,title:item.title,year:item.year,resolutionMeters:item.resolutionMeters,coverage:{...item.officialExport.coverage},preview:{kind:item.officialExport.preview.kind,url:item.officialExport.preview.url,tileTemplate:item.officialExport.preview.tileTemplate},export:{kind:item.officialExport.kind,url:item.officialExport.url,maxWidth:item.officialExport.maxWidth,maxHeight:item.officialExport.maxHeight},policy:item.policy,sourceUrl:item.sourceUrl,licenseUrl:item.licenseUrl,attribution:item.attribution};}
async function assets(){
  const logoBytes=png({width:3,height:2,marker:76}),historicalBytes=png({width:3,height:2,marker:72});
  const record=(id,kind,bytes)=>({metadata:{id,kind,mime:'image/png',size:bytes.byteLength,width:3,height:2,sha256:sha256(bytes),createdAt:STAMP},blob:new Blob([bytes],{type:'image/png'})});
  return {logo:record('logo-1','company-logo',logoBytes),historical:record(IDS.asset,'historical-image',historicalBytes)};
}
function bitmapDecoder(log=[]){return async blob=>{const bytes=new Uint8Array(await blob.arrayBuffer()),dimensions=pngDimensions(bytes);return {...dimensions,close(){log.push(`${dimensions.width}x${dimensions.height}`);}};};}
function compositor(log=[],disposed=[],options={}){
  let active=0,maximum=0;
  const compose=async({code,item,geometry})=>{
    const label=code||`H-${item.year}-${item.sequence}`;log.push(label);active++;maximum=Math.max(maximum,active);
    try{
      if(options.fail===label)throw new Error(`${label} compositor failed`);
      options.controller?.abort();
      const raster=options.raster??{bytes:png({marker:label.charCodeAt(0)}),mime:'image/png',width:1,height:1};
      return {dataUrl:dataUrl(raster.bytes,raster.mime),width:raster.width,height:raster.height,bounds:{...geometry.bounds},dispose(){disposed.push(label);active--;}};
    }catch(error){active--;throw error;}
  };
  compose.stats=()=>({active,maximum});return compose;
}
async function fixture(overrides={}){
  const project=projectFixture(),profile=companyProfile(),stored=await assets(),reads=[];
  const store={async get(id){reads.push(id);return id===IDS.asset?stored.historical:null;}};
  const composed=[],disposed=[],compose=compositor(composed,disposed,overrides.composeOptions),selection=overrides.selection??[{kind:'historical',id:IDS.item},{kind:'figure',code:'C'},{kind:'figure',code:'A'}];
  const options={project,companyProfile:profile,companyLogo:stored.logo,selection,datasets:{},assetStore:store,dpi:150,Zip:JSZip,composeMap:compose,composeHistorical:compose,decodeOptions:{decodeBitmap:bitmapDecoder(overrides.decoded)},...overrides.options};
  return {project,profile,stored,reads,composed,disposed,compose,options};
}
async function archiveResult(overrides={}){const value=await fixture(overrides);return {...value,result:await exportCadPackage(value.options)};}
async function archiveEntries(blob){const zip=await JSZip.loadAsync(await blob.arrayBuffer()),names=Object.keys(zip.files);return {zip,names};}
async function bytes(zip,path){const file=zip.file(path);assert.ok(file,`missing ${path}`);return file.async('uint8array');}
async function text(zip,path){const file=zip.file(path);assert.ok(file,`missing ${path}`);return file.async('text');}
function dxfPolylines(dxf,layer){
  const pairs=dxf.trimEnd().split('\n'),entities=[];let current=null;
  for(let index=0;index<pairs.length;index+=2){const code=Number(pairs[index]),value=pairs[index+1];if(code===0){if(current)entities.push(current);current={type:value,layer:null,points:[]};continue;}if(!current)continue;if(code===8)current.layer=value;if(code===10){current.points.push([Number(value),null]);continue;}if(code===20&&current.points.length)current.points.at(-1)[1]=Number(value);}
  if(current)entities.push(current);return entities.filter(entity=>entity.type==='LWPOLYLINE'&&entity.layer===layer).map(entity=>entity.points);
}

test('real JSZip/PDF package has the exact deterministic entries, ordered selection, branding, and no DPI chunks',async()=>{
  const first=await archiveResult({decoded:[]}),second=await archiveResult({decoded:[]});
  assert.equal(first.result.filename,'ab-12345-cad-package.zip');assert.equal(first.result.pageCount,3);assert.equal(first.result.imageCount,3);assert.equal(first.result.crs.epsg,'EPSG:26917');
  assert.deepEqual(new Uint8Array(await first.result.blob.arrayBuffer()),new Uint8Array(await second.result.blob.arrayBuffer()));
  const {zip,names}=await archiveEntries(first.result.blob);
  assert.deepEqual(names,['Project.dxf','Combined-Phase-I.pdf','Attach-Images.scr','README.txt','Sources-and-Licences.txt','Manifest.csv','Manifest.json','company/logo.png','images/Figure-A.png','images/Figure-A.pgw','images/Figure-C.png','images/Figure-C.pgw','images/H-1960-1.png','images/H-1960-1.pgw']);
  assert.deepEqual(first.composed,['A','C','H-1960-1']);assert.deepEqual(first.disposed,first.composed);assert.equal(first.compose.stats().maximum,1);assert.equal(first.compose.stats().active,0);
  for(const path of names.filter(path=>/\.(?:png)$/i.test(path)))assert.equal(hasPngChunk(await bytes(zip,path),'pHYs'),false,`${path} physical resolution metadata`);
  const pdf=Buffer.from(await bytes(zip,'Combined-Phase-I.pdf')),raw=pdf.toString('latin1');assert.equal((raw.match(/\/Type \/Page\b/g)||[]).length,3);assert.match(raw,/\/Subtype \/Image/);
  const dxf=await text(zip,'Project.dxf');for(const token of ['$INSUNITS','SITE_MARKER','IMAGE_FRAMES','COMPANY_LOGO_FRAME','EPSG:26917'])assert.match(dxf,new RegExp(token.replace(/[$]/g,'\\$&')));
  assert.doesNotMatch(dxf,/\n(?:NaN|Infinity|-Infinity)\n/);
});

test('one projected affine drives each world file, DXF frame, attachment command, and hashed manifest row',async()=>{
  const {result}=await archiveResult(),{zip,names}=await archiveEntries(result.blob),manifest=JSON.parse(await text(zip,'Manifest.json')),dxf=await text(zip,'Project.dxf'),frames=dxfPolylines(dxf,'IMAGE_FRAMES');
  assert.deepEqual(manifest.items.map(item=>item.code),['A','C','H-1960-1']);assert.equal(frames.length,3);
  const script=await text(zip,'Attach-Images.scr');assert.equal((script.match(/_-IMAGEATTACH/g)||[]).length,4);
  for(const [index,item] of manifest.items.entries()){
    const world=(await text(zip,item.worldFilePath)).trim().split('\n').map(Number),[A,D,B,E,C,F]=world,image=manifest.files.find(file=>file.path===item.imagePath);
    const outer=[C-(A+B)/2,F-(D+E)/2],upperRight=[outer[0]+A*image.pixelWidth,outer[1]+D*image.pixelWidth],lowerLeft=[outer[0]+B*image.pixelHeight,outer[1]+E*image.pixelHeight],lowerRight=[upperRight[0]+lowerLeft[0]-outer[0],upperRight[1]+lowerLeft[1]-outer[1]];
    for(const [actual,expected] of [[outer,item.projectedCorners[0]],[upperRight,item.projectedCorners[1]],[lowerRight,item.projectedCorners[2]],[lowerLeft,item.projectedCorners[3]]])assert.ok(Math.hypot(actual[0]-expected[0],actual[1]-expected[1])<1e-5,item.code);
    assert.deepEqual(frames[index],item.projectedCorners);assert.deepEqual(pixelToGround([0,0],world),[C,F]);assert.match(script,new RegExp(item.imagePath.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  }
  const declared=new Map(manifest.files.map(file=>[file.path,file]));assert.deepEqual([...declared.keys()].sort(),names.filter(path=>path!=='Manifest.json').sort());
  for(const path of names.filter(path=>path!=='Manifest.json')){const content=await bytes(zip,path),row=declared.get(path);assert.equal(row.bytes,content.byteLength,path);assert.equal(row.sha256,sha256(content),path);}
});

test('production-style JPEG composers allocate matching .jpg/.jgw paths and strip JFIF/EXIF density metadata',async()=>{
  const jpeg=new Uint8Array(await fs.readFile(new URL('./fixtures/imagery/manual/valid-2x3-o1.jpg',import.meta.url))),decodeBitmap=async blob=>blob.type==='image/jpeg'?{width:2,height:3,close(){}}:{...pngDimensions(new Uint8Array(await blob.arrayBuffer())),close(){}};
  const value=await fixture({selection:[{kind:'figure',code:'A'}],composeOptions:{raster:{bytes:jpeg,mime:'image/jpeg',width:2,height:3}},options:{decodeOptions:{decodeBitmap}}}),result=await exportCadPackage(value.options),{zip,names}=await archiveEntries(result.blob);
  assert.deepEqual(names.slice(-2),['images/Figure-A.jpg','images/Figure-A.jgw']);const image=await bytes(zip,'images/Figure-A.jpg');assert.equal(image[0],0xff);assert.equal(image[1],0xd8);assert.equal(Buffer.from(image).includes(Buffer.from('JFIF')),false);assert.equal(Buffer.from(image).includes(Buffer.from('Exif')),false);
  const manifest=JSON.parse(await text(zip,'Manifest.json'));assert.equal(manifest.items[0].imagePath,'images/Figure-A.jpg');assert.equal(manifest.items[0].worldFilePath,'images/Figure-A.jgw');
});

test('strict frozen preflight rejects duplicate, link-only, stale logo, and missing selected assets before composition',async()=>{
  const cases=[];
  {
    const value=await fixture({selection:[{kind:'figure',code:'A'},{kind:'figure',code:'A'}]});cases.push([value,/duplicate/i]);
  }
  {
    const value=await fixture();value.project.historical[0].policy='link-only';cases.push([value,/policy|exportable|link-only/i]);
  }
  {
    const value=await fixture();value.options.companyLogo={...value.stored.logo,metadata:{...value.stored.logo.metadata,sha256:'0'.repeat(64)}};cases.push([value,/logo.*hash|hash.*logo|integrity/i]);
  }
  {
    const value=await fixture();value.options.assetStore={get:async()=>null};cases.push([value,/missing.*historical|historical.*missing|asset/i]);
  }
  for(const [value,pattern] of cases){await assert.rejects(exportCadPackage(value.options),pattern);assert.deepEqual(value.composed,[]);assert.deepEqual(value.disposed,[]);}
});

test('typed selection rejects accessors without invoking untrusted getters',async()=>{
  let getterCalls=0;const selection={code:'A'};Object.defineProperty(selection,'kind',{enumerable:true,get(){getterCalls++;return 'figure';}});const value=await fixture({selection:[selection]});
  await assert.rejects(exportCadPackage(value.options),/data field|exact fields/i);assert.equal(getterCalls,0);assert.deepEqual(value.composed,[]);
});

test('official imagery is revalidated once and stale provider identity fails before composition',async()=>{
  const value=await fixture({selection:[{kind:'historical',id:IDS.item}]});value.project.historical=[officialItem()];value.project.historicalSequenceCounters={'1972':1};const calls=[],current=currentOfficial(value.project.historical[0]);value.options.providers=[TORONTO_IMAGERY_PROVIDER];value.options.revalidateOfficial=async({item})=>{calls.push(item.id);return structuredClone(current);};
  const result=await exportCadPackage(value.options),{zip}=await archiveEntries(result.blob),manifest=JSON.parse(await text(zip,'Manifest.json'));assert.deepEqual(calls,[IDS.item]);assert.deepEqual(value.reads,[]);assert.deepEqual(value.composed,['H-1972-1']);assert.equal(manifest.items[0].provider,TORONTO_IMAGERY_PROVIDER.label);
  const stale=await fixture({selection:[{kind:'historical',id:IDS.item}]});stale.project.historical=[officialItem()];stale.project.historicalSequenceCounters={'1972':1};stale.options.providers=[TORONTO_IMAGERY_PROVIDER];stale.options.revalidateOfficial=async({item})=>({...currentOfficial(item),id:'toronto:changed-result'});
  await assert.rejects(exportCadPackage(stale.options),/current official|identity|changed|stale/i);assert.deepEqual(stale.composed,[]);assert.deepEqual(stale.disposed,[]);
});

test('only selected assets are read and unselected project imagery never enters the archive',async()=>{
  const value=await fixture({selection:[{kind:'figure',code:'A'}]});value.project.historical.push({...value.project.historical[0],id:'9833e469-c7e8-4ef1-84f1-b89c608c2126',sequence:2,assetId:'d9a64b75-571c-4142-ae5d-cc8ee35f36fa'});value.project.historicalSequenceCounters={'1960':2};
  const result=await exportCadPackage(value.options),{names}=await archiveEntries(result.blob);assert.deepEqual(value.reads,[]);assert.deepEqual(value.composed,['A']);assert.equal(names.some(path=>path.includes('H-1960')),false);
});

test('composition failure and cancellation return no partial Blob and dispose every acquired surface',async()=>{
  {
    const value=await fixture({composeOptions:{fail:'C'}});let result;await assert.rejects(async()=>{result=await exportCadPackage(value.options);},/Figure C.*compositor failed|C compositor failed/i);assert.equal(result,undefined);assert.deepEqual(value.composed,['A','C']);assert.deepEqual(value.disposed,['A']);assert.equal(value.compose.stats().active,0);
  }
  {
    const controller=new AbortController(),value=await fixture({selection:[{kind:'figure',code:'A'}],composeOptions:{controller},options:{signal:controller.signal}});let result;
    await assert.rejects(async()=>{result=await exportCadPackage(value.options);},{name:'AbortError'});assert.equal(result,undefined);assert.deepEqual(value.disposed,['A']);assert.equal(value.compose.stats().active,0);
  }
});

test('a PDF exporter cannot request one selected raster twice',async()=>{
  const value=await fixture({selection:[{kind:'figure',code:'A'}],options:{exportPdf:async options=>{
    const geometry=(await import('../src/sheet-layout.mjs')).sheetGeometry(options.project,'A',options.dpi);const first=await options.compose({project:options.project,code:'A',geometry,features:[],signal:options.signal});first.dispose();
    await options.compose({project:options.project,code:'A',geometry,features:[],signal:options.signal});return {blob:new Blob(['not a pdf'],{type:'application/pdf'}),pageCount:1};
  }}});
  await assert.rejects(exportCadPackage(value.options),/duplicate|exactly once/i);assert.deepEqual(value.composed,['A']);assert.deepEqual(value.disposed,['A']);assert.equal(value.compose.stats().active,0);
});

test('a PDF exporter cannot substitute a non-PDF payload with an application/pdf MIME label',async()=>{
  const value=await fixture({selection:[{kind:'figure',code:'A'}],options:{exportPdf:async options=>{
    const geometry=(await import('../src/sheet-layout.mjs')).sheetGeometry(options.project,'A',options.dpi),surface=await options.compose({project:options.project,code:'A',geometry,features:[],signal:options.signal});surface.dispose();return {blob:new Blob(['not a pdf'],{type:'application/pdf'}),pageCount:1};
  }}});
  await assert.rejects(exportCadPackage(value.options),/valid PDF|signature|end marker/i);assert.deepEqual(value.composed,['A']);assert.deepEqual(value.disposed,['A']);assert.equal(value.compose.stats().active,0);
});

test('abort during final ZIP generation prevents publication after all temporary raster resources close',async()=>{
  const controller=new AbortController(),value=await fixture({selection:[{kind:'figure',code:'A'}],options:{signal:controller.signal,onProgress:event=>{if(event.phase==='compressing')controller.abort();}}});let result;
  await assert.rejects(async()=>{result=await exportCadPackage(value.options);},{name:'AbortError'});assert.equal(result,undefined);assert.deepEqual(value.disposed,['A']);assert.equal(value.compose.stats().active,0);
});

test('logo byte and package entry budgets fail closed before any map composition',async()=>{
  const value=await fixture(),oversized=new Uint8Array(16_000_001),blob=new Blob([oversized],{type:'image/png'});value.options.companyLogo={blob,metadata:{...value.stored.logo.metadata,size:blob.size,sha256:sha256(oversized)}};
  await assert.rejects(exportCadPackage(value.options),/16 MB|byte limit|too large|budget/i);assert.deepEqual(value.composed,[]);
});

test('pre-aborted exports do not read assets, compose, invoke PDF generation, or construct ZIPs',async()=>{
  const controller=new AbortController();controller.abort();const value=await fixture({options:{signal:controller.signal,exportPdf:async()=>{throw new Error('must not export PDF');},Zip:class{constructor(){throw new Error('must not construct ZIP');}}}});
  await assert.rejects(exportCadPackage(value.options),{name:'AbortError'});assert.deepEqual(value.reads,[]);assert.deepEqual(value.composed,[]);
});

test('test fixture remains a fully decodable PNG boundary',async()=>{
  const fixtureBytes=new Uint8Array(await fs.readFile(new URL('./fixtures/imagery/manual/valid-3x2.png',import.meta.url)));assert.deepEqual(pngDimensions(fixtureBytes),{width:3,height:2});
});
