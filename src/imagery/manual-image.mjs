const PNG_SIGNATURE=[137,80,78,71,13,10,26,10];
const PNG_CRC_TABLE=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
const JPEG_SOF=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
const JPEG_MAX_MARKERS=1_000_000,JPEG_MAX_SEGMENTS=4_096,JPEG_MAX_SCANS=256;
const TIFF_GUIDANCE='Convert it to a single-image, uncompressed 8-bit RGB or grayscale GeoTIFF in EPSG:4326, EPSG:3857, or NAD83 UTM zone 15-18, or use PNG/JPEG with a matching world file.';
const SUPPORTED_CRS=new Set([4326,3857,26915,26916,26917,26918]);
const DECIMAL=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const HARD_MAX_BYTES=64_000_000,HARD_MAX_PIXELS=32_000_000;
const TIFF_TYPE_SIZES=new Map([[1,1],[2,1],[3,2],[4,4],[5,8],[6,1],[7,1],[8,2],[9,4],[10,8],[11,4],[12,8],[13,4]]);
const TIFF_MAX_IFD_ENTRIES=128,TIFF_MAX_TAG_VALUES=4096,TIFF_MAX_SEGMENTS=65_536,TIFF_MAX_TAG_BYTES=1_048_576;

function fail(message){throw new Error(message);}
function throwIfAborted(signal){if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new DOMException('Cancelled','AbortError');}
function positiveLimit(value,label){if(!Number.isSafeInteger(value)||value<=0)fail(`${label} must be a positive safe integer.`);}
function safeProduct(left,right,limit){return Number.isSafeInteger(left)&&Number.isSafeInteger(right)&&left>0&&right>0&&left<=Math.floor(limit/right);}
function values(value){return value===undefined?[]:typeof value==='number'?[value]:ArrayBuffer.isView(value)||Array.isArray(value)?Array.from(value):[];}
function scalar(value,fallback){const list=values(value);return list.length?list[0]:fallback;}

function abortable(work,signal,disposeLate=()=>{}){
  const promise=Promise.resolve(work);
  if(!signal)return promise;
  throwIfAborted(signal);
  return new Promise((resolve,reject)=>{
    let settled=false;
    const abort=()=>{if(!settled){settled=true;reject(signal.reason instanceof Error?signal.reason:new DOMException('Cancelled','AbortError'));}};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{
      signal.removeEventListener('abort',abort);
      if(settled){disposeLate(value);return;}settled=true;resolve(value);
    },error=>{signal.removeEventListener('abort',abort);if(!settled){settled=true;reject(error);}});
  });
}

function sniff(bytes){
  if(bytes.length>=8&&PNG_SIGNATURE.every((byte,index)=>bytes[index]===byte))return 'image/png';
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.length>=4&&((bytes[0]===0x49&&bytes[1]===0x49)||(bytes[0]===0x4d&&bytes[1]===0x4d))&&((bytes[2]===0x2a&&bytes[3]===0)||(bytes[2]===0&&bytes[3]===0x2a)||(bytes[2]===0x2b&&bytes[3]===0)||(bytes[2]===0&&bytes[3]===0x2b)))return 'image/tiff';
  fail('Image byte signature must be PNG, JPEG, or TIFF.');
}

function validateDeclaredType(file,mime){
  const expected={
    'image/png':new Set(['.png']),'image/jpeg':new Set(['.jpg','.jpeg','.jpe']),'image/tiff':new Set(['.tif','.tiff'])
  }[mime];
  if(typeof file.type==='string'&&file.type.trim()){
    const declared=file.type.trim().toLowerCase(),accepted=mime==='image/tiff'?new Set(['image/tiff','image/geotiff']):new Set([mime]);
    if(!accepted.has(declared))fail('Image MIME type does not match its byte signature.');
  }
  if(typeof file.name==='string'&&file.name.trim()){
    const match=/([.][^.\\/]+)$/.exec(file.name.trim().toLowerCase());
    if(match&&!expected.has(match[1]))fail('Image filename extension does not match its byte signature.');
  }
}

function pngCrc(bytes,start,end,signal){
  let crc=0xffffffff;
  for(let index=start;index<end;index++){if((index&0xfffff)===0)throwIfAborted(signal);crc=PNG_CRC_TABLE[(crc^bytes[index])&0xff]^(crc>>>8);}
  return (crc^0xffffffff)>>>0;
}

