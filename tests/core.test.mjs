import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as core from '../src/core.mjs';
import { createProject, closeRing, pointInPolygon, figureDefaults, buildDxf, extractNetworkLinks, normalizeMrd128Unit, getMrd128Legend, kmlColorToCss } from '../src/core.mjs';
import {emptyCompanyProfile,snapshotCompanyProfile} from '../src/company-profile.mjs';

const mrd128 = fs.readFileSync(new URL('../data/mrd128.kml', import.meta.url), 'utf8');

test('createProject creates the five core figures with expected extents', () => {
  const p = createProject({ name: 'Test', address: '92 Orchard Road' });
  assert.equal(p.name, 'Test');
  assert.equal(p.address, '92 Orchard Road');
  assert.deepEqual(Object.keys(p.figures), ['A','B','C','D','E']);
  assert.equal(p.figures.A.extentMeters, 500);
  assert.equal(p.figures.B.extentMeters, 100);
  assert.equal(p.figures.D.extentMeters, 2000);
  assert.equal(p.figures.E.extentMeters, 20000);
});

test('new project keeps project number blank and restores a profile snapshot',()=>{
  const p=createProject();
  assert.equal(p.projectNo,'');
  const validProfile={...emptyCompanyProfile(),companyName:'ABC Engineering',address:'1 Main St',
    phone:'416-555-0100',email:'maps@example.com',website:'https://example.com',
    logoAssetId:'logo-1',logoMime:'image/png',logoWidth:400,logoHeight:160};
  p.companyProfileSnapshot=snapshotCompanyProfile(validProfile);
  const restored=core.restoreProject(p);
  assert.equal(restored.companyProfileSnapshot.companyName,'ABC Engineering');
  assert.equal(restored.schemaVersion,4);
});

test('restoreProject gives legacy projects no profile snapshot and rejects invalid snapshots',()=>{
  const legacy=createProject();
  assert.equal(core.restoreProject(legacy).companyProfileSnapshot,null);
  legacy.companyProfileSnapshot={companyName:'Unsafe'};
  assert.throws(()=>core.restoreProject(legacy),/company profile snapshot/i);
});

test('closeRing appends the first point only when needed', () => {
  assert.deepEqual(closeRing([[1,2],[3,4]]), [[1,2],[3,4],[1,2]]);
  assert.deepEqual(closeRing([[1,2],[3,4],[1,2]]), [[1,2],[3,4],[1,2]]);
});

test('pointInPolygon detects points inside and outside a polygon', () => {
  const square = [[0,0],[10,0],[10,10],[0,10],[0,0]];
  assert.equal(pointInPolygon([5,5], square), true);
  assert.equal(pointInPolygon([15,5], square), false);
});

test('figureDefaults returns stable labels and extents', () => {
  const f = figureDefaults();
  assert.equal(f.B.title, 'CURRENT AERIAL / SITE PLAN');
  assert.equal(f.C.title, 'TOPOGRAPHICAL MAP');
  assert.equal(f.E.title, 'BEDROCK GEOLOGY');
});

test('buildDxf includes layer names and polygon vertices', () => {
  const dxf = buildDxf({ siteBoundary: [[-79,43],[-79.1,43],[-79.1,43.1]], buildingBoundary: [] });
  assert.match(dxf, /SITE_BOUNDARY/);
  assert.match(dxf, /LWPOLYLINE/);
  assert.match(dxf, /10\n-79/);
});

test('extractNetworkLinks finds MRD128 official polygon and raster links', () => {
  const links = extractNetworkLinks(mrd128);
  const polygon = links.find(x => x.name === 'Surficial Geology');
  const raster = links.find(x => x.name === 'Surficial Geology Raster');
  assert.ok(polygon);
  assert.match(polygon.href, /mrd128\/polygons\/doc\.kml$/i);
  assert.ok(raster);
  assert.match(raster.href, /SurficialGeology\/doc\.kmz$/i);
});

test('normalizeMrd128Unit extracts canonical subunit codes', () => {
  assert.equal(normalizeMrd128Unit('8A'), '8a');
  assert.equal(normalizeMrd128Unit('Unit 9C - foreshore'), '9c');
  assert.equal(normalizeMrd128Unit('5b Stone-poor till'), '5b');
  assert.equal(normalizeMrd128Unit('21'), '21');
});

