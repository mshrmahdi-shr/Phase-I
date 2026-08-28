import test from 'node:test';
import assert from 'node:assert/strict';

const manifestModule=()=>import('../src/cad-manifest.mjs');
const HASHES=Object.freeze({a:'a'.repeat(64),b:'b'.repeat(64),c:'c'.repeat(64),d:'d'.repeat(64),e:'e'.repeat(64),f:'f'.repeat(64),g:'1'.repeat(64),h:'2'.repeat(64),zero:'0'.repeat(64)});

function project(overrides={}){
  return {name:'Phase I Environmental Site Assessment',projectNo:'AB-12345',address:'92 Orchard Road',date:'2026-08-28',...overrides};
}

function company(overrides={}){
  return {
    companyName:'Acme Environmental',address:'1 Main Street',phone:'416-555-0100',email:'info@acme.test',website:'https://acme.test',
    preparedBy:'A. Author',reviewedBy:'R. Reviewer',logoMime:'image/png',logoWidth:320,logoHeight:160,...overrides
  };
}

const crs=Object.freeze({zone:17,epsg:'EPSG:26917',name:'NAD83 / UTM zone 17N',units:'m'});
const figureProjected=[[630000,4831000],[630240,4831000],[630240,4830840],[630000,4830840]];
const tiffProjected=[[632000,4831000],[632080,4831060],[632110,4831020],[632030,4830960]];
const historicalProjected=[[631000,4830000],[631000,4830400],[631200,4830400],[631200,4830000]];
const logoProjected=[[629900,4830800],[629916,4830800],[629916,4830792],[629900,4830792]];

function file(path,sha256,mime,bytes,pixelWidth=null,pixelHeight=null,worldFilePath=null){
  return {path,sha256,mime,bytes,pixelWidth,pixelHeight,worldFilePath};
}

function item(overrides={}){
  return {
    code:'A',year:2025,provider:'Natural Resources Canada',sourceResolutionMeters:0.1,
    geographicCorners:[[-79.4,43.7],[-79.397,43.7],[-79.397,43.698],[-79.4,43.698]],
    projectedCorners:figureProjected,attribution:'Contains information licensed under the Open Government Licence - Canada',
    license:'Open Government Licence - Canada',redistributionEvidence:'official-provider-exportable-policy',
    imagePath:'images/Figure-A.png',rotation:0,...overrides
  };
}

function input(overrides={}){
  return structuredClone({
    project:project(),companyProfile:company(),crs,
    rasterNormalization:'physical-resolution-stripped',
    files:[
      file('Project.dxf',HASHES.a,'application/dxf',8192),
      file('images/Figure-A.png',HASHES.b,'image/png',120000,2400,1600,'images/Figure-A.pgw'),
      file('images/Figure-A.pgw',HASHES.c,'text/plain',96),
      file('images/H-1960-1.jpg',HASHES.d,'image/jpeg',80000,2000,1000,'images/H-1960-1.jgw'),
      file('images/H-1960-1.jgw',HASHES.e,'text/plain',96),
      file('images/Figure-B.tif',HASHES.g,'image/tiff',160000,1000,500,'images/Figure-B.tfw'),
      file('images/Figure-B.tfw',HASHES.h,'text/plain',96),
      file('company/logo.png',HASHES.f,'image/png',4000,320,160,null)
    ],
    items:[
      item(),
      item({code:'B',year:2024,provider:'Ontario imagery programme',sourceResolutionMeters:0.1,
        geographicCorners:[[-79.38,43.7],[-79.379,43.701],[-79.378,43.7005],[-79.379,43.6995]],
        projectedCorners:tiffProjected,attribution:'Ontario imagery programme',license:'Open Government Licence - Ontario',
        redistributionEvidence:'official-provider-exportable-policy',imagePath:'images/Figure-B.tif',rotation:36.8698976458}),
      item({code:'H-1960-1',year:1960,provider:'City of Toronto Archives',sourceResolutionMeters:0.2,
        geographicCorners:[[-79.39,43.69],[-79.39,43.693],[-79.387,43.693],[-79.387,43.69]],
        projectedCorners:historicalProjected,attribution:'City of Toronto Archives, Series 12',license:'Reproduction permission on file',
        redistributionEvidence:'manual-permission-confirmed',imagePath:'images/H-1960-1.jpg',rotation:90})
    ],
    logoAttachment:{projectedCorners:logoProjected,rotation:0},
    ...overrides
  });
}

