import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjector} from '../src/projection.mjs';

const REQUIRED_LAYERS=['SITE_MARKER','SITE_BOUNDARY','BUILDING_BOUNDARY','IMAGE_FRAMES','IMAGE_LABELS','TITLE_BLOCK','COMPANY_TEXT','COMPANY_LOGO_FRAME','NOTES'];
const historicalId='74f14168-4de6-4c5f-88f4-87db8ec731c2';

function company(overrides={}){
  return {
    companyName:'Acme Engineering',address:'1 Main Street',phone:'416-555-0100',email:'info@acme.test',website:'https://acme.test',
    preparedBy:'A. Author',reviewedBy:'R. Reviewer',logoAssetId:'logo-1',logoMime:'image/png',logoWidth:320,logoHeight:160,
    logoPlacement:{align:'center',scale:1},...overrides
  };
}

function project(overrides={}){
  return {
    name:'Phase I Environmental Site Assessment',projectNo:'AB-12345',address:'92 Orchard Road',date:'2026-08-28',
    location:{lat:43.65,lng:-79.38},
    siteBoundary:[[-79.385,43.645],[-79.375,43.645],[-79.375,43.655],[-79.385,43.655],[-79.385,43.645]],
    buildingBoundary:[[-79.382,43.648],[-79.378,43.648],[-79.378,43.652],[-79.382,43.652],[-79.382,43.648]],
    figures:{A:{title:'SITE LOCATION MAP'},B:{title:'CURRENT AERIAL / SITE PLAN'},C:{title:'TOPOGRAPHICAL MAP'},D:{title:'SURFICIAL GEOLOGY'},E:{title:'BEDROCK GEOLOGY'}},
    historical:[{id:historicalId,year:1972,sequence:1,title:'Archive flight 1',attribution:'City of Toronto'}],
    ...overrides
  };
}

const figureSelection={kind:'figure',code:'A'};
const historicalSelection={kind:'historical',id:historicalId};
const figureCorners=[[629800,4835200],[630400,4835200],[630400,4834800],[629800,4834800]];
const historicalCorners=[[629950,4835100],[630250,4835100],[630250,4834900],[629950,4834900]];

function imageFrame(selection,corners,overrides={}){
  const key=selection?.kind==='figure'?`figure-${selection.code}`:`historical-${selection?.id}`;
  return {selection,corners,pixelWidth:800,pixelHeight:600,imagePath:`images/${key}.png`,...overrides};
}

function input(overrides={}){
  const p=overrides.project||project(),companyProfile=overrides.companyProfile||company();
  return {
    project:p,companyProfile,
    selection:overrides.selection||[historicalSelection,figureSelection],
    imageFrames:overrides.imageFrames||[
      imageFrame(figureSelection,figureCorners),
      imageFrame(historicalSelection,historicalCorners)
    ],
    projector:overrides.projector||createProjector(p.location),
    companyLogoImage:overrides.companyLogoImage||{path:'company/logo.png',width:companyProfile.logoWidth,height:companyProfile.logoHeight}
  };
}

function pairs(dxf){
  assert.equal(typeof dxf,'string');assert.equal(dxf.endsWith('\n'),true);assert.equal(dxf.includes('\r'),false);
  const lines=dxf.slice(0,-1).split('\n');assert.equal(lines.length%2,0,'DXF has complete group-code pairs');
  return Array.from({length:lines.length/2},(_,index)=>({code:lines[index*2],value:lines[index*2+1]}));
}

function sections(dxf){
  const result=new Map(),source=pairs(dxf);let current=null;
  for(let index=0;index<source.length;index++){
    const pair=source[index];
    if(pair.code==='0'&&pair.value==='SECTION'){
      assert.equal(source[index+1]?.code,'2');current=source[++index].value;assert.equal(result.has(current),false);result.set(current,[]);continue;
    }
    if(pair.code==='0'&&pair.value==='ENDSEC'){current=null;continue;}
    if(current)result.get(current).push(pair);
  }
  return result;
}

