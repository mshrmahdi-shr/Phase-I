import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createProject, closeRing, pointInPolygon, figureDefaults, buildDxf, extractNetworkLinks, normalizeMrd128Unit, getMrd128Legend, kmlColorToCss } from '../src/core.mjs';

const mrd128 = fs.readFileSync(new URL('../data/mrd128.kml', import.meta.url), 'utf8');

test('createProject creates the five core figures with expected extents', () => {
  const p = createProject({ name: 'Test', address: '92 Orchard Road' });
  assert.equal(p.name, 'Test');
  assert.equal(p.address, '92 Orchard Road');
  assert.deepEqual(Object.keys(p.figures), ['A','B','C','D','E']);
  assert.equal(p.figures.A.extentMeters, 500);
  assert.equal(p.figures.D.extentMeters, 2000);
  assert.equal(p.figures.E.extentMeters, 20000);
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
