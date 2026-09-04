import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync,crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createProject} from '../src/core.mjs';
import {JSDOM} from 'jsdom';
import {TORONTO_IMAGERY_PROVIDER} from '../src/imagery/providers/toronto.mjs';
import {projectPoint,unprojectPoint} from '../src/sheet-layout.mjs';

const project=()=>({...createProject({name:'Café geological study',projectNo:'26-123',address:'Toronto',date:'2026-08-26'}),location:{lat:43.7,lng:-79.3}});
const feature={name:'Custom bedrock',description:'User supplied unit',unitCode:'54a',color:'#aaaaaa',fillOpacity:.6,polygon:[[-80,43],[-78,43],[-78,45],[-80,45],[-80,43]],holes:[]};
const datasets={bedrock:{features:[feature],source:'User bedrock',coverage:null}};
// Browser canvas/network is replaced, but real jsPDF must assemble and serialize these distinct map images.
function png(code){
  const chunk=(type,data)=>{const payload=Buffer.concat([Buffer.from(type),data]),header=Buffer.alloc(4),crc=Buffer.alloc(4);header.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(payload));return Buffer.concat([header,payload,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,code.charCodeAt(0),100,150,128]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const companyProfile=()=>({schemaVersion:1,id:'company-1',companyName:'Acme Environmental',address:'22 King Street',phone:'416-555-0110',
  email:'hello@acme.test',website:'https://acme.test',preparedBy:'Pat Lee',reviewedBy:'Sam Roy',logoAssetId:'logo-1',
  logoMime:'image/png',logoWidth:1,logoHeight:1,logoPlacement:{align:'left',scale:1},updatedAt:'2026-08-26T12:00:00Z'});
const branding=()=>({companyProfile:companyProfile(),companyLogoDataUrl:png('L')});
function compositor(log,disposed){return async({code,geometry})=>{log.push(code);return {dataUrl:png(code),width:1,height:1,bounds:geometry.bounds,dispose:()=>disposed.push(code)};};}
function longSurficialDataset(count=28){
  const features=Array.from({length:count},(_,index)=>({
    name:`Official unit ${String(index+1).padStart(2,'0')}`,
    description:'Official Quaternary geology description with deposits, sediments, landforms, and interpretive qualifiers preserved in full.',
    unitCode:`DUNIT-${index+1}`,color:'#5fa8d3',fillOpacity:.6,
    polygon:[[-80,43],[-78,43],[-78,45],[-80,45],[-80,43]],holes:[],
  }));
  return {features,source:{name:'Ontario Geological Survey official surficial geology',credits:'Official unit descriptions reproduced without abbreviation.'},coverage:null};
}
function longBedrockDataset(count=28){
  const features=Array.from({length:count},(_,index)=>({
    name:`Custom bedrock unit ${index+1}`,
    description:'User supplied bedrock description preserving formation, member, lithology, and interpretive qualifiers in full.',
    unitCode:`BR-${index+1}`,color:'#aaaaaa',fillOpacity:.6,
    polygon:[[-80,43],[-78,43],[-78,45],[-80,45],[-80,43]],holes:[],
  }));
  return {features,source:{name:'Synthetic custom bedrock.kml',credits:'Synthetic review fixture; no private data.'},coverage:null};
}
function decodePdfText(raw){
  const cmap=new Map([...raw.matchAll(/<([0-9a-f]{4})><([0-9a-f]{4})>/gi)].map(m=>[m[1].toLowerCase(),String.fromCodePoint(parseInt(m[2],16))]));
  return [...raw.matchAll(/<([0-9a-f]+)>\s*Tj/gi)].map(m=>m[1].match(/.{4}/g).map(g=>cmap.get(g.toLowerCase())||'?').join('')).join('\n');
}
async function engine(){const {exportCombinedPdf}=await import('../src/pdf-export.mjs');return options=>exportCombinedPdf({...branding(),revalidateOfficial:async({item})=>currentOfficialResult(item),...options});}
test('long Figure D and E legends preserve exact code tokens and global order across physical pages',async()=>{
  const exportPdf=await engine(),log=[],disposed=[],surficial=longSurficialDataset(),bedrock=longBedrockDataset();
  const result=await exportPdf({project:project(),codes:['E','D'],datasets:{surficial,bedrock},compose:compositor(log,disposed)});
  assert.deepEqual(log,['D','E'],'only the D/E map pages compose, in figure order');
  assert.deepEqual(disposed,log);assert.equal(result.pageCount,4,'each selected geology map receives one continuation');
  const raw=Buffer.from(await result.blob.arrayBuffer()).toString('latin1'),decoded=decodePdfText(raw);
  assert.equal((raw.match(/\/Type \/Page\b/g)||[]).length,result.pageCount);
  assert.ok(decoded.indexOf('FIGURE D')<decoded.indexOf('LEGEND — CONTINUED'));
  assert.ok(decoded.lastIndexOf('FIGURE D')<decoded.indexOf('FIGURE E'),'D continuation is immediately before the E map');
  assert.ok(decoded.indexOf('FIGURE E')<decoded.lastIndexOf('LEGEND — CONTINUED'));
  assert.equal((decoded.match(/Acme Environmental/g)||[]).length,result.pageCount,'company block is present on every physical page');
  assert.equal((decoded.match(/Ontario Geological Survey official surficial geology/g)||[]).length,2,'Figure D source appears on its map and continuation');
  assert.equal((decoded.match(/Synthetic custom bedrock\.kml/g)||[]).length,2,'Figure E custom source appears on its map and continuation');
  for(let page=1;page<=result.pageCount;page+=1)assert.match(decoded,new RegExp(`Page ${page} of ${result.pageCount}`));
  assert.ok((decoded.match(/LEGEND — CONTINUED/g)||[]).length>=1);
  assert.equal((decoded.replace(/\s+/g,' ').match(/Official Quaternary geology description/g)||[]).length,surficial.features.length,'every complete official description is extractable');
  assert.equal((decoded.replace(/\s+/g,' ').match(/User supplied bedrock description/g)||[]).length,bedrock.features.length,'every complete custom bedrock description is extractable');
  const expectedCodes=[...surficial.features,...bedrock.features].map(unit=>unit.unitCode);
  const actualCodes=decoded.split('\n').filter(line=>/^(?:DUNIT|BR)-\d+$/.test(line));
  assert.deepEqual(actualCodes,expectedCodes,'complete code tokens occur exactly once and in global D-then-E order despite prefix collisions');
  assert.equal(new Set(actualCodes).size,expectedCodes.length);
});
test('real PDF has only A/C/E pages in figure order, A3 media boxes, embedded text, and cleaned maps',async()=>{
  const exportPdf=await engine(),log=[],disposed=[];
  const result=await exportPdf({project:project(),codes:['E','A','C','A'],datasets,compose:compositor(log,disposed)});
  assert.deepEqual(log,['A','C','E']);assert.deepEqual(disposed,log);assert.equal(result.pageCount,3);
  const bytes=Buffer.from(await result.blob.arrayBuffer()),raw=bytes.toString('latin1');
  assert.equal((raw.match(/\/Type \/Page\b/g)||[]).length,3);
  const boxes=[...raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];assert.equal(boxes.length,3);
  for(const [,w,h] of boxes){assert.ok(Math.abs(Number(w)*25.4/72-420)<.01);assert.ok(Math.abs(Number(h)*25.4/72-297)<.01);}
  assert.ok([...raw.matchAll(/([\d.]+) ([\d.]+) Td/g)].every(([,x,y])=>Number(x)>=7*72/25.4&&Number(y)>=7*72/25.4),'all text stays within the 7 mm page margins');
  assert.match(raw,/\/ToUnicode/);assert.match(raw,/\/FontFile2/);
  assert.ok((raw.match(/\/Subtype \/Image/g)||[]).length>=8,'the PDF embeds each map and the reusable company logo');
  assert.ok(!/\/JavaScript|\/Launch|\/URI\b/.test(raw),'user text never becomes executable PDF actions');
  assert.equal(result.filename,'26-123-figures-ACE.pdf');
  // Decode this PDF's uncompressed ToUnicode mapping and text operators (not a fixture PDF).
  const decoded=decodePdfText(raw);
  assert.match(decoded,/FIGURE A/);assert.match(decoded,/FIGURE C/);assert.match(decoded,/FIGURE E/);
  assert.match(decoded,/Page 1 of 3/);assert.match(decoded,/Page 3 of 3/);assert.match(decoded,/Café geological study/);
  assert.match(decoded,/Acme Environmental/);assert.match(decoded,/hello@acme.test/);
  const finalBaseline=Number([...raw.matchAll(/([\d.]+) ([\d.]+) Td/g)].at(-1)[2]);
  assert.ok(finalBaseline>30&&finalBaseline<45,'footer sits wholly inside the map, clear of its bottom frame');
});
test('missing company profile or decoded logo blocks the complete PDF before map composition',async()=>{
  const {exportCombinedPdf}=await import('../src/pdf-export.mjs'),log=[],compose=compositor(log,[]);
  await assert.rejects(exportCombinedPdf({project:project(),codes:['A'],compose}),/company name|company profile/i);
  await assert.rejects(exportCombinedPdf({project:project(),codes:['A'],companyProfile:companyProfile(),companyLogoDataUrl:'',compose}),/logo/i);
  assert.deepEqual(log,[]);
});
test('empty selection, invalid data, text overflow, unsupported glyphs and unsafe DPI fail before map work',async()=>{
  const exportPdf=await engine(),log=[],compose=compositor(log,[]),p=project();
  await assert.rejects(exportPdf({project:p,codes:[],compose}),/select/i);
  await assert.rejects(exportPdf({project:p,codes:['E'],compose}),/Figure E.*geology/i);
  await assert.rejects(exportPdf({project:p,codes:['A'],dpi:600,compose}),/choose 300/i);
  await assert.rejects(exportPdf({project:{...p,name:'Very long project '.repeat(100)},codes:['A'],compose}),/Figure A.*fit|overflow/i);
  await assert.rejects(exportPdf({project:{...p,name:'Unsupported 𠀀'},codes:['A'],compose}),/unsupported.*U\+20000/i);
  const impossible=longSurficialDataset(1);impossible.features[0].unitCode='UNIT-LONG';impossible.features[0].description='x\n'.repeat(6000);
  await assert.rejects(exportPdf({project:p,codes:['D'],datasets:{surficial:impossible},compose}),/Figure D.*Legend entry UNIT-LONG exceeds the supported text length/);
  assert.deepEqual(log,[]);
});
test('sheet C error prevents a result and disposes previously composed image',async()=>{
  const exportPdf=await engine(),disposed=[];let result;
  await assert.rejects(async()=>{result=await exportPdf({project:project(),codes:['A','C'],compose:async args=>{
    if(args.code==='C')throw Error('Toporama is unavailable');return {...await compositor([],disposed)(args)};
  }});},/Figure C.*Toporama/);
  assert.equal(result,undefined,'a failed source cannot yield a Blob result');assert.deepEqual(disposed,['A']);
});
test('cancellation during composition disposes image and never resolves a PDF; snapshot cannot drift',async()=>{
  const exportPdf=await engine(),p=project(),controller=new AbortController(),disposed=[];
  await assert.rejects(exportPdf({project:p,codes:['A'],signal:controller.signal,compose:async args=>{
    p.name='Changed in editor';assert.equal(args.project.name,'Café geological study');controller.abort();return compositor([],disposed)(args);
  }}),{name:'AbortError'});assert.deepEqual(disposed,['A']);
  await assert.rejects(exportPdf({project:p,codes:['A'],signal:controller.signal,compose:()=>{throw Error('must not compose');}}),{name:'AbortError'});
});
test('cancellation during bitmap decoding rejects the complete PDF without retaining the renderer',async t=>{
  const exportPdf=await engine(),controller=new AbortController(),dom=new JSDOM('<!doctype html><body></body>');
  const previous={document:globalThis.document,fetch:globalThis.fetch,createImageBitmap:globalThis.createImageBitmap};
  let canvas,started,release,closed=0;
  const decoding=new Promise(resolve=>{started=resolve;});
  dom.window.HTMLCanvasElement.prototype.getContext=function(){canvas=this;return {fillRect(){}};};
  globalThis.document=dom.window.document;
  globalThis.fetch=async()=>({ok:true,headers:new Headers({'content-type':'image/png'}),blob:async()=>new Blob(['image'])});
  globalThis.createImageBitmap=()=>new Promise(resolve=>{release=()=>resolve({width:1536,height:1286,close(){closed++;}});started();});
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}dom.window.close();});
  const outcome=exportPdf({project:project(),codes:['C'],signal:controller.signal}).then(result=>({result}),error=>({error}));
  await decoding;controller.abort();let timer;
  try{
    const observed=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);
    assert.ok(!observed.pending,'combined export must not wait for an abandoned decoder');assert.equal(observed.error?.name,'AbortError');assert.equal(observed.result,undefined);
    assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(dom.window.document.body.children.length,0);
  }finally{clearTimeout(timer);release();await outcome;}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
});
test('Persian remains an embedded-font PDF and custom bedrock labels retain their supplied meaning',async()=>{
  const result=await (await engine())({project:{...project(),name:'پروژه محیط زیست'},codes:['E'],datasets,compose:compositor([],[])});
  assert.ok(result.blob.size>20000);
  const raw=Buffer.from(await result.blob.arrayBuffer()).toString('latin1');
  const decoded=decodePdfText(raw);
  assert.match(decoded,/Custom bedrock/,'decoded PDF must retain the supplied custom bedrock label');
  assert.ok(decoded.includes('ﺖﺴﯾﺯ ﻂﯿﺤﻣ ﻩﮊﻭﺮﭘ'),'decoded PDF must retain the expected jsPDF-shaped Persian Unicode');
});
test('geology prerequisites check final sheet coverage, SITE holes and closed nondegenerate geometry',async()=>{
  const exportPdf=await engine(),p=project(),compose=compositor([],[]);
  await assert.rejects(exportPdf({project:p,codes:['B'],compose}),/Figure B.*Site Boundary/);
  for(const polygon of [[[-80,43],[-78,43],[-78,45],[-80,45]],[[-80,43],[-79,43],[-78,43],[-80,43]]]){
    await assert.rejects(exportPdf({project:p,codes:['E'],datasets:{bedrock:{...datasets.bedrock,features:[{...feature,polygon}]}},compose}),/Figure E.*invalid polygon/);
  }
  await assert.rejects(exportPdf({project:p,codes:['E'],datasets:{bedrock:{...datasets.bedrock,coverage:{west:-79.31,east:-79.29,south:43.69,north:43.71}}},compose}),/Figure E.*cover.*final sheet/);
  await assert.rejects(exportPdf({project:p,codes:['E'],datasets:{bedrock:{...datasets.bedrock,features:[{...feature,holes:[[[-79.4,43.6],[-79.2,43.6],[-79.2,43.8],[-79.4,43.8],[-79.4,43.6]]]}]}},compose}),/Figure E.*SITE/);
});

