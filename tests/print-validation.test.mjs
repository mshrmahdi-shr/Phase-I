import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePrintRequirements } from '../src/print-validation.mjs';

function baseProject(){
  return {
    name:'Phase I ESA', projectNo:'26-10001', date:'2026-08-26', address:'1 Test St, Toronto, ON',
    location:{lat:43.65,lng:-79.38}, siteBoundary:[[-79.38,43.65],[-79.37,43.65],[-79.37,43.66],[-79.38,43.65]],
    geology:{surficial:{siteUnit:'9c'},bedrock:{siteUnit:'3'}}
  };
}

test('print validation reports all common missing project fields', () => {
  const errors=validatePrintRequirements({project:{},figureCode:'A'});
  assert.deepEqual(errors.map(x=>x.code),['project-name','project-number','project-date','address','location']);
});

test('Figure B requires a site boundary', () => {
  const project=baseProject(); project.siteBoundary=[];
  const errors=validatePrintRequirements({project,figureCode:'B'});
  assert.equal(errors.some(x=>x.code==='site-boundary'),true);
});

test('Figure D requires loaded surficial polygons and a detected site unit', () => {
  const project=baseProject(); project.geology.surficial={};
  let errors=validatePrintRequirements({project,figureCode:'D',geologyLoaded:false,geologySiteUnit:null});
  assert.equal(errors.some(x=>x.code==='surficial-layer'),true);
  assert.equal(errors.some(x=>x.code==='surficial-unit'),true);

  errors=validatePrintRequirements({project,figureCode:'D',geologyLoaded:true,geologySiteUnit:'9c'});
  assert.equal(errors.length,0);
});

test('Figure E requires loaded bedrock polygons and a detected site unit', () => {
  const project=baseProject(); project.geology.bedrock={};
  const errors=validatePrintRequirements({project,figureCode:'E',geologyLoaded:false,geologySiteUnit:null});
  assert.equal(errors.some(x=>x.code==='bedrock-layer'),true);
  assert.equal(errors.some(x=>x.code==='bedrock-unit'),true);
});

test('complete Figure A project passes validation', () => {
  assert.deepEqual(validatePrintRequirements({project:baseProject(),figureCode:'A'}),[]);
});

test('print rejects blank, null and out-of-range SITE coordinates', () => {
  for (const location of [{lat:null,lng:null},{lat:'',lng:''},{lat:91,lng:0},{lat:43,lng:181},{lat:NaN,lng:-79}]) {
    const errors=validatePrintRequirements({project:{...baseProject(),location}});
    assert.ok(errors.some(e=>e.code==='location'), JSON.stringify(location));
  }
});

test('Figure B rejects open, degenerate and invalid boundary rings', () => {
  for (const siteBoundary of [
    [[0,0],[1,0],[1,1],[0,1]],
    [[0,0],[0,0],[0,0],[0,0]],
    [[0,0],[1,1],[2,2],[0,0]],
    [[0,0],[1,1],[0,1],[1,0],[0,0]],
    [[null,0],[1,0],[1,1],[null,0]]
  ]) {
    assert.ok(validatePrintRequirements({project:{...baseProject(),siteBoundary},figureCode:'B'}).some(e=>e.code==='site-boundary'));
  }
});

test('print rejects an impossible project date and unknown figure', () => {
  assert.ok(validatePrintRequirements({project:{...baseProject(),date:'2026-02-30'}}).some(e=>e.code==='project-date'));
  assert.ok(validatePrintRequirements({project:baseProject(),figureCode:'X'}).some(e=>e.code==='figure'));
});
