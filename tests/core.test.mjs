import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as core from '../src/core.mjs';
import { createProject, closeRing, pointInPolygon, figureDefaults, buildDxf, extractNetworkLinks, normalizeMrd128Unit, getMrd128Legend, kmlColorToCss } from '../src/core.mjs';
import {emptyCompanyProfile,snapshotCompanyProfile} from '../src/company-profile.mjs';

const mrd128 = fs.readFileSync(new URL('../data/mrd128.kml', import.meta.url), 'utf8');
const HISTORICAL_BOUNDS={west:-79.39796630568237,south:43.640806527158304,east:-79.3620336943176,north:43.65919206583274};
const HISTORICAL_SOURCE='https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer';
const CURRENT_OFFICIAL_EXPORT={kind:'arcgis-export',url:`${HISTORICAL_SOURCE}/export`,layer:null,maxWidth:4096,maxHeight:4096,
  resultId:'toronto:cot-historic-aerial-1972',coverage:{west:-79.5,south:43.5,east:-79.2,north:43.8},
  preview:{kind:'arcgis-map-service',url:HISTORICAL_SOURCE,layer:null,tileTemplate:`${HISTORICAL_SOURCE}/tile/{z}/{y}/{x}`}};

function dxfPairs(dxf){
  const lines=dxf.trimEnd().split('\n');assert.equal(lines.length%2,0);
  return Array.from({length:lines.length/2},(_,index)=>({code:lines[index*2],value:lines[index*2+1]}));
}

function dxfTextEntities(dxf){
  const entities=[];let entity=null;
  for(const pair of dxfPairs(dxf)){
    if(pair.code==='0'){
      if(entity)entities.push(entity);
      entity=pair.value==='TEXT'?{}:null;continue;
    }
    if(!entity)continue;
    if(pair.code==='8')entity.layer=pair.value;
    if(pair.code==='10')entity.x=Number(pair.value);
    if(pair.code==='20')entity.y=Number(pair.value);
    if(pair.code==='40')entity.height=Number(pair.value);
    if(pair.code==='1')entity.value=pair.value;
  }
  return entities;
}

function decodeDxfText(value){return value.replace(/\\U\+([0-9A-F]{4})/g,(_,hex)=>String.fromCharCode(Number.parseInt(hex,16)));}

test('createProject creates the five core figures with expected extents', () => {
  const p = createProject({ name: 'Test', address: '92 Orchard Road' });
  assert.equal(p.name, 'Test');
  assert.equal(p.address, '92 Orchard Road');
  assert.deepEqual(Object.keys(p.figures), ['A','B','C','D','E']);
  assert.equal(p.figures.A.extentMeters, 500);
  assert.equal(p.figures.B.extentMeters, 100);
  assert.equal(p.figures.D.extentMeters, 2000);
  assert.equal(p.figures.E.extentMeters, 20000);
});

test('new project keeps project number blank and restores a profile snapshot',()=>{
  const p=createProject();
  assert.equal(p.projectNo,'');
  const validProfile={...emptyCompanyProfile(),companyName:'ABC Engineering',address:'1 Main St',
    phone:'416-555-0100',email:'maps@example.com',website:'https://example.com',
    logoAssetId:'logo-1',logoMime:'image/png',logoWidth:400,logoHeight:160};
  p.companyProfileSnapshot=snapshotCompanyProfile(validProfile);
  const restored=core.restoreProject(p);
  assert.equal(restored.companyProfileSnapshot.companyName,'ABC Engineering');
  assert.equal(restored.schemaVersion,6);
});

test('restoreProject gives legacy projects no profile snapshot and rejects invalid snapshots',()=>{
  const legacy=createProject();
  assert.equal(core.restoreProject(legacy).companyProfileSnapshot,null);
  legacy.companyProfileSnapshot={companyName:'Unsafe'};
  assert.throws(()=>core.restoreProject(legacy),/company profile snapshot/i);
});

