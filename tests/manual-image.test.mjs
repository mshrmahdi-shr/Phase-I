import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fromArrayBuffer,writeArrayBuffer} from 'geotiff';

const manual=()=>import('../src/imagery/manual-image.mjs');

function namedBlob(bytes,name,type=''){
  const blob=new Blob([bytes],{type});
  Object.defineProperty(blob,'name',{value:name});
  return blob;
}

const fixture=async name=>new Uint8Array(await fs.readFile(new URL(`./fixtures/imagery/manual/${name}`,import.meta.url)));
const pngFixture=()=>fixture('valid-3x2.png');
const jpegFixture=orientation=>fixture(`valid-2x3-o${orientation}.jpg`);
const progressiveFixture=name=>fixture(name);
const concatBytes=parts=>{const length=parts.reduce((sum,part)=>sum+part.length,0),bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;};

function removeNonemptyIdat(bytes){
  const parts=[bytes.subarray(0,8)],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8;
  while(offset<bytes.length){const length=view.getUint32(offset),end=offset+12+length,type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));if(type!=='IDAT'||length===0)parts.push(bytes.subarray(offset,end));offset=end;}
  return concatBytes(parts);
}

function firstJpegScanParts(bytes){
  let offset=2;
  while(offset<bytes.length){const markerStart=offset;if(bytes[offset++]!==0xff)throw new Error('Fixture marker prefix missing.');while(bytes[offset]===0xff)offset++;const marker=bytes[offset++],length=bytes[offset]<<8|bytes[offset+1],end=offset+length;if(marker===0xda)return {prefix:bytes.subarray(0,markerStart),sos:bytes.subarray(markerStart,end)};offset=end;}
  throw new Error('Fixture SOS missing.');
}

function jpegWithScanCount(bytes,count){
  const {prefix,sos}=firstJpegScanParts(bytes),parts=[prefix];for(let index=0;index<count;index++)parts.push(sos,Uint8Array.of(1));parts.push(Uint8Array.of(0xff,0xd9));return concatBytes(parts);
}

async function geotiffBlob({width=2,height=2,crs=4326,compression=1,values=new Uint8Array([0,64,128,255]),samples=1,
  photometric=samples===1?1:2,bits=Array(samples).fill(8),sampleFormat=Array(samples).fill(1),extraSamples=[],planar=1,metadata={},omit=[]}={}){
  const crsMetadata=crs===4326
    ?{GTModelTypeGeoKey:2,GeographicTypeGeoKey:4326,GeogAngularUnitsGeoKey:9102}
    :{GTModelTypeGeoKey:1,ProjectedCSTypeGeoKey:crs,ProjLinearUnitsGeoKey:9001};
  const options={width,height,BitsPerSample:bits,SamplesPerPixel:samples,PhotometricInterpretation:photometric,
    Compression:compression,SampleFormat:sampleFormat,ExtraSamples:extraSamples,PlanarConfiguration:planar,GTRasterTypeGeoKey:1,
    ModelPixelScale:[.1,.2,0],ModelTiepoint:[0,0,0,-80,44,0],...crsMetadata,...metadata};
  for(const name of omit)delete options[name];
  const buffer=await writeArrayBuffer(values,options);
  return namedBlob(new Uint8Array(buffer),'fixture.tif','image/tiff');
}

function tiffView(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),little=bytes[0]===73;
  return {view,little,get16:offset=>view.getUint16(offset,little),get32:offset=>view.getUint32(offset,little),set16:(offset,value)=>view.setUint16(offset,value,little),set32:(offset,value)=>view.setUint32(offset,value,little)};
}

async function patchTiffTag(blob,tag,{type,count,value}){
  const bytes=new Uint8Array(await blob.arrayBuffer()),io=tiffView(bytes),ifd=io.get32(4),entries=io.get16(ifd);
  for(let index=0;index<entries;index++){
    const entry=ifd+2+index*12;
    if(io.get16(entry)!==tag)continue;
    if(type!==undefined)io.set16(entry+2,type);
    if(count!==undefined)io.set32(entry+4,count);
    if(value!==undefined){io.set32(entry+8,0);io.set16(entry+8,value);}
    return namedBlob(bytes,'fixture.tif','image/tiff');
  }
  throw new Error(`TIFF fixture has no tag ${tag}`);
}

