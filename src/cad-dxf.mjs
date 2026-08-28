import {normalizeCompanyProfile,validateCompanyProfile} from './company-profile.mjs';
import {projectRing,projectedBounds,utmZoneForLocation} from './projection.mjs';

export const CAD_DXF_LAYERS=Object.freeze([
  'SITE_MARKER','SITE_BOUNDARY','BUILDING_BOUNDARY','IMAGE_FRAMES','IMAGE_LABELS',
  'TITLE_BLOCK','COMPANY_TEXT','COMPANY_LOGO_FRAME','NOTES'
]);

const FIGURE_CODES=Object.freeze(['A','B','C','D','E']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SELECTIONS=100,MAX_DRAWING_SPAN=500_000,MAX_GROUP_TEXT=240;
const LAYER_COLOURS=Object.freeze({
  '0':7,SITE_MARKER:1,SITE_BOUNDARY:1,BUILDING_BOUNDARY:7,IMAGE_FRAMES:8,IMAGE_LABELS:3,
  TITLE_BLOCK:7,COMPANY_TEXT:7,COMPANY_LOGO_FRAME:4,NOTES:8
});

function fail(message){throw new Error(message);}

function plainRecord(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} must be a plain record.`);
  let prototype;try{prototype=Object.getPrototypeOf(value);}catch{fail(`${label} must be inspectable.`);}
  if(prototype!==Object.prototype&&prototype!==null)fail(`${label} must be a plain record.`);
  return value;
}

function exactRecord(value,fields,label){
  plainRecord(value,label);let keys;try{keys=Reflect.ownKeys(value);}catch{fail(`${label} must be inspectable.`);}
  if(keys.some(key=>typeof key!=='string')||keys.length!==fields.length||keys.some(key=>!fields.includes(key))||fields.some(key=>!keys.includes(key)))fail(`${label} must contain exact fields.`);
  const result={};
  for(const key of fields){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail(`${label}.${key} must be an enumerable data field.`);
    result[key]=descriptor.value;
  }
  return result;
}

function boundedText(value,label,maximum,{required=true}={}){
  if(typeof value!=='string')fail(`${label} must contain text.`);
  const normalized=value.replace(/\r\n?/g,'\n').trim(),length=[...normalized].length;
  if(required&&!normalized)fail(`${label} must contain nonempty text.`);
  if(length>maximum)fail(`${label} is too long to fit the DXF layout.`);
  return normalized;
}

function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value))fail(`${label} must be finite.`);return value;}

function canonicalNumber(value,label='DXF number'){
  finite(value,label);const canonical=value===0?0:Number(value.toPrecision(12));
  if(!Number.isFinite(canonical))fail(`${label} exceeds the supported DXF numeric range.`);
  return canonical===0?0:canonical;
}

function projectedPoint(value,label){
  if(!Array.isArray(value)||value.length!==2)fail(`${label} must be an exact two-coordinate point.`);
  const x=finite(value[0],`${label} easting`),y=finite(value[1],`${label} northing`);
  if(x<100_000||x>900_000)fail(`${label} UTM easting is outside the supported coordinate range.`);
  if(y<0||y>10_000_000)fail(`${label} UTM northing is outside the supported coordinate range.`);
  return [x,y];
}

function canonicalProjectedPoint(value,label){
  const [x,y]=projectedPoint(value,label);
  return projectedPoint([canonicalNumber(x,`${label} easting`),canonicalNumber(y,`${label} northing`)],label);
}

function canonicalPolyline(points,{label='DXF polyline',closed=true,affine=false}={}){
  if(!Array.isArray(points))fail(`${label} points must be an array.`);
  let vertices=points.map((point,index)=>canonicalProjectedPoint(point,`${label} vertex ${index+1}`));
  if(closed&&vertices.length>1&&vertices[0][0]===vertices.at(-1)[0]&&vertices[0][1]===vertices.at(-1)[1])vertices=vertices.slice(0,-1);
  const minimum=closed?3:2;
  if(vertices.length<minimum||vertices.length>5000)fail(`${label} has an invalid vertex count.`);
  const keys=vertices.map(point=>`${point[0]},${point[1]}`);
  if(new Set(keys).size!==vertices.length)fail(`${label} collapses or repeats a vertex at DXF numeric precision.`);
  const xs=vertices.map(point=>point[0]),ys=vertices.map(point=>point[1]);
  const scale=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  if(!(scale>0)||!Number.isFinite(scale))fail(`${label} collapses at DXF numeric precision.`);
  const segmentCount=closed?vertices.length:vertices.length-1;
  for(let index=0;index<segmentCount;index++){
    const start=vertices[index],end=vertices[(index+1)%vertices.length];
    if(start[0]===end[0]&&start[1]===end[1])fail(`${label} contains a zero-length edge at DXF numeric precision.`);
  }
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const crossTolerance=scale*scale*Number.EPSILON*1024,coordinateTolerance=scale*Number.EPSILON*1024;
  const orientation=(a,b,c)=>{const value=cross(a,b,c);return Math.abs(value)<=crossTolerance?0:Math.sign(value);};
  const onSegment=(point,start,end)=>orientation(start,end,point)===0&&point[0]>=Math.min(start[0],end[0])-coordinateTolerance&&point[0]<=Math.max(start[0],end[0])+coordinateTolerance&&point[1]>=Math.min(start[1],end[1])-coordinateTolerance&&point[1]<=Math.max(start[1],end[1])+coordinateTolerance;
  for(let first=0;first<segmentCount;first++)for(let second=first+1;second<segmentCount;second++){
    if(second===first+1||closed&&first===0&&second===segmentCount-1)continue;
    const a=vertices[first],b=vertices[(first+1)%vertices.length],c=vertices[second],d=vertices[(second+1)%vertices.length];
    const firstC=orientation(a,b,c),firstD=orientation(a,b,d),secondA=orientation(c,d,a),secondB=orientation(c,d,b);
    if(onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b)||firstC*firstD<0&&secondA*secondB<0)fail(`${label} self-intersects at DXF numeric precision.`);
  }
  if(closed){
    const [originX,originY]=vertices[0];let twiceArea=0,compensation=0;
    for(let index=1;index<vertices.length-1;index++){
      const first=vertices[index],second=vertices[index+1],term=(first[0]-originX)*(second[1]-originY)-(first[1]-originY)*(second[0]-originX),sum=twiceArea+term;
      compensation+=Math.abs(twiceArea)>=Math.abs(term)?(twiceArea-sum)+term:(term-sum)+twiceArea;twiceArea=sum;
    }
    twiceArea+=compensation;const areaTolerance=scale*scale*Number.EPSILON*256*vertices.length;
    if(!Number.isFinite(twiceArea)||Math.abs(twiceArea)<=areaTolerance)fail(`${label} has zero or degenerate area at DXF numeric precision.`);
  }
  if(affine){
    if(!closed||vertices.length!==4)fail(`${label} must be a four-corner closed affine frame.`);
    const [upperLeft,upperRight,lowerRight,lowerLeft]=vertices;
    const column=[upperRight[0]-upperLeft[0],upperRight[1]-upperLeft[1]],row=[lowerLeft[0]-upperLeft[0],lowerLeft[1]-upperLeft[1]];
    const affineScale=Math.max(Math.hypot(...column),Math.hypot(...row)),determinant=column[0]*row[1]-column[1]*row[0];
    if(!(affineScale>0)||!Number.isFinite(determinant)||Math.abs(determinant)<=affineScale*affineScale*1e-12)fail(`${label} is degenerate or ill-conditioned at DXF numeric precision.`);
    const expected=[canonicalNumber(upperRight[0]+lowerLeft[0]-upperLeft[0]),canonicalNumber(upperRight[1]+lowerLeft[1]-upperLeft[1])];
    if(lowerRight[0]!==expected[0]||lowerRight[1]!==expected[1])fail(`${label} is not affine at DXF numeric precision.`);
  }
  return vertices;
}

function checkedProjector(project,projector){
  if(!projector||typeof projector!=='object'||typeof projector.forward!=='function'||typeof projector.inverse!=='function')fail('A compatible NAD83 UTM projector is required.');
  const expected=utmZoneForLocation(project.location),crs=plainRecord(projector.crs,'Projector CRS');
  if(crs.zone!==expected.zone||crs.epsg!==expected.epsg||crs.name!==expected.name||crs.units!=='m')fail('Projector CRS does not match the SITE NAD83 UTM zone.');
  return {projector,crs:expected};
}

function selectionRecord(value,label='Selection'){
  plainRecord(value,label);
  if(value.kind==='figure'){
    const fields=exactRecord(value,['kind','code'],label);
    if(!FIGURE_CODES.includes(fields.code))fail(`${label} figure code must be A through E.`);
    return {kind:'figure',code:fields.code,key:`figure:${fields.code}`};
  }
  if(value.kind==='historical'){
    const fields=exactRecord(value,['kind','id'],label);
    if(typeof fields.id!=='string'||!UUID.test(fields.id))fail(`${label} historical ID must be a UUID.`);
    return {kind:'historical',id:fields.id,key:`historical:${fields.id}`};
  }
  fail(`${label} kind must be figure or historical.`);
}

function selectionMetadata(project,selection){
  if(selection.kind==='figure'){
    const figures=plainRecord(project.figures,'Project figures'),figure=plainRecord(figures[selection.code],`Figure ${selection.code}`);
    const title=boundedText(figure.title,`Figure ${selection.code} title`,240);
    return {label:`FIGURE ${selection.code} - ${title}`,rank:[0,FIGURE_CODES.indexOf(selection.code)]};
  }
  if(!Array.isArray(project.historical))fail('Project historical imagery must be an array.');
  const matches=project.historical.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)&&item.id===selection.id);
  if(matches.length!==1)fail(`CAD selection references an unknown, missing, or duplicate historical project item: ${selection.key}.`);
  const item=plainRecord(matches[0],'Selected historical imagery item');
  if(!Number.isInteger(item.year)||item.year<1850||item.year>9999)fail('Selected historical imagery year is invalid.');
  if(!Number.isSafeInteger(item.sequence)||item.sequence<=0||item.sequence>1_000_000)fail('Selected historical imagery sequence is invalid.');
  const title=boundedText(item.title,'Historical imagery title',240),attribution=boundedText(item.attribution,'Historical imagery attribution',1000);
  return {label:`H-${item.year}-${item.sequence} - ${title}`,source:attribution,rank:[1,item.year,item.sequence,item.id]};
}

function compareRank(first,second){
  const length=Math.max(first.length,second.length);
  for(let index=0;index<length;index++){
    const a=first[index],b=second[index];if(a===b)continue;
    if(typeof a==='number'&&typeof b==='number')return a-b;
    const firstText=String(a),secondText=String(b);return firstText<secondText?-1:1;
  }
  return 0;
}

function normalizedSelections(project,selection){
  if(!Array.isArray(selection)||selection.length<1||selection.length>MAX_SELECTIONS)fail(`CAD selection must contain between 1 and ${MAX_SELECTIONS} items.`);
  const seen=new Set(),items=[];
  for(const [index,value] of selection.entries()){
    const normalized=selectionRecord(value,`Selection ${index+1}`);
    if(seen.has(normalized.key))fail(`CAD selection contains duplicate ${normalized.key}.`);seen.add(normalized.key);
    const metadata=selectionMetadata(project,normalized);
    items.push({...normalized,...metadata});
  }
  return items.sort((a,b)=>compareRank(a.rank,b.rank));
}

function checkedFrameCorners(value,label){
  if(!Array.isArray(value)||value.length!==4)fail(`${label} corners must contain upper-left, upper-right, lower-right, and lower-left projected points.`);
  const raw=value.map((point,index)=>projectedPoint(point,`${label} vertex ${index+1}`)),[upperLeft,upperRight,lowerRight,lowerLeft]=raw;
  const column=[upperRight[0]-upperLeft[0],upperRight[1]-upperLeft[1]],row=[lowerLeft[0]-upperLeft[0],lowerLeft[1]-upperLeft[1]];
  const scale=Math.max(Math.hypot(...column),Math.hypot(...row)),determinant=column[0]*row[1]-column[1]*row[0];
  if(!(scale>0)||!Number.isFinite(determinant)||Math.abs(determinant)<=scale*scale*1e-12)fail(`${label} is degenerate or ill-conditioned before DXF serialization.`);
  const expectedRaw=[upperRight[0]+lowerLeft[0]-upperLeft[0],upperRight[1]+lowerLeft[1]-upperLeft[1]],magnitude=Math.max(1,...raw.flat().map(Math.abs));
  const affineTolerance=(magnitude+scale)*Number.EPSILON*64;
  if(Math.abs(lowerRight[0]-expectedRaw[0])>affineTolerance||Math.abs(lowerRight[1]-expectedRaw[1])>affineTolerance)fail(`${label} is not an affine frame before DXF serialization.`);
  const canonicalUpperLeft=canonicalProjectedPoint(upperLeft,`${label} upper-left`),canonicalUpperRight=canonicalProjectedPoint(upperRight,`${label} upper-right`),canonicalLowerLeft=canonicalProjectedPoint(lowerLeft,`${label} lower-left`);
  const canonicalLowerRight=[canonicalNumber(canonicalUpperRight[0]+canonicalLowerLeft[0]-canonicalUpperLeft[0],`${label} lower-right easting`),canonicalNumber(canonicalUpperRight[1]+canonicalLowerLeft[1]-canonicalUpperLeft[1],`${label} lower-right northing`)];
  return canonicalPolyline([canonicalUpperLeft,canonicalUpperRight,canonicalLowerRight,canonicalLowerLeft],{label,closed:true,affine:true});
}

function normalizedFrames(imageFrames,selections){
  if(!Array.isArray(imageFrames)||imageFrames.length!==selections.length)fail('Image frames must match the CAD selection one-for-one.');
  const selected=new Map(selections.map(item=>[item.key,item])),frames=new Map();
  for(const [index,value] of imageFrames.entries()){
    const fields=exactRecord(value,['selection','corners'],`Image frame ${index+1}`),identity=selectionRecord(fields.selection,`Image frame ${index+1} selection`);
    if(!selected.has(identity.key))fail(`Image frame references a missing selection: ${identity.key}.`);
    if(frames.has(identity.key))fail(`Image frames contain duplicate selection ${identity.key}.`);
    frames.set(identity.key,checkedFrameCorners(fields.corners,`Image frame ${identity.key}`));
  }
  for(const item of selections)if(!frames.has(item.key))fail(`Image frame is missing for selection ${item.key}.`);
  return selections.map(item=>({...item,corners:frames.get(item.key)}));
}

function normalizedCompany(companyProfile){
  const source=plainRecord(companyProfile,'Company profile'),placementDescriptor=Object.getOwnPropertyDescriptor(source,'logoPlacement');
  if(!placementDescriptor||!placementDescriptor.enumerable||!Object.hasOwn(placementDescriptor,'value'))fail('Company logo placement must be an enumerable data field.');
  const placement=exactRecord(placementDescriptor.value,['align','scale'],'Company logo placement');
  if(!['left','center','right'].includes(placement.align))fail('Company logo placement align must be left, center, or right.');
  if(typeof placement.scale!=='number'||!Number.isFinite(placement.scale)||placement.scale<.5||placement.scale>1.5)fail('Company logo placement scale must be from 0.5 to 1.5.');
  let profile;try{profile=normalizeCompanyProfile(companyProfile);}catch(error){throw new Error(`Company profile is invalid: ${error.message}`,{cause:error});}
  const errors=validateCompanyProfile(profile);if(errors.length)fail(`Company profile is incomplete: ${errors.map(error=>error.message).join(' ')}`);
  for(const [field,maximum,required] of [['companyName',160,true],['address',220,true],['phone',220,true],['email',220,true],['website',220,true],['preparedBy',160,false],['reviewedBy',160,false]])profile[field]=boundedText(profile[field],`Company ${field}`,maximum,{required});
  if([profile.address,profile.phone,profile.email,profile.website].join(' | ').length>500)fail('Company contact text is too long to fit the DXF title block.');
  profile.logoPlacement={align:placement.align,scale:placement.scale};return profile;
}

function normalizedProject(project){
  plainRecord(project,'Project');
  const normalized={
    source:project,
    name:boundedText(project.name,'Project title',180),projectNo:boundedText(project.projectNo??'','Project number',80,{required:false}),
    address:boundedText(project.address??'','Project address',240,{required:false}),date:boundedText(project.date??'','Project date',80,{required:false}),
    siteBoundary:project.siteBoundary??[],buildingBoundary:project.buildingBoundary??[]
  };
  if([normalized.projectNo,normalized.address,normalized.date].filter(Boolean).join(' | ').length>300)fail('Project detail text is too long to fit the DXF title block.');
  return normalized;
}

function projectedGeometry(project,projector,frames){
  if(!Array.isArray(project.siteBoundary)||!Array.isArray(project.buildingBoundary))fail('Project boundaries must be arrays.');
  const site=project.siteBoundary.length?canonicalPolyline(projectRing(project.siteBoundary,projector),{label:'SITE boundary',closed:true}):[];
  const building=project.buildingBoundary.length?canonicalPolyline(projectRing(project.buildingBoundary,projector),{label:'Building boundary',closed:true}):[];
  const marker=canonicalProjectedPoint(projector.forward([project.source.location.lng,project.source.location.lat]),'Projected SITE marker');
  const sourcePoints=[marker,...site,...building,...frames.flatMap(frame=>frame.corners)],bounds=projectedBounds(sourcePoints);
  if(bounds.east-bounds.west>MAX_DRAWING_SPAN||bounds.north-bounds.south>MAX_DRAWING_SPAN)fail('CAD drawing geometry exceeds the supported extent and would overflow the layout.');
  return {marker,site,building,bounds};
}

function rectangle(x,y,width,height){return [[x,y],[x+width,y],[x+width,y+height],[x,y+height]];}

function titleLayout(bounds,selectionCount,company){
  const span=Math.max(bounds.east-bounds.west,bounds.north-bounds.south,1),width=Math.max(140,Math.min(240,span*.4)),height=Math.max(140,130+selectionCount*16);
  const gap=Math.max(12,Math.min(50,span*.03));let x,y;
  if(bounds.east+gap+width<=900_000){x=bounds.east+gap;y=Math.min(Math.max(bounds.south,0),10_000_000-height);}
  else if(bounds.west-gap-width>=100_000){x=bounds.west-gap-width;y=Math.min(Math.max(bounds.south,0),10_000_000-height);}
  else if(bounds.south-gap-height>=0){x=Math.min(Math.max(bounds.west,100_000),900_000-width);y=bounds.south-gap-height;}
  else if(bounds.north+gap+height<=10_000_000){x=Math.min(Math.max(bounds.west,100_000),900_000-width);y=bounds.north+gap;}
  else fail('CAD title block cannot be placed outside the geometry without coordinate overflow.');
  const logoCell={x:x+6,y:y+height-42,width:Math.min(62,width*.3),height:36},aspect=company.logoWidth/company.logoHeight;
  const baseWidth=Math.min(logoCell.width/1.5,logoCell.height*aspect/1.5),logoWidth=baseWidth*company.logoPlacement.scale,logoHeight=logoWidth/aspect;
  const horizontalSpace=logoCell.width-logoWidth,logoX=logoCell.x+(company.logoPlacement.align==='left'?0:company.logoPlacement.align==='center'?horizontalSpace/2:horizontalSpace),logoY=logoCell.y+(logoCell.height-logoHeight)/2;
  return {x,y,width,height,outer:rectangle(x,y,width,height),logoCell,logo:rectangle(logoX,logoY,logoWidth,logoHeight)};
}

function textEscapeTokens(value){
  const tokens=[];
  for(const character of value){
    const code=character.codePointAt(0);
    if(character==='\n'){tokens.push('\\P');continue;}
    if(code<32||code===127){tokens.push(' ');continue;}
    if(code>=32&&code<=126&&!['\\','{','}','%','^','~'].includes(character)){tokens.push(character);continue;}
    if(code<=0xffff){tokens.push(`\\U+${code.toString(16).toUpperCase().padStart(4,'0')}`);continue;}
    const offset=code-0x10000,high=0xd800+(offset>>10),low=0xdc00+(offset&0x3ff);
    tokens.push(`\\U+${high.toString(16).toUpperCase()}\\U+${low.toString(16).toUpperCase()}`);
  }
  return tokens;
}

function textChunks(value){
  const chunks=[];let chunk='';
  for(const token of textEscapeTokens(value)){
    if(token.length>MAX_GROUP_TEXT)fail('DXF text token exceeds the supported group-code length.');
    if(chunk&&chunk.length+token.length>MAX_GROUP_TEXT){chunks.push(chunk);chunk='';}
    chunk+=token;
  }
  if(chunk)chunks.push(chunk);return chunks.length?chunks:[' '];
}

function numberText(value){
  return String(canonicalNumber(value));
}

class PairWriter{
  constructor(){this.lines=[];}
  add(code,value){
    if(!Number.isInteger(code)||code<0||code>1071)fail('DXF group code is invalid.');
    const content=typeof value==='number'?numberText(value):String(value);
    if(/[\r\n]/.test(content)||/[^\x00-\x7f]/.test(content))fail('DXF group value is not ASCII-safe.');
    if((code===1||code===3)&&content.length>MAX_GROUP_TEXT)fail('DXF text group exceeds the supported length.');
    this.lines.push(String(code),content);return this;
  }
  append(writer){this.lines.push(...writer.lines);return this;}
  toString(){return this.lines.join('\n')+'\n';}
}

class Handles{
  constructor(){this.nextValue=0x10;}
  take(){return (this.nextValue++).toString(16).toUpperCase();}
  peek(){return this.nextValue.toString(16).toUpperCase();}
}

function section(name,body){const writer=new PairWriter();writer.add(0,'SECTION').add(2,name).append(body).add(0,'ENDSEC');return writer;}

function symbolTable(writer,handles,name,records,writeRecord){
  const tableHandle=handles.take();writer.add(0,'TABLE').add(2,name).add(5,tableHandle).add(330,'0').add(100,'AcDbSymbolTable').add(70,records.length);
  const recordHandles=[];
  for(const record of records){const handle=handles.take();recordHandles.push(handle);writeRecord(writer,{record,handle,owner:tableHandle});}
  writer.add(0,'ENDTAB');return recordHandles;
}

function buildTables(handles){
  const writer=new PairWriter();
  symbolTable(writer,handles,'VPORT',['*ACTIVE'],(out,{record,handle,owner})=>out.add(0,'VPORT').add(5,handle).add(330,owner).add(100,'AcDbSymbolTableRecord').add(100,'AcDbViewportTableRecord').add(2,record).add(70,0).add(10,0).add(20,0).add(11,1).add(21,1).add(12,0).add(22,0).add(40,1000).add(41,1).add(42,50));
  symbolTable(writer,handles,'LTYPE',['CONTINUOUS'],(out,{record,handle,owner})=>out.add(0,'LTYPE').add(5,handle).add(330,owner).add(100,'AcDbSymbolTableRecord').add(100,'AcDbLinetypeTableRecord').add(2,record).add(70,0).add(3,'Solid line').add(72,65).add(73,0).add(40,0));
  symbolTable(writer,handles,'LAYER',['0',...CAD_DXF_LAYERS],(out,{record,handle,owner})=>out.add(0,'LAYER').add(5,handle).add(330,owner).add(100,'AcDbSymbolTableRecord').add(100,'AcDbLayerTableRecord').add(2,record).add(70,0).add(62,LAYER_COLOURS[record]).add(6,'CONTINUOUS').add(370,-3));
  symbolTable(writer,handles,'STYLE',['STANDARD'],(out,{record,handle,owner})=>out.add(0,'STYLE').add(5,handle).add(330,owner).add(100,'AcDbSymbolTableRecord').add(100,'AcDbTextStyleTableRecord').add(2,record).add(70,0).add(40,0).add(41,1).add(50,0).add(71,0).add(42,2.5).add(3,'txt').add(4,''));
  symbolTable(writer,handles,'APPID',['ACAD'],(out,{record,handle,owner})=>out.add(0,'APPID').add(5,handle).add(330,owner).add(100,'AcDbSymbolTableRecord').add(100,'AcDbRegAppTableRecord').add(2,record).add(70,0));
  let blockRecords;
  blockRecords=symbolTable(writer,handles,'BLOCK_RECORD',['*Model_Space','*Paper_Space'],(out,{record,handle,owner})=>out.add(0,'BLOCK_RECORD').add(5,handle).add(330,owner).add(100,'AcDbSymbolTableRecord').add(100,'AcDbBlockTableRecord').add(2,record).add(70,0));
  return {writer,modelRecord:blockRecords[0],paperRecord:blockRecords[1]};
}

function block(writer,handles,name,owner){
  writer.add(0,'BLOCK').add(5,handles.take()).add(330,owner).add(100,'AcDbEntity').add(8,'0').add(100,'AcDbBlockBegin').add(2,name).add(70,0).add(10,0).add(20,0).add(30,0).add(3,name).add(1,'');
  writer.add(0,'ENDBLK').add(5,handles.take()).add(330,owner).add(100,'AcDbEntity').add(8,'0').add(100,'AcDbBlockEnd');
}

function buildBlocks(handles,modelRecord,paperRecord){const writer=new PairWriter();block(writer,handles,'*Model_Space',modelRecord);block(writer,handles,'*Paper_Space',paperRecord);return writer;}

function entityStart(writer,handles,owner,type,layerName,subclass){
  writer.add(0,type).add(5,handles.take()).add(330,owner).add(100,'AcDbEntity').add(8,layerName).add(100,subclass);
}

function pointEntity(writer,handles,owner,layerName,[x,y]){
  [x,y]=canonicalProjectedPoint([x,y],`${layerName} point`);entityStart(writer,handles,owner,'POINT',layerName,'AcDbPoint');writer.add(10,x).add(20,y).add(30,0);
}

function polylineEntity(writer,handles,owner,layerName,points,{closed=true,affine=false}={}){
  const vertices=canonicalPolyline(points,{label:`${layerName} polyline`,closed,affine});
  entityStart(writer,handles,owner,'LWPOLYLINE',layerName,'AcDbPolyline');writer.add(90,vertices.length).add(70,closed?1:0).add(43,0);
  for(const [x,y] of vertices)writer.add(10,x).add(20,y);
}

function mtextEntity(writer,handles,owner,layerName,{point:[x,y],height,width,text}){
  projectedPoint([x,y],`${layerName} text insertion`);finite(height,`${layerName} text height`);finite(width,`${layerName} text width`);
  if(height<=0||height>1000||width<=0||width>MAX_DRAWING_SPAN)fail(`${layerName} text geometry is outside supported DXF limits.`);
  entityStart(writer,handles,owner,'MTEXT',layerName,'AcDbMText');writer.add(10,x).add(20,y).add(30,0).add(40,height).add(41,width).add(71,1).add(72,1);
  const chunks=textChunks(text);for(const chunk of chunks.slice(0,-1))writer.add(3,chunk);writer.add(1,chunks.at(-1)).add(7,'STANDARD').add(50,0);
}

function entitiesModel(project,company,selections,frames,geometry,layout){
  const result=[];
  result.push({kind:'point',layer:'SITE_MARKER',point:geometry.marker});
  if(geometry.site.length)result.push({kind:'polyline',layer:'SITE_BOUNDARY',points:geometry.site,closed:true});
  if(geometry.building.length)result.push({kind:'polyline',layer:'BUILDING_BOUNDARY',points:geometry.building,closed:true});
  for(const frame of frames){
    result.push({kind:'polyline',layer:'IMAGE_FRAMES',points:frame.corners,closed:true,affine:true});
    const frameBounds=projectedBounds(frame.corners),height=Math.max(2.5,Math.min(5,Math.min(frameBounds.east-frameBounds.west,frameBounds.north-frameBounds.south)*.025));
    result.push({kind:'mtext',layer:'IMAGE_LABELS',point:[frameBounds.west+height,frameBounds.north-height*1.5],height,width:Math.max(20,frameBounds.east-frameBounds.west-height*2),text:frame.label});
  }
  result.push({kind:'polyline',layer:'TITLE_BLOCK',points:layout.outer,closed:true,affine:true});
  result.push({kind:'polyline',layer:'TITLE_BLOCK',points:[[layout.x,layout.y+layout.height-48],[layout.x+layout.width,layout.y+layout.height-48]],closed:false});
  result.push({kind:'polyline',layer:'COMPANY_LOGO_FRAME',points:layout.logo,closed:true,affine:true});
  const textX=layout.logoCell.x+layout.logoCell.width+6,textWidth=layout.width-(textX-layout.x)-6;
  result.push({kind:'mtext',layer:'COMPANY_TEXT',point:[textX,layout.y+layout.height-9],height:4,width:textWidth,text:company.companyName});
  result.push({kind:'mtext',layer:'COMPANY_TEXT',point:[textX,layout.y+layout.height-28],height:2.5,width:textWidth,text:[company.address,company.phone,company.email,company.website].join(' | ')});
  result.push({kind:'mtext',layer:'TITLE_BLOCK',point:[layout.x+6,layout.y+layout.height-57],height:5,width:layout.width-12,text:project.name});
  const details=[project.projectNo&&`Project ${project.projectNo}`,project.address,project.date].filter(Boolean).join(' | ')||'Project details not assigned';
  result.push({kind:'mtext',layer:'TITLE_BLOCK',point:[layout.x+6,layout.y+layout.height-82],height:2.8,width:layout.width-12,text:details});
  result.push({kind:'mtext',layer:'NOTES',point:[layout.x+6,layout.y+layout.height-101],height:2.3,width:layout.width-12,text:`Coordinate system: ${geometry.crs.name} (${geometry.crs.epsg}); drawing units: metres.`});
  result.push({kind:'mtext',layer:'NOTES',point:[layout.x+6,layout.y+layout.height-108],height:2.3,width:layout.width-12,text:'Raster imagery and the company logo are external raster attachments; frames contain no raster pixels.'});
  selections.forEach((selection,index)=>result.push({kind:'mtext',layer:'NOTES',point:[layout.x+6,layout.y+layout.height-116-index*16],height:2,width:layout.width-12,text:`Source: ${selection.label}${selection.source?` - ${selection.source}`:''}`}));
  return result;
}

function buildEntities(handles,owner,model){
  const writer=new PairWriter();
  for(const entity of model){
    if(entity.kind==='point')pointEntity(writer,handles,owner,entity.layer,entity.point);
    else if(entity.kind==='polyline')polylineEntity(writer,handles,owner,entity.layer,entity.points,{closed:entity.closed,affine:entity.affine});
    else if(entity.kind==='mtext')mtextEntity(writer,handles,owner,entity.layer,entity);
    else fail('Unknown internal DXF entity type.');
  }
  return writer;
}

function buildObjects(handles){
  const writer=new PairWriter(),root=handles.take();writer.add(0,'DICTIONARY').add(5,root).add(330,'0').add(100,'AcDbDictionary').add(281,1);return writer;
}

function modelBounds(model){
  const points=[];
  for(const entity of model){if(entity.point)points.push(entity.point);if(entity.points)points.push(...entity.points);}
  return projectedBounds(points);
}

function buildHeader(handles,bounds,crs){
  const writer=new PairWriter();
  writer.add(9,'$ACADVER').add(1,'AC1021').add(9,'$DWGCODEPAGE').add(3,'ANSI_1252').add(9,'$HANDSEED').add(5,handles.peek());
  writer.add(9,'$INSBASE').add(10,0).add(20,0).add(30,0).add(9,'$EXTMIN').add(10,bounds.west).add(20,bounds.south).add(30,0).add(9,'$EXTMAX').add(10,bounds.east).add(20,bounds.north).add(30,0);
  writer.add(9,'$INSUNITS').add(70,6).add(9,'$MEASUREMENT').add(70,1).add(9,'$LUNITS').add(70,2).add(9,'$LUPREC').add(70,4);
  writer.add(9,'$USERI1').add(70,crs.zone).add(9,'$USERR1').add(40,1);return writer;
}

export function buildCadDxf(input){
  const fields=exactRecord(input,['project','companyProfile','selection','imageFrames','projector'],'CAD DXF input');
  const project=normalizedProject(fields.project),company=normalizedCompany(fields.companyProfile),checked=checkedProjector(project.source,fields.projector);
  const selections=normalizedSelections(project.source,fields.selection),frames=normalizedFrames(fields.imageFrames,selections);
  const geometry={...projectedGeometry(project,checked.projector,frames),crs:checked.crs},layout=titleLayout(geometry.bounds,selections.length,company);
  const model=entitiesModel(project,company,selections,frames,geometry,layout),bounds=modelBounds(model),handles=new Handles();
  const tables=buildTables(handles),blocks=buildBlocks(handles,tables.modelRecord,tables.paperRecord),entitySection=buildEntities(handles,tables.modelRecord,model),objects=buildObjects(handles),header=buildHeader(handles,bounds,checked.crs);
  const output=new PairWriter().append(section('HEADER',header)).append(section('TABLES',tables.writer)).append(section('BLOCKS',blocks)).append(section('ENTITIES',entitySection)).append(section('OBJECTS',objects)).add(0,'EOF').toString();
  if(/[^\x00-\x7f]/.test(output)||/\r/.test(output)||/(?:^|\n)(?:NaN|Infinity|-Infinity)(?:\n|$)/.test(output))fail('DXF serialization produced unsafe output.');
  return output;
}
