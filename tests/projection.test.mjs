import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';

const projectionModule=()=>import('../src/projection.mjs');
const near=(actual,expected,tolerance,label='coordinate')=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} != ${expected} within ${tolerance}`);
const nearPoint=(actual,expected,tolerance)=>{near(actual[0],expected[0],tolerance,'easting');near(actual[1],expected[1],tolerance,'northing');};
const earthDistance=([firstLng,firstLat],[secondLng,secondLat])=>{
  const radians=Math.PI/180,meanLat=(firstLat+secondLat)/2*radians;
  return Math.hypot((firstLng-secondLng)*radians*6378137*Math.cos(meanLat),(firstLat-secondLat)*radians*6378137);
};
const maliciousProj4=({forward=point=>point,inverse=point=>point}={})=>{
  const implementation=()=>({forward,inverse});implementation.defs=()=>{};return implementation;
};

test('SITE longitude selects the four supported NAD83 UTM zones with explicit metre metadata',async()=>{
  const {utmZoneForLocation}=await projectionModule();
  for(const [lng,zone] of [[-93,15],[-87,16],[-81,17],[-75,18]])assert.deepEqual(
    utmZoneForLocation({lat:45,lng}),
    {zone,epsg:`EPSG:269${zone}`,name:`NAD83 / UTM zone ${zone}N`,units:'m'}
  );
  for(const [lng,zone] of [[-95.999999,15],[-90.000001,15],[-89.999999,16],[-84.000001,16],[-83.999999,17],[-78.000001,17],[-77.999999,18],[-72.000001,18]])assert.equal(utmZoneForLocation({lat:45,lng}).zone,zone);
});

test('exact UTM longitude boundaries are rejected as ambiguous instead of silently choosing a zone',async()=>{
  const {utmZoneForLocation}=await projectionModule();
  for(const lng of [-96,-90,-84,-78,-72])assert.throws(()=>utmZoneForLocation({lat:45,lng}),/boundary|ambiguous/i,String(lng));
});

test('zone selection rejects malformed, nonfinite, southern, polar, and unsupported SITE locations',async()=>{
  const {utmZoneForLocation}=await projectionModule();
  for(const location of [undefined,null,{},[],{lat:'45',lng:-79},{lat:45,lng:'-79'},{lat:NaN,lng:-79},{lat:45,lng:Infinity}])assert.throws(()=>utmZoneForLocation(location),/location|latitude|longitude|finite/i);
  for(const location of [{lat:-0.000001,lng:-79},{lat:-90,lng:-79}])assert.throws(()=>utmZoneForLocation(location),/north|southern|hemisphere/i);
  for(const location of [{lat:84.000001,lng:-79},{lat:91,lng:-79}])assert.throws(()=>utmZoneForLocation(location),/latitude|UTM|supported/i);
  for(const location of [{lat:45,lng:-96.000001},{lat:45,lng:-71.999999},{lat:45,lng:-181},{lat:45,lng:181}])assert.throws(()=>utmZoneForLocation(location),/zone|supported|longitude/i);
  assert.equal(utmZoneForLocation({lat:0,lng:-79}).zone,17,'the equator belongs to the northern UTM definition');
});

test('projectors register explicit NAD83 northern UTM definitions and expose their frozen CRS',async()=>{
  const {createProjector}=await projectionModule();
  for(const [lng,zone] of [[-93,15],[-87,16],[-81,17],[-75,18]]){
    const projector=createProjector({lat:45,lng},{proj4Impl:proj4}),definition=proj4.defs(`EPSG:269${zone}`);
    assert.deepEqual(projector.crs,{zone,epsg:`EPSG:269${zone}`,name:`NAD83 / UTM zone ${zone}N`,units:'m'});
    assert.equal(Object.isFrozen(projector.crs),true);
    assert.equal(definition.projName,'utm');assert.equal(definition.zone,zone);assert.equal(definition.datumCode,'nad83');
    assert.equal(definition.units,'m');assert.notEqual(definition.utmSouth,true);
  }
});

test('NOAA NGS NAD83 control marks project within two centimetres in every supported zone',async()=>{
  const {createProjector}=await projectionModule();
  // Published NAD83(2011) latitude/longitude and UTM values. Projection is realization-independent
  // when both coordinate forms use the same NAD83 realization. Sources:
  // zone 15, NGS PID DL3192: https://geodesy.noaa.gov/web/science_edu/presentations_library/files/ngs_updates.pdf#page=15
  // zones 16-18, NGS OPUS PIDs BE1917, JY0678, DN6986: https://geodesy.noaa.gov/OPUS/getDatasheet.jsp?PID=<PID>
  const controls=[
    {zone:15,point:[-92.84634490555555,47.393935830555556],utm:[511595.578,5248953.723]},
    {zone:16,point:[-85.83564099444445,30.22622436388889],utm:[612047.979,3344426.472]},
    {zone:17,point:[-82.78284718055555,39.012358819444444],utm:[345641.770,4319660.073]},
    {zone:18,point:[-73.10988251944444,44.92689951944444],utm:[649159.582,4976567.704]}
  ];
  for(const control of controls){
    const projector=createProjector({lat:control.point[1],lng:control.point[0]});
    assert.equal(projector.crs.zone,control.zone);nearPoint(projector.forward(control.point),control.utm,.02);
  }
});

test('forward and inverse round trips stay under two centimetres throughout the four Ontario zones',async()=>{
  const {createProjector}=await projectionModule();
  for(const point of [[-94.5,49.2],[-88.2,48.1],[-81.2497,42.9834],[-75.6972,45.4215]]){
    const projector=createProjector({lng:point[0],lat:point[1]}),projected=projector.forward(point),roundTrip=projector.inverse(projected);
    assert.ok(earthDistance(roundTrip,point)<.02,`${projector.crs.epsg} round trip exceeded 2 cm`);
  }
});

test('projectors reject malformed and out-of-range geographic or projected coordinates',async()=>{
  const {createProjector}=await projectionModule(),projector=createProjector({lat:43.65,lng:-79.38});
  for(const point of [undefined,null,[],[1],[1,2,3],['-79',43],[NaN,43],[-79,Infinity]])assert.throws(()=>projector.forward(point),/coordinate|point|finite|longitude|latitude/i);
  for(const point of [[-97,45],[-71,45],[-79,-1],[-79,84.1],[-181,45],[181,45]])assert.throws(()=>projector.forward(point),/supported|north|latitude|longitude/i);
  for(const point of [undefined,null,[],[1],[1,2,3],['500000',4800000],[NaN,4800000],[500000,Infinity],[99999,4800000],[900001,4800000],[500000,-1],[500000,10000001]])assert.throws(()=>projector.inverse(point),/coordinate|point|finite|easting|northing|supported/i);
});

test('forward projection rejects every finite but implausible coordinate returned by an injected proj4 implementation',async()=>{
  const {createProjector}=await projectionModule(),location={lat:45,lng:-79},point=[-79,45];
  for(const output of [[-1,4800000],[99999,4800000],[900001,4800000],[500000,-1],[500000,10000001],[9e99,1e50],[500000,4800000,1]]){
    const projector=createProjector(location,{proj4Impl:maliciousProj4({forward:()=>output})});
    assert.throws(()=>projector.forward(point),/projected|UTM|easting|northing|coordinate|supported/i,JSON.stringify(output));
  }
  assert.deepEqual(createProjector(location,{proj4Impl:maliciousProj4({forward:()=>[500000,4800000]})}).forward(point),[500000,4800000]);
});

test('closed geographic rings are projected without mutation and preserve exact closure',async()=>{
  const {createProjector,projectRing}=await projectionModule(),projector=createProjector({lat:43.65,lng:-79.38});
  const ring=[[-79.39,43.64],[-79.37,43.64],[-79.37,43.66],[-79.39,43.66],[-79.39,43.64]],snapshot=structuredClone(ring);
  const projected=projectRing(ring,projector);
  assert.deepEqual(ring,snapshot);assert.equal(projected.length,ring.length);assert.deepEqual(projected.at(-1),projected[0]);
  projected.forEach((point,index)=>nearPoint(point,projector.forward(ring[index]),1e-8));
});

test('ring projection rejects empty, open, degenerate, malformed, and nonfinite rings and projector output',async()=>{
  const {createProjector,projectRing}=await projectionModule(),projector=createProjector({lat:43.65,lng:-79.38});
  for(const ring of [undefined,null,[],[[-79,43],[-78,43],[-79,43]],
    [[-79,43],[-78,43],[-78,44],[-79,44]],
    [[-79,43],[-79,43],[-79,43],[-79,43]],
    [[-80,43],[-79.7,43.3],[-80,43.4],[-79.6,43],[-80,43]],
    [[-79,43],[-78,43],[-78,44],[-79,43,0],[-79,43]],
    [[-79,43],[-78,43],[NaN,44],[-79,43]]
  ])assert.throws(()=>projectRing(ring,projector),/ring|closed|coordinate|degenerate|finite/i);
  assert.throws(()=>projectRing([[-79,43],[-78,43],[-78,44],[-79,43]],{forward:()=>[NaN,0]}),/projected|finite/i);
});

test('ring degeneracy is scale-aware for exact, near, and alternating collinear Ontario coordinates',async()=>{
  const {createProjector,projectRing}=await projectionModule(),projector=createProjector({lat:50,lng:-80});
  const rings=[
    [[-80.7,49.4],[-79.5,52.7],[-80.3,50.5],[-80.7,49.4]],
    [[-80.7,49.4],[-79.5,52.7],[-80.3,50.500000000001],[-80.7,49.4]],
    [[-80.7,49.4],[-79.5,52.7],[-80.4,50.225],[-79.8,51.875],[-80.7,49.4]]
  ];
  for(const ring of rings)assert.throws(()=>projectRing(ring,projector),/ring|degenerate|collinear/i);
});

test('local scale preserves a valid small Ontario ring despite its large absolute coordinates',async()=>{
  const {createProjector,projectRing}=await projectionModule(),projector=createProjector({lat:50,lng:-80});
  const ring=[[-80,50],[-79.99999999,50],[-79.99999999,50.00000001],[-80,50.00000001],[-80,50]];
  const projected=projectRing(ring,projector);
  assert.equal(projected.length,5);assert.deepEqual(projected.at(-1),projected[0]);
  assert.ok(Math.hypot(projected[1][0]-projected[0][0],projected[1][1]-projected[0][1])>.0005);
});

test('projected bounds cover every point and reject absent or malformed input',async()=>{
  const {projectedBounds}=await projectionModule();
  assert.deepEqual(projectedBounds([[630004.5,4830009],[629998,4830012.25],[630001,4829997]]),{west:629998,south:4829997,east:630004.5,north:4830012.25});
  assert.deepEqual(projectedBounds([[500000,4800000]]),{west:500000,south:4800000,east:500000,north:4800000});
  for(const points of [undefined,null,[],[[1]],[[1,2,3]],[[1,NaN]],'1,2'])assert.throws(()=>projectedBounds(points),/point|bounds|coordinate|finite/i);
});

test('projected rings and direct bounds enforce the same plausible NAD83 UTM coordinate range',async()=>{
  const {projectRing,projectedBounds}=await projectionModule(),ring=[[-79,43],[-78.5,43],[-78.5,43.5],[-79,43]];
  for(const output of [[-1,4800000],[900001,4800000],[500000,-1],[500000,10000001],[9e99,1e50]]){
    assert.throws(()=>projectRing(ring,{forward:()=>output}),/projected|UTM|easting|northing|supported/i,`ring ${output}`);
    assert.throws(()=>projectedBounds([[500000,4800000],output]),/projected|UTM|easting|northing|supported/i,`bounds ${output}`);
  }
});
