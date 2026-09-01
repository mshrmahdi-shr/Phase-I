import {validateAcquisitionYearRange} from './acquisition-year.mjs';

const SCHEMA_VERSION=2;
const FORMAT='phase-i-cad-manifest';
export const CAD_RASTER_NORMALIZATION='physical-resolution-stripped';
const FIGURE_CODES=Object.freeze(['A','B','C','D','E']);
const SHA256=/^[a-f0-9]{64}$/;
const HISTORICAL_CODE=/^H-(\d{4})-([1-9]\d{0,6})$/;
const RESERVED_NAME=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_FILES=512,MAX_ITEMS=100,MAX_BYTES=512*1024*1024,MAX_PIXELS=100_000_000;
const IMAGE_MIMES=Object.freeze({
  'image/png':Object.freeze({extension:'png',worldExtension:'pgw'}),
  'image/jpeg':Object.freeze({extension:'jpg',worldExtension:'jgw'}),
  'image/tiff':Object.freeze({extension:'tif',worldExtension:'tfw'})
});
const EXTENSION_MIMES=Object.freeze({
  dxf:'application/dxf',pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',tif:'image/tiff',
  pgw:'text/plain',jgw:'text/plain',tfw:'text/plain',txt:'text/plain',scr:'text/plain',csv:'text/csv',json:'application/json'
});
const FILE_FIELDS=Object.freeze(['path','sha256','mime','bytes','pixelWidth','pixelHeight','worldFilePath']);
const ITEM_FIELDS=Object.freeze(['code','acquisitionYear','acquisitionYearVerification','provider','sourceResolutionMeters','sources','geographicCorners','projectedCorners','attribution','license','redistributionEvidence','imagePath','rotation']);
const FITTED_ITEM_FIELDS=Object.freeze([...ITEM_FIELDS,'projectedControlCorners','projectionFit']);
const SOURCE_FIELDS=Object.freeze(['role','name','sourceUrl','attribution','license','acquisitionYear','acquisitionYearVerification','redistributionEvidence']);
const PROJECTION_FIT_FIELDS=Object.freeze(['method','residualMetres','maxToleranceMetres','fitness']);
const INPUT_FIELDS=Object.freeze(['project','companyProfile','crs','rasterNormalization','files','items','logoAttachment']);

function fail(message){throw new Error(message);}