const HISTORICAL_SOURCE='https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer',HISTORICAL_COVERAGE={west:-79.5,south:43.5,east:-79.1,north:43.9};
function historicalA3Bounds(){const [x,y]=projectPoint([-79.3,43.7]),halfWidth=12000,halfHeight=halfWidth/(420/297),sw=unprojectPoint([x-halfWidth,y-halfHeight]),ne=unprojectPoint([x+halfWidth,y+halfHeight]);return {west:sw[0],south:sw[1],east:ne[0],north:ne[1]};}
function approvedOfficial(id,sequence,title){return {id,year:1972,sequence,title,mode:'official',providerId:'toronto',
  sourceUrl:HISTORICAL_SOURCE,licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto <archive>',policy:'exportable',resolutionMeters:.2,
  bounds:historicalA3Bounds(),placement:null,assetId:null,
  officialExport:{kind:'arcgis-export',url:`${HISTORICAL_SOURCE}/export`,layer:null,maxWidth:4096,maxHeight:4096,resultId:`toronto:flight-${sequence}`,coverage:{...HISTORICAL_COVERAGE},preview:{kind:'arcgis-map-service',url:HISTORICAL_SOURCE,layer:null,tileTemplate:`${HISTORICAL_SOURCE}/tile/{z}/{y}/{x}`}},
  createdAt:'2026-08-27T12:00:00.000Z',updatedAt:'2026-08-27T12:00:00.000Z'};}
