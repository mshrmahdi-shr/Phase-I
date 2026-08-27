import test from 'node:test';
import assert from 'node:assert/strict';

const placementModule=()=>import('../src/imagery/placement.mjs');
const overlayModule=()=>import('../src/imagery/canvas-overlay.mjs');
const near=(actual,expected,epsilon=1e-8)=>assert.ok(Math.abs(actual-expected)<=epsilon,`${actual} != ${expected}`);
const nearPoint=(actual,expected,epsilon=1e-8)=>{near(actual[0],expected[0],epsilon);near(actual[1],expected[1],epsilon);};

test('extent placement stores a projected centre, exact ground dimensions, and source raster dimensions',async()=>{
  const {placementFromExtent,placementCorners,placementCanvasTransform,validatePlacement}=await placementModule();
  const placement=placementFromExtent({bounds:{west:-.001,south:-.001,east:.001,north:.001},width:4,height:2});
  nearPoint(placement.center,[0,0],1e-7);near(placement.groundWidth,222.63898158654715);near(placement.groundHeight,222.6389815982638);
  assert.deepEqual({sourceWidth:placement.sourceWidth,sourceHeight:placement.sourceHeight,rotationDegrees:placement.rotationDegrees},{sourceWidth:4,sourceHeight:2,rotationDegrees:0});
  const corners=placementCorners(placement);
  nearPoint(corners[0],[-111.31949079327357,111.31949079913186]);
  nearPoint(corners[1],[111.31949079327357,111.31949079913186]);
  nearPoint(corners[2],[111.31949079327357,-111.31949079913186]);
  nearPoint(corners[3],[-111.31949079327357,-111.31949079913186]);
  const matrix=placementCanvasTransform(placement);near(matrix[0],55.65974539663679);near(matrix[1],0);near(matrix[2],0);near(matrix[3],-111.31949079913186);near(matrix[4],-111.31949079327357);near(matrix[5],111.31949079913186);
  assert.equal(validatePlacement(placement,{location:{lng:0,lat:0}}),true);
});

test('positive rotation is clockwise and the pixel-to-projected matrix independently reaches all four corners',async()=>{
  const {placementCorners,placementCanvasTransform}=await placementModule();
  const placement={center:[0,0],groundWidth:20,groundHeight:10,sourceWidth:2,sourceHeight:1,rotationDegrees:90};
  const expected=[[5,10],[5,-10],[-5,-10],[-5,10]],corners=placementCorners(placement);
  corners.forEach((corner,index)=>nearPoint(corner,expected[index]));
  const [a,b,c,d,e,f]=placementCanvasTransform(placement),apply=(x,y)=>[a*x+c*y+e,b*x+d*y+f];
  nearPoint(apply(0,0),expected[0]);nearPoint(apply(2,0),expected[1]);nearPoint(apply(2,1),expected[2]);nearPoint(apply(0,1),expected[3]);
  assert.ok(b<0,'moving right across the source moves south after a 90 degree clockwise rotation');
});

test('placement validation rejects SITE exclusion, unsafe dimensions, Mercator overflow, and antimeridian crossing',async()=>{
  const {projectWebMercator,validatePlacement}=await placementModule();
  const valid={center:projectWebMercator([-79.38,43.65]),groundWidth:200,groundHeight:100,sourceWidth:20,sourceHeight:10,rotationDegrees:15};
  assert.equal(validatePlacement(valid,{location:{lng:-79.38,lat:43.65}}),true);
  assert.throws(()=>validatePlacement(valid,{location:{lng:-79.3,lat:43.65}}),/SITE.*placement/i);
  for(const change of [
    {groundWidth:0},{groundHeight:Infinity},{sourceWidth:1.5},{sourceHeight:0},{rotationDegrees:NaN},{center:[NaN,0]}
  ])assert.throws(()=>validatePlacement({...valid,...change},{location:{lng:-79.38,lat:43.65}}),/dimension|finite|rotation|centre|center/i);
  const edge={...valid,center:projectWebMercator([179.999,0]),groundWidth:1000,groundHeight:100,rotationDegrees:0};
  assert.throws(()=>validatePlacement(edge,{location:{lng:179.999,lat:0}}),/antimeridian|Mercator/i);
  assert.throws(()=>projectWebMercator([0,85.1]),/Mercator/i);
});