function hostileTiff({entry,next=0,second=false,truncated=false,big=false}={}){
  if(big)return namedBlob(Uint8Array.from([73,73,43,0,8,0,0,0,0,0,0,0,0,0,0,0]),'hostile.tif','image/tiff');
  const count=entry?1:0,firstLength=2+count*12+4,total=8+firstLength+(second?6:0),bytes=new Uint8Array(truncated?10:total),view=new DataView(bytes.buffer);
  bytes.set([73,73,42,0]);view.setUint32(4,8,true);if(truncated){view.setUint16(8,1,true);return namedBlob(bytes,'hostile.tif','image/tiff');}
  view.setUint16(8,count,true);
  if(entry){view.setUint16(10,entry.tag,true);view.setUint16(12,entry.type,true);view.setUint32(14,entry.count,true);view.setUint32(18,entry.offset??0,true);}
  view.setUint32(8+2+count*12,next===true?8+firstLength:next,true);
  if(second){const offset=8+firstLength;view.setUint16(offset,0,true);view.setUint32(offset+2,0,true);}
  return namedBlob(bytes,'hostile.tif','image/tiff');
}

function utmGeoMetadata(crs,{originLongitude,falseNorthing}={}){
  const directory=[1,1,0,4,1024,0,1,1,1025,0,1,1,3072,0,1,crs,3076,0,1,9001],doubles=[];
  const addDouble=(key,value)=>{if(value===undefined)return;directory.push(key,34736,1,doubles.length);doubles.push(value);directory[3]++;};
  addDouble(3080,originLongitude);addDouble(3083,falseNorthing);
  return {GeoKeyDirectory:directory,GeoDoubleParams:doubles};
}

const bitmapDecoder=(width,height,log={})=>async(_blob,options)=>{
  log.called=(log.called||0)+1;log.options=options;
  return {width,height,close(){log.closed=(log.closed||0)+1;}};
};

test('manual PNG decoding uses a complete fixture, verifies completed decode dimensions, and rejects extension or MIME spoofing',async()=>{
  const {decodeManualImage}=await manual(),log={};
  const png=await pngFixture(),decoded=await decodeManualImage(namedBlob(png,'scan.png','image/png'),{decodeBitmap:bitmapDecoder(3,2,log)});
  assert.equal(decoded.mime,'image/png');assert.equal(decoded.width,3);assert.equal(decoded.height,2);assert.equal(decoded.geo,null);
  assert.ok(decoded.blob instanceof Blob);assert.equal(log.closed,1);assert.equal(log.options.imageOrientation,'none');
  await assert.rejects(decodeManualImage(namedBlob(png,'scan.jpg','image/png'),{decodeBitmap:bitmapDecoder(3,2)}),/extension.*signature|signature.*extension/i);
  await assert.rejects(decodeManualImage(namedBlob(png,'scan.png','image\/jpeg'),{decodeBitmap:bitmapDecoder(3,2)}),/MIME.*signature|signature.*MIME/i);
  await assert.rejects(decodeManualImage(namedBlob(Uint8Array.from([1,2,3]),'scan.png','image/png'),{decodeBitmap:bitmapDecoder(3,2)}),/PNG.*JPEG.*TIFF|signature/i);
});

test('complete JPEG fixtures cover a non-swap orientation and every EXIF axis-swap orientation',async()=>{
  const {decodeManualImage}=await manual();
  for(const orientation of [1,5,6,7,8]){
    const log={},bytes=await jpegFixture(orientation),decoded=await decodeManualImage(namedBlob(bytes,`o${orientation}.jpeg`,'image/jpeg'),{decodeBitmap:bitmapDecoder(2,3,log)});
    assert.deepEqual({width:decoded.width,height:decoded.height},orientation>=5?{width:3,height:2}:{width:2,height:3});
    assert.equal(log.closed,1);assert.equal(log.options.orientation,orientation);
  }
  const browserOriented=await decodeManualImage(namedBlob(await jpegFixture(6),'browser-oriented.jpeg','image/jpeg'),{decodeBitmap:bitmapDecoder(3,2)});
  assert.deepEqual({width:browserOriented.width,height:browserOriented.height},{width:3,height:2},'browser decoders may return already-oriented dimensions');
});

