import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('index exposes the core Phase I workflow controls', () => {
  const html=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
  for (const id of ['address','searchAddress','drawSite','drawBuilding','finishDraw','figureList','uploadAerial','uploadGeology','printA3','exportDxf']) {
    assert.match(html,new RegExp(`id=["']${id}["']`),`missing #${id}`);
  }
});
