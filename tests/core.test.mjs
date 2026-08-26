import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, closeRing, pointInPolygon, figureDefaults, buildDxf } from '../src/core.mjs';

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