test('Web Mercator forward and inverse transforms are deterministic at an Ontario SITE',async()=>{
  const {projectWebMercator,unprojectWebMercator}=await placementModule();
  const point=[-79.3832,43.6532],projected=projectWebMercator(point),roundTrip=unprojectWebMercator(projected);
  nearPoint(projected,[-8836897.401540594,5411929.999074457],1e-6);nearPoint(roundTrip,point,1e-12);
});

test('pixel-centre georeferences become deterministic placements in Web Mercator and NAD83 UTM',async()=>{
  const {placementFromGeoReference,placementCanvasTransform,unprojectWebMercator}=await placementModule();
  const mercator=placementFromGeoReference({geo:{crs:'EPSG:3857',transform:[10,0,0,-10,100,200]},width:2,height:1});
  assert.deepEqual(mercator,{center:[105,200],groundWidth:20,groundHeight:10,sourceWidth:2,sourceHeight:1,rotationDegrees:0});
  assert.deepEqual(placementCanvasTransform(mercator),[10,0,0,-10,95,205]);
  const utm=placementFromGeoReference({geo:{crs:'EPSG:26917',transform:[1,0,0,-1,630000,4830000]},width:2,height:2});
  const [lng,lat]=unprojectWebMercator(utm.center);assert.ok(lng>-80&&lng<-78);assert.ok(lat>43&&lat<45);
  assert.ok(utm.groundWidth>1.9&&utm.groundWidth<3);assert.ok(utm.groundHeight>1.9&&utm.groundHeight<3);
});

function overlayHarness({bitmapPromise=Promise.resolve({width:2,height:1,close(){}})}={}){
  const calls={transforms:[],draws:0,clears:0,closed:0,appends:0,removes:0};
  const context={setTransform(...values){calls.transforms.push(values);},clearRect(){calls.clears++;},drawImage(){calls.draws++;}};
  const pane={children:[],appendChild(node){if(!this.children.includes(node)){this.children.push(node);node.parentNode=this;calls.appends++;}},removeChild(node){this.children=this.children.filter(value=>value!==node);node.parentNode=null;calls.removes++;}};
  const document={createElement(tag){assert.equal(tag,'canvas');return {style:{},width:0,height:0,parentNode:null,getContext:()=>context,remove(){this.parentNode?.removeChild(this);}};}};
  const listeners=new Map();let scale=1;
  const map={
    getContainer:()=>({ownerDocument:document}),getPanes:()=>({overlayPane:pane}),getSize:()=>({x:200,y:100}),containerPointToLayerPoint:()=>({x:0,y:0}),
    latLngToLayerPoint({lat,lng}){const R=6378137,d=Math.PI/180;return {x:R*lng*d*scale,y:-R*Math.log(Math.tan(Math.PI/4+lat*d/2))*scale};},
    on(names,handler){for(const name of names.split(/\s+/)){const set=listeners.get(name)||new Set();set.add(handler);listeners.set(name,set);}return this;},
    off(names,handler){for(const name of names.split(/\s+/))listeners.get(name)?.delete(handler);return this;},
    emit(name){for(const handler of listeners.get(name)||[])handler();},listenerCount(){return [...listeners.values()].reduce((sum,set)=>sum+set.size,0);},setScale(value){scale=value;}
  };
  const L={latLng:(lat,lng)=>({lat,lng}),DomUtil:{setPosition(node,point){node.position=point;}}};
  const createBitmap=async()=>{const bitmap=await bitmapPromise;return {...bitmap,close(){calls.closed++;bitmap.close?.();}};};
  return {calls,context,document,pane,map,L,createBitmap};
}