function pngDimensions(bytes,signal){
  if(bytes.length<33)fail('PNG structure is incomplete or invalid.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8,width=0,height=0,colorType=-1,sawIdat=false,idatBytes=0,idatState=0,sawPalette=false,sawEnd=false,chunks=0;
  while(offset<bytes.length){
    if(offset>bytes.length-12)fail('PNG chunk structure is truncated.');
    const length=view.getUint32(offset),data=offset+8,end=data+length;
    if(!Number.isSafeInteger(end)||end>bytes.length-4)fail('PNG chunk length is invalid.');
    const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));chunks++;
    if(pngCrc(bytes,offset+4,end,signal)!==view.getUint32(end))fail(`PNG ${type} chunk CRC is invalid.`);
    if(chunks===1){if(type!=='IHDR'||length!==13)fail('PNG IHDR is incomplete or invalid.');width=view.getUint32(data);height=view.getUint32(data+4);colorType=bytes[data+9];}
    else if(type==='IHDR')fail('PNG contains more than one IHDR.');
    if(type==='PLTE'){if(sawPalette||idatState!==0||length===0||length%3!==0||length>768||[0,4].includes(colorType))fail('PNG palette order or length is invalid.');sawPalette=true;}
    if(type==='IDAT'){
      if(idatState===2||(colorType===3&&!sawPalette))fail('PNG IDAT chunks are out of order.');
      sawIdat=true;idatState=1;
      if(idatBytes>Number.MAX_SAFE_INTEGER-length)fail('PNG image data length is unsafe.');idatBytes+=length;
    }else if(idatState===1)idatState=2;
    if(type==='IEND'){if(length!==0||end+4!==bytes.length)fail('PNG IEND is invalid or has trailing bytes.');sawEnd=true;break;}
    offset=end+4;
  }
  if(!width||!height||!sawIdat||idatBytes<8||!sawEnd)fail('PNG image data is incomplete or invalid.');
  return {width,height,orientation:1};
}

function exifOrientation(segment){
  if(segment.length<14||![69,120,105,102,0,0].every((byte,index)=>segment[index]===byte))return 1;
  const base=6,little=segment[base]===0x49&&segment[base+1]===0x49,big=segment[base]===0x4d&&segment[base+1]===0x4d;
  if(!little&&!big)return 1;
  const view=new DataView(segment.buffer,segment.byteOffset,segment.byteLength),get16=offset=>view.getUint16(offset,little),get32=offset=>view.getUint32(offset,little);
  if(get16(base+2)!==42)return 1;
  const directory=base+get32(base+4);if(directory+2>segment.length)return 1;
  const count=get16(directory);if(directory+2+count*12+4>segment.length)return 1;
  for(let index=0;index<count;index++){
    const entry=directory+2+index*12;
    if(get16(entry)===0x0112&&get16(entry+2)===3&&get32(entry+4)===1){const orientation=get16(entry+8);return orientation>=1&&orientation<=8?orientation:1;}
  }
  return 1;
}

function jpegDimensions(bytes,signal){
  let offset=2,width=0,height=0,orientation=1,sawFrame=false,sawScan=false,sawEnd=false,inEntropy=false,scanBytes=0,markerCount=0,segmentCount=0,scanCount=0,restartInterval=0,nextRestart=0;let frameComponents=new Set();
  const countMarker=()=>{if(++markerCount>JPEG_MAX_MARKERS)fail(`JPEG exceeds the ${JPEG_MAX_MARKERS} marker limit.`);};
  const validDqt=data=>{let cursor=0;while(cursor<data.length){const table=data[cursor++],precision=table>>4;if(precision>1||(table&15)>3)return false;cursor+=precision?128:64;if(cursor>data.length)return false;}return cursor===data.length&&cursor>0;};
  const validDht=data=>{let cursor=0;while(cursor<data.length){if(cursor+17>data.length)return false;const table=data[cursor++];if((table>>4)>1||(table&15)>3)return false;let values=0;for(let index=0;index<16;index++)values+=data[cursor+index];cursor+=16+values;if(cursor>data.length)return false;}return cursor===data.length&&cursor>0;};
  while(offset<bytes.length){
    throwIfAborted(signal);let marker,fromEntropy=false;
    if(inEntropy){
      if(bytes[offset]!==0xff){scanBytes++;offset++;continue;}
      while(offset<bytes.length&&bytes[offset]===0xff)offset++;
      if(offset>=bytes.length)fail('JPEG entropy data is truncated after a marker prefix.');
      marker=bytes[offset++];countMarker();
      if(marker===0){scanBytes++;continue;}
      if(marker>=0xd0&&marker<=0xd7){if(!restartInterval||scanBytes===0||marker!==0xd0+nextRestart)fail('JPEG restart marker is missing its interval, out of sequence, or has no preceding entropy data.');nextRestart=(nextRestart+1)%8;scanBytes=0;continue;}
      if(marker===0x01)continue;
      if(scanBytes===0)fail('JPEG scan contains no entropy-coded data.');
      inEntropy=false;fromEntropy=true;
    }else{
      if(bytes[offset]!==0xff)fail('JPEG contains entropy bytes outside a scan.');
      while(offset<bytes.length&&bytes[offset]===0xff)offset++;
      if(offset>=bytes.length)fail('JPEG marker prefix is truncated.');
      marker=bytes[offset++];countMarker();
      if(marker===0||marker===0x01||marker>=0xd0&&marker<=0xd7)fail('JPEG contains an unexpected standalone or restart marker outside entropy data.');
    }
    if(marker===0xd9){if(!sawScan||offset!==bytes.length)fail('JPEG EOI is missing, premature, or followed by trailing data.');sawEnd=true;break;}
    if(marker===0xd8)fail('JPEG contains an unexpected duplicate SOI marker.');
    const lengthBearing=JPEG_SOF.has(marker)||[0xc4,0xcc,0xda,0xdb,0xdc,0xdd,0xfe].includes(marker)||marker>=0xe0&&marker<=0xef;
    if(!lengthBearing)fail(`JPEG contains unsupported marker 0x${marker.toString(16).padStart(2,'0')}.`);
    if(++segmentCount>JPEG_MAX_SEGMENTS)fail(`JPEG exceeds the ${JPEG_MAX_SEGMENTS} segment limit.`);
    if(offset+2>bytes.length)fail('JPEG marker segment is truncated.');
    const length=bytes[offset]<<8|bytes[offset+1];
    if(length<2||offset>bytes.length-length)fail('JPEG marker segment length is invalid or truncated.');
    const data=bytes.subarray(offset+2,offset+length);offset+=length;
    if(marker===0xe1)orientation=exifOrientation(data);
    if(JPEG_SOF.has(marker)){
      if(sawFrame||sawScan)fail('JPEG contains multiple or misplaced frame headers.');
      if(data.length<6)fail('JPEG frame header is incomplete.');
      const components=data[5];if(components<1||components>4||data.length!==6+components*3)fail('JPEG frame header component length is invalid.');
      frameComponents=new Set();for(let index=0;index<components;index++)frameComponents.add(data[6+index*3]);if(frameComponents.size!==components)fail('JPEG frame repeats a component identifier.');
      height=data[1]<<8|data[2];width=data[3]<<8|data[4];sawFrame=true;
    }else if(marker===0xdb&&!validDqt(data))fail('JPEG DQT segment length or table structure is invalid.');
    else if(marker===0xc4&&!validDht(data))fail('JPEG DHT segment length or table structure is invalid.');
    else if(marker===0xdd){if(data.length!==2)fail('JPEG DRI segment must contain exactly two data bytes.');restartInterval=data[0]<<8|data[1];}
    else if(marker===0xcc&&(data.length<2||data.length%2!==0))fail('JPEG DAC segment length is invalid.');
    else if(marker===0xdc){
      if(!fromEntropy||data.length!==2)fail('JPEG DNL is misplaced or has an invalid length.');
      const lines=data[0]<<8|data[1];if(!lines||height&&height!==lines)fail('JPEG DNL conflicts with its frame dimensions.');height=lines;inEntropy=true;
    }else if(marker===0xda){
      if(!sawFrame)fail('JPEG scan appears before its frame header.');
      const components=data[0];if(components<1||components>frameComponents.size||data.length!==4+components*2)fail('JPEG SOS component length is invalid.');
      const selectors=new Set();for(let index=0;index<components;index++){const selector=data[1+index*2];if(!frameComponents.has(selector)||selectors.has(selector))fail('JPEG SOS references a missing or repeated frame component.');selectors.add(selector);}
      if(++scanCount>JPEG_MAX_SCANS)fail(`JPEG exceeds the ${JPEG_MAX_SCANS} scan limit.`);
      sawScan=true;inEntropy=true;scanBytes=0;nextRestart=0;
    }
  }
  if(!width||!height||!sawFrame||!sawScan||!sawEnd||inEntropy||offset!==bytes.length)fail('JPEG image data is incomplete or invalid.');
  return {width,height,orientation};
}

