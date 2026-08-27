import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineImageryProvider,
  normalizeProviderResult,
  validateImageryProvider,
  validateImageryResult
} from '../src/imagery/provider-registry.mjs';
import {groupImageryResults,searchOfficialImagery} from '../src/imagery/search.mjs';

const location={lat:43.65,lng:-79.38};
const bounds={west:-80,south:43,east:-79,north:44};
const fetchImpl=async()=>{throw Error('Unit tests must not use the network');};

function provider(overrides={}){
  return defineImageryProvider({
    id:'official',label:'Official imagery',organization:'Official authority',priority:10,
    coverage:bounds,licenseUrl:'https://official.example/licence/open.html',
    attribution:'Official authority',policy:'exportable',
    allowedOrigins:['https://official.example'],
    allowedRoots:['https://official.example/arcgis/','https://official.example/licence/'],
    covers:point=>point.lat>=bounds.south&&point.lat<=bounds.north&&point.lng>=bounds.west&&point.lng<=bounds.east,
    search:async()=>[],...overrides
  });
}

function result(overrides={}){
  return {
    id:'flight-1972-a',providerId:'official',title:'1972 flight A',year:1972,
    resolutionMeters:0.5,coverage:bounds,
    preview:{kind:'tile',url:'https://official.example/arcgis/preview/1972',tileTemplate:'https://official.example/arcgis/tiles/{z}/{x}/{y}.png'},
    export:{kind:'arcgis-export',url:'https://official.example/arcgis/export/1972',maxWidth:4096,maxHeight:4096},
    policy:'exportable',sourceUrl:'https://official.example/arcgis/source/1972',
    licenseUrl:'https://official.example/licence/open.html',attribution:'Official authority',
    ...overrides
  };
}

const allResults=group=>[...group.exact,...group.nearby,...group.remaining];

test('registry requires complete explicit provider coverage, URL and legal-policy metadata',()=>{
  const valid=provider();
  assert.equal(validateImageryProvider(valid),valid);
  for(const change of [
    {id:'Official Provider'}, {priority:true}, {coverage:{...bounds,east:-81}},
    {covers:true}, {search:true}, {policy:'assumed-exportable'},
    {licenseUrl:'http://official.example/licence/open.html'},
    {allowedOrigins:['http://official.example']},
    {allowedRoots:['https://evil.example/arcgis/']},
    {allowedRoots:['https://official.example/arcgis/../private/']}
  ]) assert.throws(()=>provider(change),/provider|priority|coverage|covers|search|policy|https|origin|root|path|licen[cs]e/i);
});

test('result validation accepts exact normalized fields and a nullable missing resolution',()=>{
  const registryProvider=provider();
  const normalized=normalizeProviderResult(registryProvider,result({resolutionMeters:null}));
  assert.equal(normalized.id,'official:flight-1972-a');
  assert.equal(validateImageryResult(normalized,registryProvider),normalized);
  assert.deepEqual(Object.keys(normalized).sort(),[
    'attribution','coverage','export','id','licenseUrl','policy','preview','providerId',
    'resolutionMeters','sourceUrl','title','year'
  ]);
  assert.throws(()=>validateImageryResult({...normalized,unexpected:true},registryProvider),/field|unexpected|exact/i);
});

test('acquisition years are four-digit integers in a defensible historical-to-current range without coercion',()=>{
  const registryProvider=provider();
  const currentYear=new Date().getUTCFullYear();
  for(const year of [1900,currentYear]) assert.equal(normalizeProviderResult(registryProvider,result({year})).year,year);
  for(const year of [true,'1972',1972.5,999,1800,currentYear+1,NaN,Infinity]){
    assert.throws(()=>normalizeProviderResult(registryProvider,result({year})),/year|four-digit|acquisition/i);
  }
  for(const year of [true,'1972',1972.5,1800,currentYear+1]) assert.throws(()=>groupImageryResults([],year),/year/i);
});

