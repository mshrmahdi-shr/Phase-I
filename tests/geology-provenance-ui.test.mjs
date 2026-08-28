import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import JSZip from 'jszip';
import {parsePolys,readKmz} from '../src/geology.mjs';
import {createGeologyProvenanceController} from '../src/geology-provenance-ui.mjs';
import {createCadExportController} from '../src/cad-ui.mjs';
import {MIN_ACQUISITION_YEAR} from '../src/imagery/provider-registry.mjs';

const KML='<kml><Document><Placemark><name>55b Custom meaning</name><description>Customer geology</description><Polygon><outerBoundaryIs><LinearRing><coordinates>-80,43 -79,43 -79,44 -80,44 -80,43</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>';
const PROFILE={schemaVersion:1,id:'company-1',companyName:'Acme Environmental',address:'22 King Street',phone:'416-555-0110',email:'hello@acme.test',website:'https://acme.test',preparedBy:'',reviewedBy:'',logoAssetId:'logo-1',logoMime:'image/png',logoWidth:3,logoHeight:2,logoPlacement:{align:'left',scale:1},updatedAt:'2026-08-26T12:00:00Z'};
function fill(document,{year='',verification='unknown'}={}){const $=id=>document.getElementById(id);$('geologySourceName').value='Bed rock-126Rev1_Legend / supplied KML';$('geologySourceCredits').value='Prepared by Example Engineer';$('geologySourceUrl').value='';$('geologySourceLicense').value='Written project-use licence on file';$('geologyPermissionEvidence').value='Client confirmed use and redistribution for this project';$('geologyAcquisitionYear').value=year;$('geologyYearVerification').value=verification;$('geologyRightsConfirmed').checked=true;}
async function waitFor(predicate){for(let index=0;index<30;index++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,0));}throw new Error('UI condition timed out.');}
function parser(dom){return (text,kind)=>{const previous=globalThis.DOMParser;globalThis.DOMParser=dom.window.DOMParser;try{return parsePolys(text,kind);}finally{if(previous===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=previous;}};}

test('real KML provenance form commits only after complete rights evidence and reaches the selected E CAD exporter',async()=>{
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://app.test/'}),document=dom.window.document,$=id=>document.getElementById(id);let committed=null,cadInput=null;
  const provenance=createGeologyProvenanceController({document,parsePolys:parser(dom),readKmz,Zip:class{},onCommit:value=>{committed=value;}});
  const pending=provenance.importFile({name:'bedrock.kml',text:async()=>KML},'bedrock');await waitFor(()=>$('geologyProvenanceDialog').hidden===false);
  assert.equal($('geologyProvenanceDialog').hidden,false);$('saveGeologyProvenance').click();await Promise.resolve();assert.match($('geologyProvenanceStatus').textContent,/credits|licen[cs]e|evidence/i);assert.equal(committed,null,'a bare/default form cannot commit');
  fill(document);$('saveGeologyProvenance').click();assert.equal(await pending,true);assert.equal(committed.kind,'bedrock');assert.equal(committed.features.length,1);assert.equal(committed.source.acquisitionYear,null);assert.equal(committed.source.acquisitionYearVerification,'unknown');
  const cad=createCadExportController({document,getSnapshot:()=>({project:{location:{lat:43.65,lng:-79.38}},companyProfile:PROFILE,selection:[{kind:'figure',code:'E'}],datasets:{bedrock:{source:committed.source}},blockers:[],ready:true}),setBusy(){},exportPackage:async input=>{cadInput=input;return {blob:new Blob(['zip'],{type:'application/zip'}),filename:'custom-e.zip',imageCount:1,pageCount:1};},download(){}});
  assert.equal(cad.refresh(),true);await cad.start();assert.deepEqual(cadInput.datasets.bedrock.source,committed.source);cad.destroy();provenance.destroy();dom.window.close();
});

test('cancel, invalid year state, and later edit never invent provenance or replace the previous source',async()=>{
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://app.test/'}),document=dom.window.document,$=id=>document.getElementById(id),commits=[];
  const provenance=createGeologyProvenanceController({document,parsePolys:parser(dom),readKmz,Zip:class{},onCommit:value=>commits.push(value)});
  let pending=provenance.importFile({name:'cancel.kml',text:async()=>KML},'surficial');await waitFor(()=>$('geologyProvenanceDialog').hidden===false);$('cancelGeologyProvenance').click();assert.equal(await pending,false);assert.deepEqual(commits,[]);
  pending=provenance.importFile({name:'invalid.kml',text:async()=>KML},'surficial');await waitFor(()=>$('geologyProvenanceDialog').hidden===false);fill(document,{year:'2011',verification:'unknown'});$('saveGeologyProvenance').click();await Promise.resolve();assert.match($('geologyProvenanceStatus').textContent,/verification/i);assert.deepEqual(commits,[]);$('geologyYearVerification').value='verified';$('saveGeologyProvenance').click();assert.equal(await pending,true);assert.equal(commits[0].source.acquisitionYear,2011);
  const editing=provenance.editSource('surficial',commits[0].source);await waitFor(()=>$('geologyProvenanceDialog').hidden===false);$('geologySourceCredits').value='Corrected organization credit';$('saveGeologyProvenance').click();assert.equal(await editing,true);assert.equal(commits[1].mode,'edit');assert.equal(commits[1].source.credits,'Corrected organization credit');
  provenance.destroy();dom.window.close();
});

test('the same provenance gate reads a real KMZ before showing the form',async()=>{
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://app.test/'}),document=dom.window.document,$=id=>document.getElementById(id);let committed=false;
  const archive=new JSZip();archive.file('doc.kml',KML);const file=await archive.generateAsync({type:'uint8array'});Object.defineProperty(file,'name',{value:'supplied.kmz'});
  const provenance=createGeologyProvenanceController({document,parsePolys:parser(dom),readKmz,Zip:JSZip,onCommit:()=>{committed=true;}}),pending=provenance.importFile(file,'bedrock');await waitFor(()=>$('geologyProvenanceDialog').hidden===false);assert.match($('geologySourceName').value,/supplied\.kmz/);$('cancelGeologyProvenance').click();assert.equal(await pending,false);assert.equal(committed,false);provenance.destroy();dom.window.close();
});

test('the provenance form exposes and enforces the same acquisition-year range before commit',async()=>{
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://app.test/'}),document=dom.window.document,$=id=>document.getElementById(id),commits=[];
  const maximum=new Date().getUTCFullYear()+1,provenance=createGeologyProvenanceController({document,parsePolys:parser(dom),readKmz,Zip:class{},onCommit:value=>commits.push(value)});
  assert.equal($('geologyAcquisitionYear').min,String(MIN_ACQUISITION_YEAR));assert.equal($('geologyAcquisitionYear').max,String(maximum));
  let pending=provenance.importFile({name:'too-early.kml',text:async()=>KML},'bedrock');await waitFor(()=>$('geologyProvenanceDialog').hidden===false);fill(document,{year:String(MIN_ACQUISITION_YEAR-1),verification:'verified'});$('saveGeologyProvenance').click();await Promise.resolve();assert.deepEqual(commits,[]);assert.match($('geologyProvenanceStatus').textContent,/1850|year|range/i);$('cancelGeologyProvenance').click();assert.equal(await pending,false);
  pending=provenance.importFile({name:'minimum.kml',text:async()=>KML},'bedrock');await waitFor(()=>$('geologyProvenanceDialog').hidden===false);fill(document,{year:String(MIN_ACQUISITION_YEAR),verification:'verified'});$('saveGeologyProvenance').click();assert.equal(await pending,true);assert.equal(commits[0].source.acquisitionYear,MIN_ACQUISITION_YEAR);
  provenance.destroy();dom.window.close();
});
