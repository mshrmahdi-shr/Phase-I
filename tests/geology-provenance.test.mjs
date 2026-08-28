import test from 'node:test';
import assert from 'node:assert/strict';
import {customGeologySourceDraft,normalizeCustomGeologySource} from '../src/geology-provenance.mjs';
import {MIN_ACQUISITION_YEAR} from '../src/imagery/provider-registry.mjs';

const COMPLETE={id:'custom',name:'Bed rock-126Rev1.kml',credits:'Prepared by Example Engineer',sourceUrl:null,license:'Written project-use licence on file',redistributionEvidence:'Client confirmed use and redistribution for this project',acquisitionYear:null,acquisitionYearVerification:'unknown',permissionConfirmed:true};

test('custom geology provenance normalizes complete bounded evidence without inventing a year or licence',()=>{
  assert.deepEqual(normalizeCustomGeologySource(COMPLETE),COMPLETE);
  const draft=customGeologySourceDraft({id:'custom',name:'Custom import: legacy.kml'});
  assert.deepEqual(draft,{id:'custom',name:'Custom import: legacy.kml',credits:'',sourceUrl:null,license:'',redistributionEvidence:'',acquisitionYear:null,acquisitionYearVerification:'unknown',permissionConfirmed:false});
  assert.throws(()=>normalizeCustomGeologySource(draft),/credits|licen[cs]e|evidence|confirm/i);
});

test('custom geology provenance rejects bare confirmation, invalid URLs, oversized text and invented year states',()=>{
  for(const value of [
    {...COMPLETE,credits:''},{...COMPLETE,license:''},{...COMPLETE,redistributionEvidence:''},{...COMPLETE,permissionConfirmed:false},
    {...COMPLETE,sourceUrl:'file:///secret.kml'},{...COMPLETE,name:'x'.repeat(201)},
    {...COMPLETE,acquisitionYear:2020,acquisitionYearVerification:'unknown'},
    {...COMPLETE,acquisitionYear:null,acquisitionYearVerification:'verified'},
    {...COMPLETE,acquisitionYear:0,acquisitionYearVerification:'verified'}
  ])assert.throws(()=>normalizeCustomGeologySource(value),/source|credit|licen[cs]e|evidence|confirm|year|verification|bounded|URL/i);
  assert.equal(normalizeCustomGeologySource({...COMPLETE,acquisitionYear:2011,acquisitionYearVerification:'verified'}).acquisitionYear,2011);
});

test('custom geology provenance enforces the shared acquisition-year boundaries while preserving unknown',()=>{
  const maximum=new Date().getUTCFullYear()+1,known=acquisitionYear=>({...COMPLETE,acquisitionYear,acquisitionYearVerification:'verified'});
  assert.throws(()=>normalizeCustomGeologySource(known(MIN_ACQUISITION_YEAR-1)),/1850|year|range/i);
  assert.equal(normalizeCustomGeologySource(known(MIN_ACQUISITION_YEAR)).acquisitionYear,MIN_ACQUISITION_YEAR);
  assert.equal(normalizeCustomGeologySource(known(maximum)).acquisitionYear,maximum);
  assert.throws(()=>normalizeCustomGeologySource(known(maximum+1)),/year|range/i);
  assert.deepEqual(normalizeCustomGeologySource(COMPLETE),COMPLETE);
});
