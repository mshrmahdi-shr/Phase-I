import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {createProjectPackageUI} from '../src/project-package-ui.mjs';

const HTML=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const CSS=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function harness(overrides={}){
  const dom=new JSDOM(HTML,{url:'https://app.test/',pretendToBeVisual:true}),document=dom.window.document,events=[],downloads=[];
  let state={project:{id:'current',name:'Current project'},companyProfile:{id:'current-company',companyName:'Current company'}};
  const controller=createProjectPackageUI({document,assetStore:{},Zip:class{},getState:()=>state,readState:async()=>structuredClone(state),
    persistState:async next=>{events.push('persist');state=structuredClone(next);},initialize:async()=>events.push('initialize'),onCommitted:async()=>events.push('committed'),setBusy:value=>events.push(`busy:${value}`),
    download:output=>downloads.push(output),exportPackage:async()=>({blob:new Blob(['zip']),filename:'project.phasei-project.zip'}),
    inspectPackage:async()=>({schemaVersion:1,project:{id:'imported',name:'Imported <img src=x>'},companyProfile:{id:'imported-company',companyName:'Imported <script>'},assets:[{metadata:{id:'a'}}],warnings:[]}),
    commitPackage:async(candidate,options)=>{await options.persistState({project:candidate.project,companyProfile:candidate.companyProfile});await options.initialize({project:candidate.project,companyProfile:candidate.companyProfile});return {project:candidate.project,companyProfile:candidate.companyProfile,addedAssetIds:['a'],reusedAssetIds:[]};},...overrides});
  return {dom,document,controller,events,downloads,get state(){return state;},set state(value){state=value;}};
}

test('package controls are accessible, recommended, and keep JSON explicitly labelled legacy',()=>{
  const document=new JSDOM(HTML).window.document;
  for(const id of ['exportProjectPackage','importProjectPackage','importProjectPackageFile','projectPackageDialog','projectPackageHeading','projectPackageStatus','projectPackageMeter','projectPackagePreview','confirmProjectPackageImport','cancelProjectPackage'])assert.ok(document.getElementById(id),`missing #${id}`);
  assert.match(document.getElementById('exportProjectPackage').textContent,/project package/i);assert.match(document.getElementById('projectPackageHelp').textContent,/recommended|backup|share/i);
  assert.match(document.getElementById('exportJson').textContent,/legacy json/i);assert.match(document.querySelector('label[for="importJson"]').textContent,/legacy json/i);
  const dialog=document.getElementById('projectPackageDialog');assert.equal(dialog.getAttribute('role'),'dialog');assert.equal(dialog.getAttribute('aria-modal'),'true');assert.equal(dialog.getAttribute('aria-labelledby'),'projectPackageHeading');
  assert.equal(document.getElementById('projectPackageStatus').getAttribute('aria-live'),'polite');assert.equal(document.getElementById('importProjectPackageFile').getAttribute('accept').includes('.phasei-project.zip'),true);
  assert.match(CSS,/#projectPackageDialog\s*\{/);assert.match(CSS,/\.project-package-panel\s*\{/);assert.match(CSS,/@media\(max-width:540px\)[\s\S]*\.project-package-actions/);
});

test('export reports progress and cancellation prevents a late package from downloading',async()=>{
  const gate=deferred();let signal,onProgress;
  const h=harness({exportPackage:async options=>{signal=options.signal;onProgress=options.onProgress;return gate.promise;}});
  h.document.getElementById('exportProjectPackage').focus();h.document.getElementById('exportProjectPackage').click();
  await Promise.resolve();assert.equal(h.document.getElementById('projectPackageDialog').hidden,false);assert.equal(h.document.body.classList.contains('project-package-open'),true);
  onProgress({phase:'reading-assets',completed:1,total:2});assert.match(h.document.getElementById('projectPackageStatus').textContent,/1 of 2/i);
  h.document.getElementById('cancelProjectPackage').click();assert.equal(signal.aborted,true);
  assert.equal(h.document.getElementById('projectPackageDialog').hidden,false,'cancelling dialog remains visible until the operation settles');
  assert.equal(h.document.getElementById('cancelProjectPackage').disabled,false);assert.equal(h.document.activeElement,h.document.getElementById('cancelProjectPackage'));
  assert.match(h.document.getElementById('projectPackageStatus').textContent,/cancelling/i);
  gate.resolve({blob:new Blob(['late']),filename:'late.phasei-project.zip'});await h.controller.whenIdle();
  assert.equal(h.downloads.length,0);assert.equal(h.document.getElementById('projectPackageDialog').hidden,true);assert.equal(h.document.activeElement,h.document.getElementById('exportProjectPackage'));
  assert.deepEqual(h.events,['busy:true','busy:false']);h.controller.destroy();h.dom.window.close();
});

test('inspection previews untrusted names as text and does not mutate until explicit confirmation',async()=>{
  const h=harness(),input=h.document.getElementById('importProjectPackageFile'),file=new h.dom.window.File(['zip'],'safe.phasei-project.zip',{type:'application/zip'});
  Object.defineProperty(input,'files',{value:[file],configurable:true});input.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await h.controller.whenIdle();
  assert.equal(h.events.includes('persist'),false);assert.equal(h.state.project.id,'current');assert.equal(h.document.getElementById('projectPackagePreview').hidden,false);
  assert.match(h.document.getElementById('projectPackageSummary').textContent,/Imported <img src=x>/);assert.equal(h.document.getElementById('projectPackageSummary').querySelector('img'),null);
  assert.match(h.document.getElementById('projectPackageCompanySummary').textContent,/Imported <script>/);assert.equal(h.document.getElementById('confirmProjectPackageImport').disabled,false);
  h.document.getElementById('confirmProjectPackageImport').click();await h.controller.whenIdle();assert.equal(h.state.project.id,'imported');assert.deepEqual(h.events,['busy:true','busy:false','busy:true','persist','initialize','committed','busy:false']);
  assert.match(h.document.getElementById('projectPackageStatus').textContent,/imported|restored/i);h.controller.destroy();h.dom.window.close();
});

test('invalid package and failed commit show actionable errors, keep current state, and support Escape/focus trapping',async()=>{
  const h=harness({inspectPackage:async()=>{throw Error('manifest hash mismatch');}}),launcher=h.document.getElementById('importProjectPackage');launcher.focus();const input=h.document.getElementById('importProjectPackageFile');
  const file=new h.dom.window.File(['bad'],'bad.phasei-project.zip',{type:'application/zip'});Object.defineProperty(input,'files',{value:[file],configurable:true});input.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await h.controller.whenIdle();
  assert.match(h.document.getElementById('projectPackageStatus').textContent,/not changed|hash mismatch/i);assert.equal(h.state.project.id,'current');assert.equal(h.document.getElementById('confirmProjectPackageImport').disabled,true);
  const cancel=h.document.getElementById('cancelProjectPackage');cancel.focus();cancel.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  assert.notEqual(h.document.activeElement,h.document.body);h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(h.document.getElementById('projectPackageDialog').hidden,true);assert.equal(h.document.activeElement,launcher);h.controller.destroy();h.dom.window.close();
});