async function defaultBitmapDecoder(blob,{signal}={}){
  if(typeof globalThis.createImageBitmap==='function')return globalThis.createImageBitmap(blob,{imageOrientation:'none'});
  const ImageConstructor=globalThis.Image,makeUrl=globalThis.URL?.createObjectURL?.bind(globalThis.URL),revokeUrl=globalThis.URL?.revokeObjectURL?.bind(globalThis.URL);
  if(typeof ImageConstructor!=='function'||typeof makeUrl!=='function'||typeof revokeUrl!=='function')fail('This browser cannot decode the selected image. Use a current browser.');
  const url=makeUrl(blob);
  try{
    return await new Promise((resolve,reject)=>{
      const image=new ImageConstructor(),abort=()=>reject(signal.reason instanceof Error?signal.reason:new DOMException('Cancelled','AbortError'));
      image.onload=()=>{signal?.removeEventListener('abort',abort);resolve(image);};
      image.onerror=()=>{signal?.removeEventListener('abort',abort);reject(new Error('The PNG or JPEG image could not be decoded.'));};
      signal?.addEventListener('abort',abort,{once:true});image.src=url;
    });
  }finally{revokeUrl(url);}
}

async function decodeBrowserImage(bytes,mime,{signal,maxPixels,decodeBitmap}){
  const header=mime==='image/png'?pngDimensions(bytes,signal):jpegDimensions(bytes,signal);
  if(!safeProduct(header.width,header.height,maxPixels))fail(`Decoded image exceeds the ${maxPixels} pixel limit.`);
  const blob=new Blob([bytes],{type:mime}),decoder=decodeBitmap||defaultBitmapDecoder;
  let bitmap;
  try{
    bitmap=await abortable(decoder(blob,{signal,mime,orientation:header.orientation,imageOrientation:'none'}),signal,value=>value?.close?.());
    throwIfAborted(signal);
    if(!Number.isSafeInteger(bitmap?.width)||!Number.isSafeInteger(bitmap?.height)||bitmap.width<=0||bitmap.height<=0)fail('The image decoder returned invalid dimensions.');
    const swaps=header.orientation>=5&&header.orientation<=8,width=swaps?header.height:header.width,height=swaps?header.width:header.height;
    const rawDimensions=bitmap.width===header.width&&bitmap.height===header.height,orientedDimensions=swaps&&bitmap.width===width&&bitmap.height===height;
    if(!rawDimensions&&!orientedDimensions)fail('Decoded image dimensions do not match its byte header and EXIF orientation.');
    if(!safeProduct(width,height,maxPixels))fail(`Decoded image exceeds the ${maxPixels} pixel limit.`);
    return {blob,mime,width,height,geo:null};
  }catch(error){
    if(error?.name==='AbortError')throw error;
    if(error instanceof Error&&/pixel limit|dimensions/.test(error.message))throw error;
    throw new Error('The PNG or JPEG image could not be decoded.',{cause:error});
  }finally{bitmap?.close?.();}
}