function records(source,startValue,endValue){
  const result=[];let current=null;
  for(const pair of source){
    if(pair.code==='0'){
      if(current)result.push(current);
      current=pair.value===endValue?null:{type:pair.value,pairs:[]};
      if(pair.value===startValue||pair.value===endValue)continue;
    }
    if(current)current.pairs.push(pair);
  }
  if(current)result.push(current);return result;
}

function entities(dxf){return records(sections(dxf).get('ENTITIES')||[],'','').filter(record=>!['SECTION','ENDSEC'].includes(record.type));}
function values(entity,code){return entity.pairs.filter(pair=>pair.code===String(code)).map(pair=>pair.value);}
function value(entity,code){return values(entity,code)[0];}
function layer(entity){return value(entity,8);}
function xy(entity){
  const xs=values(entity,10).map(Number),ys=values(entity,20).map(Number);assert.equal(xs.length,ys.length);return xs.map((x,index)=>[x,ys[index]]);
}
function bounds(points){return {west:Math.min(...points.map(p=>p[0])),south:Math.min(...points.map(p=>p[1])),east:Math.max(...points.map(p=>p[0])),north:Math.max(...points.map(p=>p[1]))};}
function textContent(entity){return [...values(entity,3),...values(entity,1)].join('');}
function decodeText(value){return value.replace(/\\U\+([0-9A-F]{4})/g,(_,hex)=>String.fromCharCode(Number.parseInt(hex,16)));}
function selectionKey(item){return item.kind==='figure'?`figure:${item.code}`:`historical:${item.id}`;}
function twiceArea(points){const [originX,originY]=points[0];return points.reduce((sum,point,index)=>{const next=points[(index+1)%points.length];return sum+(point[0]-originX)*(next[1]-originY)-(next[0]-originX)*(point[1]-originY);},0);}

test('buildCadDxf emits a deterministic complete R2007 drawing with metre units, required layers, handles, and sections',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),args=input(),first=buildCadDxf(args);
  const permuted=buildCadDxf({...args,selection:[...args.selection].reverse(),imageFrames:[...args.imageFrames].reverse()});
  assert.equal(first,buildCadDxf(args));assert.equal(first,permuted,'canonical selection order is independent of input array order');
  assert.doesNotMatch(first,/[\u0080-\uFFFF]/);assert.doesNotMatch(first,/NaN|Infinity/);assert.equal(first.endsWith('0\nEOF\n'),true);
  const parsed=sections(first);assert.deepEqual([...parsed.keys()],['HEADER','CLASSES','TABLES','BLOCKS','ENTITIES','OBJECTS']);
  const header=parsed.get('HEADER'),headerValue=name=>header[header.findIndex(pair=>pair.code==='9'&&pair.value===name)+1];
  assert.deepEqual(headerValue('$ACADVER'),{code:'1',value:'AC1021'});assert.deepEqual(headerValue('$DWGCODEPAGE'),{code:'3',value:'ANSI_1252'});
  assert.deepEqual(headerValue('$INSUNITS'),{code:'70',value:'6'});
  const tablePairs=parsed.get('TABLES'),layerStart=tablePairs.findIndex((pair,index)=>pair.code==='0'&&pair.value==='TABLE'&&tablePairs[index+1]?.value==='LAYER');
  const layerEnd=tablePairs.findIndex((pair,index)=>index>layerStart&&pair.code==='0'&&pair.value==='ENDTAB');
  const layerNames=tablePairs.slice(layerStart,layerEnd).filter(pair=>pair.code==='2').map(pair=>pair.value).slice(1);
  assert.deepEqual(layerNames,['0',...REQUIRED_LAYERS]);
  const layerRecords=tablePairs.slice(layerStart,layerEnd).filter(pair=>pair.code==='0'&&pair.value==='LAYER');
  assert.equal(layerRecords.length,REQUIRED_LAYERS.length+1);
  const plotStyleHandles=tablePairs.slice(layerStart,layerEnd).filter(pair=>pair.code==='390').map(pair=>pair.value);
  assert.equal(plotStyleHandles.length,REQUIRED_LAYERS.length+1);assert.equal(new Set(plotStyleHandles).size,1,'every layer references the same named plot style placeholder');
  assert.notEqual(plotStyleHandles[0],'0','plot style must resolve to a real ACDBPLACEHOLDER object, not a null handle');
  const viewportStart=tablePairs.findIndex(pair=>pair.code==='0'&&pair.value==='VPORT'),viewportEnd=tablePairs.findIndex((pair,index)=>index>viewportStart&&pair.code==='0');
  assert.equal(tablePairs.slice(viewportStart,viewportEnd).filter(pair=>pair.code==='70').length,1,'the VPORT symbol record has one flags group');
  const assigned=[];for(const [name,content] of parsed)if(name!=='HEADER')for(const pair of content)if(pair.code==='5')assigned.push(pair.value);
  assert.ok(assigned.length>25);assert.equal(new Set(assigned).size,assigned.length);assert.ok(assigned.every(handle=>/^[1-9A-F][0-9A-F]*$/.test(handle)));
  // Handles are still allocated from one monotonic counter (guaranteeing uniqueness, asserted above), but are no
  // longer required to appear in strictly ascending file order: IMAGE entities in ENTITIES forward-reference
  // IMAGEDEF/IMAGEDEF_REACTOR handles that are only *defined* later, in OBJECTS.
  const owners=[...parsed.values()].flat().filter(pair=>pair.code==='330'&&pair.value!=='0').map(pair=>pair.value);
  assert.ok(owners.every(owner=>assigned.includes(owner)),'every non-root owner reference resolves to an assigned handle');
});