function currentOfficialResult(item){return {id:item.officialExport.resultId,providerId:item.providerId,title:item.title,year:item.year,resolutionMeters:item.resolutionMeters,coverage:{...item.officialExport.coverage},
  preview:{kind:item.officialExport.preview.kind,url:item.officialExport.preview.url,tileTemplate:item.officialExport.preview.tileTemplate},export:{kind:item.officialExport.kind,url:item.officialExport.url,maxWidth:item.officialExport.maxWidth,maxHeight:item.officialExport.maxHeight},
  policy:item.policy,sourceUrl:item.sourceUrl,licenseUrl:item.licenseUrl,attribution:item.attribution};}

test('PDF preflight revalidates the exact saved official result once and passes that immutable result to composition',async()=>{
  const exportPdf=await engine(),p=project(),item=approvedOfficial('74f14168-4de6-4c5f-88f4-87db8ec731c2',1,'Current flight'),calls=[],current=currentOfficialResult(item);p.historical=[item];p.historicalSequenceCounters={'1972':1};
  const result=await exportPdf({project:p,providers:[TORONTO_IMAGERY_PROVIDER],selection:[{kind:'historical',id:item.id}],revalidateOfficial:async args=>{calls.push(args.item.id);return current;},composeHistorical:async args=>{assert.deepEqual(args.currentOfficialResult,current);assert.notEqual(args.currentOfficialResult,current);assert.ok(Object.isFrozen(args.currentOfficialResult));return {dataUrl:png('H'),width:1,height:1,bounds:args.geometry.bounds,dispose(){}};}});
  assert.deepEqual(calls,[item.id]);assert.equal(result.pageCount,1);
});

