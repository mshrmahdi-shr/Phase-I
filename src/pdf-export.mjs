import {sheetGeometry} from './sheet-layout.mjs';
import {sourceForFigure} from './map-sources.mjs';
import {composeHistoricalImage,composeMap,historicalImageryPlan,loadHistoricalAssetSnapshot,revalidateHistoricalOfficialSource,throwIfAborted} from './map-compositor.mjs';
import {relevantFeatures,relevantUnits,siteFeature,containsBounds} from './geology.mjs';
import {validBoundary,validLocation} from './core.mjs';
import {validatePrintRequirements} from './print-validation.mjs';
import {planLegend} from './legend-layout.mjs';
import {createAssetStore} from './asset-store.mjs';
import {historicalCode,historicalSheetGeometry,orderedHistoricalItems} from './historical-layout.mjs';

const FONT='DejaVuSans';
const TITLE_ROWS=[18,26,117.4,34,23,28,20],LEGEND_SYMBOL_WIDTH=9,LEGEND_COLUMN_GAP=3;
const MAX_HISTORICAL_SNAPSHOT_BYTES=32_000_000;
async function pdfLibrary(){
  if(typeof window==='undefined')return (await import('jspdf')).jsPDF;
  await import(new URL('../vendor/jspdf.umd.min.js',import.meta.url).href);
  if(!globalThis.jspdf?.jsPDF)throw new Error('The packaged PDF library is unavailable; rebuild or reload the application.');
  return globalThis.jspdf.jsPDF;
}
async function fontBytes(signal){
  const url=new URL('../assets/fonts/DejaVuSans.ttf',import.meta.url);
  if(url.protocol==='file:')return new Uint8Array(await (await import('node:fs/promises')).readFile(url));
  const response=await fetch(url,{signal});if(!response.ok)throw new Error('The packaged Unicode font is unavailable; rebuild or reload the application.');
  return new Uint8Array(await response.arrayBuffer());
}
function base64(bytes){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
function validateText(doc,value){
  const text=String(value??'');
  if(text.length>12000)throw new Error('Text overflow: shorten the project or legend text to fit the sheet.');
  // jsPDF uses Arabic presentation glyphs after shaping, so validate both sets.
  const shaped=doc.processArabic(text),font=doc.getFont().metadata;
  for(const char of text+shaped){
    const cp=char.codePointAt(0);if(/[\r\n\t]/.test(char)||cp===0x200c||cp===0x200d)continue;
    if(cp>0xffff||!font.characterToGlyph(cp))throw new Error(`Unsupported font character U+${cp.toString(16).toUpperCase()}; replace it with a character supported by DejaVu Sans.`);
  }
  return text.replace(/\t/g,'    ').replace(/\r\n?/g,'\n');
}
function linesFor(doc,text,width,size){
  doc.setFontSize(size);text=validateText(doc,text);const lines=doc.splitTextToSize(text,width);
  if(lines.some(line=>doc.getTextWidth(doc.processArabic(line))>width+.05))throw new Error('Text overflow: a word does not fit the sheet.');
  return lines;
}
function textBlock(doc,text,box,size,{align='left',draw=true}={}){
  const lines=linesFor(doc,text,box.width,size),leading=size*.352778*1.24;
  if(lines.length*leading>box.height+.01)throw new Error('Text does not fit the sheet. Shorten the project, title, source or legend text.');
  if(draw){
    doc.setFontSize(size);doc.setTextColor(17,17,17);
    for(let i=0;i<lines.length;i++)doc.text(lines[i],align==='center'?box.x+box.width/2:box.x,box.y+size*.352778+i*leading,{align,isInputVisual:false,isOutputVisual:true});
  }
  return lines.length*leading;
}
function deepFreeze(value,seen=new WeakSet()){
  if(!value||typeof value!=='object'||seen.has(value))return value;
  seen.add(value);for(const child of Object.values(value))deepFreeze(child,seen);return Object.freeze(value);
}
function exactSelection(value,fields){
  if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))return false;
  const keys=Reflect.ownKeys(value);if(keys.some(key=>typeof key!=='string')||keys.length!==fields.length||fields.some(field=>!keys.includes(field)))return false;
  return keys.every(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor?.enumerable&&Object.hasOwn(descriptor,'value');});
}
function normalizeSelection(project,codes,selection){
  const raw=selection===undefined?(Array.isArray(codes)?codes.map(code=>({kind:'figure',code})):[]):selection;
  if(!Array.isArray(raw)||!raw.length)throw new Error('Select at least one ready sheet.');
  const figures=new Set(),historical=new Set(),items=new Map((project?.historical||[]).map(item=>[item.id,item]));
  for(const entry of raw){
    if(exactSelection(entry,['kind','code'])&&entry.kind==='figure'&&['A','B','C','D','E'].includes(entry.code)){figures.add(entry.code);continue;}
    if(exactSelection(entry,['kind','id'])&&entry.kind==='historical'&&typeof entry.id==='string'){
      if(!items.has(entry.id))throw new Error('A selected approved historical item is missing from the project.');historical.add(entry.id);continue;
    }
    throw new Error('Choose valid Figure A-E or approved historical sheet selections.');
  }
  const figureCodes=['A','B','C','D','E'].filter(code=>figures.has(code)),historicalItems=orderedHistoricalItems(project).filter(item=>historical.has(item.id));
  return {selection:[...figureCodes.map(code=>({kind:'figure',code})),...historicalItems.map(item=>({kind:'historical',id:item.id}))],figureCodes,historicalItems};
}
function sourceText(source){return typeof source==='string'?source:[source?.name,source?.credits].filter(Boolean).join('. ');}
function validateFeature(feature){
  for(const ring of [feature?.polygon,...(feature?.holes||[])]){
    if(!Array.isArray(ring)||ring.length<4||ring.some(p=>!Array.isArray(p)||!validLocation({lng:p[0],lat:p[1]})))throw new Error('The geology dataset contains an invalid polygon.');
    const [ox,oy]=ring[0],last=ring.at(-1);
    let area=0;for(let i=1;i<ring.length;i++)area+=(ring[i-1][0]-ox)*(ring[i][1]-oy)-(ring[i][0]-ox)*(ring[i-1][1]-oy);
    if(last[0]!==ox||last[1]!==oy||!Number.isFinite(area)||area===0)throw new Error('The geology dataset contains an invalid polygon.');
  }
}
function prepare(project,code,datasets,dpi,companyProfile){
  const geometry=sheetGeometry(project,code,dpi),kind=code==='D'?'surficial':code==='E'?'bedrock':null,dataset=kind?datasets[kind]:null;
  let features=[],units=[];
  if(kind){
    if(!Array.isArray(dataset?.features)||!dataset.features.length||!sourceText(dataset.source).trim())throw new Error(`Load a labelled ${kind} geology dataset before exporting.`);
    dataset.features.forEach(validateFeature);
    if(dataset.coverage&&!containsBounds(dataset.coverage,geometry.bounds))throw new Error('The geology data does not cover the final sheet extent. Reload it for this extent.');
    features=relevantFeatures(dataset.features,geometry.bounds);units=relevantUnits(features,geometry.bounds);
  }
  for(const key of ['siteBoundary','buildingBoundary'])if(project[key]?.length&&!validBoundary(project[key]))throw new Error('The project contains an invalid boundary.');
  const errors=validatePrintRequirements({project,companyProfile,figureCode:code,geologyLoaded:!!features.length,geologySiteUnit:siteFeature(features,project.location)?.name});
  if(errors.length)throw new Error(errors.map(e=>e.message).join(' '));
  return {code,geometry,features,units,dataset};
}
function drawScale(doc,geometry){
  const m=geometry.mapFrame,scale=geometry.scale,x=m.x+5,y=m.y+m.height-12,w=scale.pixelWidth/geometry.raster.width*m.width;
  doc.setFillColor(255,255,255);doc.setDrawColor(255,255,255);doc.rect(x-2,y-5,w+14,15,'F');
  doc.setFontSize(7);doc.setTextColor(17,17,17);doc.text('Approximate ground scale',x,y-2);
  doc.setDrawColor(0,0,0);doc.setLineWidth(.2);
  for(let i=0;i<4;i++){doc.setFillColor(i%2?255:0);doc.rect(x+i*w/4,y,w/4,2,'FD');}
  doc.text(scale.labels[0],x,y+6);doc.text(scale.labels[1],x+w/2,y+6,{align:'center'});doc.text(scale.labels[2],x+w,y+6,{align:'center'});
}
function titleBoxes(geometry,rows=TITLE_ROWS){
  const t=geometry.titleFrame;let y=t.y;
  return rows.map(height=>{const box={x:t.x,y,width:t.width,height};y+=height+2;return box;});
}
function legendEntries(project,sheet){
  return [
    {name:'SITE',symbol:'site'},
    ...(project.siteBoundary?.length?[{name:'Site boundary',symbol:'siteBoundary'}]:[]),
    ...(project.buildingBoundary?.length?[{name:'Building boundary',symbol:'buildingBoundary'}]:[]),
    ...sheet.units.map(unit=>({...unit,code:String(unit.unitCode||unit.name||'Geology unit')})),
  ];
}
function legendText(entry){
  if(entry.symbol)return entry.name;
  return [...new Set([entry.code,entry.name,entry.description].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()))].join('\n');
}
function legendMeasure(doc){
  return (entry,{fontSize,width})=>{
    const textWidth=width-LEGEND_SYMBOL_WIDTH;
    if(textWidth<=0)return Number.MAX_VALUE;
    let lines;
    try{lines=linesFor(doc,legendText(entry),textWidth,fontSize);}
    catch(error){if(/^Text overflow:/i.test(error.message))return Number.MAX_VALUE;throw error;}
    const textHeight=lines.length*fontSize*.352778*1.24;
    return Math.max(textHeight,4)+2;
  };
}
function mapLegendBox(sheet){
  const box=titleBoxes(sheet.geometry)[2];
  return {x:box.x+2,y:box.y+8,width:box.width-4,height:box.height-10,padding:0,gap:LEGEND_COLUMN_GAP};
}
function continuationLegendBox(sheet){
  const frame=sheet.geometry.mapFrame;
  return {x:frame.x+4,y:frame.y+15,width:frame.width-8,height:frame.height-23,padding:0,gap:8};
}
function legendBoxOptions(box){return {width:box.width,height:box.height,padding:box.padding,gap:box.gap};}
function planSheetLegend(doc,project,sheet){
  const entries=legendEntries(project,sheet),measure=legendMeasure(doc),mapBox=mapLegendBox(sheet);
  const required=entries.findIndex(entry=>!entry.symbol),fixedCount=required<0?entries.length:required;
  let map=null,included=0;
  for(let count=fixedCount;count<=entries.length;count+=1){
    let candidate;
    try{candidate=planLegend({entries:entries.slice(0,count),measure,box:legendBoxOptions(mapBox)});}
    catch(error){if(count===fixedCount)throw error;break;}
    if(candidate.continuations.length)break;
    map=candidate.map;included=count;
  }
  if(!map)throw new Error('Required legend symbols do not fit on the map page.');
  const remaining=entries.slice(included),continuations=[];
  if(remaining.length){
    const planned=planLegend({entries:remaining,measure,box:legendBoxOptions(continuationLegendBox(sheet))});
    continuations.push(planned.map,...planned.continuations.map(({title,...page})=>page));
  }
  return deepFreeze({map,continuations});
}
function columnDimensions(box,columnCount){
  return {width:(box.width-box.padding*2-box.gap*(columnCount-1))/columnCount,height:box.height-box.padding*2};
}
function drawLegendEntry(doc,entry,x,y,width,fontSize,{draw=true}={}){
  const height=legendMeasure(doc)(entry,{fontSize,width});
  textBlock(doc,legendText(entry),{x:x+LEGEND_SYMBOL_WIDTH,y,width:width-LEGEND_SYMBOL_WIDTH,height:height-2},fontSize,{draw});
  if(draw){
    doc.setDrawColor(17,17,17);doc.setLineWidth(.2);
    if(entry.symbol==='site'){doc.setFillColor(239,68,68);doc.circle(x+3,y+1.8,1.2,'F');}
    else if(entry.symbol){doc.setDrawColor(entry.symbol==='siteBoundary'?'#ef4444':'#111111');doc.setLineWidth(entry.symbol==='siteBoundary'?.7:.45);doc.setLineDashPattern(entry.symbol==='buildingBoundary'?[1.2,.8]:[],0);doc.line(x,y+2,x+7,y+2);doc.setLineDashPattern([],0);}
    else{doc.setFillColor(/^#[0-9a-f]{6}$/i.test(entry.color)?entry.color:'#5fa8d3');doc.rect(x,y+.4,6,3,'FD');}
  }
  return height;
}
function drawLegendPlan(doc,plan,box,{draw=true}={}){
  const dimensions=columnDimensions(box,plan.columnCount);
  plan.columns.forEach((entries,column)=>{
    const x=box.x+box.padding+column*(dimensions.width+box.gap);let y=box.y+box.padding;
    for(const entry of entries)y+=drawLegendEntry(doc,entry,x,y,dimensions.width,plan.fontSize,{draw});
    if(y>box.y+box.height+.01)throw new Error('Legend plan exceeds its measured page box.');
  });
}
function renderCompanyBlock(doc,box,companyProfile,companyLogoDataUrl,{draw=true}={}){
  const logoCell={x:box.x+2,y:box.y+2,width:18,height:box.height-4},scale=companyProfile.logoPlacement.scale;
  if(scale<.5||scale>1.5)throw new Error('Company logo scale must be between 0.5 and 1.5 to fit the title block.');
  const ratio=companyProfile.logoWidth/companyProfile.logoHeight,maxWidth=Math.min(logoCell.width,17*scale),maxHeight=Math.min(logoCell.height,14*scale);
  let logoWidth=maxWidth,logoHeight=logoWidth/ratio;if(logoHeight>maxHeight){logoHeight=maxHeight;logoWidth=logoHeight*ratio;}
  const alignOffset=companyProfile.logoPlacement.align==='right'?logoCell.width-logoWidth:companyProfile.logoPlacement.align==='center'?(logoCell.width-logoWidth)/2:0;
  const logoX=logoCell.x+alignOffset,logoY=logoCell.y+(logoCell.height-logoHeight)/2;
  const companyBox={x:box.x+22,y:box.y+2,width:box.width-24,height:box.height-4};
  const companyHeight=textBlock(doc,companyProfile.companyName,{...companyBox,height:5.5},7,{draw});
  const contact=[companyProfile.address,[companyProfile.phone,companyProfile.email].filter(Boolean).join(' · '),companyProfile.website].filter(Boolean).join('\n');
  textBlock(doc,contact,{x:companyBox.x,y:companyBox.y+companyHeight+.4,width:companyBox.width,height:companyBox.height-companyHeight-.4},5.2,{draw});
  if(draw)doc.addImage(companyLogoDataUrl,companyProfile.logoMime==='image/png'?'PNG':'JPEG',logoX,logoY,logoWidth,logoHeight,'company-logo','FAST');
}
function creditsFor(sheet){const source=sourceForFigure(sheet.code);return [sourceText(sheet.dataset?.source),source.credits].filter(Boolean).join(' | ');}
function renderMapPage(doc,project,page,index,count,{draw=true,companyProfile,companyLogoDataUrl}={}){
  const sheet=page.sheet,g=sheet.geometry,t=g.titleFrame,boxes=titleBoxes(g);
  const inset=(box,top=2)=>({x:box.x+2,y:box.y+top,width:box.width-4,height:box.height-top-2});
  function label(text,box){textBlock(doc,text,{...inset(box),height:4},6.5,{align:'center',draw});}
  if(draw){doc.setDrawColor(17,17,17);doc.setLineWidth(.3);doc.rect(g.sheet.x,g.sheet.y,g.sheet.width,g.sheet.height);doc.setLineWidth(.25);doc.rect(g.mapFrame.x,g.mapFrame.y,g.mapFrame.width,g.mapFrame.height);for(const b of boxes)doc.rect(b.x,b.y,b.width,b.height);}
  renderCompanyBlock(doc,boxes[0],companyProfile,companyLogoDataUrl,{draw});
  label('NORTH',boxes[1]);
  if(draw){const x=t.x+t.width/2,ny=boxes[1].y;doc.setFontSize(11);doc.text('N',x,ny+11,{align:'center'});doc.setFillColor(17,17,17);doc.triangle(x,ny+13,x-3,ny+22,x,ny+20,'F');doc.setLineWidth(.25);doc.triangle(x,ny+13,x+3,ny+22,x,ny+20,'S');}
  label('LEGEND',boxes[2]);drawLegendPlan(doc,page.legendPlan,mapLegendBox(sheet),{draw});
  label('PROJECT NAME AND ADDRESS',boxes[3]);
  const projectHeight=textBlock(doc,project.name,{...inset(boxes[3],7),height:15},11,{align:'center',draw});
  textBlock(doc,project.address,{...inset(boxes[3],8+projectHeight),height:boxes[3].height-projectHeight-10},8.5,{align:'center',draw});
  label(`FIGURE ${sheet.code}`,boxes[4]);textBlock(doc,project.figures[sheet.code].title,{...inset(boxes[4],7),height:14},10,{align:'center',draw});
  for(const [i,key,value] of [[0,'PROJECT NO.',project.projectNo],[1,'DATE',project.date],[2,'SCALE','AS SHOWN']]){
    textBlock(doc,key,{x:t.x+2,y:boxes[5].y+2+i*8,width:24,height:6},6.5,{draw});
    textBlock(doc,value,{x:t.x+27,y:boxes[5].y+2+i*8,width:38,height:7},8,{draw});
  }
  label('SOURCE',boxes[6]);
  textBlock(doc,creditsFor(sheet),{...inset(boxes[6],6),height:12},6.5,{draw});
  if(draw){
    drawScale(doc,g);doc.setFontSize(6.5);doc.setTextColor(17,17,17);
    const bottom=g.mapFrame.y+g.mapFrame.height;
    doc.setFillColor(255,255,255);doc.rect(g.mapFrame.x+.3,bottom-4.5,g.mapFrame.width-.6,4.2,'F');
    doc.text(`Page ${index+1} of ${count}`,g.mapFrame.x+g.mapFrame.width-2,bottom-1.3,{align:'right'});
    doc.text(`${g.dpi} DPI composition; source detail is unchanged. ${sheet.code==='B'?'Imagery acquisition date not verified.':''}`,g.mapFrame.x+2,bottom-1.3);
  }
}
function renderContinuationPage(doc,project,page,index,count,{draw=true,companyProfile,companyLogoDataUrl}={}){
  const sheet=page.sheet,g=sheet.geometry,t=g.titleFrame,m=g.mapFrame;
  const gap=2,rows=[18,44,42,30],used=rows.reduce((sum,row)=>sum+row,0)+gap*rows.length;
  rows.push(t.height-used);const boxes=titleBoxes(g,rows);
  const inset=(box,top=2)=>({x:box.x+2,y:box.y+top,width:box.width-4,height:box.height-top-2});
  function label(text,box){textBlock(doc,text,{...inset(box),height:4},6.5,{align:'center',draw});}
  if(draw){doc.setDrawColor(17,17,17);doc.setLineWidth(.3);doc.rect(g.sheet.x,g.sheet.y,g.sheet.width,g.sheet.height);doc.setLineWidth(.25);doc.rect(m.x,m.y,m.width,m.height);for(const box of boxes)doc.rect(box.x,box.y,box.width,box.height);doc.line(m.x,m.y+11,m.x+m.width,m.y+11);}
  renderCompanyBlock(doc,boxes[0],companyProfile,companyLogoDataUrl,{draw});
  label('PROJECT NAME AND ADDRESS',boxes[1]);
  const projectHeight=textBlock(doc,project.name,{...inset(boxes[1],7),height:16},11,{align:'center',draw});
  textBlock(doc,project.address,{...inset(boxes[1],8+projectHeight),height:boxes[1].height-projectHeight-10},8.5,{align:'center',draw});
  label(`FIGURE ${sheet.code}`,boxes[2]);
  textBlock(doc,project.figures[sheet.code].title,{...inset(boxes[2],7),height:14},9,{align:'center',draw});
  textBlock(doc,'LEGEND — CONTINUED',{...inset(boxes[2],23),height:12},9,{align:'center',draw});
  for(const [row,key,value] of [[0,'PROJECT NO.',project.projectNo],[1,'DATE',project.date],[2,'SHEET',`LEGEND CONT. ${page.continuationIndex}`]]){
    textBlock(doc,key,{x:t.x+2,y:boxes[3].y+2+row*8,width:24,height:6},6.5,{draw});
    textBlock(doc,value,{x:t.x+27,y:boxes[3].y+2+row*8,width:38,height:7},8,{draw});
  }
  label('SOURCE',boxes[4]);textBlock(doc,creditsFor(sheet),{...inset(boxes[4],7),height:boxes[4].height-9},6.5,{draw});
  textBlock(doc,'LEGEND — CONTINUED',{x:m.x+4,y:m.y+2,width:m.width-8,height:7},12,{align:'center',draw});
  drawLegendPlan(doc,page.legendPlan,continuationLegendBox(sheet),{draw});
  if(draw){doc.setFontSize(6.5);doc.setTextColor(17,17,17);doc.text(`Figure ${sheet.code} · legend continuation ${page.continuationIndex}`,m.x+2,m.y+m.height-1.3);doc.text(`Page ${index+1} of ${count}`,m.x+m.width-2,m.y+m.height-1.3,{align:'right'});}
}
function historicalResolution(value){return value===null?'Not published':`${Number(value.toPrecision(6))} m`;}
function failedHistoricalPlaceholder(page,error){
  const {width,height}=page.geometry.raster;
  const fallback='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  if(typeof document==='undefined')return {dataUrl:fallback,width,height,dispose(){}};
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');if(!ctx)return {dataUrl:fallback,width,height,dispose(){}};
  ctx.fillStyle='#f8fafc';ctx.fillRect(0,0,width,height);ctx.strokeStyle='#b91c1c';ctx.lineWidth=Math.max(2,Math.round(width/900));ctx.strokeRect(width*.04,height*.04,width*.92,height*.92);
  ctx.fillStyle='#7f1d1d';ctx.textAlign='center';ctx.font=`bold ${Math.max(24,Math.round(width/35))}px sans-serif`;ctx.fillText('HISTORICAL IMAGE UNAVAILABLE',width/2,height*.46);
  ctx.font=`${Math.max(14,Math.round(width/70))}px sans-serif`;ctx.fillText('Retry this sheet when the source service is available.',width/2,height*.54);
  const dataUrl=canvas.toDataURL('image/jpeg',.9);return {dataUrl,width,height,dispose(){canvas.width=canvas.height=0;}};
}
function renderHistoricalPage(doc,project,page,index,count,{draw=true,companyProfile,companyLogoDataUrl}={}){
  const {geometry:g,item,code}=page,m=g.mapFrame,t=g.titleFrame,gap=2,widths=[104,96,132],used=widths.reduce((sum,value)=>sum+value,0)+gap*3;
  const boxes=[];let x=t.x;for(const width of [...widths,t.width-used]){boxes.push({x,y:t.y,width,height:t.height});x+=width+gap;}
  if(draw){doc.setFillColor(255,255,255);doc.setDrawColor(17,17,17);doc.setLineWidth(.3);doc.rect(g.sheet.x,g.sheet.y,g.sheet.width,g.sheet.height);doc.rect(m.x,m.y,m.width,m.height);doc.rect(t.x,t.y,t.width,t.height,'FD');for(const box of boxes)doc.rect(box.x,box.y,box.width,box.height);}
  renderCompanyBlock(doc,boxes[0],companyProfile,companyLogoDataUrl,{draw});
  textBlock(doc,project.name,{x:boxes[1].x+2,y:boxes[1].y+2,width:boxes[1].width-4,height:7},8,{draw});
  textBlock(doc,project.address,{x:boxes[1].x+2,y:boxes[1].y+10,width:boxes[1].width-4,height:10},6,{draw});
  textBlock(doc,`Project no.: ${project.projectNo}\nDate: ${project.date}`,{x:boxes[1].x+2,y:boxes[1].y+22,width:boxes[1].width-4,height:13},6.5,{draw});
  const licence=item.mode==='official'?item.licenseUrl:'Manual permission acknowledged';
  textBlock(doc,`Year: ${item.year}\nSource: ${item.title}\nResolution: ${historicalResolution(item.resolutionMeters)}\nAttribution: ${item.attribution}\nLicence: ${licence}`,
    {x:boxes[2].x+2,y:boxes[2].y+2,width:boxes[2].width-4,height:boxes[2].height-4},5.2,{draw});
  textBlock(doc,code,{x:boxes[3].x+1,y:boxes[3].y+5,width:boxes[3].width-2,height:10},9,{align:'center',draw});
  textBlock(doc,'HISTORICAL\nIMAGERY',{x:boxes[3].x+1,y:boxes[3].y+18,width:boxes[3].width-2,height:14},6,{align:'center',draw});
  if(draw){
    const sx=m.x+5,sy=m.y+17,sw=g.scale.pixelWidth/g.raster.width*m.width;doc.setFillColor(255,255,255);doc.rect(sx-2,sy-10,sw+14,16,'F');doc.setFontSize(6.5);doc.setTextColor(17,17,17);doc.text('Approximate ground scale',sx,sy-6);doc.setDrawColor(0,0,0);doc.setLineWidth(.2);for(let segment=0;segment<4;segment++){doc.setFillColor(segment%2?255:0);doc.rect(sx+segment*sw/4,sy-3,sw/4,2,'FD');}doc.text(g.scale.labels[0],sx,sy+3);doc.text(g.scale.labels[1],sx+sw/2,sy+3,{align:'center'});doc.text(g.scale.labels[2],sx+sw,sy+3,{align:'center'});
    const nx=m.x+m.width-13,ny=m.y+8;doc.setFillColor(255,255,255);doc.rect(nx-8,ny-5,16,24,'F');doc.setFontSize(9);doc.text('N',nx,ny,{align:'center'});doc.setFillColor(17,17,17);doc.triangle(nx,ny+2,nx-3,ny+13,nx,ny+11,'F');doc.setLineWidth(.25);doc.triangle(nx,ny+2,nx+3,ny+13,nx,ny+11,'S');
    doc.setFillColor(255,255,255);doc.rect(m.x+m.width-32,m.y+1,30,5,'F');doc.setFontSize(6.5);doc.text(`Page ${index+1} of ${count}`,m.x+m.width-3,m.y+4.5,{align:'right'});
  }
}
async function createDocument(signal){
  const Constructor=await pdfLibrary();throwIfAborted(signal);
  const doc=new Constructor({orientation:'landscape',unit:'mm',format:'a3',putOnlyUsedFonts:true,compress:false,precision:4});
  doc.setCreationDate("D:19800101000000+00'00'");doc.setFileId('00000000000000000000000000000000');
  doc.addFileToVFS('DejaVuSans.ttf',base64(await fontBytes(signal)));throwIfAborted(signal);
  doc.addFont('DejaVuSans.ttf',FONT,'normal');doc.setFont(FONT);return doc;
}
async function preparePagePlan({project,codes,selection,datasets={},companyProfile,companyLogoDataUrl,dpi=300,signal,requireLogo=false,providers,assetStore,revalidateOfficial=revalidateHistoricalOfficialSource,fetchImpl=globalThis.fetch}){
  throwIfAborted(signal);const normalized=normalizeSelection(project,codes,selection),snapshot=structuredClone({project,datasets,companyProfile,companyLogoDataUrl});
  const selected=normalized.figureCodes,sheets=selected.map(code=>{try{return prepare(snapshot.project,code,snapshot.datasets,dpi,snapshot.companyProfile);}catch(error){throw new Error(`Figure ${code}: ${error.message}`,{cause:error});}});
  const historicalItems=normalized.historicalItems.map(selectedItem=>snapshot.project.historical.find(item=>item.id===selectedItem.id)),historicalSheets=[];
  let ownedStore=null,store=assetStore,historicalAssetBytes=0;const historicalAssets=new Map(),officialResults=new Map();
  try{
    if(historicalItems.some(item=>item.mode==='manual')&&!store){ownedStore=createAssetStore();store=ownedStore;}
    for(const item of historicalItems){
      const code=historicalCode(item);try{
        const errors=validatePrintRequirements({project:snapshot.project,companyProfile:snapshot.companyProfile,figureCode:'A'});if(errors.length)throw new Error(errors.map(error=>error.message).join(' '));
        const geometry=historicalSheetGeometry(snapshot.project,item,dpi);
        if(item.mode==='official'){
          const current=deepFreeze(structuredClone(await revalidateOfficial({project:snapshot.project,item,providers,signal,fetchImpl})));throwIfAborted(signal);historicalImageryPlan({project:snapshot.project,item,geometry,providers,currentResult:current});officialResults.set(item.id,current);
        }else{
          const asset=await loadHistoricalAssetSnapshot({project:snapshot.project,item,assetStore:store,signal});if(!historicalAssets.has(item.assetId)){historicalAssetBytes+=asset.metadata.size;if(historicalAssetBytes>MAX_HISTORICAL_SNAPSHOT_BYTES)throw new Error(`${code}: selected manual historical assets exceed the 32 MB aggregate resident snapshot limit. Export fewer historical sheets together.`);historicalAssets.set(item.assetId,asset);}
        }
        historicalSheets.push({item,geometry,code});
      }catch(error){if(error?.name==='AbortError')throw error;throw new Error(`${code}: ${error.message}`,{cause:error});}
    }
  }finally{await ownedStore?.close?.();}
  if(requireLogo&&(typeof snapshot.companyLogoDataUrl!=='string'||!/^data:image\/(?:png|jpeg);base64,[a-z0-9+/]+=*$/i.test(snapshot.companyLogoDataUrl)))throw new Error('A decoded PNG or JPEG company logo is required before exporting.');
  const doc=await createDocument(signal);if(requireLogo){let properties;try{properties=doc.getImageProperties(snapshot.companyLogoDataUrl);}catch(error){throw new Error('The company logo could not be decoded for the PDF.',{cause:error});}if(properties.width!==snapshot.companyProfile.logoWidth||properties.height!==snapshot.companyProfile.logoHeight)throw new Error('The decoded company logo dimensions do not match the Company Profile.');}
  doc.setProperties({title:'Phase I ESA figures and historical imagery',subject:'Selected A3 landscape figure sheets',creator:'Phase I ESA'});const pages=[];
  for(const sheet of sheets){let legend;try{legend=planSheetLegend(doc,snapshot.project,sheet);}catch(error){throw new Error(`Figure ${sheet.code}: ${error.message}`,{cause:error});}pages.push({kind:'map',code:sheet.code,sheet,legendPlan:legend.map});legend.continuations.forEach((legendPlan,index)=>pages.push({kind:'legend',code:sheet.code,sheet,continuationIndex:index+1,entries:legendPlan.columns.flat(),legendPlan}));}
  for(const sheet of historicalSheets)pages.push({kind:'historical',...sheet});const pagePlan=deepFreeze(pages);
  pagePlan.forEach((page,index)=>{try{const options={draw:false,companyProfile:snapshot.companyProfile,companyLogoDataUrl:snapshot.companyLogoDataUrl};if(page.kind==='map')renderMapPage(doc,snapshot.project,page,index,pagePlan.length,options);else if(page.kind==='legend')renderContinuationPage(doc,snapshot.project,page,index,pagePlan.length,options);else renderHistoricalPage(doc,snapshot.project,page,index,pagePlan.length,options);}catch(error){const label=page.kind==='historical'?page.code:`Figure ${page.code}`;throw new Error(`${label}: ${error.message}`,{cause:error});}});
  const snapshotStore=Object.freeze({async get(id){const asset=historicalAssets.get(id);return asset?{metadata:{...asset.metadata},blob:asset.blob}:null;}});
  return {doc,pagePlan,selected,normalizedSelection:deepFreeze(normalized.selection),snapshot:deepFreeze(snapshot),mapCount:sheets.length+historicalSheets.length,historicalAssetStore:snapshotStore,officialResults};
}
export async function planPdfExport(options){const {pagePlan,selected}=await preparePagePlan({...options,requireLogo:false});const continuationCounts=Object.fromEntries(selected.map(code=>[code,pagePlan.filter(page=>page.kind==='legend'&&page.code===code).length]));return deepFreeze({pageCount:pagePlan.length,continuationCounts});}

/** Returns a complete PDF only; downloading belongs to the UI after its final abort check. */
export async function exportCombinedPdf({project,codes,selection,datasets={},companyProfile,companyLogoDataUrl,dpi=300,onProgress=()=>{},signal,providers,assetStore,revalidateOfficial=revalidateHistoricalOfficialSource,fetchImpl=globalThis.fetch,compose=composeMap,composeHistorical=composeHistoricalImage}){
  const prepared=await preparePagePlan({project,codes,selection,datasets,companyProfile,companyLogoDataUrl,dpi,signal,requireLogo:true,providers,assetStore,revalidateOfficial,fetchImpl}),{doc,pagePlan,selected,normalizedSelection,snapshot,mapCount,historicalAssetStore,officialResults}=prepared;let completedMaps=0;const warnings=[];
  for(let i=0;i<pagePlan.length;i++){
    const page=pagePlan[i],sheet=page.sheet;let image;try{
      throwIfAborted(signal);if(page.kind==='map'){onProgress({phase:'sheet',code:sheet.code,completed:completedMaps,total:mapCount});image=await compose({project:snapshot.project,code:sheet.code,features:sheet.features,geometry:sheet.geometry,signal,onProgress});throwIfAborted(signal);}
      if(page.kind==='historical'){onProgress({phase:'sheet',code:page.code,completed:completedMaps,total:mapCount});image=await composeHistorical({project:snapshot.project,item:page.item,geometry:page.geometry,assetStore:historicalAssetStore,providers,currentOfficialResult:officialResults.get(page.item.id),signal,onProgress,fetchImpl});throwIfAborted(signal);}
    }catch(error){
      if(page.kind==='historical'&&signal?.aborted!==true&&error?.name!=='AbortError'){
        warnings.push(`${page.code}: ${error.message}`);image=failedHistoricalPlaceholder(page,error);
      }else{image?.dispose?.();if(signal?.aborted||error.name==='AbortError')throw new DOMException('Export cancelled.','AbortError');const label=page.kind==='historical'?page.code:`Figure ${page.code}`;throw new Error(`${label}: ${error.message}`,{cause:error});}
    }
    try{
      if(image&&(!image.dataUrl||!(image.width>0&&image.height>0)))throw new Error('Map composition did not return a complete image.');if(i)doc.addPage('a3','landscape');
      if(page.kind==='map'){const m=sheet.geometry.mapFrame;doc.addImage(image.dataUrl,undefined,m.x,m.y,m.width,m.height,`map-${sheet.code}-${i}`,'FAST');renderMapPage(doc,snapshot.project,page,i,pagePlan.length,{companyProfile:snapshot.companyProfile,companyLogoDataUrl:snapshot.companyLogoDataUrl});completedMaps++;}
      else if(page.kind==='historical'){const m=page.geometry.mapFrame;doc.addImage(image.dataUrl,undefined,m.x,m.y,m.width,m.height,`map-${page.code}-${i}`,'FAST');renderHistoricalPage(doc,snapshot.project,page,i,pagePlan.length,{companyProfile:snapshot.companyProfile,companyLogoDataUrl:snapshot.companyLogoDataUrl});completedMaps++;}
      else renderContinuationPage(doc,snapshot.project,page,i,pagePlan.length,{companyProfile:snapshot.companyProfile,companyLogoDataUrl:snapshot.companyLogoDataUrl});
    }catch(error){if(signal?.aborted||error.name==='AbortError')throw new DOMException('Export cancelled.','AbortError');const label=page.kind==='historical'?page.code:`Figure ${page.code}`;throw new Error(`${label}: ${error.message}`,{cause:error});}finally{image?.dispose?.();}
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  throwIfAborted(signal);const buffer=doc.output('arraybuffer');await new Promise(resolve=>setTimeout(resolve,0));throwIfAborted(signal);const historicalLabels=pagePlan.filter(page=>page.kind==='historical').map(page=>page.code),tag=`${selected.join('')}${historicalLabels.length?`${selected.length?'-':''}${historicalLabels.join('-')}`:''}`;
  const filename=`${(snapshot.project.projectNo||'phase-i').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64)||'phase-i'}-figures-${tag}.pdf`,result={blob:new Blob([buffer],{type:'application/pdf'}),filename,pageCount:pagePlan.length,selection:normalizedSelection,warnings:Object.freeze(warnings)};onProgress({phase:'complete',completed:pagePlan.length,total:pagePlan.length});throwIfAborted(signal);return result;
}