function clone(value){return structuredClone(value);}
function csvRows(text){
  const rows=[];let row=[],field='',quoted=false;
  for(let index=0;index<text.length;index++){
    const character=text[index];
    if(quoted){
      if(character==='"'&&text[index+1]==='"'){field+='"';index++;}
      else if(character==='"')quoted=false;
      else field+=character;
    }else if(character==='"')quoted=true;
    else if(character===','){row.push(field);field='';}
    else if(character==='\r'&&text[index+1]==='\n'){row.push(field);rows.push(row);row=[];field='';index++;}
    else field+=character;
  }
  assert.equal(quoted,false,'CSV ends outside a quoted field');assert.deepEqual(row,[]);assert.equal(field,'');return rows;
}

test('builds deterministic canonical JSON with complete CRS, file, company, source, licence, and corner metadata',async()=>{
  const {buildCadManifest}=await manifestModule(),source=input(),permuted=clone(source);permuted.files.reverse();permuted.items.reverse();
  const first=buildCadManifest(source),second=buildCadManifest(permuted);
  assert.deepEqual(first,second);assert.deepEqual(Object.keys(first),['json','csv','sourcesText','readmeText','attachScript']);
  assert.equal(first.json.endsWith('\n'),true);assert.equal(first.json.includes('\r'),false);
  const manifest=JSON.parse(first.json);
  assert.deepEqual(manifest.crs,crs);assert.equal(manifest.schemaVersion,1);assert.equal(manifest.format,'phase-i-cad-manifest');
  assert.deepEqual(manifest.files.map(entry=>entry.path),['Project.dxf','company/logo.png','images/Figure-A.pgw','images/Figure-A.png','images/Figure-B.tfw','images/Figure-B.tif','images/H-1960-1.jgw','images/H-1960-1.jpg']);
  assert.deepEqual(manifest.items.map(entry=>entry.code),['A','B','H-1960-1']);
  assert.equal(manifest.files.find(entry=>entry.path==='images/Figure-A.png').sha256,HASHES.b);
  assert.equal(manifest.items[0].worldFilePath,'images/Figure-A.pgw');
  assert.deepEqual({pixelSizeMetres:manifest.items[0].pixelSizeMetres,width:manifest.items[0].attachmentWidthMetres,height:manifest.items[0].attachmentHeightMetres},{pixelSizeMetres:0.1,width:240,height:160});
  assert.deepEqual({pixelSizeMetres:manifest.items[1].pixelSizeMetres,width:manifest.items[1].attachmentWidthMetres,height:manifest.items[1].attachmentHeightMetres},{pixelSizeMetres:0.1,width:100,height:50});
  assert.deepEqual(manifest.items[2].projectedCorners,historicalProjected);
  assert.equal(manifest.items[2].redistributionEvidence,'manual-permission-confirmed');
  assert.deepEqual(manifest.company,{address:'1 Main Street',companyName:'Acme Environmental',email:'info@acme.test',phone:'416-555-0100',preparedBy:'A. Author',reviewedBy:'R. Reviewer',website:'https://acme.test'});
  assert.deepEqual({pixelSizeMetres:manifest.logoAttachment.pixelSizeMetres,width:manifest.logoAttachment.attachmentWidthMetres,height:manifest.logoAttachment.attachmentHeightMetres},{pixelSizeMetres:0.05,width:16,height:8});
  assert.deepEqual(Object.keys(manifest).sort(),Object.keys(manifest),'canonical top-level keys are lexically ordered');
});

