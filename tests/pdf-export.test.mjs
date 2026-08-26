import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync,crc32} from 'node:zlib';
import {createProject} from '../src/core.mjs';
import {JSDOM} from 'jsdom';

const project=()=>({...createProject({name:'Café geological study',projectNo:'26-123',address:'Toronto',date:'2026-08-26'}),location:{lat:43.7,lng:-79.3}});
const feature={name:'Custom bedrock',description:'User supplied unit',unitCode:'54a',color:'#aaaaaa',fillOpacity:.6,polygon:[[-80,43],[-78,43],[-78,45],[-80,45],[-80,43]],holes:[]};
const datasets={bedrock:{features:[feature],source:'User bedrock',coverage:null}};
// Browser canvas/network is replaced, but real jsPDF must assemble and serialize these distinct map images.
function png(code){
  const chunk=(type,data)=>{const payload=Buffer.concat([Buffer.from(type),data]),header=Buffer.alloc(4),crc=Buffer.alloc(4);header.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(payload));return Buffer.concat([header,payload,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,code.charCodeAt(0),100,150,128]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
function compositor(log,disposed){return async({code,geometry})=>{log.push(code);return {dataUrl:png(code),width:1,height:1,bounds:geometry.bounds,dispose:()=>disposed.push(code)};};}
async function engine(){const {exportCombinedPdf}=await import('../src/pdf-export.mjs');return exportCombinedPdf;}
test('real PDF has only A/C/E pages in figure order, A3 media boxes, embedded text, and cleaned maps',async()=>{
  const exportPdf=await engine(),log=[],disposed=[];
  const result=await exportPdf({project:project(),codes:['E','A','C','A'],datasets,compose:compositor(log,disposed)});
  assert.deepEqual(log,['A','C','E']);assert.deepEqual(disposed,log);assert.equal(result.pageCount,3);
  const bytes=Buffer.from(await result.blob.arrayBuffer()),raw=bytes.toString('latin1');
  assert.equal((raw.match(/\/Type \/Page\b/g)||[]).length,3);
  const boxes=[...raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];assert.equal(boxes.length,3);
  for(const [,w,h] of boxes){assert.ok(Math.abs(Number(w)*25.4/72-420)<.01);assert.ok(Math.abs(Number(h)*25.4/72-297)<.01);}
  assert.ok([...raw.matchAll(/([\d.]+) ([\d.]+) Td/g)].every(([,x,y])=>Number(x)>=7*72/25.4&&Number(y)>=7*72/25.4),'all text stays within the 7 mm page margins');
  assert.match(raw,/\/ToUnicode/);assert.match(raw,/\/FontFile2/);
  assert.equal((raw.match(/\/Subtype \/Image/g)||[]).length,6,'each page has a unique color image and alpha image');
  assert.ok(!/\/JavaScript|\/Launch|\/URI\b/.test(raw),'user text never becomes executable PDF actions');
  assert.ok(result.filename.endsWith('.pdf'));
  // Decode this PDF's uncompressed ToUnicode mapping and text operators (not a fixture PDF).
  const cmap=new Map([...raw.matchAll(/<([0-9a-f]{4})><([0-9a-f]{4})>/gi)].map(m=>[m[1].toLowerCase(),String.fromCodePoint(parseInt(m[2],16))]));
  const decoded=[...raw.matchAll(/<([0-9a-f]+)>\s*Tj/gi)].map(m=>m[1].match(/.{4}/g).map(g=>cmap.get(g.toLowerCase())||'?').join('')).join('\n');
  assert.match(decoded,/FIGURE A/);assert.match(decoded,/FIGURE C/);assert.match(decoded,/FIGURE E/);
  assert.match(decoded,/Page 1 of 3/);assert.match(decoded,/Page 3 of 3/);assert.match(decoded,/Café geological study/);
  const finalBaseline=Number([...raw.matchAll(/([\d.]+) ([\d.]+) Td/g)].at(-1)[2]);
  assert.ok(finalBaseline>30&&finalBaseline<45,'footer sits wholly inside the map, clear of its bottom frame');
});
test('empty selection, invalid data, text overflow, unsupported glyphs and unsafe DPI fail before map work',async()=>{
  const exportPdf=await engine(),log=[],compose=compositor(log,[]),p=project();
  await assert.rejects(exportPdf({project:p,codes:[],compose}),/select/i);
  await assert.rejects(exportPdf({project:p,codes:['E'],compose}),/Figure E.*geology/i);
  await assert.rejects(exportPdf({project:p,codes:['A'],dpi:600,compose}),/choose 300/i);
  await assert.rejects(exportPdf({project:{...p,name:'Very long project '.repeat(100)},codes:['A'],compose}),/Figure A.*fit|overflow/i);
  await assert.rejects(exportPdf({project:{...p,name:'Unsupported 𠀀'},codes:['A'],compose}),/unsupported.*U\+20000/i);
  assert.deepEqual(log,[]);
});
test('sheet C error prevents a result and disposes previously composed image',async()=>{
  const exportPdf=await engine(),disposed=[];
  await assert.rejects(exportPdf({project:project(),codes:['A','C'],compose:async args=>{
    if(args.code==='C')throw Error('Toporama is unavailable');return {...await compositor([],disposed)(args)};
  }}),/Figure C.*Toporama/);assert.deepEqual(disposed,['A']);
});
test('cancellation during composition disposes image and never resolves a PDF; snapshot cannot drift',async()=>{
  const exportPdf=await engine(),p=project(),controller=new AbortController(),disposed=[];
  await assert.rejects(exportPdf({project:p,codes:['A'],signal:controller.signal,compose:async args=>{
    p.name='Changed in editor';assert.equal(args.project.name,'Café geological study');controller.abort();return compositor([],disposed)(args);
  }}),{name:'AbortError'});assert.deepEqual(disposed,['A']);
  await assert.rejects(exportPdf({project:p,codes:['A'],signal:controller.signal,compose:()=>{throw Error('must not compose');}}),{name:'AbortError'});
});
test('cancellation during bitmap decoding rejects the complete PDF without retaining the renderer',async t=>{
  const exportPdf=await engine(),controller=new AbortController(),dom=new JSDOM('<!doctype html><body></body>');
  const previous={document:globalThis.document,fetch:globalThis.fetch,createImageBitmap:globalThis.createImageBitmap};
  let canvas,started,release,closed=0;
  const decoding=new Promise(resolve=>{started=resolve;});
  dom.window.HTMLCanvasElement.prototype.getContext=function(){canvas=this;return {fillRect(){}};};
  globalThis.document=dom.window.document;
  globalThis.fetch=async()=>({ok:true,headers:new Headers({'content-type':'image/png'}),blob:async()=>new Blob(['image'])});
  globalThis.createImageBitmap=()=>new Promise(resolve=>{release=()=>resolve({width:1536,height:1286,close(){closed++;}});started();});
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}dom.window.close();});
  const outcome=exportPdf({project:project(),codes:['C'],signal:controller.signal}).then(result=>({result}),error=>({error}));
  await decoding;controller.abort();let timer;
  try{
    const observed=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({pending:true}),50);})]);
    assert.ok(!observed.pending,'combined export must not wait for an abandoned decoder');assert.equal(observed.error?.name,'AbortError');assert.equal(observed.result,undefined);
    assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(dom.window.document.body.children.length,0);
  }finally{clearTimeout(timer);release();await outcome;}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
});
test('Persian remains an embedded-font PDF and custom bedrock labels retain their supplied meaning',async()=>{
  const result=await (await engine())({project:{...project(),name:'پروژه محیط زیست'},codes:['E'],datasets,compose:compositor([],[])});
  assert.ok(result.blob.size>20000);
});
test('geology prerequisites check final sheet coverage, SITE holes and closed nondegenerate geometry',async()=>{
  const exportPdf=await engine(),p=project(),compose=compositor([],[]);
  await assert.rejects(exportPdf({project:p,codes:['B'],compose}),/Figure B.*Site Boundary/);
  for(const polygon of [[[-80,43],[-78,43],[-78,45],[-80,45]],[[-80,43],[-79,43],[-78,43],[-80,43]]]){
    await assert.rejects(exportPdf({project:p,codes:['E'],datasets:{bedrock:{...datasets.bedrock,features:[{...feature,polygon}]}},compose}),/Figure E.*invalid polygon/);
  }
  await assert.rejects(exportPdf({project:p,codes:['E'],datasets:{bedrock:{...datasets.bedrock,coverage:{west:-79.31,east:-79.29,south:43.69,north:43.71}}},compose}),/Figure E.*cover.*final sheet/);
  await assert.rejects(exportPdf({project:p,codes:['E'],datasets:{bedrock:{...datasets.bedrock,features:[{...feature,holes:[[[-79.4,43.6],[-79.2,43.6],[-79.2,43.8],[-79.4,43.8],[-79.4,43.6]]]}]}},compose}),/Figure E.*SITE/);
});
