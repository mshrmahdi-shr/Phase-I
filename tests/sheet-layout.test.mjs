import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject} from '../src/core.mjs';

test('layout fits the approved A3 frame with each figure default when no A3 view is saved',async()=>{
  const {sheetGeometry}=await import('../src/sheet-layout.mjs');
  const p=createProject();p.location={lat:43.7,lng:-79.3};
  for(const [code,minimum] of Object.entries({A:500,B:100,C:1000,D:2000,E:20000})){
    const g=sheetGeometry(p,code);
    assert.deepEqual(g.page,{width:420,height:297,margin:7});
    assert.equal(g.sheet.width,406);assert.equal(g.sheet.height,283);
    assert.equal(g.mapFrame.width,332.4);assert.equal(g.mapFrame.height,278.4);
    assert.ok(g.raster.width*g.raster.height<16000000);
    assert.ok(g.scale.groundWidth>=minimum);
    p.figures[code].extentMeters=1;
    assert.deepEqual(sheetGeometry(p,code).bounds,g.bounds,'unsaved figure extent is migration/display metadata');
  }
  assert.throws(()=>sheetGeometry(p,'A',149),/150 DPI|300 DPI/i);
  assert.throws(()=>sheetGeometry(p,'A',600),/Unsafe raster dimensions; choose 300 DPI/i);
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
test('saved A-E crops may be smaller or larger than their default A3 views',async()=>{
  const {sheetGeometry}=await import('../src/sheet-layout.mjs');
  const small={north:43.7002,south:43.6998,east:-79.2997,west:-79.3003};
  const large={north:44.2,south:43.2,east:-78.7,west:-79.9};
  for(const [name,selected] of Object.entries({small,large}))for(const code of ['A','B','C','D','E']){
    const p=createProject();p.location={lat:43.7,lng:-79.3};
    p.figures[code].extentMeters=1;p.figures[code].bounds=selected;
    const geometry=sheetGeometry(p,code),epsilon=1e-10;
    assert.ok(geometry.bounds.north+epsilon>=selected.north&&geometry.bounds.south-epsilon<=selected.south,`${name} ${code} must contain saved latitude bounds`);
    assert.ok(geometry.bounds.east+epsilon>=selected.east&&geometry.bounds.west-epsilon<=selected.west,`${name} ${code} must contain saved longitude bounds`);
    if(name==='small')assert.ok(geometry.scale.groundWidth<100,`${code} must not expand a small saved crop to its default extent`);
    else assert.ok(geometry.scale.groundWidth>90000,`${code} must preserve a large saved crop`);
  }
});

test('saved A3 views reject SITE exclusion, non-finite, inverted, degenerate, and out-of-range bounds',async()=>{
  const {sheetGeometry}=await import('../src/sheet-layout.mjs');
  const p=createProject();p.location={lat:43.7,lng:-79.3};
  p.figures.A.bounds={north:43.701,south:43.699,east:-79.298,west:-79.299};
  assert.throws(()=>sheetGeometry(p,'A'),/SITE.*view/i);
  for(const bounds of [
    {north:NaN,south:43.699,east:-79.299,west:-79.301},
    {north:43.699,south:43.701,east:-79.299,west:-79.301},
    {north:43.7,south:43.7,east:-79.299,west:-79.301},
    {north:43.701,south:43.699,east:181,west:-79.301}
  ]){
    p.figures.A.bounds=bounds;
    assert.throws(()=>sheetGeometry(p,'A'),/SITE.*view/i);
  }
});

test('saved A3 views explicitly reject antimeridian crossings and Mercator-overflow aspect fits',async()=>{
  const {sheetGeometry,captureFigureView}=await import('../src/sheet-layout.mjs');
  const p=createProject();p.location={lat:10,lng:179.95};
  p.figures.A.bounds={north:10.01,south:9.99,east:-179.9,west:179.9};
  assert.throws(()=>sheetGeometry(p,'A'),/antimeridian/i);
  assert.throws(()=>captureFigureView(p,'A',p.figures.A.bounds),/antimeridian/i);
  p.location={lat:84.9995,lng:0};p.figures.A.bounds={north:85,south:84.999,east:.1,west:-.1};
  assert.throws(()=>sheetGeometry(p,'A'),/Mercator/i);
});

test('captured display extent follows the final fitted saved crop instead of a figure minimum',async()=>{
  const {captureFigureView,groundHeight}=await import('../src/sheet-layout.mjs');
  const p=createProject();p.location={lat:43.7,lng:-79.3};
  const captured=captureFigureView(p,'E',{north:43.7002,south:43.6998,east:-79.2997,west:-79.3003});
  assert.ok(captured.extentMeters<100,'the captured display span must not be clamped to Figure E default');
  assert.equal(captured.extentMeters,Math.ceil(groundHeight(captured.bounds)));
});
test('Figure C has explicit Toporama WMS metadata with no street fallback',async()=>{
  const {sourceForFigure}=await import('../src/map-sources.mjs');
  const source=sourceForFigure('C');assert.equal(source.kind,'wms');
  assert.equal(source.url,'https://maps.geogratis.gc.ca/wms/toporama_en');
  assert.equal(source.layer,'WMS-Toporama');assert.equal(source.version,'1.1.1');assert.equal(source.crs,'EPSG:3857');
  assert.match(sourceForFigure('A').url,/^https:\/\/tile.openstreetmap.org/);
  assert.throws(()=>sourceForFigure('F'),/figure/i);
});
