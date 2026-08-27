import assert from 'node:assert/strict';
import test from 'node:test';
import {planLegend} from '../src/legend-layout.mjs';

const box={width:40,height:20,padding:2,gap:2};
const entries=(count,height=3)=>Array.from({length:count},(_,index)=>({code:`u${index + 1}`,name:`Unit ${index + 1}`,height}));
const measured=(entry,{fontSize,width})=>entry.height*(fontSize/7.5);
const flatten=plan=>[
  ...plan.map.columns.flat(),
  ...plan.continuations.flatMap(page=>page.columns.flat()),
];

test('keeps a short legend on the map in one column at the largest font',()=>{
  const input=entries(3);
  const plan=planLegend({entries:input,measure:measured,box});

  assert.equal(plan.map.fontSize,7.5);
  assert.equal(plan.map.columnCount,1);
  assert.deepEqual(plan.map.columns,[input]);
  assert.deepEqual(plan.continuations,[]);
});

test('uses two columns when that is the first complete map-page fit',()=>{
  const input=entries(4,4);
  const plan=planLegend({entries:input,measure:measured,box:{width:30,height:10,padding:1,gap:4}});

  assert.equal(plan.map.fontSize,7.5);
  assert.equal(plan.map.columnCount,2);
  assert.deepEqual(plan.map.columns,[input.slice(0,2),input.slice(2)]);
  assert.deepEqual(plan.continuations,[]);
});

test('accounts for horizontal padding and the inter-column gap in measured widths',()=>{
  const input=entries(4,3);
  const plan=planLegend({
    entries:input,
    box:{width:30,height:10,padding:2,gap:4},
    measure:(entry,{width})=>(width===11||width===26)?entry.height:100,
  });

  assert.equal(plan.map.columnCount,2);
  assert.deepEqual(plan.map.columns,[input.slice(0,2),input.slice(2)]);
});

test('keeps explicit symbol entries on the overflowing map page and continues complete geology entries',()=>{
  const input=[
    {code:'custom-required-a',name:'SITE',symbol:'site',height:4},
    {code:'custom-required-b',name:'Site boundary',symbol:'siteBoundary',height:4},
    ...entries(8,4),
  ];
  const plan=planLegend({entries:input,measure:measured,box:{width:40,height:14,padding:1,gap:2}});

  assert.equal(plan.map.columnCount,2);
  assert.deepEqual(plan.map.columns.flat(),input.slice(0,8));
  assert.equal(plan.continuations.length,1);
  assert.equal(plan.continuations[0].title,'LEGEND — CONTINUED');
  assert.deepEqual(flatten(plan),input);
});

test('rejects an unbreakable entry that cannot fit at minimum font and full continuation width',()=>{
  const input=[{code:'55b',name:'OneVeryLongWord',height:100}];

  assert.throws(
    ()=>planLegend({entries:input,measure:measured,box}),
    {message:'Legend entry 55b exceeds the supported text length.'},
  );
});

test('is deterministic and keeps each original entry exactly once and in order',()=>{
  const input=[
    {code:'symbol',name:'SITE',symbol:'site',description:'Required marker',height:4},
    ...entries(9,4).map(entry=>({...entry,description:`Complete geological description for ${entry.code}`})),
  ];
  const options={entries:input,measure:measured,box:{width:40,height:14,padding:1,gap:2}};
  const first=planLegend(options),second=planLegend(options);

  assert.deepEqual(second,first);
  assert.deepEqual(flatten(first),input);
  assert.deepEqual(flatten(first).map(entry=>entry.description),input.map(entry=>entry.description));
});

test('selects only supplied font sizes while attempting them from largest to smallest',()=>{
  const input=entries(2);
  const plan=planLegend({
    entries:input,
    measure:(entry,{fontSize})=>fontSize===9?10:3,
    box:{width:30,height:10,padding:1,gap:2},
    fontSizes:[8,9],
  });

  assert.equal(plan.map.fontSize,8);
  assert.ok([8,9].includes(plan.map.fontSize));
  assert.ok(plan.continuations.every(page=>[8,9].includes(page.fontSize)));
});

test('paginates long Figure D entries into continuation columns that each fit',()=>{
  const input=entries(13,4);
  const continuationBox={width:40,height:14,padding:1,gap:2};
  const plan=planLegend({entries:input,measure:measured,box:continuationBox});

  assert.ok(plan.continuations.length>0);
  for(const page of plan.continuations){
    const columnWidth=(continuationBox.width-continuationBox.padding*2-continuationBox.gap*(page.columnCount-1))/page.columnCount;
    for(const column of page.columns){
      const height=column.reduce((sum,entry)=>sum+measured(entry,{fontSize:page.fontSize,width:columnWidth}),0);
      assert.ok(height<=continuationBox.height-continuationBox.padding*2);
    }
  }
  assert.deepEqual(flatten(plan),input);
});

test('rejects invalid entries, layout dimensions, options, and measurements',()=>{
  assert.throws(()=>planLegend({entries:[null],measure:measured,box}),/Legend entries/);
  assert.throws(()=>planLegend({entries:entries(1),measure:measured,box:{width:0,height:20}}),/Legend box/);
  assert.throws(()=>planLegend({entries:entries(1),measure:measured,box,fontSizes:[NaN]}),/font sizes/);
  assert.throws(()=>planLegend({entries:entries(1),measure:measured,box,columnCounts:[3]}),/column counts/);
  for(const invalid of [NaN,-1,Infinity]){
    assert.throws(()=>planLegend({entries:entries(1),measure:()=>invalid,box}),/finite non-negative height/);
  }
});