function plainRecord(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} must be a plain record.`);
  let prototype;try{prototype=Object.getPrototypeOf(value);}catch{fail(`${label} must be inspectable.`);}
  if(prototype!==Object.prototype&&prototype!==null)fail(`${label} must be a plain record.`);return value;
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

function itemRecord(value,label){
  plainRecord(value,label);let keys;try{keys=Reflect.ownKeys(value);}catch{fail(`${label} must be inspectable.`);}const fields=keys.length===ITEM_FIELDS.length?ITEM_FIELDS:keys.length===FITTED_ITEM_FIELDS.length?FITTED_ITEM_FIELDS:null;
  if(!fields)return exactRecord(value,ITEM_FIELDS,label);return exactRecord(value,fields,label);
}

function normalizedText(value,label,{maximum=4000,required=true}={}){
  if(typeof value!=='string')fail(`${label} must contain text.`);
  const normalized=value.replace(/\r\n?/g,'\n');
  if(required&&!normalized.trim())fail(`${label} must contain nonempty text.`);
  if([...normalized].length>maximum)fail(`${label} exceeds its bounded text limit.`);
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized))fail(`${label} contains unsafe control text.`);
  return normalized;
}

function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value))fail(`${label} must be a finite number.`);return value;}
function safePositiveInteger(value,label,maximum=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||value<=0||value>maximum)fail(`${label} must be a positive safe integer.`);return value;}
function canonicalNumber(value,label){
  finite(value,label);const result=value===0?0:Number(value.toPrecision(12));
  if(!Number.isFinite(result))fail(`${label} exceeds the supported numeric range.`);return result===0?0:result;
}

function stableValue(value){
  if(Array.isArray(value))return value.map(stableValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort(compareText).map(key=>[key,stableValue(value[key])]));
  return value;
}
function stableJson(value){return JSON.stringify(stableValue(value),null,2)+'\n';}
function compareText(left,right){return left<right?-1:left>right?1:0;}

function checkedPath(value,label){
  if(typeof value!=='string'||!value||value.length>240)fail(`${label} must be a bounded relative path.`);
  if(value!==value.normalize('NFKC'))fail(`${label} has an ambiguous Unicode-normalized path.`);
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)||/\\|[\u0000-\u001f\u007f]/.test(value))fail(`${label} must use printable ASCII path characters and forward slashes.`);
  if(value.startsWith('/')||/^[A-Za-z]:/.test(value)||/%(?:2e|2f|5c)/i.test(value))fail(`${label} must be relative and must not contain encoded traversal.`);
  const segments=value.split('/');
  if(segments.some(segment=>!segment||segment==='.'||segment==='..'||segment.endsWith('.')||segment.endsWith(' ')))fail(`${label} contains an unsafe path segment.`);
  for(const segment of segments){const base=segment.split('.')[0];if(RESERVED_NAME.test(base))fail(`${label} contains a reserved device name.`);}
  return value;
}

function extension(path){const name=path.slice(path.lastIndexOf('/')+1),index=name.lastIndexOf('.');return index<1?'':name.slice(index+1);}
function withoutExtension(path){return path.slice(0,-extension(path).length-1);}

function checkedCrs(value){
  const crs=exactRecord(value,['zone','epsg','name','units'],'CAD manifest CRS');
  if(![15,16,17,18].includes(crs.zone))fail('CAD manifest CRS zone must be supported Ontario UTM zone 15 through 18.');
  if(crs.epsg!==`EPSG:269${crs.zone}`)fail('CAD manifest CRS EPSG code does not match its UTM zone.');
  if(crs.name!==`NAD83 / UTM zone ${crs.zone}N`)fail('CAD manifest CRS name does not match its EPSG zone.');
  if(crs.units!=='m')fail('CAD manifest CRS units must be metres (m).');return {...crs};
}

function checkedProject(value){
  const project=plainRecord(value,'CAD manifest project');
  return {
    name:normalizedText(project.name,'Project name',{maximum:240}),projectNo:normalizedText(project.projectNo,'Project number',{maximum:120}),
    address:normalizedText(project.address,'Project address',{maximum:500}),date:normalizedText(project.date,'Project date',{maximum:120})
  };
}

function checkedCompany(value){
  const company=plainRecord(value,'CAD manifest company profile');
  const result={};
  for(const [field,label,maximum,required] of [
    ['companyName','Company name',240,true],['address','Company address',500,true],['phone','Company phone',240,true],['email','Company email',240,true],
    ['website','Company website',500,true],['preparedBy','Prepared-by name',240,false],['reviewedBy','Reviewed-by name',240,false]
  ])result[field]=normalizedText(company[field]??'',label,{maximum,required});
  if(!Object.hasOwn(IMAGE_MIMES,company.logoMime)||company.logoMime==='image/tiff')fail('Company logo media must be image/png or image/jpeg.');
  result.logoMime=company.logoMime;result.logoWidth=safePositiveInteger(company.logoWidth,'Company logo pixel width',MAX_PIXELS);
  result.logoHeight=safePositiveInteger(company.logoHeight,'Company logo pixel height',MAX_PIXELS);
  if(result.logoWidth>Math.floor(MAX_PIXELS/result.logoHeight))fail('Company logo pixel dimensions exceed the supported limit.');return result;
}

function checkedFile(value,index){
  const row=exactRecord(value,FILE_FIELDS,`CAD manifest file ${index+1}`),path=checkedPath(row.path,`CAD manifest file ${index+1} path`),suffix=extension(path);
  if(!Object.hasOwn(EXTENSION_MIMES,suffix)||row.mime!==EXTENSION_MIMES[suffix])fail(`CAD manifest file ${path} has an unsafe extension or mismatched media type.`);
  if(typeof row.sha256!=='string'||!SHA256.test(row.sha256))fail(`CAD manifest file ${path} SHA-256 must contain 64 lowercase hexadecimal characters.`);
  const bytes=safePositiveInteger(row.bytes,`CAD manifest file ${path} byte count`,MAX_BYTES),image=Object.hasOwn(IMAGE_MIMES,row.mime);
  let pixelWidth=null,pixelHeight=null,worldFilePath=null;
  if(image){
    pixelWidth=safePositiveInteger(row.pixelWidth,`CAD manifest file ${path} pixel width`,MAX_PIXELS);
    pixelHeight=safePositiveInteger(row.pixelHeight,`CAD manifest file ${path} pixel height`,MAX_PIXELS);
    if(pixelWidth>Math.floor(MAX_PIXELS/pixelHeight))fail(`CAD manifest file ${path} pixel dimensions exceed the supported limit.`);
    if(path.startsWith('company/')){
      if(row.worldFilePath!==null)fail(`Company logo file ${path} must not claim a world-file reference.`);
    }else{
      worldFilePath=checkedPath(row.worldFilePath,`CAD manifest file ${path} world-file reference`);
      const expected=`${withoutExtension(path)}.${IMAGE_MIMES[row.mime].worldExtension}`;
      if(worldFilePath!==expected)fail(`CAD manifest file ${path} has a mismatched world-file reference.`);
    }
  }else if(row.pixelWidth!==null||row.pixelHeight!==null||row.worldFilePath!==null)fail(`Non-image CAD manifest file ${path} must not contain pixel dimensions or a world-file reference.`);
  return {path,sha256:row.sha256,mime:row.mime,bytes,pixelWidth,pixelHeight,worldFilePath};
}

function checkedFiles(value){
  if(!Array.isArray(value)||value.length<1||value.length>MAX_FILES)fail(`CAD manifest files must contain between 1 and ${MAX_FILES} file rows.`);
  const rows=value.map(checkedFile),keys=new Set();
  for(const row of rows){const key=row.path.normalize('NFKC').toLowerCase();if(keys.has(key))fail(`CAD manifest files contain a duplicate normalized path: ${row.path}.`);keys.add(key);}
  return rows.sort((left,right)=>compareText(left.path,right.path));
}

function finitePair(value,label,{geographic=false}={}){
  if(!Array.isArray(value)||value.length!==2)fail(`${label} must be an exact two-coordinate corner.`);
  const x=canonicalNumber(value[0],`${label} first coordinate`),y=canonicalNumber(value[1],`${label} second coordinate`);
  if(geographic){if(x< -180||x>180||y< -90||y>90)fail(`${label} is outside geographic longitude/latitude bounds.`);}
  else{if(x<100_000||x>900_000||y<0||y>10_000_000)fail(`${label} is outside supported UTM projected bounds.`);}
  return [x,y];
}

function checkedCorners(value,label,{geographic=false,affine=false}={}){
  if(!Array.isArray(value)||value.length!==4)fail(`${label} must contain upper-left, upper-right, lower-right, and lower-left corners.`);
  const corners=value.map((point,index)=>finitePair(point,`${label} corner ${index+1}`,{geographic}));
  if(new Set(corners.map(point=>point.join(','))).size!==4)fail(`${label} repeats or collapses a corner.`);
  const [upperLeft,upperRight,lowerRight,lowerLeft]=corners,column=[upperRight[0]-upperLeft[0],upperRight[1]-upperLeft[1]],row=[lowerLeft[0]-upperLeft[0],lowerLeft[1]-upperLeft[1]];
  const scale=Math.max(Math.hypot(...column),Math.hypot(...row)),determinant=column[0]*row[1]-column[1]*row[0];
  if(!(scale>0)||!Number.isFinite(determinant)||determinant>= -scale*scale*1e-12)fail(`${label} is degenerate, ill-conditioned, or not in clockwise image-corner order.`);
  let twiceArea=0;for(let index=0;index<4;index++){const next=corners[(index+1)%4];twiceArea+=corners[index][0]*next[1]-corners[index][1]*next[0];}
  if(!Number.isFinite(twiceArea)||Math.abs(twiceArea)<=scale*scale*1e-12)fail(`${label} has zero or degenerate area.`);
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]),tolerance=scale*scale*Number.EPSILON*256;
  const orientation=(a,b,c)=>{const value=cross(a,b,c);return Math.abs(value)<=tolerance?0:Math.sign(value);};
  const intersects=(a,b,c,d)=>{
    const firstC=orientation(a,b,c),firstD=orientation(a,b,d),secondA=orientation(c,d,a),secondB=orientation(c,d,b);
    return firstC*firstD<=0&&secondA*secondB<=0;
  };
  if(intersects(corners[0],corners[1],corners[2],corners[3])||intersects(corners[1],corners[2],corners[3],corners[0]))fail(`${label} must not self-intersect.`);
  if(affine){
    const expected=[upperRight[0]+lowerLeft[0]-upperLeft[0],upperRight[1]+lowerLeft[1]-upperLeft[1]],magnitude=Math.max(1,...corners.flat().map(Math.abs)),tolerance=magnitude*Number.EPSILON*128;
    if(Math.abs(lowerRight[0]-expected[0])>tolerance||Math.abs(lowerRight[1]-expected[1])>tolerance)fail(`${label} must be an affine four-corner frame.`);
  }
  return corners;
}

function normalizedAngle(value,label){
  const angle=canonicalNumber(value,label);if(angle<0||angle>=360)fail(`${label} must be from 0 (inclusive) to 360 (exclusive) degrees.`);return angle;
}
function angularDistance(left,right){const difference=Math.abs(left-right)%360;return Math.min(difference,360-difference);}

function attachmentGeometry(corners,pixelWidth,pixelHeight,rotation,label){
  const checked=checkedCorners(corners,`${label} projected corners`,{affine:true}),[upperLeft,upperRight,,lowerLeft]=checked;
  const column=[upperRight[0]-upperLeft[0],upperRight[1]-upperLeft[1]],row=[lowerLeft[0]-upperLeft[0],lowerLeft[1]-upperLeft[1]],columnLength=Math.hypot(...column),rowLength=Math.hypot(...row);
  const orthogonalTolerance=columnLength*rowLength*1e-10;
  if(Math.abs(column[0]*row[0]+column[1]*row[1])>orthogonalTolerance)fail(`${label} attachment frame must have perpendicular pixel axes.`);
  const columnScale=columnLength/pixelWidth,rowScale=rowLength/pixelHeight,tolerance=Math.max(columnScale,rowScale)*1e-10;
  if(!Number.isFinite(columnScale)||!Number.isFinite(rowScale)||Math.abs(columnScale-rowScale)>tolerance)fail(`${label} attachment frame must have one uniform pixel scale.`);
  const pixelSizeMetres=canonicalNumber((columnScale+rowScale)/2,`${label} pixel size`);if(!(pixelSizeMetres>0))fail(`${label} pixel size must remain positive.`);
  const attachmentWidthMetres=canonicalNumber(columnLength,`${label} attachment width`),attachmentHeightMetres=canonicalNumber(rowLength,`${label} attachment height`);
  if(!(attachmentWidthMetres>0)||!(attachmentHeightMetres>0))fail(`${label} attachment dimensions must remain positive.`);
  let derived=Math.atan2(column[1],column[0])*180/Math.PI;if(derived<0)derived+=360;derived=canonicalNumber(derived,`${label} derived rotation`);
  const supplied=normalizedAngle(rotation,`${label} rotation`);if(angularDistance(derived,supplied)>1e-8)fail(`${label} attachment rotation does not match its projected corners.`);
  return {projectedCorners:checked,insertionPoint:[...lowerLeft],pixelSizeMetres,attachmentWidthMetres,attachmentHeightMetres,rotation:supplied};
}

function checkedProjectionFit(row,attachment,code){
  if(!Object.hasOwn(row,'projectedControlCorners'))return null;const controls=checkedCorners(row.projectedControlCorners,`CAD manifest item ${code} true projected control corners`),fit=exactRecord(row.projectionFit,PROJECTION_FIT_FIELDS,`CAD manifest item ${code} projection fit`);
  if(fit.method!=='least-squares-similarity')fail(`CAD manifest item ${code} projection fit method must be least-squares-similarity.`);if(fit.fitness!=='contextual-not-survey-grade')fail(`CAD manifest item ${code} projection fit must be labelled contextual-not-survey-grade.`);const residualMetres=canonicalNumber(finite(fit.residualMetres,`CAD manifest item ${code} projection residual`),`CAD manifest item ${code} projection residual`),maxToleranceMetres=canonicalNumber(finite(fit.maxToleranceMetres,`CAD manifest item ${code} maximum projection tolerance`),`CAD manifest item ${code} maximum projection tolerance`);
  if(residualMetres<0||!(maxToleranceMetres>0)||maxToleranceMetres>100_000||residualMetres>maxToleranceMetres)fail(`CAD manifest item ${code} fitted CAD frame residual ${residualMetres} m exceeds its declared ${maxToleranceMetres} m maximum projection tolerance.`);const measured=canonicalNumber(Math.max(...controls.map((point,index)=>Math.hypot(point[0]-attachment.projectedCorners[index][0],point[1]-attachment.projectedCorners[index][1]))),`CAD manifest item ${code} measured projection residual`),difference=Math.abs(measured-residualMetres),comparisonTolerance=Math.max(1e-8,Math.abs(measured)*1e-10);
  if(difference>comparisonTolerance)fail(`CAD manifest item ${code} projection residual does not match its true controls and fitted CAD frame.`);return {projectedControlCorners:controls,cadFrameCorners:attachment.projectedCorners,projectionFit:{method:fit.method,residualMetres,maxToleranceMetres,fitness:fit.fitness}};
}

function checkedAcquisition(value,status,label){
  if(!['verified','unverified','unknown'].includes(status))fail(`${label} verification must be verified, unverified, or unknown.`);
  if(value===null){if(status!=='unknown')fail(`${label} must use unknown verification when the acquisition year is null.`);return null;}
  const year=validateAcquisitionYearRange(value,{label:`${label} year`});if(status==='unknown')fail(`${label} with a known year cannot use unknown verification.`);return year;
}

function checkedSources(value,code){
  if(!Array.isArray(value)||value.length<1||value.length>20)fail(`CAD manifest item ${code} sources must contain one to 20 composited layer records.`);const roles=new Set(),sources=[];
  for(const [index,candidate] of value.entries()){
    const row=exactRecord(candidate,SOURCE_FIELDS,`CAD manifest item ${code} source ${index+1}`),role=normalizedText(row.role,`CAD manifest item ${code} source role`,{maximum:80});
    if(!['basemap','geology-overlay','user-supplied-overlay','historical-imagery','user-supplied-imagery'].includes(role))fail(`CAD manifest item ${code} source role is unsupported.`);
    if(roles.has(role)&&role!=='geology-overlay')fail(`CAD manifest item ${code} duplicates source role ${role}.`);roles.add(role);
    const sourceUrl=row.sourceUrl===null?null:normalizedText(row.sourceUrl,`CAD manifest item ${code} source URL`,{maximum:8192});
    const acquisitionYear=checkedAcquisition(row.acquisitionYear,row.acquisitionYearVerification,`CAD manifest item ${code} source ${index+1} acquisition`);
    sources.push({role,name:normalizedText(row.name,`CAD manifest item ${code} source name`,{maximum:1000}),sourceUrl,
      attribution:normalizedText(row.attribution,`CAD manifest item ${code} source attribution`,{maximum:4000}),license:normalizedText(row.license,`CAD manifest item ${code} source licence`,{maximum:4000}),
      acquisitionYear,acquisitionYearVerification:row.acquisitionYearVerification,redistributionEvidence:normalizedText(row.redistributionEvidence,`CAD manifest item ${code} source redistribution evidence`,{maximum:1000})});
  }
  return sources;
}

function itemRank(item){
  if(FIGURE_CODES.includes(item.code))return [0,FIGURE_CODES.indexOf(item.code)];
  const match=HISTORICAL_CODE.exec(item.code);return [1,Number(match[1]),Number(match[2]),item.code];
}
function compareRank(left,right){
  const a=itemRank(left),b=itemRank(right);for(let index=0;index<Math.max(a.length,b.length);index++){if(a[index]===b[index])continue;return typeof a[index]==='number'&&typeof b[index]==='number'?a[index]-b[index]:compareText(String(a[index]),String(b[index]));}return 0;
}

function checkedItems(value,fileByPath){
  if(!Array.isArray(value)||value.length<1||value.length>MAX_ITEMS)fail(`CAD manifest items must contain between 1 and ${MAX_ITEMS} selected rasters.`);
  const codes=new Set(),images=new Set(),items=[];
  for(const [index,candidate] of value.entries()){
    const row=itemRecord(candidate,`CAD manifest item ${index+1}`),code=normalizedText(row.code,`CAD manifest item ${index+1} code`,{maximum:32});
    const historical=HISTORICAL_CODE.exec(code);
    if(!FIGURE_CODES.includes(code)&&!historical)fail(`CAD manifest item ${index+1} code must be A through E or H-YYYY-N.`);
    const acquisitionYear=checkedAcquisition(row.acquisitionYear,row.acquisitionYearVerification,`CAD manifest item ${code} acquisition`);
    if(historical&&acquisitionYear!==Number(historical[1]))fail(`CAD manifest historical item ${code} acquisition year does not match its code.`);
    if(codes.has(code.toLowerCase()))fail(`CAD manifest items contain duplicate code ${code}.`);codes.add(code.toLowerCase());
    const imagePath=checkedPath(row.imagePath,`CAD manifest item ${code} image path`),image=fileByPath.get(imagePath);
    if(!image||!Object.hasOwn(IMAGE_MIMES,image.mime)||!imagePath.startsWith('images/'))fail(`CAD manifest item ${code} image path does not match a raster file.`);
    const expectedStem=FIGURE_CODES.includes(code)?`images/Figure-${code}`:`images/${code}`;
    if(withoutExtension(imagePath)!==expectedStem||extension(imagePath)!==IMAGE_MIMES[image.mime].extension)fail(`CAD manifest item ${code} image path is not its canonical generated path.`);
    if(images.has(imagePath))fail(`CAD manifest items duplicate raster image path ${imagePath}.`);images.add(imagePath);
    const geographicCorners=checkedCorners(row.geographicCorners,`CAD manifest item ${code} geographic corners`,{geographic:true}),rotation=normalizedAngle(row.rotation,`CAD manifest item ${code} rotation`);
    const attachment=attachmentGeometry(row.projectedCorners,image.pixelWidth,image.pixelHeight,rotation,`CAD manifest item ${code}`),projectionFit=checkedProjectionFit(row,attachment,code);
    const sources=checkedSources(row.sources,code),provider=normalizedText(row.provider,`CAD manifest item ${code} provider`,{maximum:1000}),attribution=normalizedText(row.attribution,`CAD manifest item ${code} attribution`,{maximum:4000}),license=normalizedText(row.license,`CAD manifest item ${code} license`,{maximum:4000}),redistributionEvidence=normalizedText(row.redistributionEvidence,`CAD manifest item ${code} redistribution evidence`,{maximum:1000}),join=field=>sources.map(source=>source[field]).join(' | ');
    if(provider!==sources.map(source=>source.name).join(' + ')||attribution!==join('attribution')||license!==join('license')||redistributionEvidence!==join('redistributionEvidence'))fail(`CAD manifest item ${code} aggregate provenance does not agree with its composited source layers.`);
    items.push({
      code,acquisitionYear,acquisitionYearVerification:row.acquisitionYearVerification,provider,
      sourceResolutionMeters:canonicalNumber(finite(row.sourceResolutionMeters,`CAD manifest item ${code} source resolution`),`CAD manifest item ${code} source resolution`),
      geographicCorners,projectedCorners:attachment.projectedCorners,...(projectionFit??{}),
      sources,attribution,license,redistributionEvidence,
      imagePath,worldFilePath:image.worldFilePath,mime:image.mime,bytes:image.bytes,pixelWidth:image.pixelWidth,pixelHeight:image.pixelHeight,sha256:image.sha256,
      insertionPoint:attachment.insertionPoint,pixelSizeMetres:attachment.pixelSizeMetres,attachmentWidthMetres:attachment.attachmentWidthMetres,
      attachmentHeightMetres:attachment.attachmentHeightMetres,rotation:attachment.rotation
    });
    if(!(items.at(-1).sourceResolutionMeters>0)||items.at(-1).sourceResolutionMeters>100_000)fail(`CAD manifest item ${code} source resolution must be positive and plausible.`);
  }
  return {items:items.sort(compareRank),imagePaths:images};
}

function checkedLogo(company,files,fileByPath,logoAttachment){
  const logos=files.filter(file=>Object.hasOwn(IMAGE_MIMES,file.mime)&&file.path.startsWith('company/'));
  if(logos.length!==1)fail('CAD manifest must contain exactly one company logo raster file.');const logo=logos[0],expected=`company/logo.${IMAGE_MIMES[company.logoMime].extension}`;
  if(logo.path!==expected||logo.mime!==company.logoMime)fail('Company logo file path or media type does not match the company profile.');
  if(logo.pixelWidth!==company.logoWidth||logo.pixelHeight!==company.logoHeight)fail('Company logo file pixel dimensions do not match the company profile.');
  const placement=exactRecord(logoAttachment,['projectedCorners','rotation'],'Company logo attachment'),geometry=attachmentGeometry(placement.projectedCorners,logo.pixelWidth,logo.pixelHeight,placement.rotation,'Company logo');
  return {imagePath:logo.path,mime:logo.mime,bytes:logo.bytes,pixelWidth:logo.pixelWidth,pixelHeight:logo.pixelHeight,sha256:logo.sha256,...geometry};
}

function crossCheckFiles(files,fileByPath,items,imagePaths,logo){
  const referencedWorldFiles=new Set();
  for(const item of items){
    const world=fileByPath.get(item.worldFilePath);if(!world||world.mime!=='text/plain'||!['pgw','jgw','tfw'].includes(extension(world.path)))fail(`CAD manifest item ${item.code} has a missing or invalid world-file reference.`);referencedWorldFiles.add(world.path);
  }
  for(const file of files){
    if(Object.hasOwn(IMAGE_MIMES,file.mime)&&file.path.startsWith('images/')&&!imagePaths.has(file.path))fail(`CAD manifest raster file ${file.path} is not matched by a selected item.`);
    if(['pgw','jgw','tfw'].includes(extension(file.path))&&!referencedWorldFiles.has(file.path))fail(`CAD manifest world file ${file.path} is not referenced by a selected item.`);
    if(Object.hasOwn(IMAGE_MIMES,file.mime)&&!file.path.startsWith('images/')&&file.path!==logo.imagePath)fail(`CAD manifest raster file ${file.path} is outside a generated image or company logo path.`);
  }
}

function csvNeutral(value){const text=String(value);return /^[\t \r\n]*[=+\-@]/.test(text)?`'${text}`:text;}
function csvCell(value){
  const text=csvNeutral(value).replace(/\r\n?|\n/g,'\r\n');return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}