test('real combined PDF orders A-B-D, geology continuation, then same-year historical sheets with branding and source text',async()=>{
  const exportPdf=await engine(),p=project(),first=approvedOfficial('74f14168-4de6-4c5f-88f4-87db8ec731c2',1,'First 1972 flight'),second=approvedOfficial('9833e469-c7e8-4ef1-84f1-b89c608c2126',2,'Second 1972 flight');
  p.historical=[second,first];p.historicalSequenceCounters={'1972':2};p.siteBoundary=[[-79.4,43.69],[-79.2,43.69],[-79.2,43.71],[-79.4,43.71],[-79.4,43.69]];
  const figures=[],historical=[],disposed=[];
  const result=await exportPdf({project:p,datasets:{surficial:longSurficialDataset()},providers:[TORONTO_IMAGERY_PROVIDER],
    selection:[{kind:'historical',id:second.id},{kind:'figure',code:'D'},{kind:'figure',code:'B'},{kind:'historical',id:first.id},{kind:'figure',code:'A'}],
    compose:compositor(figures,disposed),composeHistorical:async({item,geometry})=>{historical.push(`${item.year}:${item.sequence}`);return {dataUrl:png(String(item.sequence)),width:1,height:1,bounds:geometry.bounds,dispose:()=>disposed.push(`H${item.sequence}`)};}});
  assert.deepEqual(figures,['A','B','D']);assert.deepEqual(historical,['1972:1','1972:2']);assert.deepEqual(disposed,['A','B','D','H1','H2']);assert.equal(result.pageCount,6);
  const raw=Buffer.from(await result.blob.arrayBuffer()).toString('latin1'),decoded=decodePdfText(raw);
  assert.equal((raw.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)||[]).length,6);
  for(const token of ['H-1972-1','H-1972-2','First 1972 flight','Second 1972 flight','Year: 1972','Resolution: 0.2 m','Attribution: City of Toronto <archive>','Licence: https://open.toronto.ca/open-data-licence/','Acme Environmental'])assert.ok(decoded.includes(token),`missing PDF text: ${token}`);
  assert.ok(decoded.indexOf('FIGURE A')<decoded.indexOf('FIGURE B'));assert.ok(decoded.indexOf('FIGURE B')<decoded.indexOf('FIGURE D'));assert.ok(decoded.lastIndexOf('LEGEND — CONTINUED')<decoded.indexOf('H-1972-1'));assert.ok(decoded.indexOf('H-1972-1')<decoded.indexOf('H-1972-2'));
  for(let page=1;page<=6;page++)assert.match(decoded,new RegExp(`Page ${page} of 6`));
});

