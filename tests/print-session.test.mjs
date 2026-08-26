import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import {waitForMapTiles} from '../src/print-session.mjs';

function tileFixture(){
  const dom=new JSDOM('<div id="map"></div>');
  const container=dom.window.document.getElementById('map');
  container.getBoundingClientRect=()=>({left:0,top:0,right:500,bottom:500});
  function tile({left=0,complete=true,width=256}={}){
    const img=dom.window.document.createElement('img');img.className='leaflet-tile';
    Object.defineProperties(img,{complete:{value:complete,configurable:true},naturalWidth:{value:width,configurable:true}});
    img.getBoundingClientRect=()=>({left,top:0,right:left+256,bottom:256});container.append(img);return img;
  }
  return {dom,container,tile};
}

test('tile readiness ignores failed buffered tiles outside the print viewport',async()=>{
  const {container,tile}=tileFixture();tile();tile({left:600,width:0});
  await waitForMapTiles(container);
});

test('tile readiness rejects missing, failed and timed out visible tiles',async()=>{
  const {container,tile}=tileFixture();
  await assert.rejects(waitForMapTiles(container),/No map tiles/);
  const failed=tile({width:0});await assert.rejects(waitForMapTiles(container),/failed to load/);failed.remove();
  tile({complete:false});await assert.rejects(waitForMapTiles(container,{timeoutMs:5}),/in time/);
});

test('tile readiness waits for pending visible images to finish loading',async()=>{
  const {dom,container,tile}=tileFixture();const img=tile({complete:false});
  let finished=false;const pending=waitForMapTiles(container).then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);
  Object.defineProperty(img,'complete',{value:true});
  img.dispatchEvent(new dom.window.Event('load'));await pending;assert.equal(finished,true);
});

test('print preparation sizes the live map before fitting and restores it on close',async()=>{
  const {createPrintSession}=await import('../src/print-session.mjs');
  const dom=new JSDOM('<div id="mapHome"><div id="map"></div></div><div id="printPreview" hidden><div id="printMapHost"></div><button id="confirmPrint"></button><div id="printStatus"></div></div>');
  const document=dom.window.document,calls=[];
  const map={getCenter:()=>[43,-79],getZoom:()=>14,invalidateSize:()=>calls.push('size'),setView:(center,zoom)=>calls.push([center,zoom])};
  let valid=true;
  const session=createPrintSession({document,map,validate:()=>valid,
    fit:()=>{assert.equal(document.getElementById('printPreview').hidden,false);assert.equal(document.getElementById('map').parentElement.id,'printMapHost');calls.push('fit');},
    render:()=>{},waitForTiles:async()=>calls.push('tiles'),onRestore:()=>{}});
  assert.equal(await session.open(),true);
  assert.deepEqual(calls.slice(0,3),['size','fit','tiles']);
  assert.equal(document.getElementById('confirmPrint').disabled,false);
  session.close();
  assert.equal(document.getElementById('map').parentElement.id,'mapHome');
  assert.deepEqual(calls.at(-1),[[43,-79],14]);
  valid=false;assert.equal(await session.open(),false);
  assert.equal(document.getElementById('printPreview').hidden,true);
});

test('failed tiles block printing and closing during loading cannot later enable print',async()=>{
  const {createPrintSession}=await import('../src/print-session.mjs');
  const dom=new JSDOM('<div id="mapHome"><div id="map"></div></div><div id="printPreview" hidden><div id="printMapHost"></div><button id="confirmPrint"></button><div id="printStatus"></div></div>');
  const document=dom.window.document;
  const map={getCenter:()=>[0,0],getZoom:()=>1,invalidateSize(){},setView(){}};
  const session=createPrintSession({document,map,validate:()=>true,fit(){},render(){},waitForTiles:async()=>{throw new Error('Map tiles are unavailable.');},onRestore(){}});
  assert.equal(await session.open(),false);
  assert.equal(document.getElementById('confirmPrint').disabled,true);
  assert.match(document.getElementById('printStatus').textContent,/unavailable/);
  session.close();
  let release;const pending=new Promise(r=>release=r);
  const loading=createPrintSession({document,map,validate:()=>true,fit(){},render(){},waitForTiles:()=>pending,onRestore(){}});
  const opening=loading.open();loading.close();release();
  assert.equal(await opening,false);
  assert.equal(document.getElementById('confirmPrint').disabled,true);
});

test('native preview blocks overflowing project, title and source cells and still restores the editor',async()=>{
  const {createPrintSession}=await import('../src/print-session.mjs');
  for(const [selector,label,axis='Height'] of [['.tb-project','project'],['.tb-title','title'],['.tb-details','details'],['.tb-source','source'],['#printLegend','legend','Width']]){
    const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'));
    const document=dom.window.document,cell=document.querySelector(selector);
    Object.defineProperties(cell,{['scroll'+axis]:{value:150},['client'+axis]:{value:100}});
    let restored=false;
    const map={getCenter:()=>[43,-79],getZoom:()=>15,invalidateSize(){},setView(){restored=true;}};
    const session=createPrintSession({document,map,validate:()=>true,fit(){},render(){},waitForTiles:async()=>{},onRestore(){}});
    assert.equal(await session.open(),false,selector);
    assert.equal(document.getElementById('confirmPrint').disabled,true);
    assert.match(document.getElementById('printStatus').textContent,new RegExp(`Figure A.*${label}`,'i'));
    session.close();assert.equal(restored,true);assert.equal(document.getElementById('map').parentElement.id,'mapHome');
  }
});
