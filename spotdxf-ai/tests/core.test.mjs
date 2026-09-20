import test from 'node:test';
import assert from 'node:assert/strict';
import { parseElevationText, buildCsv, buildDxf, buildCivil3dPnezd, buildLandXml, buildCivil3dSoftdeskDxf, metresPerPixel } from '../lib/core.mjs';

test('parses 2 and 3 digit survey elevations', () => {
  const p = parseElevationText('179.08 79.07 178.00');
  assert.equal(p.length, 3);
  assert.equal(p[0].validRange, true);
  assert.equal(p[1].validRange, true);
  assert.equal(p[2].roundHundredth, true);
});

test('300 dpi at 1:1500 gives 0.127 m per pixel', () => {
  assert.equal(metresPerPixel(1500, 300), 0.127);
});

test('CSV and DXF contain selected point with Z elevation', () => {
  const points = [{include:true,value:181.84,x:100,y:200,status:'OK',rawFull:'181.84'}];
  const opts = {imageHeight:1000,scale:1500,dpi:300,originX:0,originY:0,startPoint:1001,description:'SPOT_ELEV'};
  const csv = buildCsv(points, opts);
  const dxf = buildDxf(points, opts);
  assert.match(csv, /181\.84/);
  assert.match(dxf, /POINT/);
  assert.match(dxf, /30\n181\.840/);
});

test('Civil 3D PNEZD is headerless and ordered P,N,E,Z,D', () => {
  const points = [{include:true,value:181.84,x:100,y:200,status:'OK'}];
  const opts = {imageHeight:1000,scale:1500,dpi:300,originX:500000,originY:4800000,startPoint:5001,description:'SPOT_ELEV'};
  const pnezd = buildCivil3dPnezd(points, opts);
  assert.equal(pnezd.split(',')[0], '5001');
  assert.match(pnezd, /,SPOT_ELEV\r\n$/);
  assert.equal(pnezd.split('\n').length, 2);
});

test('LandXML exports COGO point name, description, northing/easting/elevation', () => {
  const points = [{include:true,value:181.84,x:100,y:200,status:'OK'}];
  const opts = {imageHeight:1000,scale:1500,dpi:300,originX:500000,originY:4800000,startPoint:5001,description:'SPOT_ELEV',date:'2026-09-19'};
  const xml = buildLandXml(points, opts);
  assert.match(xml, /<CgPoints>/);
  assert.match(xml, /<CgPoint name="5001" desc="SPOT_ELEV" code="SPOT_ELEV">/);
  assert.match(xml, /181\.840<\/CgPoint>/);
});


test('Civil 3D DXF uses Softdesk POINT block with ELEV POINT DESC attributes', () => {
  const points = [{include:true,value:181.84,x:100,y:200,status:'OK'}];
  const opts = {imageHeight:1000,scale:1500,dpi:300,originX:500000,originY:4800000,startPoint:5001,description:'SPOT_ELEV'};
  const dxf = buildCivil3dSoftdeskDxf(points, opts);
  assert.match(dxf, /2\nPOINT\n70\n2\n/);
  assert.match(dxf, /2\nELEV\n/);
  assert.match(dxf, /2\nPOINT\n/);
  assert.match(dxf, /2\nDESC\n/);
  assert.match(dxf, /1\n181\.840\n2\nELEV\n/);
  assert.match(dxf, /1\n5001\n2\nPOINT\n/);
  assert.match(dxf, /1\nSPOT_ELEV\n2\nDESC\n/);
  assert.match(dxf, /0\nINSERT\n8\nSPOT_ELEVATIONS\n2\nPOINT\n66\n1\n/);
});
