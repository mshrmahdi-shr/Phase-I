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
function assertAllColumnsFit(plan,measure,layoutBox){
  const pages=[plan.map,...plan.continuations];
  for(const page of pages){
    const width=(layoutBox.width-layoutBox.padding*2-layoutBox.gap*(page.columnCount-1))/page.columnCount;
    const height=layoutBox.height-layoutBox.padding*2;
    for(const column of page.columns){
      const total=column.reduce((sum,entry)=>sum+measure(entry,{fontSize:page.fontSize,width}),0);
      assert.ok(total<=height,`measured ${total} mm in a ${height} mm column`);
    }
  }
}

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
    {name:'SITE',symbol:'site',height:4},
    {name:'Site boundary',symbol:'siteBoundary',height:4},
    ...entries(8,4),
  ];
  const plan=planLegend({entries:input,measure:measured,box:{width:40,height:14,padding:1,gap:2}});

  assert.equal(plan.map.columnCount,2);
  assert.deepEqual(plan.map.columns.flat(),input.slice(0,8));
  assert.equal(plan.continuations.length,1);
  assert.equal(plan.continuations[0].title,'LEGEND — CONTINUED');
  assert.deepEqual(flatten(plan),input);
});

test('uses a fixed row symbol as the stable impossible-entry label when the producer has no code',()=>{
  const input=[{name:'SITE',symbol:'site',height:100}];

  assert.throws(
    ()=>planLegend({entries:input,measure:measured,box}),
    {message:'Legend entry site exceeds the supported text length.'},
  );
});

test('rejects an unbreakable entry that cannot fit at minimum font and full continuation width',()=>{
  const input=[{code:'55b',name:'OneVeryLongWord',height:100}];

  assert.throws(
    ()=>planLegend({entries:input,measure:measured,box}),
    {message:'Legend entry 55b exceeds the supported text length.'},
  );
});

test('uses a finite numeric code as a stable impossible-entry label',()=>{
  const input=[{code:55,height:100}];

  assert.throws(
    ()=>planLegend({entries:input,measure:measured,box}),
    {message:'Legend entry 55 exceeds the supported text length.'},
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

test('uses the first valid continuation candidate instead of a smaller font that saves pages',()=>{
  const input=[
    {name:'SITE',symbol:'site',kind:'fixed'},
    ...entries(4).map(entry=>({...entry,kind:'geology'})),
  ];
  const plan=planLegend({
    entries:input,
    box:{width:20,height:10,padding:0,gap:0},
    fontSizes:[8,9],
    columnCounts:[1],
    measure:(entry,{fontSize})=>entry.kind==='fixed'?10:fontSize===9?6:5,
  });

  assert.equal(plan.map.fontSize,9);
  assert.equal(plan.continuations.length,4);
  assert.ok(plan.continuations.every(page=>page.fontSize===9&&page.columnCount===1));
});

test('uses configured column order as the deterministic tie-breaker',()=>{
  const input=entries(1,3);
  const plan=planLegend({
    entries:input,
    measure:measured,
    box:{width:20,height:10,padding:0,gap:0},
    fontSizes:[9],
    columnCounts:[2,1],
  });

  assert.equal(plan.map.columnCount,2);
});

test('paginates long Figure D entries into width-sensitive map and continuation columns that each fit',()=>{
  const input=entries(13,3);
  const continuationBox={width:40,height:14,padding:1,gap:2};
  const widthSensitive=(entry,{fontSize,width})=>entry.height*(fontSize/7.5)+(width<20?1:0);
  const plan=planLegend({entries:input,measure:widthSensitive,box:continuationBox});

  assert.ok(plan.continuations.length>0);
  assertAllColumnsFit(plan,widthSensitive,continuationBox);
  assert.deepEqual(flatten(plan),input);
});

test('never returns a column that exceeds its measured height by a fractional amount',()=>{
  const strictBox={width:20,height:10,padding:0,gap:0};
  const input=entries(2,5.00000025);
  const plan=planLegend({entries:input,measure:measured,box:strictBox,fontSizes:[7.5],columnCounts:[1]});

  assert.equal(plan.map.columns[0].length,1);
  assert.equal(plan.continuations.length,1);
  assertAllColumnsFit(plan,measured,strictBox);
});

test('keeps rows whose exact measured sum equals the available height',()=>{
  const exactBox={width:20,height:10,padding:0,gap:0};
  const input=entries(2,5);
  const plan=planLegend({entries:input,measure:measured,box:exactBox,fontSizes:[7.5],columnCounts:[1]});

  assert.equal(plan.map.columns[0].length,2);
  assert.deepEqual(plan.continuations,[]);
  assertAllColumnsFit(plan,measured,exactBox);
});

test('rejects a fractional amount over the minimum full-width height with the exact error',()=>{
  const input=[{code:'too-tall',height:10.0000005}];

  assert.throws(
    ()=>planLegend({entries:input,measure:measured,box:{width:20,height:10,padding:0,gap:0},fontSizes:[7.5],columnCounts:[1]}),
    {message:'Legend entry too-tall exceeds the supported text length.'},
  );
});

test('rejects invalid entries, layout dimensions, options, and measurements',()=>{
  assert.throws(()=>planLegend({entries:[null],measure:measured,box}),/Legend entries/);
  assert.throws(()=>planLegend({entries:entries(1),measure:measured,box:{width:0,height:20}}),/Legend box/);
  assert.throws(()=>planLegend({entries:entries(1),measure:measured,box,fontSizes:[NaN]}),/font sizes/);
  assert.throws(()=>planLegend({entries:entries(1),measure:measured,box,columnCounts:[3]}),/column counts/);
  assert.throws(()=>planLegend({entries:[{code:Symbol('unit')}],measure:measured,box}),/code/);
  assert.throws(()=>planLegend({entries:[{code:{toString(){throw new TypeError('unsafe');}}}],measure:measured,box}),/code/);
  assert.throws(()=>planLegend({entries:[{name:'SITE',symbol:{id:'site'}}],measure:measured,box}),/symbol/);
  for(const invalid of [NaN,-1,Infinity]){
    assert.throws(()=>planLegend({entries:entries(1),measure:()=>invalid,box}),/finite non-negative height/);
  }
});