test('rotated canvas overlay redraws from projected corners on move, zoom, and resize and removes idempotently',async()=>{
  const {createCanvasImageOverlay}=await overlayModule(),h=overlayHarness();
  const placement={center:[0,0],groundWidth:20,groundHeight:10,sourceWidth:2,sourceHeight:1,rotationDegrees:90};
  const overlay=createCanvasImageOverlay({L:h.L,map:h.map,image:{blob:new Blob(['x'],{type:'image/png'}),width:2,height:1},placement,createBitmap:h.createBitmap});
  overlay.addTo(h.map).addTo(h.map);await overlay.ready;
  assert.equal(h.calls.appends,1);assert.equal(h.map.listenerCount(),3);assert.equal(h.calls.draws,1);
  const first=h.calls.transforms.at(-1);near(first[0],0);near(first[1],10);near(first[2],-10);near(first[3],0);near(first[4],5);near(first[5],-10);
  h.map.emit('move');h.map.setScale(2);h.map.emit('zoom');h.map.emit('resize');assert.equal(h.calls.draws,4);
  const zoomed=h.calls.transforms.at(-1);first.forEach((value,index)=>near(zoomed[index],value*2));
  overlay.remove().remove();assert.equal(h.map.listenerCount(),0);assert.equal(h.calls.closed,1);assert.equal(h.calls.removes,1);assert.equal(overlay.getElement(),null);
});

test('overlay abort removes listeners and canvas promptly, then closes a bitmap that resolves late without drawing',async()=>{
  const {createCanvasImageOverlay}=await overlayModule(),controller=new AbortController();let finish;
  const h=overlayHarness({bitmapPromise:new Promise(resolve=>{finish=resolve;})});
  const placement={center:[0,0],groundWidth:20,groundHeight:10,sourceWidth:2,sourceHeight:1,rotationDegrees:0};
  const overlay=createCanvasImageOverlay({L:h.L,map:h.map,image:{blob:new Blob(['x'],{type:'image/png'}),width:2,height:1},placement,signal:controller.signal,createBitmap:h.createBitmap});
  overlay.addTo(h.map);controller.abort();
  let timer;try{
    const observed=await Promise.race([overlay.ready.then(()=>({}),error=>({error})),new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);
    assert.equal(observed.pending,undefined);assert.equal(observed.error?.name,'AbortError');assert.equal(h.map.listenerCount(),0);assert.equal(h.pane.children.length,0);
  }finally{clearTimeout(timer);finish({width:2,height:1,close(){}});}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.closed,1);assert.equal(h.calls.draws,0);
});

test('fallback image decoding revokes its object URL when removal wins the generation race',async()=>{
  const {createCanvasImageOverlay}=await overlayModule(),h=overlayHarness();let fallbackImage;
  const revoked=[];class ImageFallback{set src(value){this._src=value;fallbackImage=this;}get src(){return this._src;}}
  const overlay=createCanvasImageOverlay({L:h.L,map:h.map,image:{blob:new Blob(['x'],{type:'image/png'}),width:2,height:1},
    placement:{center:[0,0],groundWidth:20,groundHeight:10,sourceWidth:2,sourceHeight:1,rotationDegrees:0},createBitmap:null,
    ImageConstructor:ImageFallback,createObjectURL:()=> 'blob:test',revokeObjectURL:url=>revoked.push(url)});
  overlay.addTo(h.map);overlay.remove();assert.deepEqual(revoked,['blob:test']);
  fallbackImage.naturalWidth=2;fallbackImage.naturalHeight=1;fallbackImage.onload();
  await overlay.ready;assert.equal(h.calls.draws,0);assert.equal(h.map.listenerCount(),0);assert.equal(h.pane.children.length,0);
});