test('restoreProject validates approved historical items and preserves duplicate-year stable sequences',()=>{
  const project=createProject();
  const stamp='2026-08-27T12:00:00.000Z';
  const item=(id,sequence)=>({
    id,year:1972,sequence,title:`Flight ${sequence}`,mode:'official',providerId:'toronto',
    sourceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer',
    licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy:'exportable',
    resolutionMeters:null,bounds:{...HISTORICAL_BOUNDS},placement:null,assetId:null,
    officialExport:structuredClone(CURRENT_OFFICIAL_EXPORT),
    createdAt:stamp,updatedAt:stamp
  });
  project.location={lat:43.65,lng:-79.38};
  project.historical=[item('74f14168-4de6-4c5f-88f4-87db8ec731c2',2),item('9833e469-c7e8-4ef1-84f1-b89c608c2126',1)];
  project.historicalSequenceCounters={'1972':2};

  const restored=core.restoreProject(project);
  assert.deepEqual(restored.historical.map(value=>[value.id,value.sequence]),[
    ['74f14168-4de6-4c5f-88f4-87db8ec731c2',2],['9833e469-c7e8-4ef1-84f1-b89c608c2126',1]
  ]);
  assert.equal(restored.schemaVersion,6);
  assert.equal(restored.historicalSequenceCounters['1972'],2);

  project.historical.push(item('3caa1022-b2e7-4c63-8ca8-12f4845e1be1',2));
  assert.throws(()=>core.restoreProject(project),/sequence|duplicate/i);
});

test('restoreProject leaves legacy data URLs intact for the explicit asynchronous startup migration',()=>{
  const project=createProject();
  const legacy={id:'legacy-1',year:1960,name:'flight.png',size:8,dataUrl:'data:image/png;base64,iVBORw0KGgo='};
  project.historical=[legacy];
  const restored=core.restoreProject(project);
  assert.deepEqual(restored.historical,[legacy]);
  assert.notEqual(restored.historical[0],legacy);
});

test('restoreProject rejects malformed historical IDs, URLs, bounds, policy, placement and extra fields',()=>{
  const project=createProject();project.location={lat:43.65,lng:-79.38};
  const stamp='2026-08-27T12:00:00.000Z';
  const base={id:'74f14168-4de6-4c5f-88f4-87db8ec731c2',year:1972,sequence:1,title:'Flight',mode:'official',providerId:'toronto',
    sourceUrl:'https://gis.toronto.ca/source',licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy:'exportable',resolutionMeters:null,
    bounds:{...HISTORICAL_BOUNDS},placement:null,assetId:null,
    officialExport:structuredClone(CURRENT_OFFICIAL_EXPORT),createdAt:stamp,updatedAt:stamp};
  for(const mutate of [
    value=>({...value,id:'not-a-uuid'}),value=>({...value,sourceUrl:'javascript:alert(1)'}),
    value=>({...value,sourceUrl:'https://gis.toronto.ca/%252e%252e/private'}),
    value=>({...value,policy:'unknown'}),value=>({...value,bounds:{...value.bounds,north:43.64}}),value=>({...value,bounds:{north:43.66,south:43.64,east:-79.37,west:-79.39}}),
    value=>({...value,officialExport:{...value.officialExport,resultId:'toronto:../../wrong'}}),value=>({...value,officialExport:{...value.officialExport,coverage:{...value.officialExport.coverage,east:-79.6}}}),
    value=>({...value,placement:{center:[0,0]}}),value=>({...value,unexpected:true})
  ]){
    project.historical=[mutate(base)];
    assert.throws(()=>core.restoreProject(project),/historical|item|field|URL|bounds|policy|placement|UUID/i);
  }
  let reads=0;const counters={};Object.defineProperty(counters,'1972',{enumerable:true,get(){reads++;return 1;}});project.historical=[base];project.historicalSequenceCounters=counters;
  assert.throws(()=>core.restoreProject(project),/counter|data field|accessor/i);assert.equal(reads,0);
});

test('restoreProject keeps legacy official approvals but marks their missing identity snapshot explicitly',()=>{
  const project=createProject();project.location={lat:43.65,lng:-79.38};const stamp='2026-08-27T12:00:00.000Z';
  project.historical=[{id:'74f14168-4de6-4c5f-88f4-87db8ec731c2',year:1972,sequence:1,title:'Legacy flight',mode:'official',providerId:'toronto',sourceUrl:HISTORICAL_SOURCE,
    licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy:'exportable',resolutionMeters:null,bounds:{...HISTORICAL_BOUNDS},placement:null,assetId:null,
    officialExport:{kind:'arcgis-export',url:`${HISTORICAL_SOURCE}/export`,layer:null,maxWidth:4096,maxHeight:4096},createdAt:stamp,updatedAt:stamp}];
  const restored=core.restoreProject(project),descriptor={kind:'arcgis-export',url:`${HISTORICAL_SOURCE}/export`,layer:null,maxWidth:4096,maxHeight:4096,resultId:null,coverage:null,preview:null};assert.equal(restored.schemaVersion,6);assert.deepEqual(restored.historical[0].officialExport,descriptor);
  assert.deepEqual(core.restoreProject(structuredClone(restored)).historical[0].officialExport,descriptor,'the explicit legacy marker survives save and reload without becoming trusted');
});