test('projected SITE and boundary entities use closed metre polylines while image frames and labels match selected rasters one-for-one',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),args=input(),dxf=buildCadDxf(args),all=entities(dxf),projector=args.projector;
  const point=all.find(entity=>entity.type==='POINT'&&layer(entity)==='SITE_MARKER');assert.ok(point);
  const sitePoint=[Number(value(point,10)),Number(value(point,20))],expected=projector.forward([args.project.location.lng,args.project.location.lat]);
  assert.ok(Math.hypot(sitePoint[0]-expected[0],sitePoint[1]-expected[1])<1e-5);
  const site=all.find(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='SITE_BOUNDARY');
  const building=all.find(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='BUILDING_BOUNDARY');
  for(const boundary of [site,building]){
    assert.ok(boundary);assert.equal(Number(value(boundary,70))&1,1);assert.equal(Number(value(boundary,90)),4);
    assert.equal(xy(boundary).length,4);assert.ok(xy(boundary).every(([x,y])=>x>100000&&x<900000&&y>4_000_000));
  }
  const frames=all.filter(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='IMAGE_FRAMES');
  assert.equal(frames.length,args.selection.length);assert.ok(frames.every(frame=>Number(value(frame,70))===1&&Number(value(frame,90))===4));
  assert.deepEqual(frames.map(xy),[figureCorners,historicalCorners]);
  const labels=all.filter(entity=>entity.type==='MTEXT'&&layer(entity)==='IMAGE_LABELS');assert.equal(labels.length,args.selection.length);
  assert.deepEqual(labels.map(entity=>decodeText(textContent(entity))),['FIGURE A - SITE LOCATION MAP','H-1972-1 - Archive flight 1']);
  const allCoordinates=all.flatMap(xy);assert.ok(allCoordinates.every(([x,y])=>Math.abs(x)>1000&&Math.abs(y)>1000),'longitude/latitude degree coordinates are absent');
});