test('historical export snapshots item metadata and continues with a marked placeholder after failure',async()=>{
  const exportPdf=await engine(),p=project(),first=approvedOfficial('74f14168-4de6-4c5f-88f4-87db8ec731c2',1,'Immutable title'),second=approvedOfficial('9833e469-c7e8-4ef1-84f1-b89c608c2126',2,'Failure title');
  p.historical=[first,second];p.historicalSequenceCounters={'1972':2};const disposed=[],seen=[];let result;
  result=await exportPdf({project:p,providers:[TORONTO_IMAGERY_PROVIDER],selection:[{kind:'figure',code:'A'},{kind:'historical',id:first.id},{kind:'historical',id:second.id}],
    compose:compositor([],disposed),composeHistorical:async({item,geometry})=>{seen.push(item.title);p.historical[0].title='Changed during export';if(item.id===second.id)throw Error('official archive failed');return {dataUrl:png('H'),width:1,height:1,bounds:geometry.bounds,dispose:()=>disposed.push('H1')};}});
  assert.equal(result.pageCount,3);assert.deepEqual(result.warnings,['H-1972-2: official archive failed']);assert.deepEqual(seen,['Immutable title','Failure title']);assert.deepEqual(disposed,['A','H1']);
});

test('historical preflight timeout does not block the complete export',async()=>{
  const exportPdf=await engine(),p=project(),item=approvedOfficial('74f14168-4de6-4c5f-88f4-87db8ec731c2',1,'Timed out flight');
  p.historical=[item];p.historicalSequenceCounters={'1972':1};
  const result=await exportPdf({project:p,providers:[TORONTO_IMAGERY_PROVIDER],selection:[{kind:'historical',id:item.id}],
    revalidateOfficial:async()=>{throw Error('official image request timed out');},
    composeHistorical:async()=>{throw Error('preflight failure must become a placeholder');}});
  assert.equal(result.pageCount,1);
  assert.deepEqual(result.warnings,['H-1972-1: official image request timed out']);
});