test('closeRing appends the first point only when needed', () => {
  assert.deepEqual(closeRing([[1,2],[3,4]]), [[1,2],[3,4],[1,2]]);
  assert.deepEqual(closeRing([[1,2],[3,4],[1,2]]), [[1,2],[3,4],[1,2]]);
});

test('pointInPolygon detects points inside and outside a polygon', () => {
  const square = [[0,0],[10,0],[10,10],[0,10],[0,0]];
  assert.equal(pointInPolygon([5,5], square), true);
  assert.equal(pointInPolygon([15,5], square), false);
});

test('figureDefaults returns stable labels and extents', () => {
  const f = figureDefaults();
  assert.equal(f.B.title, 'CURRENT AERIAL / SITE PLAN');
  assert.equal(f.C.title, 'TOPOGRAPHICAL MAP');
  assert.equal(f.E.title, 'BEDROCK GEOLOGY');
});

test('buildDxf includes company/title text on separate layers without raster logo vectors', () => {
  const companyProfile={...emptyCompanyProfile(),companyName:'Acme Engineering',address:'1 Main Street',phone:'555-0100',email:'info@acme.test',website:'https://acme.test',
    logoAssetId:'logo-1',logoMime:'image/png',logoWidth:320,logoHeight:160};
  const dxf = buildDxf({name:'Phase I Study',projectNo:'AB-12345',siteBoundary: [[-79,43],[-79.1,43],[-79.1,43.1]], buildingBoundary: [] },{companyProfile});
  assert.match(dxf, /SITE_BOUNDARY/);
  assert.match(dxf, /LWPOLYLINE/);
  assert.match(dxf, /10\n-79/);
  assert.match(dxf,/9\n\$ACADVER\n1\nAC1021/);
  assert.match(dxf,/9\n\$DWGCODEPAGE\n3\nANSI_1252/);
  assert.match(dxf,/8\nCOMPANY_TEXT\n[^]*1\nAcme Engineering/);
  assert.match(dxf,/8\nTITLE_BLOCK\n[^]*1\nPhase I Study/);
  assert.doesNotMatch(dxf,/IMAGE|logo-1|PNG/i);
});

test('buildDxf keeps title text positions and heights proportional to geographic drawing bounds',()=>{
  const companyProfile={...emptyCompanyProfile(),companyName:'Acme Engineering',address:'1 Main Street',phone:'555-0100',email:'info@acme.test',website:'https://acme.test',
    logoAssetId:'logo-1',logoMime:'image/png',logoWidth:320,logoHeight:160};
  const siteBoundary=[[-79.3,43.7],[-79.299,43.7],[-79.299,43.7006],[-79.3,43.7006]];
  const dxf=buildDxf({name:'Phase I Study',projectNo:'AB-12345',siteBoundary},{companyProfile});
  const text=dxfTextEntities(dxf),span=.001,minX=-79.3,maxX=-79.299,minY=43.7,maxY=43.7006;
  assert.ok(text.length>=4);
  for(const entity of text){
    assert.ok(entity.x>=minX-span&&entity.x<=maxX+span,`${entity.layer} x ${entity.x}`);
    assert.ok(entity.y>=minY-span&&entity.y<=maxY+span,`${entity.layer} y ${entity.y}`);
    assert.ok(entity.height>=span*.001&&entity.height<=span*.1,`${entity.layer} height ${entity.height}`);
    const estimatedRight=entity.x+entity.height*[...decodeDxfText(entity.value)].length*.65;
    assert.ok(estimatedRight<=maxX+span*2,`${entity.layer} estimated right ${estimatedRight}`);
  }
});