test('complete progressive JPEG fixtures support multiple scans, inter-scan tables, stuffing, restart markers, fill bytes, and EXIF',async()=>{
  const {decodeManualImage}=await manual(),cases=[
    ['valid-progressive-2x3-o1.jpg',2,3,1],['valid-progressive-2x3-o6.jpg',3,2,6],['valid-progressive-32x24-restart.jpg',32,24,1]
  ];
  for(const [name,width,height,orientation] of cases){
    const bytes=await progressiveFixture(name);assert.ok(bytes.reduce((sum,byte,index)=>sum+(byte===0xff&&bytes[index+1]===0xda),0)>1,'fixture contains multiple SOS scans');
    const decoded=await decodeManualImage(namedBlob(bytes,name,'image/jpeg'),{decodeBitmap:bitmapDecoder(name.includes('o6')?2:width,name.includes('o6')?3:height)});
    assert.deepEqual({width:decoded.width,height:decoded.height},{width,height});
    if(name.includes('restart')){assert.ok(bytes.some((byte,index)=>byte===0xff&&bytes[index+1]>=0xd0&&bytes[index+1]<=0xd7));assert.ok(bytes.some((byte,index)=>byte===0xff&&bytes[index+1]===0));assert.ok(bytes.some((byte,index)=>byte===0xff&&bytes[index+1]===0xff));}
    if(orientation===6)assert.deepEqual({width:decoded.width,height:decoded.height},{width:3,height:2});
  }
});

test('PNG permits checksummed empty IDAT chunks among consecutive nonempty image data but rejects zero-only and truncated streams',async()=>{
  const {decodeManualImage}=await manual(),bytes=await fixture('valid-3x2-empty-idat.png');let called=0;
  const decoded=await decodeManualImage(namedBlob(bytes,'empty-idat.png','image/png'),{decodeBitmap:bitmapDecoder(3,2)});assert.deepEqual({width:decoded.width,height:decoded.height},{width:3,height:2});
  await assert.rejects(decodeManualImage(namedBlob(removeNonemptyIdat(bytes),'zero-only.png','image/png'),{decodeBitmap:async()=>{called++;return {width:3,height:2};}}),/IDAT|image data|decoded/i);
  await assert.rejects(decodeManualImage(namedBlob(bytes.subarray(0,bytes.length-3),'truncated-empty-idat.png','image/png'),{decodeBitmap:async()=>{called++;return {width:3,height:2};}}),/truncated|incomplete|invalid/i);
  assert.equal(called,0);
});

test('JPEG rejects malformed inter-scan syntax and bounded marker or scan counts before browser decode',async()=>{
  const {decodeManualImage}=await manual(),progressive=await progressiveFixture('valid-progressive-2x3-o1.jpg'),baseline=await jpegFixture(1);let called=0;
  const decodeBitmap=async()=>{called++;return {width:2,height:3};};
  const standalone=concatBytes([baseline.subarray(0,2),Uint8Array.of(0xff,0xd0),baseline.subarray(2)]);
  const malformedDht=progressive.slice(),firstScan=malformedDht.findIndex((byte,index)=>byte===0xff&&malformedDht[index+1]===0xda),dht=malformedDht.findIndex((byte,index)=>index>firstScan&&byte===0xff&&malformedDht[index+1]===0xc4);malformedDht[dht+2]=0;malformedDht[dht+3]=1;
  const comments=Array.from({length:4097},()=>Uint8Array.of(0xff,0xfe,0,2)),tooManyMarkers=concatBytes([baseline.subarray(0,2),...comments,baseline.subarray(2)]);
  for(const [bytes,pattern] of [[standalone,/standalone|restart|marker/i],[malformedDht,/length|segment|DHT/i],[tooManyMarkers,/marker|segment.*limit|excess/i],[jpegWithScanCount(baseline,257),/scan.*limit|excess.*scan/i]])await assert.rejects(
    decodeManualImage(namedBlob(bytes,'malformed.jpg','image/jpeg'),{decodeBitmap}),pattern
  );
  assert.equal(called,0);
});

test('plausible PNG/JPEG headers with corrupt bodies and decoder/header disagreement are rejected',async()=>{
  const {decodeManualImage}=await manual(),png=await pngFixture(),jpeg=await jpegFixture(6);let called=0;
  const corrupt=png.slice();for(let offset=8;offset<corrupt.length;){const length=new DataView(corrupt.buffer).getUint32(offset),type=String.fromCharCode(...corrupt.subarray(offset+4,offset+8));if(type==='IDAT'){corrupt[offset+8]^=0xff;break;}offset+=12+length;}
  await assert.rejects(decodeManualImage(namedBlob(corrupt,'corrupt.png','image/png'),{decodeBitmap:async()=>{called++;return {width:3,height:2};}}),/could not be decoded|checksum|CRC|invalid/i);
  await assert.rejects(decodeManualImage(namedBlob(png.subarray(0,png.length-12),'truncated.png','image/png'),{decodeBitmap:async()=>{called++;return {width:3,height:2};}}),/could not be decoded|incomplete|invalid/i);
  await assert.rejects(decodeManualImage(namedBlob(jpeg.subarray(0,jpeg.length-2),'truncated.jpg','image/jpeg'),{decodeBitmap:async()=>{called++;return {width:2,height:3};}}),/could not be decoded|truncated|invalid/i);
  assert.equal(called,0,'structurally incomplete images do not reach the browser allocation boundary');
  await assert.rejects(decodeManualImage(namedBlob(png,'wrong.png','image/png'),{decodeBitmap:bitmapDecoder(2,3)}),/dimensions/i);
});