test('title and logo frames remain editable and wholly outside the map geometry while notes record the frozen CRS',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),args=input(),dxf=buildCadDxf(args),all=entities(dxf),parsed=sections(dxf);
  const source=all.filter(entity=>['SITE_MARKER','SITE_BOUNDARY','BUILDING_BOUNDARY','IMAGE_FRAMES'].includes(layer(entity))).flatMap(xy),sourceBounds=bounds(source);
  const titleFrames=all.filter(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='TITLE_BLOCK'&&Number(value(entity,70))===1);
  assert.equal(titleFrames.length,1);const titleBounds=bounds(xy(titleFrames[0]));
  assert.ok(titleBounds.west>sourceBounds.east||titleBounds.east<sourceBounds.west||titleBounds.south>sourceBounds.north||titleBounds.north<sourceBounds.south);
  const logo=all.filter(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='COMPANY_LOGO_FRAME');assert.equal(logo.length,1);assert.equal(Number(value(logo[0],70)),1);
  assert.ok(xy(logo[0]).every(([x,y])=>x>=titleBounds.west&&x<=titleBounds.east&&y>=titleBounds.south&&y<=titleBounds.north));
  const titleText=all.filter(entity=>entity.type==='MTEXT'&&layer(entity)==='TITLE_BLOCK').map(textContent).join(' ');
  const companyText=all.filter(entity=>entity.type==='MTEXT'&&layer(entity)==='COMPANY_TEXT').map(textContent).join(' ');
  const notes=all.filter(entity=>entity.type==='MTEXT'&&layer(entity)==='NOTES').map(textContent).join(' ');
  assert.match(titleText,/Phase I Environmental Site Assessment/);assert.match(titleText,/AB-12345/);assert.match(companyText,/Acme Engineering/);
  assert.match(notes,/NAD83 \/ UTM zone 17N/);assert.match(notes,/EPSG:26917/);assert.match(notes,/metres/i);assert.match(notes,/external raster/i);
  assert.doesNotMatch(dxf,/logo-1/,'the internal asset-store ID must never leak into the DXF, only the relative file path');
  const images=all.filter(entity=>entity.type==='IMAGE');assert.equal(images.length,args.imageFrames.length+1,'one IMAGE entity per selected raster plus the company logo');
  const logoImageEntity=images.find(entity=>layer(entity)==='COMPANY_LOGO_FRAME');assert.ok(logoImageEntity);
  const objectPairs=parsed.get('OBJECTS');
  const imageDefs=records(objectPairs,'','').filter(record=>record.type==='IMAGEDEF'),imageDefReactors=records(objectPairs,'','').filter(record=>record.type==='IMAGEDEF_REACTOR');
  assert.equal(imageDefs.length,images.length);assert.equal(imageDefReactors.length,images.length);
  assert.deepEqual(imageDefs.map(entity=>value(entity,1)).sort(),['company/logo.png','images/figure-A.png','images/historical-74f14168-4de6-4c5f-88f4-87db8ec731c2.png'].sort());
  for(const image of images){
    const defHandle=value(image,340),reactorHandle=value(image,360);assert.ok(defHandle);assert.ok(reactorHandle);
    const def=imageDefs.find(entity=>value(entity,5)===defHandle);assert.ok(def,'IMAGE entity 340 resolves to a defined IMAGEDEF');
    const reactor=imageDefReactors.find(entity=>value(entity,5)===reactorHandle);assert.ok(reactor,'IMAGE entity 360 resolves to a defined IMAGEDEF_REACTOR');
    assert.equal(value(reactor,330),value(image,5),'IMAGEDEF_REACTOR owner references this IMAGE entity');
  }
});

