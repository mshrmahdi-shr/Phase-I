import test from 'node:test';
import assert from 'node:assert/strict';

const worldFileModule=()=>import('../src/world-file.mjs');

test('axis-aligned outer corners produce negative row scale and a first-pixel centre origin',async()=>{
  const {worldFileFromCorners,pixelToGround}=await worldFileModule();
  const result=worldFileFromCorners({
    upperLeft:[500000,4800100],upperRight:[500100,4800100],lowerLeft:[500000,4800000],
    pixelWidth:100,pixelHeight:50
  });
  assert.deepEqual(result.coefficients,[1,0,0,-2,500000.5,4800099]);
  assert.equal(result.text,'1.00000000000\n0.00000000000\n0.00000000000\n-2.00000000000\n500000.500000\n4800099.00000\n');
  assert.deepEqual(pixelToGround([0,0],result.coefficients),[500000.5,4800099]);
});

test('rotated and sheared affine vectors reconstruct all four outer raster corners',async()=>{
  const {worldFileFromCorners,pixelToGround}=await worldFileModule();
  const {coefficients}=worldFileFromCorners({
    upperLeft:[100,200],upperRight:[112,216],lowerLeft:[106,197],pixelWidth:4,pixelHeight:3
  });
  assert.deepEqual(coefficients,[3,4,2,-1,102.5,201.5]);
  const outerCorners=[
    {pixel:[-.5,-.5],ground:[100,200]},
    {pixel:[3.5,-.5],ground:[112,216]},
    {pixel:[-.5,2.5],ground:[106,197]},
    {pixel:[3.5,2.5],ground:[118,213]}
  ];
  for(const {pixel,ground} of outerCorners)assert.deepEqual(pixelToGround(pixel,coefficients),ground);
  assert.deepEqual(pixelToGround([0,0],coefficients),[102.5,201.5]);
});

test('large UTM origins retain tiny pixel vectors in one canonical 12-significant-digit representation',async()=>{
  const {worldFileFromCorners,pixelToGround}=await worldFileModule();
  const input={
    upperLeft:[630000.125,4830000.75],
    upperRight:[630000.12890625,4830000.751953125],
    lowerLeft:[630000.12890625,4830000.748046875],
    pixelWidth:4,pixelHeight:8
  };
  const first=worldFileFromCorners(input),second=worldFileFromCorners(input);
  assert.equal(first.text,second.text);
  assert.deepEqual(first.coefficients,second.coefficients);
  assert.equal(first.text,'0.000976562500000\n0.000488281250000\n0.000488281250000\n-0.000244140625000\n630000.125732\n4830000.75012\n');
  assert.deepEqual(first.text.trimEnd().split('\n').map(Number),first.coefficients,'callers and serialized world files use identical rounded coefficients');
  const upperLeft=pixelToGround([-.5,-.5],first.coefficients);
  assert.ok(Math.abs(upperLeft[0]-input.upperLeft[0])<5e-6);
  assert.ok(Math.abs(upperLeft[1]-input.upperLeft[1])<5e-6);
});

test('formatting is locale-independent, LF-only, newline-terminated, and never emits negative zero',async()=>{
  const {worldFileFromCorners}=await worldFileModule();
  const original=Number.prototype.toLocaleString;
  Number.prototype.toLocaleString=function(){return 'locale,decimal';};
  try{
    const result=worldFileFromCorners({upperLeft:[0,0],upperRight:[10,-0],lowerLeft:[-0,-10],pixelWidth:10,pixelHeight:10});
    assert.deepEqual(result.coefficients,[1,0,0,-1,.5,-.5]);
    assert.equal(result.text,'1.00000000000\n0.00000000000\n0.00000000000\n-1.00000000000\n0.500000000000\n-0.500000000000\n');
    assert.equal(result.text.endsWith('\n'),true);
    assert.equal(result.text.includes('\r'),false);
    assert.equal(result.text.includes(','),false);
    assert.equal(result.text.includes('-0.00000000000'),false);
    assert.equal(result.coefficients.some(Object.is.bind(null,-0)),false);
  }finally{Number.prototype.toLocaleString=original;}
});

