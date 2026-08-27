import test from 'node:test';
import assert from 'node:assert/strict';
import {fromArrayBuffer,writeArrayBuffer} from 'geotiff';

const manual=()=>import('../src/imagery/manual-image.mjs');

function namedBlob(bytes,name,type=''){
  const blob=new Blob([bytes],{type});
  Object.defineProperty(blob,'name',{value:name});
  return blob;
}

function pngHeader(width,height){
  const bytes=new Uint8Array(24),view=new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  view.setUint32(16,width);view.setUint32(20,height);
  return bytes;
}

function jpegWithOrientation(width,height,orientation){
  const exif=new Uint8Array(32),view=new DataView(exif.buffer);
  exif.set([69,120,105,102,0,0,73,73]);
  view.setUint16(8,42,true);view.setUint32(10,8,true);view.setUint16(14,1,true);
  view.setUint16(16,0x0112,true);view.setUint16(18,3,true);view.setUint32(20,1,true);view.setUint16(24,orientation,true);
  const sof=Uint8Array.from([255,192,0,11,8,height>>8,height&255,width>>8,width&255,1,1,17,0]);
  return Uint8Array.from([255,216,255,225,0,34,...exif,...sof,255,217]);
}

async function geotiffBlob({width=2,height=2,crs=4326,compression=1,values=new Uint8Array([0,64,128,255]),metadata={}}={}){
  const projected=crs===4326?{}:{ProjectedCSTypeGeoKey:crs};
  const geographic=crs===4326?{GeographicTypeGeoKey:4326}:{};
  const buffer=await writeArrayBuffer(values,{width,height,BitsPerSample:[8],SamplesPerPixel:1,
    PhotometricInterpretation:1,Compression:compression,SampleFormat:[1],GTModelTypeGeoKey:crs===4326?2:1,
    GTRasterTypeGeoKey:1,ModelPixelScale:[.1,.2,0],ModelTiepoint:[0,0,0,-80,44,0],...geographic,...projected,...metadata});
  return namedBlob(new Uint8Array(buffer),'fixture.tif','image/tiff');
}

const bitmapDecoder=(width,height,log={})=>async(_blob,options)=>{
  log.called=(log.called||0)+1;log.options=options;
  return {width,height,close(){log.closed=(log.closed||0)+1;}};
};

test('manual PNG decoding trusts bytes, verifies completed decode dimensions, and rejects extension or MIME spoofing',async()=>{
  const {decodeManualImage}=await manual(),log={};
  const decoded=await decodeManualImage(namedBlob(pngHeader(3,2),'scan.png','image/png'),{decodeBitmap:bitmapDecoder(3,2,log)});
  assert.equal(decoded.mime,'image/png');assert.equal(decoded.width,3);assert.equal(decoded.height,2);assert.equal(decoded.geo,null);
  assert.ok(decoded.blob instanceof Blob);assert.equal(log.closed,1);assert.equal(log.options.imageOrientation,'none');
  await assert.rejects(decodeManualImage(namedBlob(pngHeader(3,2),'scan.jpg','image/png'),{decodeBitmap:bitmapDecoder(3,2)}),/extension.*signature|signature.*extension/i);
  await assert.rejects(decodeManualImage(namedBlob(pngHeader(3,2),'scan.png','image\/jpeg'),{decodeBitmap:bitmapDecoder(3,2)}),/MIME.*signature|signature.*MIME/i);
  await assert.rejects(decodeManualImage(namedBlob(Uint8Array.from([1,2,3]),'scan.png','image/png'),{decodeBitmap:bitmapDecoder(3,2)}),/PNG.*JPEG.*TIFF|signature/i);
});

test('JPEG EXIF orientation determines output dimensions without trusting a pre-load Image',async()=>{
  const {decodeManualImage}=await manual(),log={};
  const decoded=await decodeManualImage(namedBlob(jpegWithOrientation(2,3,6),'oriented.jpeg','image/jpeg'),{decodeBitmap:bitmapDecoder(2,3,log)});
  assert.deepEqual({width:decoded.width,height:decoded.height},{width:3,height:2});
  assert.equal(log.closed,1);assert.equal(log.options.orientation,6);
});

