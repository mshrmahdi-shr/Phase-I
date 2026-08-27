import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject} from '../src/core.mjs';
import {mapPoint} from '../src/sheet-layout.mjs';

const SITE={lng:-79.38,lat:43.65};
const BOUNDS={west:-79.405,south:43.632,east:-79.355,north:43.668};
const ITEM_ID='6f9719eb-3083-4bdb-a35b-d638a6efac19';

function officialItem(overrides={}){
  return {id:ITEM_ID,year:1972,sequence:2,title:'Toronto flight line 1972',mode:'official',providerId:'toronto',
    sourceUrl:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer',
    licenseUrl:'https://open.toronto.ca/open-data-licence/',attribution:'City of Toronto',policy:'exportable',resolutionMeters:.2,
    bounds:{...BOUNDS},placement:null,assetId:null,
    officialExport:{kind:'arcgis-export',url:'https://gis.toronto.ca/arcgis/rest/services/basemap/cot_historic_aerial_1972/MapServer/export',layer:null,maxWidth:4096,maxHeight:4096},
    createdAt:'2026-08-27T12:00:00.000Z',updatedAt:'2026-08-27T12:00:00.000Z',...overrides};
}

function project(item=officialItem()){
  const value=createProject({name:'Historical layout',projectNo:'AB-12345',address:'Toronto',date:'2026-08-27'});
  return {...value,location:{...SITE},historical:[item],historicalSequenceCounters:{'1972':2},
    siteBoundary:[[-79.39,43.64],[-79.37,43.64],[-79.37,43.66],[-79.39,43.66],[-79.39,43.64]],
    buildingBoundary:[[-79.385,43.645],[-79.375,43.645],[-79.375,43.655],[-79.385,43.655],[-79.385,43.645]]};
}

test('historical A3 geometry preserves the exact approved crop and shared boundary transform',async()=>{
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs');
  const item=officialItem(),geometry=historicalSheetGeometry(project(item),item,300);
  assert.deepEqual(geometry.page,{width:420,height:297,margin:7});
  assert.deepEqual(geometry.bounds,BOUNDS,'approved bounds are not fitted, expanded, or recentered');
  assert.equal(geometry.code,'H-1972-2');assert.equal(geometry.itemId,ITEM_ID);
  assert.ok(geometry.raster.width*geometry.raster.height<=16_000_000);
  assert.ok(Math.abs(geometry.raster.width/geometry.raster.height-420/297)<.001);
  const nw=mapPoint([BOUNDS.west,BOUNDS.north],geometry),se=mapPoint([BOUNDS.east,BOUNDS.south],geometry);
  assert.ok(Math.abs(nw[0])<1e-7&&Math.abs(nw[1])<1e-7);
  assert.ok(Math.abs(se[0]-geometry.raster.width)<1e-7&&Math.abs(se[1]-geometry.raster.height)<1e-7);
  const boundaryPoint=project(item).siteBoundary[0],pixel=mapPoint(boundaryPoint,geometry);
  assert.ok(pixel[0]>0&&pixel[0]<geometry.raster.width&&pixel[1]>0&&pixel[1]<geometry.raster.height);
  assert.equal(geometry.scale.groundWidth>0,true);
});

test('historical geometry rejects stale items, changed crops, invalid boundaries, and unsafe DPI',async()=>{
  const {historicalSheetGeometry}=await import('../src/historical-layout.mjs');
  const item=officialItem(),p=project(item);
  assert.throws(()=>historicalSheetGeometry({...p,historical:[]},item),/approved historical item/i);
  assert.throws(()=>historicalSheetGeometry(p,{...item,bounds:{...item.bounds,east:-79.34}}),/approved historical item|crop/i);
  assert.throws(()=>historicalSheetGeometry({...p,siteBoundary:[[0,0],[1,1]]},item),/boundary/i);
  assert.throws(()=>historicalSheetGeometry(p,item,600),/300 DPI|150 DPI/i);
});