test('result validation rejects invalid coverage, policies, dimensions and unsafe URL fields',()=>{
  const registryProvider=provider();
  const invalidValues=[
    result({coverage:{...bounds,north:91}}),
    result({policy:'public-domain'}),
    result({resolutionMeters:0}),
    result({export:{...result().export,maxWidth:1.5}}),
    result({policy:'link-only',export:result().export}),
    result({policy:'exportable',export:null})
  ];
  for(const value of invalidValues) assert.throws(()=>normalizeProviderResult(registryProvider,value),/coverage|policy|resolution|width|export/i);

  const unsafeUrls=[
    'http://official.example/arcgis/a',
    'https://evil.example/arcgis/a',
    'https://official.example/private/a',
    'https://user:pass@official.example/arcgis/a',
    'https://official.example/arcgis/a#fragment',
    '//official.example/arcgis/a',
    'https://official.example/arcgis/%2e%2e/private/a',
    'https://official.example/arcgis/%252e%252e/private/a',
    'https://official.example/arcgis/a%2fb'
  ];
  for(const url of unsafeUrls){
    for(const mutate of [
      value=>({...value,sourceUrl:url}),
      value=>({...value,licenseUrl:url}),
      value=>({...value,preview:{...value.preview,url}}),
      value=>({...value,preview:{...value.preview,tileTemplate:url}}),
      value=>({...value,export:{...value.export,url}})
    ]) assert.throws(()=>normalizeProviderResult(registryProvider,mutate(result())),/URL|https|official|origin|root|credential|fragment|path|traversal|template/i);
  }
});

test('stable result IDs use the provider namespace and reject ambiguous source identities',()=>{
  const registryProvider=provider();
  assert.equal(normalizeProviderResult(registryProvider,result()).id,'official:flight-1972-a');
  assert.equal(normalizeProviderResult(registryProvider,result({id:'official:flight-1972-a'})).id,'official:flight-1972-a');
  for(const id of ['',true,'other:flight-1972-a','flight 1972','../flight']){
    assert.throws(()=>normalizeProviderResult(registryProvider,result({id})),/id|identity|namespace/i);
  }
});

test('grouping puts exact matches first and keeps all results from the three nearest distinct years',()=>{
  const registryProvider=provider();
  const values=[
    result({id:'1969-a',year:1969}),result({id:'1970-a',year:1970}),result({id:'1970-b',year:1970}),
    result({id:'1971-a',year:1971}),result({id:'1972-a',year:1972}),result({id:'1973-a',year:1973}),
    result({id:'1974-a',year:1974}),result({id:'1978-a',year:1978})
  ].map(value=>normalizeProviderResult(registryProvider,value));
  const grouped=groupImageryResults(values,1972);
  assert.deepEqual(grouped.exact.map(value=>value.year),[1972]);
  assert.deepEqual(grouped.nearby.map(value=>value.year),[1971,1973,1970,1970]);
  assert.deepEqual(grouped.remaining.map(value=>value.year),[1974,1969,1978]);
  assert.deepEqual(grouped.errors,[]);
});

test('results within a year rank by resolution, provider priority, then stable ID with missing resolution last',()=>{
  const high=provider({id:'high',priority:1});
  const low=provider({id:'low',priority:20});
  const providers=new Map([[high.id,high],[low.id,low]]);
  const values=[
    normalizeProviderResult(low,result({id:'b',providerId:'low',resolutionMeters:0.25})),
    normalizeProviderResult(low,result({id:'missing',providerId:'low',resolutionMeters:null})),
    normalizeProviderResult(high,result({id:'z',providerId:'high',resolutionMeters:0.25})),
    normalizeProviderResult(high,result({id:'a',providerId:'high',resolutionMeters:0.25})),
    normalizeProviderResult(high,result({id:'coarse',providerId:'high',resolutionMeters:1}))
  ];
  const grouped=groupImageryResults(values,1972,{providers});
  assert.deepEqual(grouped.exact.map(value=>value.id),['high:a','high:z','low:b','high:coarse','low:missing']);
});

test('search canonicalizes stable IDs and returns deterministic ordering across provider and result order',async()=>{
  const first=provider({id:'first',priority:10,search:async()=>[
    result({id:'b',providerId:'first'}),result({id:'a',providerId:'first'})
  ]});
  const second=provider({id:'second',priority:5,search:async()=>[result({id:'z',providerId:'second'})]});
  const a=await searchOfficialImagery({providers:[first,second],location,year:1972,fetchImpl});
  const b=await searchOfficialImagery({providers:[second,first],location,year:1972,fetchImpl});
  assert.deepEqual(allResults(a).map(value=>value.id),['second:z','first:a','first:b']);
  assert.deepEqual(allResults(a).map(value=>value.id),allResults(b).map(value=>value.id));
});