test('buildDxf round-trips non-ASCII text through safe Unicode escapes without group injection',()=>{
  const companyProfile={...emptyCompanyProfile(),companyName:'Café مهندسی\n0\nSECTION',address:'Line\\Office\u0000\nSecond',phone:'555-0100',email:'info@acme.test',website:'https://acme.test',
    logoAssetId:'logo-1',logoMime:'image/png',logoWidth:320,logoHeight:160};
  const dxf=buildDxf({name:'پروژه Café\n0\nSECTION 😀',projectNo:'AB-12345',siteBoundary:[[0,0],[.001,0],[.001,.001]]},{companyProfile});
  assert.doesNotMatch(dxf,/[^\x00-\x7f]/);
  assert.match(dxf,/\\U\+00E9/);assert.match(dxf,/\\U\+0645/);assert.match(dxf,/\\U\+005C/);
  assert.match(dxf,/\\U\+D83D\\U\+DE00/);
  const pairs=dxfPairs(dxf),decoded=dxfTextEntities(dxf).map(entity=>decodeDxfText(entity.value)).join('');
  assert.equal(pairs.filter(pair=>pair.code==='0'&&pair.value==='SECTION').length,2);
  assert.match(decoded,/Café مهندسی 0 SECTION/);assert.match(decoded,/Line\\Office Second/);
  assert.match(decoded,/پروژه Café 0 SECTION 😀/);
  assert.ok(dxfTextEntities(dxf).every(entity=>entity.value.length<=240));
});

test('buildDxf rejects missing company branding and overflowing title text',()=>{
  assert.throws(()=>buildDxf({name:'Study'}),/company name|company profile/i);
  const companyProfile={...emptyCompanyProfile(),companyName:'Acme',address:'1 Main',phone:'555',email:'a@b.test',website:'https://a.test',logoAssetId:'logo',logoMime:'image/png',logoWidth:1,logoHeight:1};
  assert.throws(()=>buildDxf({name:'x'.repeat(300)}, {companyProfile}),/title.*fit|too long|overflow/i);
});

test('extractNetworkLinks finds MRD128 official polygon and raster links', () => {
  const links = extractNetworkLinks(mrd128);
  const polygon = links.find(x => x.name === 'Surficial Geology');
  const raster = links.find(x => x.name === 'Surficial Geology Raster');
  assert.ok(polygon);
  assert.match(polygon.href, /mrd128\/polygons\/doc\.kml$/i);
  assert.ok(raster);
  assert.match(raster.href, /SurficialGeology\/doc\.kmz$/i);
});

test('normalizeMrd128Unit extracts canonical subunit codes', () => {
  assert.equal(normalizeMrd128Unit('8A'), '8a');
  assert.equal(normalizeMrd128Unit('Unit 9C - foreshore'), '9c');
  assert.equal(normalizeMrd128Unit('5b Stone-poor till'), '5b');
  assert.equal(normalizeMrd128Unit('21'), '21');
});

test('MRD128 legend resolves official descriptions from supplied legend', () => {
  assert.equal(getMrd128Legend('9c').title, 'Coarse-textured glaciolacustrine deposits');
  assert.equal(getMrd128Legend('9c').detail, 'Foreshore and basinal deposits');
  assert.match(getMrd128Legend('5b').detail, /Stone-poor, sandy silt to silty sand-textured till/i);
  assert.match(getMrd128Legend('8a').detail, /Massive to well laminated/i);
});

test('KML AABBGGRR colors convert to CSS RGB and opacity', () => {
  assert.deepEqual(kmlColorToCss('7f00ff00'), { color:'#00ff00', opacity:127/255 });
  assert.deepEqual(kmlColorToCss('ff112233'), { color:'#332211', opacity:1 });
});

test('pointInPolygon excludes holes and consistently includes outer edges', () => {
  const outer = [[0,0],[10,0],[10,10],[0,10],[0,0]];
  const hole = [[3,3],[7,3],[7,7],[3,7],[3,3]];
  assert.equal(pointInPolygon([5,5], outer, [hole]), false);
  assert.equal(pointInPolygon([2,2], outer, [hole]), true);
  assert.equal(pointInPolygon([10,5], outer), true);
  assert.equal(pointInPolygon([3,5], outer, [hole]), false);
});

test('official unit presentation uses supplied PDF colors and retains parent material', () => {
  assert.equal(getMrd128Legend('18').color, '#811d8f');
  assert.equal(getMrd128Legend('5e').color, '#219b45');
  assert.equal(getMrd128Legend('9c').color, '#f4ea18');
  assert.equal(getMrd128Legend('9c').material, 'Sand, gravel, minor silt and clay');
  assert.equal(getMrd128Legend('9c').detail, 'Foreshore and basinal deposits');
  assert.equal(getMrd128Legend('5').detail, 'Silty sand to sand-textured till on Precambrian terrain');
});

