import test from 'node:test';
import assert from 'node:assert/strict';
import { parseElevationText, buildCsv, buildDxf, metresPerPixel } from '../lib/core.mjs';

test('parses survey elevations and rejects 2-digit false read', () => {
  const p = parseElevationText('179.08 79.07 178.00');
  assert.equal(p.length, 3);
  assert.equal(p[0].validRange, true);
  assert.equal(p[1].validRange, false);
  assert.equal(p[2].roundHundredth, true);
});

test('300 dpi at 1:1500 gives 0.127 m per pixel', () => {
  assert.equal(metresPerPixel(1500, 300), 0.127);
});

test('CSV and DXF contain selected point with Z elevation', () => {
  const points = [{include:true,value:181.84,x:100,y:200,status:'OK',rawFull:'181.84'}];
  const opts = {imageHeight:1000,scale:1500,dpi:300,originX:0,originY:0};
  const csv = buildCsv(points, opts);
  const dxf = buildDxf(points, opts);
  assert.match(csv, /181\.84/);
  assert.match(dxf, /POINT/);
  assert.match(dxf, /30\n181\.840/);
});