test('byte and pixel limits reject before reading or invoking a decoder allocation boundary',async()=>{
  const {decodeManualImage}=await manual();let read=false,decoded=false;
  const oversized={name:'large.png',type:'image/png',size:65,arrayBuffer(){read=true;throw new Error('must not read');}};
  await assert.rejects(decodeManualImage(oversized,{maxBytes:64,decodeBitmap:async()=>{decoded=true;}}),/64 bytes|byte limit/i);
  assert.equal(read,false);assert.equal(decoded,false);
  await assert.rejects(decodeManualImage(namedBlob(pngHeader(5,5),'large.png','image/png'),{maxPixels:24,decodeBitmap:async()=>{decoded=true;}}),/pixel limit|24 pixels/i);
  assert.equal(decoded,false,'pixel headers are bounded before browser decoding/canvas allocation');
  await assert.rejects(decodeManualImage(namedBlob(pngHeader(1,1),'small.png','image/png'),{maxPixels:32_000_001,decodeBitmap:bitmapDecoder(1,1)}),/maximum.*pixel|cannot exceed/i);
});

test('abort during injected bitmap decoding rejects promptly and closes a late bitmap without returning it',async()=>{
  const {decodeManualImage}=await manual(),controller=new AbortController();let release,closed=0;
  const started=new Promise(resolve=>{release=resolve;});
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const outcome=decodeManualImage(namedBlob(pngHeader(1,1),'scan.png','image/png'),{
    signal:controller.signal,decodeBitmap:async()=>{release();return pending;}
  }).then(value=>({value}),error=>({error}));
  await started;controller.abort();
  let timer;try{
    const observed=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);
    assert.equal(observed.pending,undefined);assert.equal(observed.error?.name,'AbortError');
  }finally{clearTimeout(timer);finish({width:1,height:1,close(){closed++;}});await outcome;}
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
  const {decodeManualImage}=await manual();let encoded;
  const decoded=await decodeManualImage(await geotiffBlob(),{
    geotiffLoader:async()=>({fromArrayBuffer}),
    encodeRaster:async value=>{encoded=value;return new Blob([pngHeader(value.width,value.height)],{type:'image/png'});}
  });
  assert.equal(decoded.mime,'image/png');assert.equal(decoded.width,2);assert.equal(decoded.height,2);
  assert.equal(decoded.geo.crs,'EPSG:4326');
  assert.deepEqual(decoded.geo.transform,[.1,0,0,-.2,-79.95,43.9]);
  assert.deepEqual(Array.from(encoded.rgba),[0,0,0,255,64,64,64,255,128,128,128,255,255,255,255,255]);
});

test('GeoTIFF CRS allowlist accepts Web Mercator and NAD83 UTM zones 15-18 only',async()=>{
  const {decodeManualImage}=await manual(),encodeRaster=async({width,height})=>new Blob([pngHeader(width,height)],{type:'image/png'});
  for(const crs of [3857,26915,26916,26917,26918]){
    const decoded=await decodeManualImage(await geotiffBlob({width:1,height:1,crs,values:new Uint8Array([1])}),{geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster});
    assert.equal(decoded.geo.crs,`EPSG:${crs}`);
  }
  for(const crs of [26914,26919])await assert.rejects(
    decodeManualImage(await geotiffBlob({width:1,height:1,crs,values:new Uint8Array([1])}),{geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster}),
    /unsupported CRS.*convert|convert.*EPSG/i
  );
});

test('GeoTIFF ambiguity and unsupported compression fail before raster decode with conversion instructions',async()=>{
  const {decodeManualImage}=await manual();let imageRead=false;
  const tiny=namedBlob(Uint8Array.from([73,73,42,0,8,0,0,0]),'tiny.tif','image/tiff');
  await assert.rejects(decodeManualImage(tiny,{geotiffLoader:async()=>({fromArrayBuffer:async()=>({getImageCount:async()=>2,getImage:async()=>{imageRead=true;}})})}),/multi-image|pyramid|single-image.*convert/i);
  assert.equal(imageRead,false);
  await assert.rejects(decodeManualImage(await geotiffBlob({compression:5}),{
    geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster:async()=>{throw new Error('must not encode');}
  }),/compression.*convert|uncompressed/i);
});

test('malformed and non-top-left GeoTIFFs fail with safe conversion guidance',async()=>{
  const {decodeManualImage}=await manual(),tiny=namedBlob(Uint8Array.from([73,73,42,0,8,0,0,0]),'broken.tif','image/tiff');
  await assert.rejects(decodeManualImage(tiny,{geotiffLoader:async()=>({fromArrayBuffer:async()=>{throw new Error('invalid IFD');}})}),/could not be safely decoded.*convert/i);
  await assert.rejects(decodeManualImage(await geotiffBlob({metadata:{Orientation:2}}),{
    geotiffLoader:async()=>({fromArrayBuffer}),encodeRaster:async()=>{throw new Error('must reject before raster encoding');}
  }),/orientation.*convert|top-left.*convert/i);
});