test('byte and pixel limits reject before reading or invoking a decoder allocation boundary',async()=>{
  const {decodeManualImage}=await manual();let read=false,decoded=false;
  const oversized={name:'large.png',type:'image/png',size:65,arrayBuffer(){read=true;throw new Error('must not read');}};
  await assert.rejects(decodeManualImage(oversized,{maxBytes:64,decodeBitmap:async()=>{decoded=true;}}),/64 bytes|byte limit/i);
  assert.equal(read,false);assert.equal(decoded,false);
  await assert.rejects(decodeManualImage(namedBlob(await pngFixture(),'large.png','image/png'),{maxPixels:5,decodeBitmap:async()=>{decoded=true;}}),/pixel limit|5 pixels/i);
  assert.equal(decoded,false,'pixel headers are bounded before browser decoding/canvas allocation');
  await assert.rejects(decodeManualImage(namedBlob(await pngFixture(),'small.png','image/png'),{maxPixels:32_000_001,decodeBitmap:bitmapDecoder(3,2)}),/maximum.*pixel|cannot exceed/i);
});

test('abort during injected bitmap decoding rejects promptly and closes a late bitmap without returning it',async()=>{
  const {decodeManualImage}=await manual(),controller=new AbortController();let release,closed=0;
  const started=new Promise(resolve=>{release=resolve;});
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const outcome=decodeManualImage(namedBlob(await pngFixture(),'scan.png','image/png'),{
    signal:controller.signal,decodeBitmap:async()=>{release();return pending;}
  }).then(value=>({value}),error=>({error}));
  await started;controller.abort();
  let timer;try{
    const observed=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);
    assert.equal(observed.pending,undefined);assert.equal(observed.error?.name,'AbortError');
  }finally{clearTimeout(timer);finish({width:3,height:2,close(){closed++;}});await outcome;}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
});

test('world files parse six locale-independent pixel-centre coefficients in canvas affine order',async()=>{
  const {parseWorldFile}=await manual();
  const transform=parseWorldFile('2\n0.5\n-0.25\n-3\n100\n200\n\n');
  assert.deepEqual(transform,[2,.5,-.25,-3,100,200]);
  const [a,b,c,d,e,f]=transform;
  assert.deepEqual([a*0+c*0+e,b*0+d*0+f],[100,200],'C and F locate the centre of the upper-left pixel');
  assert.deepEqual([a+c+e,b+d+f],[101.75,197.5]);
  for(const text of ['1\n2\n3\n4\n5','1\n2\n3\n4\n5\n6\n7','1\n2\n3\n4\n5\n6\ncomment','1,5\n2\n3\n4\n5\n6','Infinity\n2\n3\n4\n5\n6','1\n\n2\n3\n4\n5\n6'])assert.throws(()=>parseWorldFile(text),/six|finite|decimal|record/i);
});

test('an uncompressed 8-bit EPSG:4326 GeoTIFF is decoded and exposes a pixel-centre transform',async()=>{
  const {decodeManualImage}=await manual();let encoded;const png=await pngFixture();
  const decoded=await decodeManualImage(await geotiffBlob(),{
    geotiffLoader:async()=>({fromArrayBuffer}),
    encodeRaster:async value=>{encoded=value;return new Blob([png],{type:'image/png'});}
  });
  assert.equal(decoded.mime,'image/png');assert.equal(decoded.width,2);assert.equal(decoded.height,2);
  assert.equal(decoded.geo.crs,'EPSG:4326');
  assert.deepEqual(decoded.geo.transform,[.1,0,0,-.2,-79.95,43.9]);
  assert.deepEqual(Array.from(encoded.rgba),[0,0,0,255,64,64,64,255,128,128,128,255,255,255,255,255]);
});

