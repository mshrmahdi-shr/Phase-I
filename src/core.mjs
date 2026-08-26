export function figureDefaults(){
  return {
    A:{title:'SITE LOCATION MAP',extentMeters:500,status:'Not Started'},
    B:{title:'CURRENT AERIAL / SITE PLAN',extentMeters:250,status:'Not Started'},
    C:{title:'TOPOGRAPHICAL MAP',extentMeters:1000,status:'Not Started'},
    D:{title:'SURFICIAL GEOLOGY',extentMeters:2000,status:'Not Started'},
    E:{title:'BEDROCK GEOLOGY',extentMeters:20000,status:'Not Started'}
  };
}

export function createProject({name='',projectNo='',address='',date='',company=''}={}){
  return {
    id: (globalThis.crypto?.randomUUID?.() || `p-${Date.now()}`),
    name, projectNo, address, date, company,
    location:null,
    siteBoundary:[], buildingBoundary:[], historical:[],
    geology:{surficial:null,bedrock:null},
    dpi:300,
    figures:figureDefaults(),
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
  };
}

export function closeRing(points){
  if(!points?.length) return [];
  const out=points.map(p=>[Number(p[0]),Number(p[1])]);
  const a=out[0], b=out[out.length-1];
  if(a[0]!==b[0] || a[1]!==b[1]) out.push([...a]);
  return out;
}

export function pointInPolygon(point, polygon){
  const [x,y]=point; let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [xi,yi]=polygon[i], [xj,yj]=polygon[j];
    const intersects=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||Number.EPSILON)+xi);
    if(intersects) inside=!inside;
  }
  return inside;
}

function dxfPolyline(layer, points){
  if(!points?.length) return '';
  const ring=closeRing(points);
  let s=`0\nLWPOLYLINE\n8\n${layer}\n90\n${ring.length}\n70\n1\n`;
  for(const [x,y] of ring) s+=`10\n${x}\n20\n${y}\n`;
  return s;
}

export function buildDxf({siteBoundary=[],buildingBoundary=[]}={}){
  return `0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${dxfPolyline('SITE_BOUNDARY',siteBoundary)}${dxfPolyline('BUILDING_BOUNDARY',buildingBoundary)}0\nENDSEC\n0\nEOF\n`;
}