test('figureBounds computes a 100 metre span without requiring an attached Leaflet layer', () => {
  const b=core.figureBounds({lat:0,lng:0},100);
  assert.ok(Math.abs(b.north-0.00044966)<0.00000001);
  assert.ok(Math.abs(b.south+0.00044966)<0.00000001);
  assert.ok(Math.abs(b.east-0.00044966)<0.00000001);
  assert.throws(()=>core.figureBounds({lat:null,lng:0},100));
});

test('legacy Figure B defaults migrate without losing project or custom extents', () => {
  const p=createProject({name:'Kept'}); p.figures.B.extentMeters=250;
  assert.equal(core.restoreProject(p).figures.B.extentMeters,100);
  assert.equal(core.restoreProject(p).name,'Kept');
  p.figures.B.extentMeters=150;
  assert.equal(core.restoreProject(p).figures.B.extentMeters,150);
  p.figures.B.bounds={north:43.1,south:42.9,east:-78.9,west:-79.1};p.location={lat:43,lng:-79};
  assert.deepEqual(core.restoreProject(p).figures.B.bounds,p.figures.B.bounds);
  p.figures.B.bounds={north:42,south:43,east:-79.1,west:-78.9};
  assert.throws(()=>core.restoreProject(p),/figure view/i);
  assert.throws(()=>core.restoreProject({name:'invalid'}));
});

test('export preferences restore only known figure codes and sources without rewriting project numbers',()=>{
  const p=createProject({projectNo:'FE 26-15876'});
  assert.deepEqual(p.exportPreferences.codes,[]);
  p.exportPreferences={codes:['E','C','A','A','Z'],sources:{A:'unknown',C:'toporama',E:'osm'}};
  p.geology.bedrock={source:{id:'MRD126-REV1',name:'Official'},siteUnit:'55b'};
  const restored=core.restoreProject(JSON.parse(JSON.stringify(p)));
  assert.equal(restored.projectNo,'FE 26-15876');
  assert.deepEqual(restored.exportPreferences.codes,['A','C','E']);
  assert.deepEqual(restored.exportPreferences.sources,{A:'osm',B:'esri-imagery',C:'toporama',D:'osm',E:'osm'});
  assert.equal(restored.geology.bedrock.source.id,'MRD126-REV1');
  delete p.exportPreferences;assert.deepEqual(core.restoreProject(p).exportPreferences.codes,[]);
  p.geology.bedrock={name:'My supplied geology.kmz',count:3,siteUnit:'Custom 55b'};
  assert.equal(core.restoreProject(p).geology.bedrock.source.id,'custom');
  assert.equal(core.restoreProject(p).geology.bedrock.name,'My supplied geology.kmz');
});

test('typed PDF selection restores valid historical IDs while retaining the legacy figure codes adapter',()=>{
  const first='74f14168-4de6-4c5f-88f4-87db8ec731c2',second='9833e469-c7e8-4ef1-84f1-b89c608c2126',stamp='2026-08-27T12:00:00.000Z';
  const item=(id,sequence)=>({id,year:1972,sequence,title:`Flight ${sequence}`,mode:'official',providerId:'toronto',
    sourceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer',licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy:'exportable',resolutionMeters:null,
    bounds:{...HISTORICAL_BOUNDS},placement:null,assetId:null,
    officialExport:structuredClone(CURRENT_OFFICIAL_EXPORT),createdAt:stamp,updatedAt:stamp});
  const p=createProject();p.location={lat:43.65,lng:-79.38};p.historical=[item(first,1),item(second,2)];p.historicalSequenceCounters={'1972':2};
  p.exportPreferences={...p.exportPreferences,codes:['C','A'],selection:[{kind:'historical',id:second},{kind:'figure',code:'C'},{kind:'historical',id:first},{kind:'figure',code:'C'},{kind:'historical',id:'3caa1022-b2e7-4c63-8ca8-12f4845e1be1'}]};
  const restored=core.restoreProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(restored.exportPreferences.codes,['A','C']);
  assert.deepEqual(restored.exportPreferences.selection,[{kind:'figure',code:'C'},{kind:'historical',id:first},{kind:'historical',id:second}]);
  delete p.exportPreferences.selection;
  assert.deepEqual(core.restoreProject(JSON.parse(JSON.stringify(p))).exportPreferences.selection,[{kind:'figure',code:'A'},{kind:'figure',code:'C'}]);
});
