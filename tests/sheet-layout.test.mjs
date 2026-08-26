import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject,figureBounds} from '../src/core.mjs';

test('layout fits the approved A3 frame and preserves every minimum and selected extent',async()=>{
  const {sheetGeometry}=await import('../src/sheet-layout.mjs');
  const p=createProject();p.location={lat:43.7,lng:-79.3};
  for(const [code,minimum] of Object.entries({A:500,B:100,C:1000,D:2000,E:20000})){
    const g=sheetGeometry(p,code);
    assert.deepEqual(g.page,{width:420,height:297,margin:7});
    assert.equal(g.sheet.width,406);assert.equal(g.sheet.height,283);
    assert.equal(g.mapFrame.width,332.4);assert.equal(g.mapFrame.height,278.4);
    const required=figureBounds(p.location,minimum);
    assert.ok(g.bounds.west<=required.west&&g.bounds.east>=required.east);
    assert.ok(g.bounds.south<=required.south+1e-9&&g.bounds.north>=required.north-1e-9);
    assert.ok(g.raster.width*g.raster.height<16000000);
    p.figures[code].extentMeters=minimum*3;
    assert.ok(sheetGeometry(p,code).scale.groundWidth>g.scale.groundWidth*2.99);
  }
  assert.throws(()=>sheetGeometry(p,'A',600),/choose 300/i);
  p.figures.A.extentMeters=499;assert.throws(()=>sheetGeometry(p,'A'),/500/);
});
test('segmented metric scale measures final ground width at map centre latitude',async()=>{
  const {metricScale}=await import('../src/sheet-layout.mjs');
  const equator=metricScale({west:0,east:1,south:-.1,north:.1},1000,200);
  const north=metricScale({west:0,east:1,south:59.9,north:60.1},1000,200);
  assert.ok(Math.abs(equator.groundWidth-111195)<10);
  assert.ok(Math.abs(north.groundWidth/equator.groundWidth-.5)<.001);
  assert.equal(equator.segments.length,4);
  assert.ok(equator.pixelWidth<=200&&equator.pixelWidth>50);
  assert.equal(equator.distanceMeters/equator.groundWidth,equator.pixelWidth/1000);
  assert.match(equator.label,/km$/);
  assert.match(metricScale({west:0,east:.001,south:0,north:.001},1000).label,/m$/);
});
test('a saved figure view controls the A3 centre and contains the selected map extent',async()=>{
  const {sheetGeometry}=await import('../src/sheet-layout.mjs');
  const p=createProject();p.location={lat:43.7,lng:-79.3};
  const selected={north:43.704,south:43.696,east:-79.291,west:-79.302};
  p.figures.B.extentMeters=900;p.figures.B.bounds=selected;
  const geometry=sheetGeometry(p,'B');
  const epsilon=1e-10;
  assert.ok(geometry.bounds.north+epsilon>=selected.north&&geometry.bounds.south-epsilon<=selected.south);
  assert.ok(geometry.bounds.east+epsilon>=selected.east&&geometry.bounds.west-epsilon<=selected.west);
  const centre=(geometry.bounds.east+geometry.bounds.west)/2;
  assert.ok(centre>-79.299,'the saved, panned view must not be recentered on SITE');
  p.figures.B.bounds={north:44,south:43.9,east:-79.1,west:-79.2};
  assert.throws(()=>sheetGeometry(p,'B'),/SITE.*view/i);
});
test('Figure C has explicit Toporama WMS metadata with no street fallback',async()=>{
  const {sourceForFigure}=await import('../src/map-sources.mjs');
  const source=sourceForFigure('C');assert.equal(source.kind,'wms');
  assert.equal(source.url,'https://maps.geogratis.gc.ca/wms/toporama_en');
  assert.equal(source.layer,'WMS-Toporama');assert.equal(source.version,'1.1.1');assert.equal(source.crs,'EPSG:3857');
  assert.match(sourceForFigure('A').url,/^https:\/\/tile.openstreetmap.org/);
  assert.throws(()=>sourceForFigure('F'),/figure/i);
});