function coordinateCell(point){return `[${decimal(point[0])} ${decimal(point[1])}]`;}
function csv(project,company,items,crs){
  const fitted=items.some(item=>item.projectionFit),headers=['Project name','Project number','Project address','Project date','Company name','Company address','Company phone','Company email','Company website','Prepared by','Reviewed by','Code','Acquisition year','Acquisition year verification','Provider','Source resolution (m)','Composited sources (JSON)','Attribution','License','Redistribution evidence','Image path','World file path','MIME type','Bytes','Pixel width','Pixel height','SHA-256','Rotation (deg)','CRS EPSG','CRS name','CRS units','Geographic upper left','Geographic upper right','Geographic lower right','Geographic lower left',...(fitted?['True projected control upper left','True projected control upper right','True projected control lower right','True projected control lower left','Projection fit method','Projection residual (m)','Maximum projection tolerance (m)','Projection fitness','CAD frame upper left','CAD frame upper right','CAD frame lower right','CAD frame lower left']:['Projected upper left','Projected upper right','Projected lower right','Projected lower left'])];
  const rows=[headers,...items.map(item=>[
    project.name,project.projectNo,project.address,project.date,company.companyName,company.address,company.phone,company.email,company.website,company.preparedBy,company.reviewedBy,
    item.code,item.acquisitionYear??'',item.acquisitionYearVerification,item.provider,decimal(item.sourceResolutionMeters),JSON.stringify(stableValue(item.sources)),item.attribution,item.license,item.redistributionEvidence,item.imagePath,item.worldFilePath,item.mime,item.bytes,item.pixelWidth,item.pixelHeight,item.sha256,decimal(item.rotation),crs.epsg,crs.name,crs.units,
    ...item.geographicCorners.map(coordinateCell),...(fitted?[...(item.projectedControlCorners??item.projectedCorners).map(coordinateCell),item.projectionFit?.method??'',item.projectionFit?decimal(item.projectionFit.residualMetres):'',item.projectionFit?decimal(item.projectionFit.maxToleranceMetres):'',item.projectionFit?.fitness??'',...(item.cadFrameCorners??item.projectedCorners).map(coordinateCell)]:item.projectedCorners.map(coordinateCell))
  ])];
  return rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

function displayValue(value){return String(value).replace(/\n/g,'\n    ');}
function sources(project,company,crs,items){
  const lines=['PHASE I CAD PACKAGE SOURCE RECORD','', 'PROJECT',`Name: ${displayValue(project.name)}`,`Project number: ${displayValue(project.projectNo)}`,`Address: ${displayValue(project.address)}`,`Date: ${displayValue(project.date)}`,'',
    'COMPANY',`Name: ${displayValue(company.companyName)}`,`Address: ${displayValue(company.address)}`,`Phone: ${displayValue(company.phone)}`,`Email: ${displayValue(company.email)}`,`Website: ${displayValue(company.website)}`,`Prepared by: ${displayValue(company.preparedBy)}`,`Reviewed by: ${displayValue(company.reviewedBy)}`,'',
    'COORDINATE REFERENCE SYSTEM',`EPSG: ${crs.epsg}`,`Name: ${crs.name}`,`Units: ${crs.units} (metres)`,`Raster normalization: ${CAD_RASTER_NORMALIZATION}`,'','SOURCES AND LICENCES'];
  for(const [index,item] of items.entries()){
    lines.push('',`${index+1}. ${item.code}`,`Acquisition year: ${item.acquisitionYear??'unknown'}`,`Acquisition year verification: ${item.acquisitionYearVerification}`,`Provider: ${displayValue(item.provider)}`,`Source resolution: ${decimal(item.sourceResolutionMeters)} m`);
    for(const [sourceIndex,source] of item.sources.entries())lines.push(`Source layer ${sourceIndex+1} role: ${source.role}`,`Source layer ${sourceIndex+1} name: ${displayValue(source.name)}`,`Source layer ${sourceIndex+1} URL: ${source.sourceUrl??'not provided'}`,`Source layer ${sourceIndex+1} acquisition year: ${source.acquisitionYear??'unknown'}`,`Source layer ${sourceIndex+1} acquisition year verification: ${source.acquisitionYearVerification}`,`Source layer ${sourceIndex+1} attribution: ${displayValue(source.attribution)}`,`Source layer ${sourceIndex+1} licence: ${displayValue(source.license)}`,`Source layer ${sourceIndex+1} redistribution evidence: ${displayValue(source.redistributionEvidence)}`);
    lines.push(`Attribution: ${displayValue(item.attribution)}`,`Licence: ${displayValue(item.license)}`,`Redistribution evidence: ${displayValue(item.redistributionEvidence)}`,`Image: ${item.imagePath}`,`World file: ${item.worldFilePath}`,`SHA-256: ${item.sha256}`,...(item.projectionFit?[`Projection fit: ${item.projectionFit.method}`,`True-control residual: ${decimal(item.projectionFit.residualMetres)} m`,`Maximum projection tolerance: ${decimal(item.projectionFit.maxToleranceMetres)} m`,`Fitness: ${item.projectionFit.fitness}`]:[]));
  }
  return lines.join('\n')+'\n';
}

function readme(project,crs){
  return [
    'PHASE I AUTOCAD PACKAGE','',`${project.projectNo} - ${project.name}`,`${crs.name} (${crs.epsg}), metres`,'',
    'GET STARTED','1. Extract All files from the ZIP before opening anything. Keep the folder structure together (Project.dxf must stay next to the images and company folders).',
    '2. Open Project.dxf in AutoCAD or a compatible CAD program. The map imagery and company logo are already attached and visible.',
    '3. If an image shows as missing or unresolved (for example after moving the DXF on its own), use External References to relink the images folder, or run the SCRIPT command and choose Attach-Images.scr to reattach every image at its generated metre coordinates.',
    '4. Edit, move, scale, rotate, clip, detach, or replace the common entities and raster references as needed.','',
    'WHAT IS EDITABLE','Boundaries, frames, labels, title block, company text, logo frame, and notes are editable vector entities.',
    'Map imagery and company logo remain external raster references that can be moved, scaled, rotated, clipped, detached, or replaced.',
    'Raster pixels are not editable CAD vectors. Editing the linework does not change the source image pixels.','',
    'IMAGE SCALE','All packaged raster files have embedded physical-resolution metadata stripped. Project.dxf and the reattachment script therefore both supply each full projected image width in drawing metres; pixel size remains in the world files and manifests.','',
    'PROJECTION FIT','AutoCAD image attachment supports one uniform scale and rotation. Manifest.json and Manifest.csv therefore preserve both the independently projected true control corners and the fitted CAD frame used by the world file, DXF, and script.','The fit is contextual, not survey grade. Its residual and maximum tolerance are recorded per image; export fails when a fit exceeds the larger of 2 metres or 0.15% of the projected control diagonal.','',
    'SOURCE AND DATE PROVENANCE','Acquisition year means the independently described source-image year, not the project/report date. Unknown years remain blank/unknown; unverified years are labelled unverified.','Every composited basemap, geology overlay, and user-supplied overlay is recorded separately in Manifest.json, Manifest.csv, and Sources-and-Licences.txt.','',
    'FILES','Manifest.csv is the spreadsheet-friendly source list. Manifest.json is the machine-readable file and geometry record.',
    'Sources-and-Licences.txt records every composited source layer, attribution, licence, acquisition-year verification, resolution, hash, and redistribution evidence. World files beside each map image preserve its georeferencing.',''
  ].join('\n');
}

function decimal(value){
  const canonical=canonicalNumber(value,'Attachment number'),text=canonical.toFixed(12).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/,'$1');
  if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))fail('Attachment number cannot be represented as an invariant plain decimal.');return text==='-0'?'0':text;
}
function scriptLine(path,attachment){return ['_-IMAGEATTACH',`"${path}"`,`${decimal(attachment.insertionPoint[0])},${decimal(attachment.insertionPoint[1])}`,decimal(attachment.attachmentWidthMetres),decimal(attachment.rotation)].join('\r\n')+'\r\n';}
function attachmentScript(items,logo){return [...items.map(item=>scriptLine(item.imagePath,item)),scriptLine(logo.imagePath,logo)].join('');}

