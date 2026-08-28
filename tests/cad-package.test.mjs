import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import JSZip from 'jszip';
import {createProject} from '../src/core.mjs';
import {projectPoint,sheetGeometry,unprojectPoint} from '../src/sheet-layout.mjs';
import {pixelToGround} from '../src/world-file.mjs';
import {exportCadPackage} from '../src/cad-package.mjs';
import {createProjector} from '../src/projection.mjs';
import {TORONTO_IMAGERY_PROVIDER} from '../src/imagery/providers/toronto.mjs';
import {MIN_ACQUISITION_YEAR} from '../src/imagery/provider-registry.mjs';

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
function jpegWithDimensions(source,width,height){const bytes=new Uint8Array(source);for(let offset=2;offset<bytes.length-8;){if(bytes[offset++]!==0xff)throw new Error('invalid JPEG fixture marker');while(bytes[offset]===0xff)offset++;const marker=bytes[offset++];if(marker===0xda||marker===0xd9)break;if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;const length=bytes[offset]<<8|bytes[offset+1];if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){bytes[offset+3]=height>>8;bytes[offset+4]=height&255;bytes[offset+5]=width>>8;bytes[offset+6]=width&255;return bytes;}offset+=length;}throw new Error('JPEG fixture has no SOF marker');}
const PRODUCTION_PNGS=new Map();
function productionPng(width,height,marker){const key=`${width}x${height}:${marker}`;if(PRODUCTION_PNGS.has(key))return PRODUCTION_PNGS.get(key);const row=Buffer.alloc(1+width*4);for(let offset=1;offset<row.length;offset+=4){row[offset]=marker;row[offset+3]=255;}const raw=Buffer.alloc(row.length*height);for(let index=0;index<height;index++)row.copy(raw,index*row.length);const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;const physical=Buffer.alloc(9);physical.writeUInt32BE(11811,0);physical.writeUInt32BE(11811,4);physical[8]=1;const result=new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('pHYs',physical),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));PRODUCTION_PNGS.set(key,result);return result;}