test('world-file extensions map only canonical PNG, JPEG, and TIFF extension tokens',async()=>{
  const {worldFileExtension}=await worldFileModule();
  for(const [image,world] of [['png','pgw'],['jpg','jgw'],['jpeg','jgw'],['tif','tfw'],['tiff','tfw']])assert.equal(worldFileExtension(image),world);
  for(const invalid of ['.png','PNG','image/png','map.png',' png ','gif','jpe','',null,undefined,42])assert.throws(()=>worldFileExtension(invalid),/extension|PNG|JPEG|TIFF/i,String(invalid));
});

test('world-file construction rejects malformed corners and invalid raster dimensions',async()=>{
  const {worldFileFromCorners}=await worldFileModule();
  const valid={upperLeft:[0,10],upperRight:[10,10],lowerLeft:[0,0],pixelWidth:10,pixelHeight:10};
  for(const input of [
    undefined,null,{},
    {...valid,upperLeft:null},{...valid,upperRight:[10]},{...valid,lowerLeft:[0,0,0]},
    {...valid,upperLeft:[NaN,10]},{...valid,upperRight:[Infinity,10]},{...valid,lowerLeft:[0,-Infinity]},
    {...valid,pixelWidth:0},{...valid,pixelWidth:-1},{...valid,pixelWidth:1.5},{...valid,pixelWidth:Number.MAX_SAFE_INTEGER+1},
    {...valid,pixelHeight:0},{...valid,pixelHeight:2.25},{...valid,pixelHeight:Infinity},{...valid,pixelHeight:'10'}
  ])assert.throws(()=>worldFileFromCorners(input),/corner|finite|dimension|integer|object/i);
});

test('world-file construction rejects degenerate and ill-conditioned affine geometry at every scale',async()=>{
  const {worldFileFromCorners}=await worldFileModule();
  const cases=[
    {upperLeft:[0,0],upperRight:[0,0],lowerLeft:[0,-10]},
    {upperLeft:[0,0],upperRight:[10,0],lowerLeft:[0,0]},
    {upperLeft:[0,0],upperRight:[10,0],lowerLeft:[20,0]},
    {upperLeft:[0,0],upperRight:[10,0],lowerLeft:[10,1e-13]},
    {upperLeft:[0,0],upperRight:[10,0],lowerLeft:[0,1e-13]},
    {upperLeft:[1e-100,1e-100],upperRight:[2e-100,1e-100],lowerLeft:[2e-100,1e-100+1e-115]}
  ];
  for(const corners of cases)assert.throws(()=>worldFileFromCorners({...corners,pixelWidth:10,pixelHeight:10}),/degenerate|condition|affine|corner/i);
  const tiny=worldFileFromCorners({upperLeft:[0,0],upperRight:[1e-100,0],lowerLeft:[0,-1e-100],pixelWidth:10,pixelHeight:10});
  assert.deepEqual(tiny.coefficients.slice(0,4),[1e-101,0,0,-1e-101]);
});

test('affine helpers reject nonfinite inputs, malformed coefficients, and overflowing results',async()=>{
  const {worldFileFromCorners,pixelToGround}=await worldFileModule();
  const valid=[1,0,0,-1,.5,9.5];
  for(const pixel of [null,[],[1],[1,2,3],[NaN,0],[0,Infinity],['0',0]])assert.throws(()=>pixelToGround(pixel,valid),/pixel|finite|coordinate/i);
  for(const coefficients of [null,[],[1,0,0,-1,.5],[1,0,0,-1,.5,9.5,0],[1,0,0,-1,.5,NaN],[1,0,0,0,.5,9.5]])assert.throws(()=>pixelToGround([0,0],coefficients),/coefficient|finite|affine|condition/i);
  assert.throws(()=>pixelToGround([Number.MAX_VALUE,Number.MAX_VALUE],[Number.MAX_VALUE,0,0,-Number.MAX_VALUE,0,0]),/finite|range|result/i);
  assert.throws(()=>worldFileFromCorners({upperLeft:[Number.MAX_VALUE,0],upperRight:[-Number.MAX_VALUE,0],lowerLeft:[Number.MAX_VALUE,-1],pixelWidth:1,pixelHeight:1}),/finite|range|affine|corner/i);
});