function manifestCompany(company){const {logoMime:unusedMime,logoWidth:unusedWidth,logoHeight:unusedHeight,...result}=company;return result;}

export function allocateCadFilenames(candidates){
  if(!Array.isArray(candidates)||candidates.length<1||candidates.length>MAX_ITEMS)fail(`CAD filename candidates must contain between 1 and ${MAX_ITEMS} entries.`);
  const seenIds=new Set(),normalized=candidates.map((candidate,index)=>{
    const row=exactRecord(candidate,['id','label','mime'],`CAD filename candidate ${index+1}`),id=normalizedText(row.id,`CAD filename candidate ${index+1} id`,{maximum:240}),label=normalizedText(row.label,`CAD filename candidate ${index+1} label`,{maximum:240});
    if(seenIds.has(id))fail(`CAD filename candidates contain duplicate id ${id}.`);seenIds.add(id);
    if(!Object.hasOwn(IMAGE_MIMES,row.mime))fail(`CAD filename candidate ${id} has unsupported image media.`);
    let stem=label.normalize('NFKD').replace(/\p{Mark}/gu,'').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,96).replace(/-+$/,'')||'Image';
    if(RESERVED_NAME.test(stem))stem=`Image-${stem}`;return {id,stem,mime:row.mime};
  }).sort((left,right)=>compareText(left.id,right.id));
  const used=new Set(),counts=new Map(),result=[];
  for(const row of normalized){
    const key=row.stem.toLowerCase(),count=(counts.get(key)||0)+1;counts.set(key,count);let suffix=count===1?'':`-${count}`,path=`images/${row.stem}${suffix}.${IMAGE_MIMES[row.mime].extension}`;
    while(used.has(path.toLowerCase())){const next=(counts.get(key)||count)+1;counts.set(key,next);suffix=`-${next}`;path=`images/${row.stem}${suffix}.${IMAGE_MIMES[row.mime].extension}`;}
    used.add(path.toLowerCase());const base=withoutExtension(path);result.push(Object.freeze({id:row.id,path,worldFilePath:`${base}.${IMAGE_MIMES[row.mime].worldExtension}`}));
  }
  return Object.freeze(result);
}

export function buildCadManifest(input){
  const fields=exactRecord(input,INPUT_FIELDS,'CAD manifest input'),project=checkedProject(fields.project),company=checkedCompany(fields.companyProfile),crs=checkedCrs(fields.crs),files=checkedFiles(fields.files),fileByPath=new Map(files.map(file=>[file.path,file]));
  if(fields.rasterNormalization!==CAD_RASTER_NORMALIZATION)fail(`CAD manifest raster normalization must be exactly ${CAD_RASTER_NORMALIZATION}.`);
  const {items,imagePaths}=checkedItems(fields.items,fileByPath),logo=checkedLogo(company,files,fileByPath,fields.logoAttachment);crossCheckFiles(files,fileByPath,items,imagePaths,logo);
  const manifest={company:manifestCompany(company),crs,files,format:FORMAT,items,logoAttachment:logo,project,rasterNormalization:CAD_RASTER_NORMALIZATION,schemaVersion:SCHEMA_VERSION};
  return Object.freeze({json:stableJson(manifest),csv:csv(project,company,items,crs),sourcesText:sources(project,company,crs,items),readmeText:readme(project,crs),attachScript:attachmentScript(items,logo)});
}