test('company logo frame applies left, center, and right alignment plus the full saved scale range inside its title cell',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs');
  const geometry=logoPlacement=>{
    const all=entities(buildCadDxf(input({companyProfile:company({logoPlacement})})));
    const logo=all.find(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='COMPANY_LOGO_FRAME');
    const title=all.find(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='TITLE_BLOCK'&&Number(value(entity,70))===1);
    const companyTextX=Math.min(...all.filter(entity=>entity.type==='MTEXT'&&layer(entity)==='COMPANY_TEXT').map(entity=>Number(value(entity,10))));
    return {vertices:xy(logo),logo:bounds(xy(logo)),title:bounds(xy(title)),companyTextX};
  };
  const aligned=['left','center','right'].map(align=>geometry({align,scale:1}));
  assert.ok(aligned[0].logo.west<aligned[1].logo.west&&aligned[1].logo.west<aligned[2].logo.west);
  const alignedWidths=aligned.map(item=>item.logo.east-item.logo.west);assert.ok(Math.max(...alignedWidths)-Math.min(...alignedWidths)<=2e-6,'alignment preserves width within one coordinate quantum');
  assert.notDeepEqual(aligned[0].vertices,aligned[1].vertices);assert.notDeepEqual(aligned[1].vertices,aligned[2].vertices);
  const scaled=[.5,1,1.5].map(scale=>geometry({align:'center',scale})),widths=scaled.map(item=>item.logo.east-item.logo.west);
  assert.ok(widths[0]<widths[1]&&widths[1]<widths[2]);assert.notDeepEqual(scaled[0].vertices,scaled[2].vertices);
  for(const item of [...aligned,...scaled]){
    assert.ok(item.logo.west>=item.title.west&&item.logo.east<=item.title.east&&item.logo.south>=item.title.south&&item.logo.north<=item.title.north);
    assert.ok(item.logo.east<item.companyTextX,'logo cell remains left of company text');assert.notEqual(twiceArea(item.vertices),0);
  }
});

test('CAD logo placement boundary rejects missing, extra, accessor, unsupported, and out-of-range fields',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs');let reads=0;
  const accessor={align:'left'};Object.defineProperty(accessor,'scale',{enumerable:true,get(){reads++;return 1;}});
  const invalid=[undefined,{align:'left'},{align:'left',scale:1,extra:true},{align:'top',scale:1},{align:'left',scale:.499999},{align:'right',scale:1.500001},accessor];
  for(const logoPlacement of invalid)assert.throws(()=>buildCadDxf(input({companyProfile:company({logoPlacement})})),/logo|placement|align|scale|field|record|range/i);
  assert.equal(reads,0,'DXF validation does not invoke placement accessors');
});

test('all untrusted text is ASCII encoded without group injection, MTEXT formatting injection, or oversized group values',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs');
  const attack='Café مهندسی\n0\nSECTION {\\P} %%d ^M ~ 😀';
  const p=project({name:attack,projectNo:'P\\{42}',address:'Line one\r\nLine two',historical:[{id:historicalId,year:1972,sequence:1,title:attack,attribution:attack}]});
  const dxf=buildCadDxf(input({project:p,companyProfile:company({companyName:attack,address:attack})})),parsed=pairs(dxf),all=entities(dxf);
  assert.doesNotMatch(dxf,/[\u0080-\uFFFF]/);assert.equal([...sections(dxf).keys()].length,6);
  assert.equal(parsed.filter(pair=>pair.code==='0'&&pair.value==='SECTION').length,6);
  assert.match(dxf,/\\U\+00E9/);assert.match(dxf,/\\U\+0645/);assert.match(dxf,/\\U\+D83D\\U\+DE00/);
  assert.match(dxf,/\\U\+007B/);assert.match(dxf,/\\U\+007D/);assert.match(dxf,/\\U\+005C/);assert.match(dxf,/\\U\+0025/);assert.match(dxf,/\\U\+005E/);assert.match(dxf,/\\U\+007E/);
  for(const entity of all.filter(entity=>entity.type==='MTEXT'))for(const pair of entity.pairs.filter(pair=>pair.code==='1'||pair.code==='3')){
    assert.ok(pair.value.length<=240);assert.doesNotMatch(pair.value,/\r|\n/);
  }
});

test('selection and frame validation rejects duplicates, omissions, unknown items, malformed records, and unsafe discriminator text',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),base=input();
  const bad=[
    {...base,selection:[]},{...base,selection:[figureSelection,figureSelection]},
    {...base,selection:[{kind:'figure',code:'Z'}],imageFrames:[imageFrame({kind:'figure',code:'Z'},figureCorners)]},
    {...base,selection:[{kind:'historical',id:'missing'}],imageFrames:[imageFrame({kind:'historical',id:'missing'},figureCorners)]},
    {...base,selection:[{kind:'0\nSECTION',code:'A'}],imageFrames:[imageFrame({kind:'0\nSECTION',code:'A'},figureCorners)]},
    {...base,imageFrames:[base.imageFrames[0]]},{...base,imageFrames:[...base.imageFrames,base.imageFrames[0]]},
    {...base,imageFrames:[imageFrame(figureSelection,figureCorners,{layer:'0\nSECTION'}),base.imageFrames[1]]},
    {...base,imageFrames:[imageFrame(figureSelection,figureCorners),base.imageFrames[0]]}
  ];
  for(const value of bad)assert.throws(()=>buildCadDxf(value),/selection|frame|duplicate|missing|unknown|field|kind|code|record/i);
});

