import {sheetGeometry} from './sheet-layout.mjs';
import {sourceForFigure} from './map-sources.mjs';
import {composeMap,throwIfAborted} from './map-compositor.mjs';
import {relevantFeatures,relevantUnits,siteFeature,containsBounds} from './geology.mjs';
import {validBoundary,validLocation} from './core.mjs';
import {validatePrintRequirements} from './print-validation.mjs';

const FONT='DejaVuSans';
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
function sourceText(source){return typeof source==='string'?source:[source?.name,source?.credits].filter(Boolean).join('. ');}
function validateFeature(feature){
  for(const ring of [feature?.polygon,...(feature?.holes||[])]){
    if(!Array.isArray(ring)||ring.length<4||ring.some(p=>!Array.isArray(p)||!validLocation({lng:p[0],lat:p[1]})))throw new Error('The geology dataset contains an invalid polygon.');
    const [ox,oy]=ring[0],last=ring.at(-1);
    let area=0;for(let i=1;i<ring.length;i++)area+=(ring[i-1][0]-ox)*(ring[i][1]-oy)-(ring[i][0]-ox)*(ring[i-1][1]-oy);
    if(last[0]!==ox||last[1]!==oy||!Number.isFinite(area)||area===0)throw new Error('The geology dataset contains an invalid polygon.');
  }
}
function prepare(project,code,datasets,dpi){
  const geometry=sheetGeometry(project,code,dpi),kind=code==='D'?'surficial':code==='E'?'bedrock':null,dataset=kind?datasets[kind]:null;
  let features=[],units=[];
  if(kind){
    if(!Array.isArray(dataset?.features)||!dataset.features.length||!sourceText(dataset.source).trim())throw new Error(`Load a labelled ${kind} geology dataset before exporting.`);
    dataset.features.forEach(validateFeature);
    if(dataset.coverage&&!containsBounds(dataset.coverage,geometry.bounds))throw new Error('The geology data does not cover the final sheet extent. Reload it for this extent.');
    features=relevantFeatures(dataset.features,geometry.bounds);units=relevantUnits(features,geometry.bounds);
  }
  for(const key of ['siteBoundary','buildingBoundary'])if(project[key]?.length&&!validBoundary(project[key]))throw new Error('The project contains an invalid boundary.');
  const errors=validatePrintRequirements({project,figureCode:code,geologyLoaded:!!features.length,geologySiteUnit:siteFeature(features,project.location)?.name});
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
function renderSheet(doc,project,sheet,index,count,{draw=true}={}){
  const g=sheet.geometry,t=g.titleFrame;let y=t.y;
  const rows=[18,26,117.4,34,23,28,20],boxes=rows.map(height=>{const box={x:t.x,y,width:t.width,height};y+=height+2;return box;});
  const inset=(box,top=2)=>({x:box.x+2,y:box.y+top,width:box.width-4,height:box.height-top-2});
  function label(text,box){textBlock(doc,text,{...inset(box),height:4},6.5,{align:'center',draw});}
  if(draw){doc.setDrawColor(17,17,17);doc.setLineWidth(.3);doc.rect(g.sheet.x,g.sheet.y,g.sheet.width,g.sheet.height);doc.setLineWidth(.25);doc.rect(g.mapFrame.x,g.mapFrame.y,g.mapFrame.width,g.mapFrame.height);for(const b of boxes)doc.rect(b.x,b.y,b.width,b.height);}
  textBlock(doc,'PHASE I ESA',{...inset(boxes[0],3),height:7},16,{align:'center',draw});
  textBlock(doc,'ENVIRONMENTAL SITE ASSESSMENT',{...inset(boxes[0],12),height:3},6,{align:'center',draw});
  label('NORTH',boxes[1]);
  if(draw){const x=t.x+t.width/2,ny=boxes[1].y;doc.setFontSize(11);doc.text('N',x,ny+11,{align:'center'});doc.setFillColor(17,17,17);doc.triangle(x,ny+13,x-3,ny+22,x,ny+20,'F');doc.setLineWidth(.25);doc.triangle(x,ny+13,x+3,ny+22,x,ny+20,'S');}
  label('LEGEND',boxes[2]);let ly=boxes[2].y+8,legendBottom=boxes[2].y+boxes[2].height-2;
  const legends=[{name:'SITE',symbol:'site'},...(project.siteBoundary?.length?[{name:'Site boundary',symbol:'siteBoundary'}]:[]),...(project.buildingBoundary?.length?[{name:'Building boundary',symbol:'buildingBoundary'}]:[]),...sheet.units];
  for(const unit of legends){
    const content=[unit.name,unit.description].filter(Boolean).join('\n');
    const height=textBlock(doc,content,{x:t.x+11,y:ly,width:t.width-13,height:legendBottom-ly},7.5,{draw});
    if(draw){
      doc.setDrawColor(17,17,17);doc.setLineWidth(.2);
      if(unit.symbol==='site'){doc.setFillColor(239,68,68);doc.circle(t.x+5,ly+1.8,1.2,'F');}
      else if(unit.symbol){doc.setDrawColor(unit.symbol==='siteBoundary'?'#ef4444':'#111111');doc.setLineWidth(unit.symbol==='siteBoundary'?.7:.45);doc.setLineDashPattern(unit.symbol==='buildingBoundary'?[1.2,.8]:[],0);doc.line(t.x+2,ly+2,t.x+9,ly+2);doc.setLineDashPattern([],0);}
      else{doc.setFillColor(/^#[0-9a-f]{6}$/i.test(unit.color)?unit.color:'#5fa8d3');doc.rect(t.x+2,ly+.4,6,3,'FD');}
    }
    ly+=Math.max(height,4)+2;
  }
  label('PROJECT NAME AND ADDRESS',boxes[3]);
  const projectHeight=textBlock(doc,project.name,{...inset(boxes[3],7),height:15},11,{align:'center',draw});
  textBlock(doc,project.address,{...inset(boxes[3],8+projectHeight),height:boxes[3].height-projectHeight-10},8.5,{align:'center',draw});
  label(`FIGURE ${sheet.code}`,boxes[4]);textBlock(doc,project.figures[sheet.code].title,{...inset(boxes[4],7),height:14},10,{align:'center',draw});
  for(const [i,key,value] of [[0,'PROJECT NO.',project.projectNo],[1,'DATE',project.date],[2,'SCALE','AS SHOWN']]){
    textBlock(doc,key,{x:t.x+2,y:boxes[5].y+2+i*8,width:24,height:6},6.5,{draw});
    textBlock(doc,value,{x:t.x+27,y:boxes[5].y+2+i*8,width:38,height:7},8,{draw});
  }
  label('SOURCE',boxes[6]);
  const source=sourceForFigure(sheet.code),credits=[sourceText(sheet.dataset?.source),source.credits].filter(Boolean).join(' | ');
  textBlock(doc,credits,{...inset(boxes[6],6),height:12},6.5,{draw});
  if(draw){
    drawScale(doc,g);doc.setFontSize(6.5);doc.setTextColor(17,17,17);
    const bottom=g.mapFrame.y+g.mapFrame.height;
    doc.setFillColor(255,255,255);doc.rect(g.mapFrame.x+.3,bottom-4.5,g.mapFrame.width-.6,4.2,'F');
    doc.text(`Page ${index+1} of ${count}`,g.mapFrame.x+g.mapFrame.width-2,bottom-1.3,{align:'right'});
    doc.text(`${g.dpi} DPI composition; source detail is unchanged. ${sheet.code==='B'?'Imagery acquisition date not verified.':''}`,g.mapFrame.x+2,bottom-1.3);
  }
}
/** Returns a complete PDF only; downloading belongs to the UI after its final abort check. */
export async function exportCombinedPdf({project,codes,datasets={},dpi=300,onProgress=()=>{},signal,compose=composeMap}){
  throwIfAborted(signal);
  if(!Array.isArray(codes)||!codes.length)throw new Error('Select at least one ready figure.');
  if(codes.some(code=>!['A','B','C','D','E'].includes(code)))throw new Error('Choose valid figures A-E.');
  const selected=[...new Set(codes)].sort(),snapshot=structuredClone({project,datasets});
  const sheets=selected.map(code=>{try{return prepare(snapshot.project,code,snapshot.datasets,dpi);}catch(error){throw new Error(`Figure ${code}: ${error.message}`,{cause:error});}});
  const Constructor=await pdfLibrary();throwIfAborted(signal);
  const doc=new Constructor({orientation:'landscape',unit:'mm',format:'a3',putOnlyUsedFonts:true,compress:false,precision:4});
  doc.addFileToVFS('DejaVuSans.ttf',base64(await fontBytes(signal)));throwIfAborted(signal);
  doc.addFont('DejaVuSans.ttf',FONT,'normal');doc.setFont(FONT);
  doc.setProperties({title:'Phase I ESA figures',subject:'Selected A3 landscape figure sheets',creator:'Phase I ESA'});
  // Validate every text/legend before any remote imagery or partial page composition.
  sheets.forEach((sheet,i)=>{try{renderSheet(doc,snapshot.project,sheet,i,sheets.length,{draw:false});}catch(error){throw new Error(`Figure ${sheet.code}: ${error.message}`,{cause:error});}});
  for(let i=0;i<sheets.length;i++){
    const sheet=sheets[i];let image;
    try{
      throwIfAborted(signal);onProgress({phase:'sheet',code:sheet.code,completed:i,total:sheets.length});
      image=await compose({project:snapshot.project,code:sheet.code,features:sheet.features,geometry:sheet.geometry,signal,onProgress});throwIfAborted(signal);
      if(!image?.dataUrl||!(image.width>0&&image.height>0))throw new Error('Map composition did not return a complete image.');
      if(i)doc.addPage('a3','landscape');
      const m=sheet.geometry.mapFrame;doc.addImage(image.dataUrl,undefined,m.x,m.y,m.width,m.height,`map-${sheet.code}-${i}`,'FAST');
      renderSheet(doc,snapshot.project,sheet,i,sheets.length);
    }catch(error){if(signal?.aborted||error.name==='AbortError')throw new DOMException('Export cancelled.','AbortError');throw new Error(`Figure ${sheet.code}: ${error.message}`,{cause:error});}
    finally{image?.dispose?.();}
    // Give the browser a chance to deliver cancellation between expensive page work.
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  throwIfAborted(signal);const buffer=doc.output('arraybuffer');
  await new Promise(resolve=>setTimeout(resolve,0));throwIfAborted(signal);
  const filename=`${(snapshot.project.name||'phase-i').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64)||'phase-i'}-figures-${selected.join('')}.pdf`;
  const result={blob:new Blob([buffer],{type:'application/pdf'}),filename,pageCount:sheets.length};
  onProgress({phase:'complete',completed:sheets.length,total:sheets.length});throwIfAborted(signal);return result;
}
