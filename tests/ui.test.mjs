import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';

test('index exposes the core Phase I workflow controls', () => {
  const html=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
  for (const id of ['address','searchAddress','drawSite','drawBuilding','finishDraw','figureList','uploadAerial','uploadGeology','printA3','exportDxf']) {
    assert.match(html,new RegExp(`id=["']${id}["']`),`missing #${id}`);
  }
});

test('print panel stays visible until all live requirements are corrected',async()=>{
  const {createPreflight}=await import('../print-preflight.mjs');
  const dom=new JSDOM('<button id="printA3"></button><div id="printValidation" hidden></div>');
  let state={project:{},figureCode:'A'};
  const controller=createPreflight({document:dom.window.document,getState:()=>state});
  assert.equal(controller.check(),false);
  const panel=dom.window.document.getElementById('printValidation');
  assert.equal(panel.hidden,false);
  state.project.name='Filled';controller.refresh();
  assert.equal(panel.hidden,false);
  assert.equal(panel.querySelectorAll('li').length,4);
  state.project={name:'Ready',projectNo:'1',date:'2026-08-26',address:'Public test site',location:{lat:43,lng:-79}};
  controller.refresh();assert.equal(panel.hidden,true);
  state.figureCode='D';state.geologyLoaded=true;state.geologySiteUnit=null;
  assert.equal(controller.check(),false);
  assert.match(panel.textContent,/detected/);
});