test('MRD128 legend resolves official descriptions from supplied legend', () => {
  assert.equal(getMrd128Legend('9c').title, 'Coarse-textured glaciolacustrine deposits');
  assert.equal(getMrd128Legend('9c').detail, 'Foreshore and basinal deposits');
  assert.match(getMrd128Legend('5b').detail, /Stone-poor, sandy silt to silty sand-textured till/i);
  assert.match(getMrd128Legend('8a').detail, /Massive to well laminated/i);
});

test('KML AABBGGRR colors convert to CSS RGB and opacity', () => {
  assert.deepEqual(kmlColorToCss('7f00ff00'), { color:'#00ff00', opacity:127/255 });
  assert.deepEqual(kmlColorToCss('ff112233'), { color:'#332211', opacity:1 });
});

test('pointInPolygon excludes holes and consistently includes outer edges', () => {
  const outer = [[0,0],[10,0],[10,10],[0,10],[0,0]];
  const hole = [[3,3],[7,3],[7,7],[3,7],[3,3]];
  assert.equal(pointInPolygon([5,5], outer, [hole]), false);
  assert.equal(pointInPolygon([2,2], outer, [hole]), true);
  assert.equal(pointInPolygon([10,5], outer), true);
  assert.equal(pointInPolygon([3,5], outer, [hole]), false);
});

test('official unit presentation uses supplied PDF colors and retains parent material', () => {
  assert.equal(getMrd128Legend('18').color, '#811d8f');
  assert.equal(getMrd128Legend('5e').color, '#219b45');
  assert.equal(getMrd128Legend('9c').color, '#f4ea18');
  assert.equal(getMrd128Legend('9c').material, 'Sand, gravel, minor silt and clay');
  assert.equal(getMrd128Legend('9c').detail, 'Foreshore and basinal deposits');
  assert.equal(getMrd128Legend('5').detail, 'Silty sand to sand-textured till on Precambrian terrain');
});

test('figureBounds computes a 100 metre span without requiring an attached Leaflet layer', () => {
  const b=core.figureBounds({lat:0,lng:0},100);
  assert.ok(Math.abs(b.north-0.00044966)<0.00000001);
  assert.ok(Math.abs(b.south+0.00044966)<0.00000001);
  assert.ok(Math.abs(b.east-0.00044966)<0.00000001);
  assert.throws(()=>core.figureBounds({lat:null,lng:0},100));
});

test('legacy Figure B defaults migrate without losing project or custom extents', () => {
  const p=createProject({name:'Kept'}); p.figures.B.extentMeters=250;
  assert.equal(core.restoreProject(p).figures.B.extentMeters,100);
  assert.equal(core.restoreProject(p).name,'Kept');
  p.figures.B.extentMeters=150;
  assert.equal(core.restoreProject(p).figures.B.extentMeters,150);
  p.figures.B.bounds={north:43.1,south:42.9,east:-78.9,west:-79.1};p.location={lat:43,lng:-79};
  assert.deepEqual(core.restoreProject(p).figures.B.bounds,p.figures.B.bounds);
  p.figures.B.bounds={north:42,south:43,east:-79.1,west:-78.9};
  assert.throws(()=>core.restoreProject(p),/figure view/i);
  assert.throws(()=>core.restoreProject({name:'invalid'}));
});

test('export preferences restore only known figure codes and sources without rewriting project numbers',()=>{
  const p=createProject({projectNo:'FE 26-15876'});
  assert.deepEqual(p.exportPreferences.codes,[]);
  p.exportPreferences={codes:['E','C','A','A','Z'],sources:{A:'unknown',C:'toporama',E:'osm'}};
  p.geology.bedrock={source:{id:'MRD126-REV1',name:'Official'},siteUnit:'55b'};
  const restored=core.restoreProject(JSON.parse(JSON.stringify(p)));
  assert.equal(restored.projectNo,'FE 26-15876');
  assert.deepEqual(restored.exportPreferences.codes,['A','C','E']);
  assert.deepEqual(restored.exportPreferences.sources,{A:'osm',B:'esri-imagery',C:'toporama',D:'osm',E:'osm'});
  assert.equal(restored.geology.bedrock.source.id,'MRD126-REV1');
  delete p.exportPreferences;assert.deepEqual(core.restoreProject(p).exportPreferences.codes,[]);
  p.geology.bedrock={name:'My supplied geology.kmz',count:3,siteUnit:'Custom 55b'};
  assert.equal(core.restoreProject(p).geology.bedrock.source.id,'custom');
  assert.equal(core.restoreProject(p).geology.bedrock.name,'My supplied geology.kmz');
});