function conversionFailure(message){fail(`${message} ${TIFF_GUIDANCE}`);}

function preflightClassicTiff(bytes,{signal,maxBytes,maxPixels}){
  if(bytes.length<8)conversionFailure('This TIFF has a truncated classic header.');
  const little=bytes[0]===0x49&&bytes[1]===0x49,big=bytes[0]===0x4d&&bytes[1]===0x4d;
  if(!little&&!big)conversionFailure('This TIFF has an invalid byte-order marker.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),get16=offset=>view.getUint16(offset,little),get32=offset=>view.getUint32(offset,little);
  const magic=get16(2);
  if(magic===43)conversionFailure('BigTIFF is not supported by the bounded classic TIFF decoder.');
  if(magic!==42)conversionFailure('This TIFF has an unsupported classic header.');
  const inRange=(offset,length)=>Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&offset<=bytes.length-length;
  const ifdOffset=get32(4);
  if(!inRange(ifdOffset,2)||ifdOffset<8)conversionFailure('This TIFF first IFD offset is outside the selected file.');
  const entryCount=get16(ifdOffset);
  if(entryCount>TIFF_MAX_IFD_ENTRIES)conversionFailure(`This TIFF IFD exceeds the ${TIFF_MAX_IFD_ENTRIES} entry allocation limit.`);
  const directoryBytes=2+entryCount*12+4;
  if(!inRange(ifdOffset,directoryBytes))conversionFailure('This TIFF IFD is truncated or escapes the selected file.');
  const entries=new Map();let declaredTagBytes=0;
  for(let index=0;index<entryCount;index++){
    if((index&31)===0)throwIfAborted(signal);
    const offset=ifdOffset+2+index*12,tag=get16(offset),type=get16(offset+2),count=get32(offset+4),typeSize=TIFF_TYPE_SIZES.get(type);
    if(entries.has(tag))conversionFailure(`This TIFF repeats tag ${tag}, making the image ambiguous.`);
    if(!typeSize)conversionFailure(`This TIFF tag ${tag} has an unsupported classic field type.`);
    const countLimit=new Set([273,279,324,325]).has(tag)?TIFF_MAX_SEGMENTS:TIFF_MAX_TAG_VALUES;
    if((count===0&&tag!==338)||count>countLimit)conversionFailure(`This TIFF tag ${tag} exceeds its bounded value-count allocation.`);
    if(count>Math.floor(Number.MAX_SAFE_INTEGER/typeSize))conversionFailure(`This TIFF tag ${tag} count overflows its field size.`);
    const byteLength=count*typeSize;
    if(byteLength>TIFF_MAX_TAG_BYTES||declaredTagBytes>TIFF_MAX_TAG_BYTES-byteLength)conversionFailure('This TIFF IFD declares too much tag allocation.');
    declaredTagBytes+=byteLength;
    const dataOffset=byteLength<=4?offset+8:get32(offset+8);
    if(!inRange(dataOffset,byteLength))conversionFailure(`This TIFF tag ${tag} value offset or range escapes the selected file.`);
    entries.set(tag,{tag,type,count,byteLength,dataOffset,offset});
  }
  const nextOffset=get32(ifdOffset+2+entryCount*12);
  if(nextOffset===ifdOffset)conversionFailure('This TIFF contains a cyclic IFD chain.');
  if(nextOffset!==0){
    if(!inRange(nextOffset,2))conversionFailure('This TIFF next-IFD offset escapes the selected file.');
    conversionFailure('Multiple TIFF IFDs or pyramid images are ambiguous; use one classic TIFF image.');
  }
  if(entries.has(330))conversionFailure('SubIFD pyramids are ambiguous and are not supported.');

  const unsignedValues=(tag,allowedTypes,label,{required=true}={})=>{
    const entry=entries.get(tag);
    if(!entry){if(required)conversionFailure(`This TIFF is missing ${label}.`);return [];}
    if(!allowedTypes.includes(entry.type))conversionFailure(`This TIFF ${label} uses an unsupported field type.`);
    const result=new Array(entry.count);
    for(let index=0;index<entry.count;index++){
      if((index&4095)===0)throwIfAborted(signal);
      const offset=entry.dataOffset+index*TIFF_TYPE_SIZES.get(entry.type);
      result[index]=entry.type===1?view.getUint8(offset):entry.type===3?get16(offset):get32(offset);
    }
    return result;
  };
  const scalarTag=(tag,label,{required=true}={})=>{
    const entry=entries.get(tag);
    if(!entry){if(required)conversionFailure(`This TIFF is missing ${label}.`);return undefined;}
    if(entry.count!==1)conversionFailure(`This TIFF ${label} must contain exactly one value.`);
    return unsignedValues(tag,[3,4],label)[0];
  };
  const width=scalarTag(256,'image width'),height=scalarTag(257,'image height'),samples=scalarTag(277,'samples per pixel');
  if(!safeProduct(width,height,maxPixels))conversionFailure(`This TIFF dimensions exceed the ${maxPixels} pixel allocation limit.`);
  if(!Number.isInteger(samples)||samples<1||samples>4||!safeProduct(width*height,samples,maxPixels*4))conversionFailure('This TIFF sample allocation is unsafe.');
  const exactBandTag=(tag,label)=>{const entry=entries.get(tag);if(!entry||entry.count!==samples)conversionFailure(`This TIFF ${label} must declare one value per sample.`);};
  exactBandTag(258,'bits per sample');exactBandTag(339,'sample format');
  scalarTag(259,'compression');scalarTag(262,'photometric interpretation');scalarTag(284,'planar configuration');
  const extra=entries.get(338);if(extra&&extra.count>1)conversionFailure('This TIFF declares too many extra samples.');

  const scale=entries.get(33550),tie=entries.get(33922),matrix=entries.get(34264);
  if(matrix){if(matrix.type!==12||matrix.count!==16)conversionFailure('This TIFF model transformation must contain exactly 16 doubles.');if(scale||tie)conversionFailure('This TIFF contains conflicting affine georeferences.');}
  else if(!scale||scale.type!==12||scale.count!==3||!tie||tie.type!==12||tie.count!==6)conversionFailure('This TIFF must contain one bounded scale/tie-point georeference.');

  const geoEntry=entries.get(34735);
  if(!geoEntry||geoEntry.type!==3||geoEntry.count<4||geoEntry.count>128)conversionFailure('This TIFF has a missing or unsafe GeoKey directory.');
  const geo=unsignedValues(34735,[3],'GeoKey directory');
  const keyCount=geo[3];
  if(geo[0]!==1||geo[1]!==1||geo[2]>1||geo.length!==4+keyCount*4)conversionFailure('This TIFF GeoKey directory structure is invalid.');
  const seenKeys=new Set();
  for(let index=0;index<keyCount;index++){
    const base=4+index*4,key=geo[base],location=geo[base+1],count=geo[base+2],valueOffset=geo[base+3];
    if(seenKeys.has(key)||count===0){conversionFailure('This TIFF GeoKey directory is duplicated or empty.');}seenKeys.add(key);
    if(location===0){if(count!==1)conversionFailure('This TIFF inline GeoKey has an unsafe count.');continue;}
    if(![34735,34736,34737].includes(location))conversionFailure('This TIFF GeoKey references an unsupported tag.');
    const source=entries.get(location);
    if(!source||valueOffset>source.count||count>source.count-valueOffset)conversionFailure('This TIFF GeoKey value range escapes its parameter tag.');
  }

  const stripOffsets=entries.get(273),stripCounts=entries.get(279),tileOffsets=entries.get(324),tileCounts=entries.get(325);
  if((stripOffsets||stripCounts)&&(tileOffsets||tileCounts))conversionFailure('This TIFF mixes strip and tile allocations.');
  let offsetsEntry,countsEntry,expectedSegments,allocationLabel;
  if(tileOffsets||tileCounts){
    if(!tileOffsets||!tileCounts)conversionFailure('This TIFF tile allocation is incomplete.');
    const tileWidth=scalarTag(322,'tile width'),tileHeight=scalarTag(323,'tile height');
    if(!safeProduct(tileWidth,tileHeight,maxPixels)||!safeProduct(tileWidth*tileHeight,samples,maxPixels*4))conversionFailure('This TIFF tile dimensions declare an unsafe allocation.');
    expectedSegments=Math.ceil(width/tileWidth)*Math.ceil(height/tileHeight);offsetsEntry=tileOffsets;countsEntry=tileCounts;allocationLabel='tile';
  }else{
    if(!stripOffsets||!stripCounts)conversionFailure('This TIFF strip allocation is incomplete.');
    const rows=scalarTag(278,'rows per strip');
    if(!Number.isSafeInteger(rows)||rows<=0||rows>height||!safeProduct(width,rows,maxPixels)||!safeProduct(width*rows,samples,maxPixels*4))conversionFailure('This TIFF strip dimensions declare an unsafe allocation.');
    expectedSegments=Math.ceil(height/rows);offsetsEntry=stripOffsets;countsEntry=stripCounts;allocationLabel='strip';
  }
  if(!Number.isSafeInteger(expectedSegments)||expectedSegments<=0||expectedSegments>TIFF_MAX_SEGMENTS||offsetsEntry.count!==expectedSegments||countsEntry.count!==expectedSegments)conversionFailure(`This TIFF ${allocationLabel} array cardinality is unsafe or inconsistent with its dimensions.`);
  const offsets=unsignedValues(offsetsEntry.tag,[3,4],`${allocationLabel} offsets`),counts=unsignedValues(countsEntry.tag,[3,4],`${allocationLabel} byte counts`);let rasterBytes=0;
  for(let index=0;index<expectedSegments;index++){
    if((index&4095)===0)throwIfAborted(signal);
    const offset=offsets[index],count=counts[index];
    if(!Number.isSafeInteger(count)||count<=0||count>maxBytes-rasterBytes||!inRange(offset,count))conversionFailure(`This TIFF ${allocationLabel} byte range or declared allocation is unsafe.`);
    rasterBytes+=count;
  }
  return {width,height,samples,rasterBytes};
}

function geotiffCrs(keys){
  const key=(name,{required=false}={})=>{const list=values(keys?.[name]);if(list.length>1||required&&list.length!==1)conversionFailure(`This GeoTIFF has missing or conflicting ${name} metadata.`);return list[0];};
  const model=key('GTModelTypeGeoKey',{required:true}),projected=key('ProjectedCSTypeGeoKey'),geographic=key('GeographicTypeGeoKey');
  if(projected!==undefined&&geographic!==undefined)conversionFailure('This GeoTIFF contains conflicting projected and geographic CRS keys.');
  const code=projected??geographic;
  if(!Number.isInteger(code)||!SUPPORTED_CRS.has(code))conversionFailure('This GeoTIFF has an unsupported CRS.');
  if(code===4326){
    if(model!==2||projected!==undefined)conversionFailure('EPSG:4326 requires the geographic GeoTIFF model type.');
    if(key('GeogAngularUnitsGeoKey',{required:true})!==9102)conversionFailure('EPSG:4326 coordinates must explicitly use degree angular units.');
    if(key('ProjLinearUnitsGeoKey')!==undefined)conversionFailure('EPSG:4326 contains conflicting projected linear units.');
  }else{
    if(model!==1||geographic!==undefined)conversionFailure(`EPSG:${code} requires the projected GeoTIFF model type.`);
    if(key('ProjLinearUnitsGeoKey',{required:true})!==9001)conversionFailure(`EPSG:${code} coordinates must explicitly use metre linear units.`);
    if(key('GeogAngularUnitsGeoKey')!==undefined)conversionFailure(`EPSG:${code} contains conflicting geographic angular units.`);
    if(code>=26915&&code<=26918){
      const zone=code-26900,expectedLongitude=zone*6-183;
      const projection=key('ProjectionGeoKey'),method=key('ProjCoordTransGeoKey'),originLongitude=key('ProjNatOriginLongGeoKey'),originLatitude=key('ProjNatOriginLatGeoKey'),falseEasting=key('ProjFalseEastingGeoKey'),falseNorthing=key('ProjFalseNorthingGeoKey');
      if(projection!==undefined&&projection!==16000+zone)conversionFailure(`EPSG:${code} contains a conflicting UTM zone or hemisphere projection key.`);
      if(method!==undefined&&method!==1)conversionFailure(`EPSG:${code} requires the Transverse Mercator method.`);
      if(originLongitude!==undefined&&Math.abs(originLongitude-expectedLongitude)>1e-9)conversionFailure(`EPSG:${code} contains a conflicting UTM zone central meridian.`);
      if(originLatitude!==undefined&&Math.abs(originLatitude)>1e-9)conversionFailure(`EPSG:${code} contains a conflicting UTM latitude of origin.`);
      if(falseEasting!==undefined&&Math.abs(falseEasting-500_000)>1e-6)conversionFailure(`EPSG:${code} contains a conflicting UTM false easting.`);
      if(falseNorthing!==undefined&&Math.abs(falseNorthing)>1e-6)conversionFailure(`EPSG:${code} contains a conflicting UTM hemisphere false northing.`);
    }
  }
  return `EPSG:${code}`;
}

function geotiffTransform(directory,keys){
  const rasterType=scalar(keys?.GTRasterTypeGeoKey,1);if(rasterType!==1&&rasterType!==2)conversionFailure('This GeoTIFF has an unsupported raster pixel convention.');
  const offset=rasterType===1?.5:0,model=values(directory.ModelTransformation);
  if(model.length){
    if(model.length!==16||model.some(value=>!Number.isFinite(value))||model[2]!==0||model[6]!==0||model[8]!==0||model[9]!==0||model[10]!==1||model[11]!==0||model[12]!==0||model[13]!==0||model[14]!==0||model[15]!==1)conversionFailure('This GeoTIFF has an unsupported model transformation.');
    return [model[0],model[4],model[1],model[5],model[3]+offset*(model[0]+model[1]),model[7]+offset*(model[4]+model[5])];
  }
  const scale=values(directory.ModelPixelScale),tie=values(directory.ModelTiepoint);
  if(scale.length<2||tie.length!==6||scale.some(value=>!Number.isFinite(value))||tie.some(value=>!Number.isFinite(value))||scale[0]<=0||scale[1]<=0)conversionFailure('This GeoTIFF is missing a supported affine georeference.');
  return [scale[0],0,0,-scale[1],tie[3]-tie[0]*scale[0]+offset*scale[0],tie[4]+tie[1]*scale[1]-offset*scale[1]];
}

function validateTiffDirectory(image,directory,width,height,maxBytes,maxPixels,fileBytes){
  const samples=image.getSamplesPerPixel(),compression=scalar(directory.Compression,1),photometric=scalar(directory.PhotometricInterpretation,1),planar=scalar(directory.PlanarConfiguration,1);
  const bits=values(directory.BitsPerSample),formats=values(directory.SampleFormat),extra=values(directory.ExtraSamples);
  if(scalar(directory.Orientation,1)!==1)conversionFailure('This GeoTIFF uses an unsupported orientation; only top-left orientation is accepted.');
  if(compression!==1)conversionFailure('This GeoTIFF uses unsupported compression.');
  if(planar!==1)conversionFailure('This GeoTIFF uses unsupported planar sample storage.');
  const grayscale=photometric===1&&samples===1&&extra.length===0,rgb=photometric===2&&samples===3&&extra.length===0,rgba=photometric===2&&samples===4&&extra.length===1&&extra[0]===2;
  if(!grayscale&&!rgb&&!rgba)conversionFailure('This GeoTIFF photometric/sample layout is unsupported; WhiteIsZero, palette, CMYK, and associated alpha are not rendered safely.');
  if(bits.length!==samples||bits.some(value=>value!==8)||formats.length!==samples||formats.some(value=>value!==1))conversionFailure('This GeoTIFF must explicitly use unsigned 8-bit samples for every band.');
  if(!safeProduct(width,height,maxPixels))conversionFailure(`This GeoTIFF exceeds the ${maxPixels} pixel limit.`);
  if(!safeProduct(width*height,samples,Math.min(Number.MAX_SAFE_INTEGER,maxPixels*4)))conversionFailure('This GeoTIFF decoded byte allocation is unsafe.');
  const counts=values(directory.TileByteCounts??directory.StripByteCounts),offsets=values(directory.TileOffsets??directory.StripOffsets);
  if(!counts.length||counts.length!==offsets.length||counts.some(value=>!Number.isSafeInteger(value)||value<0)||offsets.some(value=>!Number.isSafeInteger(value)||value<0)||counts.reduce((sum,value)=>sum+value,0)>maxBytes)conversionFailure('This GeoTIFF declares an unsafe tile or strip byte allocation.');
  if(counts.some((count,index)=>offsets[index]>fileBytes-count))conversionFailure('This GeoTIFF tile or strip allocation escapes the selected file.');
  if(directory.TileWidth!==undefined||directory.TileLength!==undefined){
    const tileWidth=scalar(directory.TileWidth,0),tileHeight=scalar(directory.TileLength,0);
    if(!safeProduct(tileWidth,tileHeight,maxPixels)||!safeProduct(tileWidth*tileHeight,samples,maxPixels*4))conversionFailure('This GeoTIFF declares an unsafe tile allocation.');
  }else{
    const rows=scalar(directory.RowsPerStrip,height);
    if(!Number.isSafeInteger(rows)||rows<=0||rows>height||!safeProduct(width,rows,maxPixels)||!safeProduct(width*rows,samples,maxPixels*4))conversionFailure('This GeoTIFF declares an unsafe strip allocation.');
  }
  return samples;
}

async function loadedDirectory(directory,{signal,maxPixels}){
  if(typeof directory?.loadValue!=='function')return directory;
  for(const deferred of directory.deferredArrays?.values?.()||[])if(!Number.isSafeInteger(deferred.length)||deferred.length>maxPixels)conversionFailure('This GeoTIFF declares an unsafe deferred tag allocation.');
  const tags=['Compression','BitsPerSample','SampleFormat','PhotometricInterpretation','SamplesPerPixel','PlanarConfiguration','ExtraSamples',
    'Orientation','RowsPerStrip','StripByteCounts','StripOffsets','TileWidth','TileLength','TileByteCounts','TileOffsets','ModelPixelScale','ModelTiepoint','ModelTransformation'];
  const loaded={};
  for(const tag of tags){throwIfAborted(signal);const value=await abortable(directory.loadValue(tag),signal);if(value!==undefined)loaded[tag]=value;}
  return loaded;
}

async function defaultGeotiffLoader(){
  if(typeof document==='undefined')return import('geotiff');
  await import(new URL('../../vendor/geotiff.js',import.meta.url).href);
  if(!globalThis.GeoTIFF?.fromArrayBuffer)fail('The staged GeoTIFF browser decoder did not initialize.');
  return globalThis.GeoTIFF;
}

async function defaultEncodeRaster({rgba,width,height,signal}){
  throwIfAborted(signal);
  const document=globalThis.document;if(!document?.createElement)fail('A browser canvas is required to convert GeoTIFF pixels to PNG.');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const clear=()=>{canvas.width=0;canvas.height=0;};signal?.addEventListener('abort',clear,{once:true});
  try{
    const context=canvas.getContext('2d');if(!context)fail('The browser could not allocate a GeoTIFF canvas.');
    const data=context.createImageData(width,height);data.data.set(rgba);context.putImageData(data,0,0);throwIfAborted(signal);
    if(typeof canvas.convertToBlob==='function')return await canvas.convertToBlob({type:'image/png'});
    return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('GeoTIFF PNG encoding failed.')),'image/png'));
  }finally{signal?.removeEventListener('abort',clear);clear();}
}