test('cancellation during a historical sheet disposes its image and returns no PDF Blob',async()=>{
  const exportPdf=await engine(),p=project(),item=approvedOfficial('74f14168-4de6-4c5f-88f4-87db8ec731c2',1,'Cancelled flight'),controller=new AbortController(),disposed=[];p.historical=[item];p.historicalSequenceCounters={'1972':1};let result;
  await assert.rejects(async()=>{result=await exportPdf({project:p,providers:[TORONTO_IMAGERY_PROVIDER],selection:[{kind:'historical',id:item.id}],signal:controller.signal,
    composeHistorical:async({geometry})=>{controller.abort();return {dataUrl:png('H'),width:1,height:1,bounds:geometry.bounds,dispose:()=>disposed.push('H')};}});},{name:'AbortError'});
  assert.equal(result,undefined);assert.deepEqual(disposed,['H']);
});

test('missing manual historical asset blocks before any map composition',async()=>{
  const exportPdf=await engine(),p=project(),log=[];
  const placement={center:projectPoint([-79.3,43.7]),groundWidth:30000,groundHeight:22000,sourceWidth:2,sourceHeight:2,rotationDegrees:0};
  const item={...approvedOfficial('74f14168-4de6-4c5f-88f4-87db8ec731c2',1,'Manual archive'),mode:'manual',providerId:null,sourceUrl:null,licenseUrl:null,attribution:'Private archive',resolutionMeters:null,placement,assetId:'237589d9-3d5d-4817-9d0a-a5fb2d151286',officialExport:null};
  p.historical=[item];p.historicalSequenceCounters={'1972':1};
  await assert.rejects(exportPdf({project:p,selection:[{kind:'figure',code:'A'},{kind:'historical',id:item.id}],assetStore:{get:async()=>null},compose:compositor(log,[]),composeHistorical:async()=>{throw Error('must not compose');}}),/H-1972-1.*missing.*asset/i);
  assert.deepEqual(log,[],'all required assets are snapshotted before remote composition starts');
});

test('manual historical preflight caps the aggregate resident asset snapshot before any composition',async()=>{
  const exportPdf=await engine(),p=project(),bytes=new Uint8Array(11_000_000),digest=createHash('sha256').update(bytes).digest('hex'),center=projectPoint([-79.3,43.7]),assets=new Map(),log=[];
  p.historical=Array.from({length:3},(_,index)=>{const id=`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,assetId=`10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,item={...approvedOfficial(id,index+1,`Manual ${index+1}`),mode:'manual',providerId:null,sourceUrl:null,licenseUrl:null,attribution:'Archive permission',resolutionMeters:null,placement:{center:[...center],groundWidth:30000,groundHeight:22000,sourceWidth:1,sourceHeight:1,rotationDegrees:0},assetId,officialExport:null};
    const blob=new Blob([bytes],{type:'image/png'});assets.set(assetId,{metadata:{id:assetId,kind:'historical-image',mime:'image/png',size:blob.size,width:1,height:1,sha256:digest,createdAt:'2026-08-27T12:00:00.000Z'},blob});return item;});p.historicalSequenceCounters={'1972':3};
  await assert.rejects(exportPdf({project:p,selection:p.historical.map(item=>({kind:'historical',id:item.id})),assetStore:{get:async id=>assets.get(id)},compose:compositor(log,[]),composeHistorical:async()=>{throw Error('must not compose');}}),/aggregate|resident|32 MB|memory limit/i);
  assert.deepEqual(log,[]);
});