function a3Bounds(location,halfWidth=12_000){
  const [x,y]=projectPoint([location.lng,location.lat]),halfHeight=halfWidth/(420/297),southwest=unprojectPoint([x-halfWidth,y-halfHeight]),northeast=unprojectPoint([x+halfWidth,y+halfHeight]);
  return {west:southwest[0],south:southwest[1],east:northeast[0],north:northeast[1]};
}
function companyProfile(overrides={}){
  return {schemaVersion:1,id:'company-1',companyName:'Acme Environmental',address:'22 King Street',phone:'416-555-0110',email:'hello@acme.test',website:'https://acme.test',preparedBy:'Pat Lee',reviewedBy:'Sam Roy',logoAssetId:'logo-1',logoMime:'image/png',logoWidth:3,logoHeight:2,logoPlacement:{align:'left',scale:1},updatedAt:STAMP,...overrides};
}
function projectFixture(){
  const location={lat:43.7,lng:-79.3},project={...createProject({name:'Phase I Environmental Site Assessment',projectNo:'AB-12345',address:'92 Orchard Road',date:'2026-08-28',companyProfileSnapshot:companyProfile()}),id:'project-cad-1',location,createdAt:STAMP,updatedAt:STAMP};
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
      const raster=options.raster??{bytes:productionPng(geometry.raster.width,geometry.raster.height,label.charCodeAt(0)),mime:'image/png',width:geometry.raster.width,height:geometry.raster.height};
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

test('Figure B/D/E artifacts preserve unknown acquisition year and every composited basemap and geology source',async()=>{
  const value=await fixture({selection:[{kind:'figure',code:'B'},{kind:'figure',code:'D'},{kind:'figure',code:'E'}]}),location=value.project.location;
  value.project.siteBoundary=[[location.lng-.01,location.lat-.01],[location.lng+.01,location.lat-.01],[location.lng+.01,location.lat+.01],[location.lng-.01,location.lat-.01]];
  const polygon={polygon:[[location.lng-.5,location.lat-.5],[location.lng+.5,location.lat-.5],[location.lng+.5,location.lat+.5],[location.lng-.5,location.lat+.5],[location.lng-.5,location.lat-.5]],holes:[],name:'Test unit',unitCode:'5D',description:'Test geology',color:'#22aa66',fillOpacity:.6};
  value.options.datasets={
    surficial:{features:[polygon],coverage:{west:-80,south:43,east:-79,north:44},source:{id:'MRD128-REV',name:'MRD128 / MRD128-REV Surficial Geology',credits:'Ontario Geological Survey',sourceUrl:'https://www.geologyontario.mndm.gov.on.ca/mndmaccess/mndm_dir.asp?type=pub&id=MRD128-REV',license:'https://www.ontario.ca/page/open-government-licence-ontario',redistributionEvidence:'official-open-government-licence'}},
    bedrock:{features:[polygon],coverage:{west:-80,south:43,east:-79,north:44},source:{id:'custom',name:'Engineer supplied bedrock.kml',credits:'Prepared by Example Engineer',sourceUrl:'https://records.example.test/bedrock',license:'Written project-use and redistribution permission on file',redistributionEvidence:'user-supplied-permission-confirmed',acquisitionYear:2011,acquisitionYearVerification:'verified',permissionConfirmed:true}}
  };
  const result=await exportCadPackage(value.options),{zip}=await archiveEntries(result.blob),manifest=JSON.parse(await text(zip,'Manifest.json')),csv=await text(zip,'Manifest.csv'),sources=await text(zip,'Sources-and-Licences.txt'),readme=await text(zip,'README.txt');
  const byCode=Object.fromEntries(manifest.items.map(item=>[item.code,item]));
  for(const code of ['B','D','E']){assert.equal(byCode[code].acquisitionYear,null);assert.equal(byCode[code].acquisitionYearVerification,'unknown');}
  assert.deepEqual(byCode.B.sources.map(source=>source.role),['basemap']);
  assert.deepEqual(byCode.D.sources.map(source=>source.role),['basemap','geology-overlay']);
  assert.deepEqual(byCode.E.sources.map(source=>source.role),['basemap','user-supplied-overlay']);assert.equal(byCode.E.sources[1].acquisitionYear,2011);assert.equal(byCode.E.sources[1].acquisitionYearVerification,'verified');
  assert.match(JSON.stringify(byCode.D.sources),/OpenStreetMap.*MRD128|MRD128.*OpenStreetMap/);
  assert.match(JSON.stringify(byCode.E.sources),/Engineer supplied bedrock\.kml/);
  assert.doesNotMatch(JSON.stringify(manifest.items),/"acquisitionYear":2026/,'report year must never be fabricated as acquisition year');
  for(const artifact of [csv,sources,readme]){assert.match(artifact,/Acquisition year|acquisition year/i);assert.match(artifact,/unknown/i);assert.match(artifact,/geology-overlay|geology overlay/i);}
  assert.match(csv,/MRD128/);assert.match(csv,/Engineer supplied bedrock\.kml/);assert.match(sources,/official-open-government-licence/);assert.match(sources,/user-supplied-permission-confirmed/);
});

test('CAD export fails before composition when a selected geology overlay lacks licence provenance',async()=>{
  const value=await fixture({selection:[{kind:'figure',code:'D'}]}),location=value.project.location,polygon={polygon:[[location.lng-.5,location.lat-.5],[location.lng+.5,location.lat-.5],[location.lng+.5,location.lat+.5],[location.lng-.5,location.lat+.5],[location.lng-.5,location.lat-.5]],holes:[],name:'Custom unit',unitCode:'X',description:'Custom',color:'#22aa66',fillOpacity:.6};
  value.options.datasets={surficial:{features:[polygon],coverage:{west:-80,south:43,east:-79,north:44},source:{id:'custom',name:'unlicensed.kml'}}};
  await assert.rejects(exportCadPackage(value.options),/geology.*licen[cs]e|provenance|permission/i);
  assert.deepEqual(value.composed,[]);
});

test('custom geology acquisition-year boundaries fail before composition and the shared minimum exports without a late manifest failure',async()=>{
  const setup=async acquisitionYear=>{const value=await fixture({selection:[{kind:'figure',code:'E'}]}),location=value.project.location,polygon={polygon:[[location.lng-.5,location.lat-.5],[location.lng+.5,location.lat-.5],[location.lng+.5,location.lat+.5],[location.lng-.5,location.lat+.5],[location.lng-.5,location.lat-.5]],holes:[],name:'Custom unit',unitCode:'X',description:'Custom',color:'#22aa66',fillOpacity:.6};value.options.datasets={bedrock:{features:[polygon],coverage:{west:-80,south:43,east:-79,north:44},source:{id:'custom',name:'bounded.kml',credits:'Example Engineer',sourceUrl:null,license:'Written project licence',redistributionEvidence:'Permission email on file',acquisitionYear,acquisitionYearVerification:'verified',permissionConfirmed:true}}};return value;};
  const invalid=await setup(MIN_ACQUISITION_YEAR-1);await assert.rejects(exportCadPackage(invalid.options),/1850|year|range|provenance/i);assert.deepEqual(invalid.composed,[],'invalid provenance must fail before raster composition');
  const valid=await setup(MIN_ACQUISITION_YEAR),result=await exportCadPackage(valid.options),{zip}=await archiveEntries(result.blob),manifest=JSON.parse(await text(zip,'Manifest.json'));assert.deepEqual(valid.composed,['E']);assert.equal(manifest.items[0].sources[1].acquisitionYear,MIN_ACQUISITION_YEAR);
});

test('production raster dimensions preserve true ordered UTM controls and fit one converged CAD affine within documented tolerance',async()=>{
  const exportPdf=async options=>{for(const selected of options.selection){const geometry=selected.kind==='figure'?(await import('../src/sheet-layout.mjs')).sheetGeometry(options.project,selected.code,options.dpi):(await import('../src/historical-layout.mjs')).historicalSheetGeometry(options.project,options.project.historical.find(item=>item.id===selected.id),options.dpi),surface=await (selected.kind==='figure'?options.compose({project:options.project,code:selected.code,geometry,features:[],signal:options.signal}):options.composeHistorical({project:options.project,item:options.project.historical.find(item=>item.id===selected.id),geometry,signal:options.signal}));surface.dispose();}return {blob:new Blob(['%PDF-1.3\n%%EOF\n'],{type:'application/pdf'}),pageCount:options.selection.length};};
  const {result}=await archiveResult({composeOptions:{productionDimensions:true},options:{exportPdf}}),{zip}=await archiveEntries(result.blob),manifest=JSON.parse(await text(zip,'Manifest.json')),dxf=await text(zip,'Project.dxf'),frames=dxfPolylines(dxf,'IMAGE_FRAMES'),script=await text(zip,'Attach-Images.scr'),readme=await text(zip,'README.txt'),sources=await text(zip,'Sources-and-Licences.txt'),projector=createProjector({lat:43.7,lng:-79.3});assert.match(readme,/contextual, not survey grade/i);assert.match(readme,/0\.15%/);assert.match(sources,/True-control residual:/);assert.match(sources,/Fitness: contextual-not-survey-grade/);
  for(const [index,item] of manifest.items.entries()){
    const controls=item.geographicCorners.map(point=>projector.forward(point));for(let corner=0;corner<4;corner++)assert.ok(Math.hypot(controls[corner][0]-item.projectedControlCorners[corner][0],controls[corner][1]-item.projectedControlCorners[corner][1])<1e-5,`${item.code} true control ${corner}`);
    assert.deepEqual(item.cadFrameCorners,item.projectedCorners);assert.deepEqual(frames[index],item.cadFrameCorners);assert.equal(item.projectionFit.method,'least-squares-similarity');assert.equal(item.projectionFit.fitness,'contextual-not-survey-grade');assert.ok(item.projectionFit.residualMetres<=item.projectionFit.maxToleranceMetres,item.code);assert.ok(item.rotation>1&&item.rotation<2,`${item.code} UTM convergence`);
    const residual=Math.max(...controls.map((point,corner)=>Math.hypot(point[0]-item.cadFrameCorners[corner][0],point[1]-item.cadFrameCorners[corner][1]))),diagonal=Math.hypot(controls[2][0]-controls[0][0],controls[2][1]-controls[0][1]),tolerance=Math.max(2,diagonal*.0015);assert.ok(Math.abs(residual-item.projectionFit.residualMetres)<1e-4,item.code);assert.ok(Math.abs(tolerance-item.projectionFit.maxToleranceMetres)<1e-4,item.code);if(item.code==='A'||item.code==='C')assert.ok(residual<2,`${item.code} high-quality control fit`);else assert.ok(residual>2,`${item.code} documents contextual fit`);
    const world=(await text(zip,item.worldFilePath)).trim().split('\n').map(Number),image=manifest.files.find(file=>file.path===item.imagePath),[A,D,B,E,C,F]=world,outer=[C-(A+B)/2,F-(D+E)/2],reconstructed=[outer,[outer[0]+A*image.pixelWidth,outer[1]+D*image.pixelWidth],[outer[0]+A*image.pixelWidth+B*image.pixelHeight,outer[1]+D*image.pixelWidth+E*image.pixelHeight],[outer[0]+B*image.pixelHeight,outer[1]+E*image.pixelHeight]];for(let corner=0;corner<4;corner++)assert.ok(Math.hypot(reconstructed[corner][0]-item.cadFrameCorners[corner][0],reconstructed[corner][1]-item.cadFrameCorners[corner][1])<1e-5,`${item.code} world frame`);
    const command=script.split('\r\n').findIndex(line=>line===`"${item.imagePath}"`);assert.ok(command>0);assert.ok(Math.abs(Number(script.split('\r\n')[command+3])-item.rotation)<1e-8,item.code);
  }
});

test('production-style JPEG composers allocate matching .jpg/.jgw paths and strip JFIF/EXIF density metadata',async()=>{
  const geometry=sheetGeometry(projectFixture(),'A',150),jpeg=jpegWithDimensions(new Uint8Array(await fs.readFile(new URL('./fixtures/imagery/manual/valid-2x3-o1.jpg',import.meta.url))),geometry.raster.width,geometry.raster.height),decodeBitmap=async blob=>blob.type==='image/jpeg'?{...geometry.raster,close(){}}:{...pngDimensions(new Uint8Array(await blob.arrayBuffer())),close(){}},exportPdf=async options=>{const surface=await options.compose({project:options.project,code:'A',geometry:sheetGeometry(options.project,'A',options.dpi),features:[],signal:options.signal});surface.dispose();return {blob:new Blob(['%PDF-1.3\n%%EOF\n'],{type:'application/pdf'}),pageCount:1};};
  const value=await fixture({selection:[{kind:'figure',code:'A'}],composeOptions:{raster:{bytes:jpeg,mime:'image/jpeg',...geometry.raster}},options:{decodeOptions:{decodeBitmap},exportPdf}}),result=await exportCadPackage(value.options),{zip,names}=await archiveEntries(result.blob);
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

test('CAD package rejects reusable branding that differs from the authoritative project snapshot',async()=>{
  const value=await fixture(),companyB=companyProfile({id:'company-b',companyName:'Company B',logoAssetId:'logo-b'});
  value.options.companyProfile=companyB;value.options.companyLogo={...value.stored.logo,metadata:{...value.stored.logo.metadata,id:'logo-b'}};
  await assert.rejects(exportCadPackage(value.options),/project branding|snapshot|company.*match/i);
  assert.deepEqual(value.composed,[]);
});

test('invalid mandatory logo blocks all historical asset, provider, composer, PDF, and ZIP work',async()=>{
  const value=await fixture(),official={...officialItem(),id:'9833e469-c7e8-4ef1-84f1-b89c608c2126'};value.project.historical.push(official);value.project.historicalSequenceCounters={'1960':1,'1972':1};value.options.selection=[{kind:'historical',id:IDS.item},{kind:'historical',id:official.id}];let providerCalls=0,pdfCalls=0,zipCalls=0;value.options.providers=[TORONTO_IMAGERY_PROVIDER];value.options.revalidateOfficial=async()=>{providerCalls++;return currentOfficial(official);};value.options.exportPdf=async()=>{pdfCalls++;throw new Error('must not export PDF');};value.options.Zip=class{constructor(){zipCalls++;}};value.options.companyLogo={...value.stored.logo,metadata:{...value.stored.logo.metadata,sha256:'0'.repeat(64)}};
  await assert.rejects(exportCadPackage(value.options),/logo.*hash|hash.*logo|integrity/i);assert.deepEqual(value.reads,[]);assert.equal(providerCalls,0);assert.deepEqual(value.composed,[]);assert.equal(pdfCalls,0);assert.equal(zipCalls,0);
});

test('mandatory logo bytes and metadata are snapshotted before later historical asset work can mutate the caller record',async()=>{
  const value=await fixture({selection:[{kind:'historical',id:IDS.item}]}),originalHash=value.stored.logo.metadata.sha256,normalizedHash=sha256(png({width:3,height:2,marker:76,resolution:false})),originalGet=value.options.assetStore.get;value.options.assetStore={get:async id=>{value.options.companyLogo.metadata.sha256='0'.repeat(64);value.options.companyLogo.blob=new Blob(['mutated'],{type:'image/png'});return originalGet(id);}};
  const result=await exportCadPackage(value.options),{zip}=await archiveEntries(result.blob),manifest=JSON.parse(await text(zip,'Manifest.json')),logo=manifest.files.find(file=>file.path==='company/logo.png'),logoBytes=await bytes(zip,'company/logo.png');assert.equal(logo.sha256,normalizedHash);assert.equal(logo.sha256,sha256(logoBytes));assert.notEqual(value.options.companyLogo.metadata.sha256,originalHash);
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

test('conservative budget planner enforces aggregate pixel, raster, PDF, uncompressed, archive, and working-copy boundaries',async()=>{
  const {planCadPackageBudget}=await import('../src/cad-package.mjs');assert.equal(typeof planCadPackageBudget,'function');const input={rasters:[{width:2,height:2},{width:2,height:2}],logoBytes:1,logoPixels:2,entryCount:2,pdfBytes:20,textBytes:10},base={imageBytes:10,imagePixels:100,rasterBytes:100,pixels:100,pdfBytes:100,textBytes:100,uncompressedBytes:1000,archiveBytes:2000,workingBytes:10000,zipEntryOverheadBytes:2,zipEndOverheadBytes:3};
  const exact=[['pixels',10,/pixel/i],['rasterBytes',21,/raster.*byte/i],['pdfBytes',20,/PDF.*byte/i],['uncompressedBytes',51,/uncompressed/i],['archiveBytes',58,/archive/i],['workingBytes',190,/working|memory/i]];
  for(const [field,boundary,pattern] of exact){assert.doesNotThrow(()=>planCadPackageBudget({...input,limits:{...base,[field]:boundary}}),field);assert.throws(()=>planCadPackageBudget({...input,limits:{...base,[field]:boundary-1}}),pattern,field);}
});

test('worst-case normalized raster budget fails before selected asset or provider I/O and every composer',async()=>{
  const value=await fixture(),base=officialItem(),items=[0,1,2].map(index=>({...base,id:['74f14168-4de6-4c5f-88f4-87db8ec731c2','9833e469-c7e8-4ef1-84f1-b89c608c2126','6f9719eb-3083-4bdb-a35b-d638a6efac19'][index],year:1970+index,title:`Official ${1970+index}`,officialExport:{...base.officialExport,resultId:`toronto:official-${1970+index}`}}));value.project.historical=items;value.project.historicalSequenceCounters={'1970':1,'1971':1,'1972':1};value.options.selection=[...['A','B','C','D','E'].map(code=>({kind:'figure',code})),...items.map(item=>({kind:'historical',id:item.id}))];let providerCalls=0,pdfCalls=0;value.options.providers=[TORONTO_IMAGERY_PROVIDER];value.options.revalidateOfficial=async({item})=>{providerCalls++;return currentOfficial(item);};value.options.exportPdf=async()=>{pdfCalls++;throw new Error('must not export PDF');};
  await assert.rejects(exportCadPackage(value.options),/worst-case|normalized raster|128 MB|budget/i);assert.deepEqual(value.reads,[]);assert.equal(providerCalls,0);assert.deepEqual(value.composed,[]);assert.equal(pdfCalls,0);
});

test('pre-aborted exports do not read assets, compose, invoke PDF generation, or construct ZIPs',async()=>{
  const controller=new AbortController();controller.abort();const value=await fixture({options:{signal:controller.signal,exportPdf:async()=>{throw new Error('must not export PDF');},Zip:class{constructor(){throw new Error('must not construct ZIP');}}}});
  await assert.rejects(exportCadPackage(value.options),{name:'AbortError'});assert.deepEqual(value.reads,[]);assert.deepEqual(value.composed,[]);
});

test('test fixture remains a fully decodable PNG boundary',async()=>{
  const fixtureBytes=new Uint8Array(await fs.readFile(new URL('./fixtures/imagery/manual/valid-3x2.png',import.meta.url)));assert.deepEqual(pngDimensions(fixtureBytes),{width:3,height:2});
});