test('GeoTIFF CRS allowlist accepts Web Mercator and NAD83 UTM zones 15-18 only',async()=>{
  const {decodeManualImage}=await manual(),png=await pngFixture(),encodeRaster=async()=>new Blob([png],{type:'image/png'});
  for(const crs of [3857,26915,26916,26917,26918]){
    const decoded=await decodeManualImage(await geotiffBlob({width:1,height:1,crs,values:new Uint8Array([1])}),{geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster});
    assert.equal(decoded.geo.crs,`EPSG:${crs}`);
  }
  for(const crs of [26914,26919])await assert.rejects(
    decodeManualImage(await geotiffBlob({width:1,height:1,crs,values:new Uint8Array([1])}),{geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster}),
    /unsupported CRS.*convert|convert.*EPSG/i
  );
});

test('classic TIFF preflight rejects hostile structures before loading or invoking GeoTIFF.js',async()=>{
  const {decodeManualImage}=await manual();let loaderCalls=0;
  const loader=async()=>{loaderCalls++;return {fromArrayBuffer(){throw new Error('must not parse');}};};
  const cases=[
    [hostileTiff({big:true}),/BigTIFF|classic TIFF/i],
    [hostileTiff({truncated:true}),/IFD|truncated|safely decoded/i],
    [hostileTiff({entry:{tag:273,type:12,count:1024,offset:26}}),/allocation|tag|strip|safely decoded/i],
    [hostileTiff({entry:{tag:33550,type:12,count:3,offset:0xfffffff0}}),/offset|range|safely decoded/i],
    [hostileTiff({next:8}),/cyclic|cycle|IFD/i],
    [hostileTiff({next:true,second:true}),/multi-image|multiple|IFD/i]
  ];
  for(const [blob,pattern] of cases)await assert.rejects(decodeManualImage(blob,{geotiffLoader:loader}),pattern);
  assert.equal(loaderCalls,0,'no hostile IFD reaches even the GeoTIFF library loader boundary');
});

test('classic TIFF preflight enforces exact strip cardinality and bounded declared dimensions before the library boundary',async()=>{
  const {decodeManualImage}=await manual();let loaderCalls=0;
  const loader=async()=>{loaderCalls++;return {fromArrayBuffer};};
  const stripBomb=await patchTiffTag(await geotiffBlob({width:1,height:1,values:new Uint8Array([1])}),273,{count:2});
  const rowBomb=await patchTiffTag(await geotiffBlob({width:1,height:1,values:new Uint8Array([1])}),278,{value:65535});
  await assert.rejects(decodeManualImage(stripBomb,{geotiffLoader:loader}),/strip|cardinality|allocation|convert/i);
  await assert.rejects(decodeManualImage(rowBomb,{geotiffLoader:loader}),/strip|dimension|allocation|convert/i);
  assert.equal(loaderCalls,0);
});

test('GeoTIFF CRS rejects missing or contradictory model, units, CRS kind, UTM zone, and hemisphere metadata from real files',async()=>{
  const {decodeManualImage}=await manual(),png=await pngFixture(),encodeRaster=async()=>new Blob([png],{type:'image/png'});
  const rejected=[
    geotiffBlob({metadata:{GeogAngularUnitsGeoKey:9101}}),
    geotiffBlob({metadata:{GTModelTypeGeoKey:1}}),
    geotiffBlob({omit:['GTModelTypeGeoKey']}),
    geotiffBlob({omit:['GeogAngularUnitsGeoKey']}),
    geotiffBlob({metadata:{ProjectedCSTypeGeoKey:3857,ProjLinearUnitsGeoKey:9001}}),
    geotiffBlob({crs:3857,width:1,height:1,values:new Uint8Array([1]),metadata:{ProjLinearUnitsGeoKey:9002}}),
    geotiffBlob({crs:3857,width:1,height:1,values:new Uint8Array([1]),omit:['ProjLinearUnitsGeoKey']}),
    geotiffBlob({crs:26915,width:1,height:1,values:new Uint8Array([1]),metadata:utmGeoMetadata(26915,{originLongitude:-81})}),
    geotiffBlob({crs:26915,width:1,height:1,values:new Uint8Array([1]),metadata:utmGeoMetadata(26915,{falseNorthing:10_000_000})})
  ];
  for(const pending of rejected)await assert.rejects(
    decodeManualImage(await pending,{geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster}),
    /CRS|model|unit|degree|metre|zone|hemisphere.*convert|convert.*(?:CRS|model|unit|degree|metre|zone|hemisphere)/i
  );
});