test('unselected legacy imagery does not block a valid selected figure drawing',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),p=project({historical:[{id:'legacy-1',year:1960,name:'legacy.png',size:8,dataUrl:'data:image/png;base64,AAAA'}]});
  const dxf=buildCadDxf(input({project:p,selection:[figureSelection],imageFrames:[imageFrame(figureSelection,figureCorners)]}));
  assert.match(dxf,/FIGURE A - SITE LOCATION MAP/);assert.doesNotMatch(dxf,/legacy-1|legacy\.png/);
});

test('geometry validation rejects malformed boundaries, nonfinite or implausible corners, degenerate frames, CRS mismatch, and drawing overflow',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),base=input(),oneSelection=[figureSelection];
  const cases=[
    input({project:project({siteBoundary:[[-79.38,43.65],[-79.37,43.65],[-79.37,43.66],[-79.38,43.65,0]]})}),
    input({project:project({buildingBoundary:[[-79.38,43.65],[-79.37,43.66],[-79.38,43.66],[-79.37,43.65],[-79.38,43.65]]})}),
    {...base,selection:oneSelection,imageFrames:[imageFrame(figureSelection,[[NaN,4835000],...figureCorners.slice(1)])]},
    {...base,selection:oneSelection,imageFrames:[imageFrame(figureSelection,[[99999,4835000],...figureCorners.slice(1)])]},
    {...base,selection:oneSelection,imageFrames:[imageFrame(figureSelection,[[629800,4835200],[630400,4835200],[630400,4835200],[629800,4835200]])]},
    {...base,selection:oneSelection,imageFrames:[imageFrame(figureSelection,[[100001,4835200],[899999,4835200],[899999,4834800],[100001,4834800]])]},
    input({projector:createProjector({lat:43.65,lng:-87})}),
    {...base,projector:{crs:base.projector.crs,forward(){return [Infinity,Infinity];}}}
  ];
  for(const value of cases)assert.throws(()=>buildCadDxf(value),/boundary|ring|coordinate|frame|finite|UTM|range|degenerate|overflow|CRS|zone|project/i);
});

test('projected boundary polygons are rejected when a finite projector collapses or self-intersects them',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),base=input(),actual=base.projector;
  const constant={crs:actual.crs,forward(){return [630000,4835000];},inverse:point=>actual.inverse(point)};
  const delta=.0000004,tiny={crs:actual.crs,forward([lng,lat]){return [630000+(lng>-79.38?delta:0),4835000+(lat>43.65?delta:0)];},inverse:point=>actual.inverse(point)};
  const crossing=new Map([
    ['-79.385,43.645',[630000,4835000]],['-79.375,43.645',[630010,4835010]],
    ['-79.375,43.655',[630000,4835010]],['-79.385,43.655',[630010,4835000]]
  ]),selfIntersecting={crs:actual.crs,forward(point){return crossing.get(point.join(','))||actual.forward(point);},inverse:point=>actual.inverse(point)};
  for(const projector of [constant,tiny,selfIntersecting])assert.throws(()=>buildCadDxf({...base,projector}),/boundary|polyline|polygon|degenerate|collapse|area|intersect|geometry/i);
});

test('image and computed logo frames that collapse at DXF numeric precision fail before serialization',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),base=input(),delta=.0000004,oneSelection=[figureSelection];
  const subPrecision=[[630000,4835000],[630000+delta,4835000],[630000+delta,4835000+delta],[630000,4835000+delta]];
  assert.throws(()=>buildCadDxf({...base,selection:oneSelection,imageFrames:[imageFrame(figureSelection,subPrecision)]}),/frame|polyline|polygon|degenerate|collapse|area|precision|geometry/i);
  assert.throws(()=>buildCadDxf(input({companyProfile:company({logoWidth:Number.MAX_SAFE_INTEGER,logoHeight:1})})),/logo|frame|polyline|polygon|degenerate|collapse|area|geometry/i);
});

