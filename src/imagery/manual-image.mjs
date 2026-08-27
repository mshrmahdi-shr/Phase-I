const PNG_SIGNATURE=[137,80,78,71,13,10,26,10];
const JPEG_SOF=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
const TIFF_GUIDANCE='Convert it to a single-image, uncompressed 8-bit RGB or grayscale GeoTIFF in EPSG:4326, EPSG:3857, or NAD83 UTM zone 15-18, or use PNG/JPEG with a matching world file.';
const SUPPORTED_CRS=new Set([4326,3857,26915,26916,26917,26918]);
const DECIMAL=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const HARD_MAX_BYTES=64_000_000,HARD_MAX_PIXELS=32_000_000;

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
  if(bytes.length>=4&&((bytes[0]===0x49&&bytes[1]===0x49&&bytes[2]===0x2a&&bytes[3]===0)||(bytes[0]===0x4d&&bytes[1]===0x4d&&bytes[2]===0&&bytes[3]===0x2a)))return 'image/tiff';
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

function pngDimensions(bytes){
  if(bytes.length<24||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR')fail('PNG header is incomplete or invalid.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=view.getUint32(16),height=view.getUint32(20);
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

function jpegDimensions(bytes){
  let offset=2,width=0,height=0,orientation=1;
  while(offset<bytes.length){
    while(offset<bytes.length&&bytes[offset]===0xff)offset++;
    if(offset>=bytes.length)break;
    const marker=bytes[offset++];
    if(marker===0xd9||marker===0xda)break;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(offset+2>bytes.length)fail('JPEG marker is truncated.');
    const length=bytes[offset]<<8|bytes[offset+1];if(length<2||offset+length>bytes.length)fail('JPEG marker length is invalid.');
    const data=bytes.subarray(offset+2,offset+length);
    if(marker===0xe1)orientation=exifOrientation(data);
    if(JPEG_SOF.has(marker)){
      if(data.length<6)fail('JPEG frame header is incomplete.');
      height=data[1]<<8|data[2];width=data[3]<<8|data[4];
    }
    offset+=length;
  }
  if(!width||!height)fail('JPEG has no supported frame dimensions.');
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
  const header=mime==='image/png'?pngDimensions(bytes):jpegDimensions(bytes);
  if(!safeProduct(header.width,header.height,maxPixels))fail(`Decoded image exceeds the ${maxPixels} pixel limit.`);
  const blob=new Blob([bytes],{type:mime}),decoder=decodeBitmap||defaultBitmapDecoder;
  let bitmap;
  try{
    bitmap=await abortable(decoder(blob,{signal,mime,orientation:header.orientation,imageOrientation:'none'}),signal,value=>value?.close?.());
    throwIfAborted(signal);
    if(!Number.isSafeInteger(bitmap?.width)||!Number.isSafeInteger(bitmap?.height)||bitmap.width<=0||bitmap.height<=0)fail('The image decoder returned invalid dimensions.');
    if(bitmap.width!==header.width||bitmap.height!==header.height)fail('Decoded image dimensions do not match its byte header.');
    const swaps=header.orientation>=5&&header.orientation<=8,width=swaps?bitmap.height:bitmap.width,height=swaps?bitmap.width:bitmap.height;
    if(!safeProduct(width,height,maxPixels))fail(`Decoded image exceeds the ${maxPixels} pixel limit.`);
    return {blob,mime,width,height,geo:null};
  }catch(error){
    if(error?.name==='AbortError')throw error;
    if(error instanceof Error&&/pixel limit|dimensions/.test(error.message))throw error;
    throw new Error('The PNG or JPEG image could not be decoded.',{cause:error});
  }finally{bitmap?.close?.();}
}

function conversionFailure(message){fail(`${message} ${TIFF_GUIDANCE}`);}

function geotiffCrs(keys){
  const projected=scalar(keys?.ProjectedCSTypeGeoKey,undefined),geographic=scalar(keys?.GeographicTypeGeoKey,undefined),code=projected??geographic;
  if(!Number.isInteger(code)||!SUPPORTED_CRS.has(code))conversionFailure('This GeoTIFF has an unsupported CRS.');
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
  if(![1,3,4].includes(samples)||(photometric===1&&samples!==1)||(photometric===2&&!new Set([3,4]).has(samples)))conversionFailure('This GeoTIFF uses an unsupported sample or photometric layout.');
  if(samples===4?(extra.length!==1||![1,2].includes(extra[0])):extra.length!==0)conversionFailure('This GeoTIFF must explicitly declare its one supported alpha extra sample.');
  if(bits.length!==samples||bits.some(value=>value!==8)||formats.length&&formats.some(value=>value!==1))conversionFailure('This GeoTIFF must use unsigned 8-bit samples.');
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
  const module=await abortable((geotiffLoader||defaultGeotiffLoader)(),signal);throwIfAborted(signal);
  if(typeof module?.fromArrayBuffer!=='function')fail('GeoTIFF decoder boundary is unavailable.');
  const buffer=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength?bytes.buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  const tiff=await abortable(module.fromArrayBuffer(buffer,signal),signal),count=await abortable(tiff.getImageCount(),signal);
  if(count!==1)conversionFailure('Multi-image or pyramid GeoTIFFs are ambiguous; use a single-image file.');
  const image=await abortable(tiff.getImage(0),signal);throwIfAborted(signal);
  const width=image.getWidth(),height=image.getHeight();
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0)conversionFailure('This GeoTIFF declares invalid raster dimensions.');
  const directory=await loadedDirectory(image.getFileDirectory(),{signal,maxPixels}),samples=validateTiffDirectory(image,directory,width,height,maxBytes,maxPixels,bytes.byteLength);
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