test('a provider with duplicate source identities fails visibly without hiding other provider successes',async()=>{
  const good=provider({id:'good',search:async()=>[result({id:'kept',providerId:'good'})]});
  const duplicate=provider({id:'duplicate',search:async()=>[
    result({id:'same',providerId:'duplicate'}),result({id:'same',providerId:'duplicate',title:'duplicate'})
  ]});
  const grouped=await searchOfficialImagery({providers:[duplicate,good],location,year:1972,fetchImpl});
  assert.deepEqual(allResults(grouped).map(value=>value.id),['good:kept']);
  assert.deepEqual(grouped.errors.map(error=>error.providerId),['duplicate']);
  assert.match(grouped.errors[0].message,/duplicate/i);
});

test('one provider failure is reported by provider while successful results remain available',async()=>{
  const good=provider({id:'good',search:async({fetchImpl:received})=>{
    assert.equal(received,fetchImpl);return [result({id:'kept',providerId:'good'})];
  }});
  const failed=provider({id:'failed',search:async()=>{throw Error('catalogue unavailable');}});
  const grouped=await searchOfficialImagery({providers:[failed,good],location,year:1972,fetchImpl});
  assert.deepEqual(grouped.exact.map(value=>value.id),['good:kept']);
  assert.deepEqual(grouped.errors,[{providerId:'failed',message:'catalogue unavailable',name:'Error'}]);
});

test('providers outside coverage are not queried and invalid covers responses become provider errors',async()=>{
  let queried=false;
  const outside=provider({id:'outside',covers:()=>false,search:async()=>{queried=true;return [];}});
  const invalid=provider({id:'invalid-covers',covers:()=>1});
  const grouped=await searchOfficialImagery({providers:[outside,invalid],location,year:1972,fetchImpl});
  assert.equal(queried,false);
  assert.deepEqual(grouped.errors.map(error=>error.providerId),['invalid-covers']);
});

test('provider timeout aborts its child and is reported alongside successful providers',async()=>{
  let childSignal;
  const slow=provider({id:'slow',search:async({signal})=>{
    childSignal=signal;return new Promise(()=>{});
  }});
  const good=provider({id:'good',search:async()=>[result({id:'kept',providerId:'good'})]});
  const grouped=await searchOfficialImagery({providers:[slow,good],location,year:1972,fetchImpl,timeoutMs:20});
  assert.equal(childSignal.aborted,true);
  assert.deepEqual(grouped.exact.map(value=>value.id),['good:kept']);
  assert.deepEqual(grouped.errors.map(error=>error.providerId),['slow']);
  assert.match(grouped.errors[0].message,/timed out|timeout|20 ms/i);
});

test('parent abort rejects promptly, aborts children, and suppresses late progress and results',async()=>{
  const controller=new AbortController();
  let childSignal,release;
  const progress=[];
  const slow=provider({id:'slow',search:({signal})=>{
    childSignal=signal;
    return new Promise(resolve=>{release=()=>resolve([result({providerId:'slow'})]);});
  }});
  const started=Date.now();
  const pending=searchOfficialImagery({providers:[slow],location,year:1972,fetchImpl,signal:controller.signal,onProgress:event=>progress.push(event)});
  await new Promise(resolve=>setTimeout(resolve,0));
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.ok(Date.now()-started<250,'abort should not wait for a provider that ignores its signal');
  assert.equal(childSignal.aborted,true);
  const count=progress.length;
  release();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(progress.length,count);
});

test('exceptions thrown by onProgress cannot break search orchestration',async()=>{
  const good=provider({search:async()=>[result()]});
  const grouped=await searchOfficialImagery({
    providers:[good],location,year:1972,fetchImpl,onProgress:()=>{throw Error('broken observer');}
  });
  assert.deepEqual(grouped.exact.map(value=>value.id),['official:flight-1972-a']);
  assert.deepEqual(grouped.errors,[]);
});