test('tiny projected polygons remain valid when all vertices survive canonical DXF precision',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),base=input(),delta=.00002,oneSelection=[figureSelection];
  const tinyFrame=[[630000,4835000],[630000+delta,4835000],[630000+delta,4835000+delta],[630000,4835000+delta]];
  const dxf=buildCadDxf({...base,selection:oneSelection,imageFrames:[imageFrame(figureSelection,tinyFrame)]}),all=entities(dxf);
  const frame=all.find(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='IMAGE_FRAMES'),vertices=xy(frame);
  assert.equal(new Set(vertices.map(point=>point.join(','))).size,4);assert.notEqual(twiceArea(vertices),0);
  for(const polygon of all.filter(entity=>entity.type==='LWPOLYLINE'&&Number(value(entity,70))===1)){
    const points=xy(polygon);assert.equal(new Set(points.map(point=>point.join(','))).size,points.length,layer(polygon));assert.notEqual(twiceArea(points),0,layer(polygon));
  }
});

test('valid rotated affine image frames remain affine after canonical DXF serialization',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),base=input(),oneSelection=[figureSelection];
  const upperLeft=[630000.123456789,4835000.123456789],upperRight=[630123.580245912,4835012.469135701],lowerLeft=[629994.444544444,4834901.358024666];
  const lowerRight=[upperRight[0]+lowerLeft[0]-upperLeft[0],upperRight[1]+lowerLeft[1]-upperLeft[1]];
  const dxf=buildCadDxf({...base,selection:oneSelection,imageFrames:[imageFrame(figureSelection,[upperLeft,upperRight,lowerRight,lowerLeft])]}),all=entities(dxf);
  const frame=all.find(entity=>entity.type==='LWPOLYLINE'&&layer(entity)==='IMAGE_FRAMES'),vertices=xy(frame);
  assert.equal(new Set(vertices.map(point=>point.join(','))).size,4);assert.notEqual(twiceArea(vertices),0);
  assert.deepEqual(vertices[2],[vertices[1][0]+vertices[3][0]-vertices[0][0],vertices[1][1]+vertices[3][1]-vertices[0][1]].map(number=>Number(number.toPrecision(12))));
});

test('bounded text fields reject non-string and excessive values before DXF layout',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs');
  for(const value of [
    input({project:project({name:{toString:()=> 'unsafe'}})}),input({project:project({name:'x'.repeat(181)})}),
    input({project:project({projectNo:'x'.repeat(81)})}),input({companyProfile:company({companyName:'x'.repeat(161)})}),
    input({companyProfile:company({address:'a'.repeat(150),phone:'p'.repeat(150),email:'e'.repeat(150),website:'w'.repeat(150)})}),
    input({project:project({projectNo:'p'.repeat(75),address:'a'.repeat(160),date:'d'.repeat(75)})}),
    input({project:project({historical:[{id:historicalId,year:1972,sequence:1,title:'x'.repeat(241),attribution:'City'}]})})
  ])assert.throws(()=>buildCadDxf(value),/text|title|project|company|long|fit|bounded/i);
});

test('frame identities use the same exact selected records and do not mutate caller input',async()=>{
  const {buildCadDxf}=await import('../src/cad-dxf.mjs'),args=input(),snapshot=structuredClone({project:args.project,companyProfile:args.companyProfile,selection:args.selection,imageFrames:args.imageFrames});
  buildCadDxf(args);assert.deepEqual({project:args.project,companyProfile:args.companyProfile,selection:args.selection,imageFrames:args.imageFrames},snapshot);
  assert.deepEqual(args.imageFrames.map(frame=>selectionKey(frame.selection)).sort(),args.selection.map(selectionKey).sort());
});