test('preserves true projected controls separately from the contextual fitted CAD frame and fails closed above tolerance',async()=>{
  const {buildCadManifest}=await manifestModule(),source=input(),controls=[[630000.5,4831000],[630240,4831000.5],[630239.5,4830840],[630000,4830839.5]];source.items[0]={...source.items[0],projectedControlCorners:controls,projectionFit:{method:'least-squares-similarity',residualMetres:.5,maxToleranceMetres:2,fitness:'contextual-not-survey-grade'}};const output=buildCadManifest(source),manifest=JSON.parse(output.json),figure=manifest.items[0];
  assert.deepEqual(figure.projectedControlCorners,controls);assert.deepEqual(figure.cadFrameCorners,figureProjected);assert.deepEqual(figure.projectedCorners,figureProjected);assert.deepEqual(figure.projectionFit,{fitness:'contextual-not-survey-grade',maxToleranceMetres:2,method:'least-squares-similarity',residualMetres:.5});assert.match(output.csv,/True projected control upper left/);assert.match(output.sourcesText,/True-control residual: 0\.5 m/);assert.match(output.readmeText,/contextual, not survey grade/i);
  for(const projectionFit of [{method:'least-squares-similarity',residualMetres:2.1,maxToleranceMetres:2,fitness:'contextual-not-survey-grade'},{method:'least-squares-similarity',residualMetres:.4,maxToleranceMetres:2,fitness:'contextual-not-survey-grade'},{method:'least-squares-similarity',residualMetres:.5,maxToleranceMetres:2,fitness:'survey-grade'}]){const invalid=input();invalid.items[0]={...invalid.items[0],projectedControlCorners:controls,projectionFit};assert.throws(()=>buildCadManifest(invalid),/residual|tolerance|contextual|survey/i);}
});