test('GeoTIFF rendering accepts only correctly represented BlackIsZero grayscale, RGB, and unassociated RGBA',async()=>{
  const {decodeManualImage}=await manual(),png=await pngFixture();
  const cases=[
    [{width:1,height:1,values:new Uint8Array([40])},[40,40,40,255]],
    [{width:1,height:1,samples:3,values:new Uint8Array([10,20,30])},[10,20,30,255]],
    [{width:1,height:1,samples:4,extraSamples:[2],values:new Uint8Array([10,20,30,40])},[10,20,30,40]]
  ];
  for(const [options,expected] of cases){
    let rendered;await decodeManualImage(await geotiffBlob(options),{geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster:async value=>{rendered=Array.from(value.rgba);return new Blob([png],{type:'image/png'});}});
    assert.deepEqual(rendered,expected);
  }
});

test('GeoTIFF rendering rejects WhiteIsZero, palette, associated alpha, CMYK, planar, bit-depth, and signed layouts',async()=>{
  const {decodeManualImage}=await manual(),png=await pngFixture(),encodeRaster=async()=>new Blob([png],{type:'image/png'});
  const white=await patchTiffTag(await geotiffBlob({width:1,height:1,values:new Uint8Array([0])}),262,{value:0});
  const rejected=[
    white,
    geotiffBlob({width:1,height:1,photometric:3,values:new Uint8Array([1])}),
    geotiffBlob({width:1,height:1,samples:4,extraSamples:[1],values:new Uint8Array([10,20,30,40])}),
    geotiffBlob({width:1,height:1,samples:4,photometric:5,values:new Uint8Array([10,20,30,40])}),
    geotiffBlob({width:1,height:1,samples:3,planar:2,values:new Uint8Array([10,20,30])}),
    geotiffBlob({width:1,height:1,bits:[16],values:new Uint16Array([1])}),
    geotiffBlob({width:1,height:1,sampleFormat:[2],values:new Int8Array([1])})
  ];
  for(const pending of rejected)await assert.rejects(
    decodeManualImage(await pending,{geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster}),
    /photometric|WhiteIsZero|palette|alpha|CMYK|planar|8-bit|unsigned.*convert|convert.*(?:photometric|alpha|planar|8-bit|unsigned)/i
  );
});

test('GeoTIFF ambiguity and unsupported compression fail before raster decode with conversion instructions',async()=>{
  const {decodeManualImage}=await manual();let loaderCalls=0;
  await assert.rejects(decodeManualImage(hostileTiff({next:true,second:true}),{geotiffLoader:async()=>{loaderCalls++;return {fromArrayBuffer};}}),/multi-image|pyramid|multiple.*convert|IFD/i);
  assert.equal(loaderCalls,0);
  await assert.rejects(decodeManualImage(await geotiffBlob({compression:5}),{
    geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster:async()=>{throw new Error('must not encode');}
  }),/compression.*convert|uncompressed/i);
});

test('malformed and non-top-left GeoTIFFs fail with safe conversion guidance',async()=>{
  const {decodeManualImage}=await manual();
  await assert.rejects(decodeManualImage(hostileTiff({truncated:true}),{geotiffLoader:async()=>({fromArrayBuffer})}),/could not be safely decoded.*convert|IFD.*convert/i);
  await assert.rejects(decodeManualImage(await geotiffBlob({metadata:{Orientation:2}}),{
    geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster:async()=>{throw new Error('must reject before raster encoding');}
  }),/orientation.*convert|top-left.*convert/i);
});

test('abort during default GeoTIFF canvas encoding clears the canvas before a late encoder settles',async t=>{
  const {decodeManualImage}=await manual(),controller=new AbortController();let finish,start;
  const encoding=new Promise(resolve=>{start=resolve;}),pending=new Promise(resolve=>{finish=resolve;});
  const context={createImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){}};
  const canvas={width:0,height:0,getContext:()=>context,convertToBlob(){start();return pending;}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:{createElement:()=>canvas},configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const outcome=decodeManualImage(await geotiffBlob({width:1,height:1,values:new Uint8Array([1])}),{
    signal:controller.signal,geotiffLoader:async()=>({fromArrayBuffer})
  }).then(value=>({value}),error=>({error}));
  await encoding;controller.abort();
  let timer;try{
    const observed=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);
    assert.equal(observed.pending,undefined);assert.equal(observed.error?.name,'AbortError');assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  }finally{clearTimeout(timer);finish(new Blob([await pngFixture()],{type:'image/png'}));await outcome;}
});