async function decodeGeoTiff(bytes,{signal,maxBytes,maxPixels,geotiffLoader,encodeRaster}){
  const preflight=preflightClassicTiff(bytes,{signal,maxBytes,maxPixels});throwIfAborted(signal);
  const module=await abortable((geotiffLoader||defaultGeotiffLoader)(),signal);throwIfAborted(signal);
  if(typeof module?.fromArrayBuffer!=='function')fail('GeoTIFF decoder boundary is unavailable.');
  const buffer=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength?bytes.buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  const tiff=await abortable(module.fromArrayBuffer(buffer,signal),signal),count=await abortable(tiff.getImageCount(),signal);
  if(count!==1)conversionFailure('Multi-image or pyramid GeoTIFFs are ambiguous; use a single-image file.');
  const image=await abortable(tiff.getImage(0),signal);throwIfAborted(signal);
  const width=image.getWidth(),height=image.getHeight();
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width!==preflight.width||height!==preflight.height)conversionFailure('This GeoTIFF declares invalid or inconsistent raster dimensions.');
  const directory=await loadedDirectory(image.getFileDirectory(),{signal,maxPixels}),samples=validateTiffDirectory(image,directory,width,height,maxBytes,maxPixels,bytes.byteLength);
  if(samples!==preflight.samples)conversionFailure('This GeoTIFF sample allocation changed after bounded preflight.');
  const geo={crs:geotiffCrs(image.getGeoKeys()),transform:geotiffTransform(directory,image.getGeoKeys())};throwIfAborted(signal);
  const raster=await abortable(image.readRasters({interleave:true,signal}),signal);throwIfAborted(signal);
  const pixelCount=width*height;if(!raster||raster.length!==pixelCount*samples)conversionFailure('This GeoTIFF decoded to an unexpected raster allocation.');
  const rgba=new Uint8ClampedArray(pixelCount*4);
  for(let pixel=0;pixel<pixelCount;pixel++){
    const source=pixel*samples,target=pixel*4;
    if(samples===1)rgba[target]=rgba[target+1]=rgba[target+2]=raster[source];
    else{rgba[target]=raster[source];rgba[target+1]=raster[source+1];rgba[target+2]=raster[source+2];}
    rgba[target+3]=samples===4?raster[source+3]:255;
  }
  throwIfAborted(signal);
  const blob=await abortable((encodeRaster||defaultEncodeRaster)({rgba,width,height,signal}),signal);throwIfAborted(signal);
  if(!(blob instanceof Blob)||blob.type!=='image/png'||blob.size<=0||blob.size>maxBytes)fail(`Decoded GeoTIFF PNG must be nonempty and within the ${maxBytes} byte limit.`);
  return {blob,mime:'image/png',width,height,geo};
}