test('emits RFC 4180 CSV with CRLF, doubled quotes, embedded newlines, and formula-neutral text cells',async()=>{
  const {buildCadManifest}=await manifestModule(),source=input();
  source.project=project({name:' \t=CMD|\' /C calc\'!A0',projectNo:'+SUM(1,1)',address:'-2+3',date:'@NOW()'});
  source.companyProfile=company({companyName:'\t=COMPANY()',address:'\n+ADDRESS()',phone:' -PHONE()',email:'@EMAIL()',website:'=WEBSITE()',preparedBy:'+PREPARED()',reviewedBy:'-REVIEWED()'});
  source.items[0].provider='=HYPERLINK("https://bad.test","click")';source.items[0].attribution='first line\nsecond, "quoted" line';
  const output=buildCadManifest(source),rows=csvRows(output.csv),header=rows[0],figure=rows[1];
  assert.equal(output.csv.endsWith('\r\n'),true);assert.equal(/(^|[^\r])\n/.test(output.csv),false,'CSV contains no lone LF');
  assert.equal(rows.length,4);assert.equal(header[0],'Project name');
  const expectedMetadata={
    'Project name':'\' \t=CMD|\' /C calc\'!A0','Project number':'\'+SUM(1,1)','Project address':'\'-2+3','Project date':'\'@NOW()',
    'Company name':'\'\t=COMPANY()','Company address':'\'\r\n+ADDRESS()','Company phone':'\' -PHONE()','Company email':'\'@EMAIL()',
    'Company website':'\'=WEBSITE()','Prepared by':'\'+PREPARED()','Reviewed by':'\'-REVIEWED()'
  };
  for(const [column,expected] of Object.entries(expectedMetadata))assert.equal(figure[header.indexOf(column)],expected,column);
  assert.equal(figure[header.indexOf('Provider')],'\'=HYPERLINK("https://bad.test","click")');
  assert.equal(figure[header.indexOf('Attribution')],'first line\r\nsecond, "quoted" line');
  assert.equal(output.csv.includes('"first line\r\nsecond, ""quoted"" line"'),true);
  for(const row of rows.slice(1))for(const cell of row)assert.doesNotMatch(cell,/^[\t \r\n]*[=+\-@]/);
  const manifest=JSON.parse(output.json);assert.equal(manifest.project.name,' \t=CMD|\' /C calc\'!A0');assert.equal(manifest.company.companyName,'\t=COMPANY()');
  assert.match(output.sourcesText,/Name:  \t=CMD/);assert.doesNotMatch(output.sourcesText,/Name: '\s*=CMD/);
});

test('writes a source record and beginner guide with explicit vector/raster limitations and numbered CAD steps',async()=>{
  const {buildCadManifest}=await manifestModule(),{sourcesText,readmeText}=buildCadManifest(input());
  for(const expected of ['PROJECT','COMPANY','COORDINATE REFERENCE SYSTEM','SOURCES AND LICENCES','AB-12345','Acme Environmental','EPSG:26917','NAD83 / UTM zone 17N','City of Toronto Archives','Reproduction permission on file','manual-permission-confirmed'])assert.match(sourcesText,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const [number,expected] of [[1,/Extract All/i],[2,/open Project\.dxf/i],[3,/SCRIPT/i],[4,/Attach-Images\.scr/i],[5,/relink.*images folder/i],[6,/edit|move|scale|rotate|clip|replace/i]])assert.match(readmeText,new RegExp(`(?:^|\\n)${number}\\. .*${expected.source}`,'i'));
  assert.match(readmeText,/boundaries, frames, labels, title block, company text, logo frame, and notes are editable vector entities/i);
  assert.match(readmeText,/map imagery and company logo.*external raster/i);
  assert.match(readmeText,/raster pixels are not editable CAD vectors/i);
});

test('emits generated-path-only CRLF IMAGEATTACH commands with invariant geometry for every raster and logo',async()=>{
  const {buildCadManifest}=await manifestModule(),source=input();
  source.project=project({name:'PROJECT\r\n_.ERASE\r\nALL'});source.companyProfile=company({companyName:'"\r\n_.SHELL'});
  source.items[0].provider='\r\n_.ERASE\r\nALL';source.items[1].license='"\n_.QUIT';
  const script=buildCadManifest(source).attachScript;
  assert.equal(script.endsWith('\r\n'),true);assert.equal(/(^|[^\r])\n/.test(script),false);assert.match(script,/^[\x20-\x7e\r\n]+$/);
  assert.equal((script.match(/_-IMAGEATTACH/g)||[]).length,4);
  assert.match(script,/_-IMAGEATTACH\r\n"images\/Figure-A\.png"\r\n630000,4830840\r\n240\r\n0\r\n/);
  assert.match(script,/_-IMAGEATTACH\r\n"images\/Figure-B\.tif"\r\n632030,4830960\r\n100\r\n36\.8698976458\r\n/);
  assert.match(script,/_-IMAGEATTACH\r\n"images\/H-1960-1\.jpg"\r\n631200,4830000\r\n400\r\n90\r\n/);
  assert.match(script,/_-IMAGEATTACH\r\n"company\/logo\.png"\r\n629900,4830792\r\n16\r\n0\r\n/);
  const lines=script.trimEnd().split('\r\n'),attachments=new Map();
  for(let index=0;index<lines.length;index+=5){assert.equal(lines[index],'_-IMAGEATTACH');attachments.set(lines[index+1].slice(1,-1),{width:Number(lines[index+3]),rotation:Number(lines[index+4])});}
  for(const [path,pixelWidth,pixelHeight,width,height,rotation] of [
    ['images/Figure-A.png',2400,1600,240,160,0],['images/Figure-B.tif',1000,500,100,50,36.8698976458],
    ['images/H-1960-1.jpg',2000,1000,400,200,90],['company/logo.png',320,160,16,8,0]
  ]){const attached=attachments.get(path);assert.equal(attached.width,width,path);assert.equal(attached.width*pixelHeight/pixelWidth,height,`${path} reconstructed height`);assert.equal(attached.rotation,rotation,path);}
  assert.doesNotMatch(script,/ERASE|SHELL|QUIT|Acme|Toronto|Licence|AB-12345/i);assert.equal(script.includes(','),true);assert.doesNotMatch(script,/\d,\d{3}(?:\D|$)/,'numbers never use grouped thousands separators');
  const denser=input();denser.files.find(file=>file.path==='images/Figure-A.png').pixelWidth=4800;denser.files.find(file=>file.path==='images/Figure-A.png').pixelHeight=3200;
  assert.equal(buildCadManifest(denser).attachScript,buildCadManifest(input()).attachScript,'normalized image pixel density does not change projected attachment width');
});

test('allocates ASCII raster paths deterministically and suffixes normalized collisions independent of input order',async()=>{
  const {allocateCadFilenames}=await manifestModule();
  const candidates=[
    {id:'c',label:'Fígure A',mime:'image/png'},
    {id:'a',label:'Figure A',mime:'image/png'},
    {id:'b',label:'figure-a',mime:'image/png'},
    {id:'h',label:'H-1960-1',mime:'image/jpeg'},
    {id:'reserved',label:'CON',mime:'image/tiff'}
  ];
  const first=allocateCadFilenames(candidates),second=allocateCadFilenames([...candidates].reverse());
  assert.deepEqual(first,second);
  assert.deepEqual(first,[
    {id:'a',path:'images/Figure-A.png',worldFilePath:'images/Figure-A.pgw'},
    {id:'b',path:'images/figure-a-2.png',worldFilePath:'images/figure-a-2.pgw'},
    {id:'c',path:'images/Figure-A-3.png',worldFilePath:'images/Figure-A-3.pgw'},
    {id:'h',path:'images/H-1960-1.jpg',worldFilePath:'images/H-1960-1.jgw'},
    {id:'reserved',path:'images/Image-CON.tif',worldFilePath:'images/Image-CON.tfw'}
  ]);
  for(const entry of first)assert.match(entry.path,/^[\x20-\x7e]+$/);
});

test('rejects unsafe, ambiguous, duplicate, reserved, and extension/media-mismatched paths',async()=>{
  const {buildCadManifest}=await manifestModule(),cases=[];
  for(const bad of ['../Figure-A.png','/images/Figure-A.png','C:/images/Figure-A.png','images\\Figure-A.png','images/%2e%2e/Figure-A.png','images/bad\u0000.png','images/CON.png','images/Figure-A.png.','images/Ｆigure-A.png']){
    const value=input();value.files[1].path=bad;value.items[0].imagePath=bad;cases.push(value);
  }
  {const value=input();value.files.push(file('IMAGES/figure-c.PNG',HASHES.zero,'image/png',1,1,1,'images/other.pgw'));cases.push(value);}
  {const value=input();value.files[1].mime='image/jpeg';cases.push(value);}
  {const value=input();value.files[1].path='images/Figure-A.exe';value.items[0].imagePath='images/Figure-A.exe';cases.push(value);}
  for(const value of cases)assert.throws(()=>buildCadManifest(value),/path|relative|ASCII|duplicate|reserved|extension|media|canonical|safe|world/i);
});

test('rejects malformed files, hashes, byte counts, pixel dimensions, and world-file references',async()=>{
  const {buildCadManifest}=await manifestModule(),mutations=[
    value=>{value.files=[];},value=>{value.files[1].sha256='A'.repeat(64);},value=>{value.files[1].sha256='0'.repeat(63);},
    value=>{value.files[1].bytes=0;},value=>{value.files[1].bytes=1.5;},value=>{value.files[1].pixelWidth=0;},value=>{value.files[1].pixelHeight=Infinity;},
    value=>{value.files[1].pixelWidth=null;},value=>{value.files[2].pixelWidth=10;},value=>{value.files[1].worldFilePath=null;},
    value=>{value.files[1].worldFilePath='images/H-1960-1.jgw';},value=>{value.files.splice(2,1);},value=>{value.files[2].mime='application/json';},
    value=>{value.files[0].worldFilePath='images/Figure-A.pgw';},value=>{value.files[1].extra='x';}
  ];
  for(const mutate of mutations){const value=input();mutate(value);assert.throws(()=>buildCadManifest(value),/file|hash|SHA|byte|dimension|pixel|world|reference|exact|media/i);}
});

test('rejects malformed or mismatched CRS, item identity, source metadata, paths, and corners',async()=>{
  const {buildCadManifest}=await manifestModule(),mutations=[
    value=>{value.crs={...crs,epsg:'EPSG:4326'};},value=>{value.crs={...crs,name:'WGS 84'};},value=>{value.crs={...crs,units:'ft'};},value=>{value.crs={...crs,zone:16};},
    value=>{value.items[0].code='F';},value=>{value.items[0].code='H-1960-1';},value=>{value.items[0].year=NaN;},value=>{value.items[0].provider='';},
    value=>{value.items[0].sourceResolutionMeters=0;},value=>{value.items[0].attribution='\u0000';},value=>{value.items[0].license='';},value=>{delete value.items[0].redistributionEvidence;},
    value=>{value.items[0].imagePath='images/H-1960-1.jpg';},value=>{value.items[0].geographicCorners[0]=[-181,43.7];},
    value=>{value.items[0].geographicCorners=[[-79.4,43.7],[-79.396,43.7],[-79.4,43.696],[-79.397,43.696]];},
    value=>{value.items[0].projectedCorners[0]=[NaN,4831000];},value=>{value.items[0].projectedCorners[2]=value.items[0].projectedCorners[1];},
    value=>{value.items[0].rotation=5;},value=>{value.items[2].year=1961;},value=>{value.items.push(clone(value.items[0]));},value=>{value.items[0].extra='x';}
  ];
  for(const mutate of mutations){const value=input();mutate(value);assert.throws(()=>buildCadManifest(value),/CRS|EPSG|zone|unit|item|code|year|provider|resolution|text|licen|evidence|image|corner|finite|affine|rotation|duplicate|exact|path/i);}
});

test('requires every selected raster and logo to match exactly one valid attachment and rejects nonuniform transforms',async()=>{
  const {buildCadManifest}=await manifestModule(),mutations=[
    value=>{value.items.pop();},value=>{value.files.splice(3,2);},value=>{value.files.push(file('images/Figure-B.png',HASHES.zero,'image/png',10,10,10,'images/Figure-B.pgw'));value.files.push(file('images/Figure-B.pgw',HASHES.zero,'text/plain',10));},
    value=>{value.logoAttachment=null;},value=>{delete value.logoAttachment;},value=>{value.logoAttachment.projectedCorners[2][0]+=1;},value=>{value.logoAttachment.rotation=90;},
    value=>{value.files[7].pixelWidth=321;},value=>{value.companyProfile.logoWidth=319;},value=>{value.companyProfile.logoMime='image/jpeg';},
    value=>{value.items[0].projectedCorners[2][1]-=20;},value=>{value.items[0].projectedCorners[1][1]+=1;value.items[0].projectedCorners[2][1]+=1;},
    value=>{value.files.push(file('company/logo.jpg',HASHES.zero,'image/jpeg',5000,320,160,null));}
  ];
  for(const mutate of mutations){const value=input();mutate(value);assert.throws(()=>buildCadManifest(value),/raster|logo|attachment|frame|affine|scale|pixel|dimension|media|item|match|rotation|world|unreferenced|exact/i);}
});

test('is locale-independent and rejects nonfinite or unsafe numeric inputs before serializing any output',async()=>{
  const {buildCadManifest}=await manifestModule(),source=input(),original=Number.prototype.toLocaleString;
  Number.prototype.toLocaleString=function(){return '9.999,5';};
  try{
    const output=buildCadManifest(source);assert.match(output.attachScript,/240/);assert.doesNotMatch(output.attachScript,/9\.999,5/);
  }finally{Number.prototype.toLocaleString=original;}
  for(const mutate of [
    value=>{value.logoAttachment.projectedCorners[0][0]=Infinity;},value=>{value.logoAttachment.rotation=NaN;},
    value=>{value.items[0].sourceResolutionMeters=Infinity;},value=>{value.files[0].bytes=Number.MAX_SAFE_INTEGER+1;}
  ]){const value=input();mutate(value);assert.throws(()=>buildCadManifest(value),/finite|safe|number|byte|resolution|corner|rotation/i);}
});

test('requires an explicit physical-resolution-stripped raster contract for IMAGEATTACH width semantics',async()=>{
  const {buildCadManifest,CAD_RASTER_NORMALIZATION}=await manifestModule(),valid=input(),output=buildCadManifest(valid);
  assert.equal(CAD_RASTER_NORMALIZATION,'physical-resolution-stripped');
  assert.equal(JSON.parse(output.json).rasterNormalization,'physical-resolution-stripped');
  assert.match(output.readmeText,/physical-resolution metadata.*stripped/i);assert.match(output.sourcesText,/Raster normalization: physical-resolution-stripped/);
  const missing={...valid};delete missing.rasterNormalization;
  for(const value of [missing,{...valid,rasterNormalization:null},{...valid,rasterNormalization:'preserve-embedded-dpi'},{...valid,rasterNormalization:' physical-resolution-stripped'}])assert.throws(()=>buildCadManifest(value),/raster|resolution|normaliz|exact/i);
});