const MRD128_LEGEND = {
  '21': {title:'Man-made deposits', detail:'Fill, sewage lagoon, landfill, urban development', color:'#8f2fa6'},
  '20': {title:'Organic deposits', detail:'Peat, muck, marl', color:'#8d8d8d'},
  '19': {title:'Modern alluvial deposits', detail:'Clay, silt, sand, gravel, may contain organic remains', color:'#f08b52'},
  '18': {title:'Colluvial deposits', detail:'Boulders, scree, talus, undifferentiated landslide materials', color:'#e8b085'},
  '17': {title:'Eolian deposits', detail:'Fine to very fine sand and silt', color:'#f6df66'},
  '16': {title:'Coarse-textured marine deposits', detail:'Sand, gravel, minor silt and clay', color:'#f5a623'},
  '16a': {title:'Coarse-textured marine deposits', detail:'Deltaic deposits', color:'#f5a623'},
  '16b': {title:'Coarse-textured marine deposits', detail:'Littoral deposits', color:'#f5a623'},
  '16c': {title:'Coarse-textured marine deposits', detail:'Foreshore and basinal deposits', color:'#f5a623'},
  '15': {title:'Fine-textured marine deposits', detail:'Silt and clay, minor sand and gravel', color:'#5965a8'},
  '14': {title:'Coarse-textured lacustrine deposits', detail:'Sand, gravel, minor silt and clay', color:'#f2df2b'},
  '14a': {title:'Coarse-textured lacustrine deposits', detail:'Deltaic deposit', color:'#f2df2b'},
  '14b': {title:'Coarse-textured lacustrine deposits', detail:'Littoral deposits', color:'#f2df2b'},
  '14c': {title:'Coarse-textured lacustrine deposits', detail:'Foreshore and basinal deposits', color:'#f2df2b'},
  '13': {title:'Fine-textured lacustrine deposits', detail:'Silt and clay, minor sand and gravel', color:'#4bb8b6'},
  '12': {title:'Older alluvial deposits', detail:'Clay, silt, sand, gravel, may contain organic remains', color:'#a96d38'},
  '11': {title:'Coarse-textured glaciomarine deposits', detail:'Sand, gravel, minor silt and clay', color:'#dfc92d'},
  '11a': {title:'Coarse-textured glaciomarine deposits', detail:'Deltaic deposits', color:'#dfc92d'},
  '11b': {title:'Coarse-textured glaciomarine deposits', detail:'Littoral deposits', color:'#dfc92d'},
  '11c': {title:'Coarse-textured glaciomarine deposits', detail:'Foreshore and basinal deposits', color:'#dfc92d'},
  '10': {title:'Fine-textured glaciomarine deposits', detail:'Silt and clay, minor sand and gravel', color:'#54aaa9'},
  '10a': {title:'Fine-textured glaciomarine deposits', detail:'Massive to well laminated', color:'#54aaa9'},
  '10b': {title:'Fine-textured glaciomarine deposits', detail:'Interbedded silt and clay and gritty, pebbly flow till and rainout deposits', color:'#54aaa9'},
  '9': {title:'Coarse-textured glaciolacustrine deposits', detail:'Sand, gravel, minor silt and clay', color:'#f5e83b'},
  '9a': {title:'Coarse-textured glaciolacustrine deposits', detail:'Deltaic deposits', color:'#f5e83b'},
  '9b': {title:'Coarse-textured glaciolacustrine deposits', detail:'Littoral deposits', color:'#f5e83b'},
  '9c': {title:'Coarse-textured glaciolacustrine deposits', detail:'Foreshore and basinal deposits', color:'#f5e83b'},
  '8': {title:'Fine-textured glaciolacustrine deposits', detail:'Silt and clay, minor sand and gravel', color:'#7cc8d8'},
  '8a': {title:'Fine-textured glaciolacustrine deposits', detail:'Massive to well laminated', color:'#7cc8d8'},
  '8b': {title:'Fine-textured glaciolacustrine deposits', detail:'Interbedded silt and clay and gritty, pebbly flow till and rainout deposits', color:'#7cc8d8'},
  '7': {title:'Glaciofluvial deposits', detail:'River deposits and delta topset facies', color:'#c99630'},
  '7a': {title:'Glaciofluvial deposits', detail:'Sandy deposits', color:'#c99630'},
  '7b': {title:'Glaciofluvial deposits', detail:'Gravelly deposits', color:'#c99630'},
  '6': {title:'Ice-contact stratified deposits', detail:'Sand and gravel, minor silt, clay and till', color:'#e4a031'},
  '6a': {title:'Ice-contact stratified deposits', detail:'In moraines, eskers, kames and crevasse fills', color:'#e4a031'},
  '6b': {title:'Ice-contact stratified deposits', detail:'In subaquatic fans', color:'#e4a031'},
  '5': {title:'Till', detail:'Silty sand to sand-textured till', color:'#6ea847'},
  '5a': {title:'Till', detail:'Silty sand to sand-textured till on Precambrian terrain', color:'#a7c85a'},
  '5b': {title:'Till', detail:'Stone-poor, sandy silt to silty sand-textured till on Paleozoic terrain', color:'#97be49'},
  '5c': {title:'Till', detail:'Stony, sandy silt to silty sand-textured till on Paleozoic terrain', color:'#7cb43e'},
  '5d': {title:'Till', detail:'Clay to silt-textured till (derived from glaciolacustrine deposits or shale)', color:'#4aa64c'},
  '5e': {title:'Till', detail:'Undifferentiated older tills, may include stratified deposits', color:'#138948'},
  '4': {title:'Bedrock-drift complex in Paleozoic terrain', detail:'Primarily till cover', color:'#a268a9'},
  '4a': {title:'Bedrock-drift complex in Paleozoic terrain', detail:'Primarily till cover', color:'#a268a9'},
  '4b': {title:'Bedrock-drift complex in Paleozoic terrain', detail:'Primarily stratified drift cover', color:'#a268a9'},
  '3': {title:'Paleozoic bedrock', detail:'Sedimentary (Paleozoic) bedrock', color:'#a66ca4'},
  '2': {title:'Bedrock-drift complex in Precambrian terrain', detail:'Primarily till cover', color:'#de9c94'},
  '2a': {title:'Bedrock-drift complex in Precambrian terrain', detail:'Primarily till cover', color:'#de9c94'},
  '2b': {title:'Bedrock-drift complex in Precambrian terrain', detail:'Primarily stratified drift cover', color:'#de9c94'},
  '1': {title:'Precambrian bedrock', detail:'Precambrian bedrock', color:'#de7e79'}
};

export function extractNetworkLinks(kml=''){
  const links=[];
  const re=/<NetworkLink\b[\s\S]*?<\/NetworkLink>/gi;
  for(const block of kml.match(re)||[]){
    const name=(block.match(/<name>([\s\S]*?)<\/name>/i)?.[1]||'').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const href=(block.match(/<href>([\s\S]*?)<\/href>/i)?.[1]||'').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    if(href) links.push({name,href});
  }
  return links;
}

export function normalizeMrd128Unit(value=''){
  const text=String(value).trim().toLowerCase();
  const match=text.match(/(?:^|\b)(21|20|19|18|17|16[abc]?|15|14[abc]?|13|12|11[abc]?|10[ab]?|9[abc]?|8[ab]?|7[ab]?|6[ab]?|5[abcde]?|4[ab]?|3|2[ab]?|1)(?=\b|[^a-z0-9])/i);
  return match ? match[1].toLowerCase() : null;
}

export function getMrd128Legend(unit){
  const code=normalizeMrd128Unit(unit);
  return code ? ({code,...MRD128_LEGEND[code]} || null) : null;
}

export function listMrd128Legend(){
  return Object.entries(MRD128_LEGEND).map(([code,v])=>({code,...v}));
}

export function kmlColorToCss(kmlColor=''){
  const s=String(kmlColor).trim().replace(/^#/,'');
  if(!/^[0-9a-f]{8}$/i.test(s)) return null;
  const aa=s.slice(0,2), bb=s.slice(2,4), gg=s.slice(4,6), rr=s.slice(6,8);
  return {color:`#${rr}${gg}${bb}`.toLowerCase(), opacity:parseInt(aa,16)/255};
}