test('declared GeoTIFF strip allocation is bounded before raster or canvas allocation',async()=>{
  const {decodeManualImage}=await manual();let rasterRead=false,encoded=false;
  const fileDirectory={Compression:1,BitsPerSample:[8],SampleFormat:[1],PhotometricInterpretation:1,SamplesPerPixel:1,
    PlanarConfiguration:1,RowsPerStrip:2_000_000_000,StripByteCounts:[1],StripOffsets:[0],
    ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,0,0,0]};
  const image={getWidth:()=>1,getHeight:()=>1,getSamplesPerPixel:()=>1,getFileDirectory:()=>fileDirectory,
    getGeoKeys:()=>({GeographicTypeGeoKey:4326,GTRasterTypeGeoKey:1}),readRasters:async()=>{rasterRead=true;}};
  await assert.rejects(decodeManualImage(namedBlob(Uint8Array.from([73,73,42,0,8,0,0,0]),'bomb.tif','image/tiff'),{
    geotiffLoader:async()=>({fromArrayBuffer:async()=>({getImageCount:async()=>1,getImage:async()=>image})}),
    encodeRaster:async()=>{encoded=true;}
  }),/strip|allocation|convert/i);
  assert.equal(rasterRead,false);assert.equal(encoded,false);
});

test('four-sample GeoTIFF requires an explicitly declared associated or unassociated alpha sample',async()=>{
  const {decodeManualImage}=await manual(),directory={Compression:1,BitsPerSample:[8,8,8,8],SampleFormat:[1,1,1,1],PhotometricInterpretation:2,
    SamplesPerPixel:4,PlanarConfiguration:1,RowsPerStrip:1,StripByteCounts:[4],StripOffsets:[0],ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,0,0,0]};
  const image={getWidth:()=>1,getHeight:()=>1,getSamplesPerPixel:()=>4,getFileDirectory:()=>directory,
    getGeoKeys:()=>({GeographicTypeGeoKey:4326,GTRasterTypeGeoKey:1}),readRasters:async()=>new Uint8Array([1,2,3,4])};
  await assert.rejects(decodeManualImage(namedBlob(Uint8Array.from([73,73,42,0,8,0,0,0]),'rgba.tif','image/tiff'),{
    geotiffLoader:async()=>({fromArrayBuffer:async()=>({getImageCount:async()=>1,getImage:async()=>image})}),
    encodeRaster:async()=>new Blob([pngHeader(1,1)],{type:'image/png'})
  }),/alpha|extra sample.*convert/i);
});

test('abort during default GeoTIFF canvas encoding clears the canvas before a late encoder settles',async t=>{
  const {decodeManualImage}=await manual(),controller=new AbortController();let finish,start;
  const encoding=new Promise(resolve=>{start=resolve;}),pending=new Promise(resolve=>{finish=resolve;});
  const context={createImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){}};
  const canvas={width:0,height:0,getContext:()=>context,convertToBlob(){start();return pending;}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:{createElement:()=>canvas},configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const directory={Compression:1,BitsPerSample:[8],SampleFormat:[1],PhotometricInterpretation:1,SamplesPerPixel:1,PlanarConfiguration:1,
    RowsPerStrip:1,StripByteCounts:[1],StripOffsets:[0],ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,0,0,0]};
  const image={getWidth:()=>1,getHeight:()=>1,getSamplesPerPixel:()=>1,getFileDirectory:()=>directory,
    getGeoKeys:()=>({GeographicTypeGeoKey:4326,GTRasterTypeGeoKey:1}),readRasters:async()=>new Uint8Array([1])};
  const outcome=decodeManualImage(namedBlob(Uint8Array.from([73,73,42,0,8,0,0,0]),'slow.tif','image/tiff'),{
    signal:controller.signal,geotiffLoader:async()=>({fromArrayBuffer:async()=>({getImageCount:async()=>1,getImage:async()=>image})})
  }).then(value=>({value}),error=>({error}));
  await encoding;controller.abort();
  let timer;try{
    const observed=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);
    assert.equal(observed.pending,undefined);assert.equal(observed.error?.name,'AbortError');assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  }finally{clearTimeout(timer);finish(new Blob([pngHeader(1,1)],{type:'image/png'}));await outcome;}
});