/**
 * World-file records are A,D,B,E,C,F. The returned Canvas-order affine maps
 * zero-based pixel centres: X=a*column+c*row+e; Y=b*column+d*row+f.
 */
export function parseWorldFile(text){
  if(typeof text!=='string')fail('World file must be text with exactly six records.');
  const records=text.replace(/\r\n?/g,'\n').split('\n');while(records.length&&records.at(-1).trim()==='')records.pop();
  if(records.length!==6||records.some(record=>record.trim()===''))fail('World file must contain exactly six nonblank numeric records and no trailing record.');
  const numbers=records.map(record=>{const token=record.trim();if(!DECIMAL.test(token))fail('World file records must be locale-independent finite decimal numbers.');const value=Number(token);if(!Number.isFinite(value))fail('World file records must be finite numbers.');return value;});
  const [A,D,B,E,C,F]=numbers;return [A,D,B,E,C,F];
}

export async function decodeManualImage(file,{
  signal,maxBytes=64_000_000,maxPixels=32_000_000,readBytes,decodeBitmap,geotiffLoader,encodeRaster
}={}){
  positiveLimit(maxBytes,'Manual image byte limit');positiveLimit(maxPixels,'Manual image pixel limit');throwIfAborted(signal);
  if(maxBytes>HARD_MAX_BYTES)fail(`Manual image byte limit cannot exceed the ${HARD_MAX_BYTES} byte safety maximum.`);
  if(maxPixels>HARD_MAX_PIXELS)fail(`Manual image pixel limit cannot exceed the ${HARD_MAX_PIXELS} pixel safety maximum.`);
  if(!file||!Number.isSafeInteger(file.size)||file.size<=0||typeof file.arrayBuffer!=='function')fail('Choose a nonempty PNG, JPEG, or TIFF file.');
  if(file.size>maxBytes)fail(`Manual image exceeds the ${maxBytes} byte limit.`);
  const source=await abortable((readBytes||((value)=>value.arrayBuffer()))(file,{signal,maxBytes}),signal);throwIfAborted(signal);
  const bytes=source instanceof Uint8Array?source:ArrayBuffer.isView(source)?new Uint8Array(source.buffer,source.byteOffset,source.byteLength):source instanceof ArrayBuffer?new Uint8Array(source):null;
  if(!bytes||bytes.byteLength!==file.size||bytes.byteLength>maxBytes)fail('Manual image bytes do not match the bounded file size.');
  const mime=sniff(bytes);validateDeclaredType(file,mime);
  if(mime!=='image/tiff')return decodeBrowserImage(bytes,mime,{signal,maxPixels,decodeBitmap});
  try{return await decodeGeoTiff(bytes,{signal,maxBytes,maxPixels,geotiffLoader,encodeRaster});}
  catch(error){
    if(error?.name==='AbortError'||error?.message?.includes(TIFF_GUIDANCE)||/decoder boundary|browser canvas|decoder did not initialize/i.test(error?.message||''))throw error;
    throw new Error(`This TIFF could not be safely decoded. ${TIFF_GUIDANCE}`,{cause:error});
  }
}
