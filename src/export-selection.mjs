import {figureDefaults,validBoundary} from './core.mjs';
import {validatePrintRequirements} from './print-validation.mjs';
import {sheetGeometry} from './sheet-layout.mjs';
import {sourceForFigure} from './map-sources.mjs';
import {containsBounds,siteFeature} from './geology.mjs';
import {validateBedrockRing} from './bedrock.mjs';

// Saved summaries are deliberately excluded: only currently loaded geometry counts.
export function exportRows({project,datasets={},companyProfile}){
  return Object.entries(figureDefaults()).map(([code,defaults])=>{
    const kind=code==='D'?'surficial':code==='E'?'bedrock':null,dataset=datasets[kind];
    const reasons=[];let geometry,loaded=false,hit=null;
    try{geometry=sheetGeometry(project,code,150);}catch(error){reasons.push(error.message);}
    if(kind&&dataset?.features?.length){
      try{
        for(const feature of dataset.features)for(const ring of [feature.polygon,...(feature.holes||[])]){
          validateBedrockRing(ring);
          if(ring.length<4||ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])throw Error('Geology polygons must be closed.');
        }
        const source=typeof dataset.source==='string'?dataset.source:dataset.source?.name;
        loaded=Boolean(source?.trim());
        if(!loaded)reasons.push('Reload a labelled geology source.');
        if(geometry&&!containsBounds(dataset.coverage,geometry.bounds)){
          loaded=false;reasons.push('The geology data does not cover the final sheet extent. Reload this source.');
        }
        hit=siteFeature(dataset.features,project.location);
      }catch(error){reasons.push(`Invalid ${kind} geometry: ${error.message}`);}
    }
    reasons.push(...validatePrintRequirements({project,companyProfile,figureCode:code,geologyLoaded:loaded,geologySiteUnit:hit?.name}).map(e=>e.message));
    if(project.buildingBoundary?.length&&!validBoundary(project.buildingBoundary))reasons.push('Correct the invalid building boundary.');
    if(code!=='B'&&project.siteBoundary?.length&&!validBoundary(project.siteBoundary))reasons.push('Correct the invalid site boundary.');
    return {code,title:project.figures?.[code]?.title||defaults.title,source:sourceForFigure(code),ready:reasons.length===0,reasons};
  });
}

export function selectedReadyCodes(rows,codes=[]){
  return rows.filter(row=>row.ready&&codes.includes(row.code)).map(row=>row.code);
}

export function downloadPdf(result,{document,signal}){
  signal?.throwIfAborted();
  const url=URL.createObjectURL(result.blob),link=document.createElement('a');
  try{
    link.href=url;link.download=result.filename;link.hidden=true;document.body.append(link);
    signal?.throwIfAborted();link.click();
  }finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}

export function createExportDialog({document,getState,save,setBusy,exportPdf,planPdf=null,download=downloadPdf}){
  const byId=id=>document.getElementById(id),dialog=byId('exportDialog');
  const sheetCount=count=>`${count} ${count===1?'sheet':'sheets'}`;
  let controller=null,planning=null,planningController=null,planSummary=null,planGeneration=0,returnFocus=null,background=[];
  function persist(codes){
    const project=getState().project;
    if(JSON.stringify(project.exportPreferences?.codes)!==JSON.stringify(codes)){
      project.exportPreferences={...project.exportPreferences,codes};save();
    }
  }
  function render(){
    if(dialog.hidden||controller)return;
    const state=getState(),rows=exportRows(state),codes=selectedReadyCodes(rows,state.project.exportPreferences?.codes);
    persist(codes);
    const focused=document.activeElement?.id;
    byId('exportRows').replaceChildren();
    for(const row of rows){
      const label=document.createElement('label');label.className='export-row';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.id=`exportFigure${row.code}`;
      checkbox.checked=codes.includes(row.code);checkbox.disabled=!row.ready;checkbox.value=row.code;
      const text=document.createElement('span'),title=document.createElement('strong'),detail=document.createElement('span');
      title.textContent=`Figure ${row.code} — ${row.title}`;
      detail.className='export-reason';detail.id=`exportReason${row.code}`;
      const continuations=planSummary?.continuationCounts?.[row.code]||0;
      detail.textContent=!row.ready?row.reasons.join(' '):continuations?`Figure ${row.code} will include ${continuations} legend continuation ${continuations===1?'sheet':'sheets'}.`:`Ready · ${row.source.label}`;
      if(continuations)detail.classList.add('export-continuation');
      checkbox.setAttribute('aria-describedby',detail.id);
      checkbox.onchange=()=>{
        const selected=new Set(getState().project.exportPreferences?.codes||[]);
        checkbox.checked?selected.add(row.code):selected.delete(row.code);
        persist(selectedReadyCodes(exportRows(getState()),[...selected]));render();
      };
      text.append(title,detail);label.append(checkbox,text);byId('exportRows').append(label);
    }
    const physicalCount=codes.length+codes.reduce((sum,code)=>sum+(planSummary?.continuationCounts?.[code]||0),0);
    byId('downloadPdf').textContent=`Download PDF (${sheetCount(physicalCount)})`;
    byId('downloadPdf').disabled=!codes.length;
    if(focused?.startsWith('exportFigure'))byId(focused)?.focus();
  }
  function refresh(){
    if(dialog.hidden||controller)return planning||Promise.resolve();
    render();if(!planPdf)return Promise.resolve();
    if(planning)return planning;
    const state=getState(),rows=exportRows(state),codes=rows.filter(row=>row.ready).map(row=>row.code);
    if(!codes.length){planSummary=null;render();return Promise.resolve();}
    const generation=++planGeneration,pending=new AbortController();planningController=pending;
    const snapshot=structuredClone({project:state.project,datasets:state.datasets||{},companyProfile:state.companyProfile,codes});
    planning=Promise.resolve(planPdf({...snapshot,dpi:snapshot.project.dpi||300,signal:pending.signal})).then(summary=>{
      if(generation!==planGeneration||pending.signal.aborted)return;
      planSummary=summary;render();
    }).catch(error=>{
      if(generation===planGeneration&&!pending.signal.aborted){planSummary=null;byId('exportProgress').textContent=`Export planning blocked: ${error.message}`;}
    }).finally(()=>{if(generation===planGeneration){planning=null;planningController=null;}});
    return planning;
  }
  function open(){
    if(!dialog.hidden||controller)return;
    returnFocus=document.activeElement;dialog.hidden=false;document.body.classList.add('export-open');
    background=[...document.querySelectorAll('body > header, body > main, #printPreview')].map(node=>[node,node.inert]);
    background.forEach(([node])=>node.inert=true);
    byId('exportProgress').textContent='Select the sheets to include. Source images are checked during export.';
    byId('cancelExport').textContent='Cancel';
    byId('exportMeter').hidden=true;planSummary=null;refresh();byId('selectAllReady').focus();
  }
  function close(){
    if(controller){controller.abort();byId('exportProgress').textContent='Cancelling export…';return;}
    if(dialog.hidden)return;
    planGeneration++;planningController?.abort();planning=null;planningController=null;
    dialog.hidden=true;document.body.classList.remove('export-open');
    background.forEach(([node,inert])=>node.inert=inert);background=[];returnFocus?.focus();
  }
  async function start(){
    if(controller)return;
    render();const state=getState(),codes=selectedReadyCodes(exportRows(state),state.project.exportPreferences?.codes);
    if(!codes.length)return;
    const snapshot=structuredClone({project:state.project,datasets:state.datasets||{},companyProfile:state.companyProfile,codes});
    const pending=new AbortController();controller=pending;
    const controls=[...dialog.querySelectorAll('button,input')].filter(node=>node.id!=='cancelExport');
    const disabled=controls.map(node=>[node,node.disabled]);controls.forEach(node=>node.disabled=true);
    byId('cancelExport').textContent='Cancel export';byId('exportProgress').textContent='Preparing selected sheets…';
    byId('exportMeter').hidden=false;byId('exportMeter').removeAttribute('value');
    try{
      setBusy(true);
      const result=await exportPdf({...snapshot,dpi:snapshot.project.dpi||300,signal:pending.signal,onProgress:event=>{
        if(pending.signal.aborted)return;
        if(event.phase==='sheet')byId('exportProgress').textContent=`Figure ${event.code} · sheet ${event.completed+1} of ${event.total}`;
        if(event.phase==='imagery')byId('exportProgress').textContent=`Figure ${event.code} · ${event.completed} of ${event.total} source images loaded`;
        if(event.phase==='complete')byId('exportProgress').textContent='All sheets composed. Preparing download…';
        byId('exportMeter').max=event.total;byId('exportMeter').value=event.completed;
      }});
      pending.signal.throwIfAborted();download(result,{document,signal:pending.signal});
      byId('exportProgress').textContent=`Downloaded ${sheetCount(result.pageCount)} in one PDF.`;
    }catch(error){
      byId('exportProgress').textContent=pending.signal.aborted||error.name==='AbortError'?'Export cancelled. No PDF downloaded.':`Export blocked: ${error.message}`;
    }finally{
      controller=null;setBusy(false);disabled.forEach(([node,value])=>node.disabled=value);
      byId('cancelExport').textContent='Close';byId('exportMeter').hidden=true;render();
    }
  }
  byId('selectAllReady').onclick=()=>{persist(exportRows(getState()).filter(row=>row.ready).map(row=>row.code));render();};
  byId('clearExport').onclick=()=>{persist([]);render();};
  byId('cancelExport').onclick=close;byId('downloadPdf').onclick=start;
  document.addEventListener('keydown',event=>{
    if(dialog.hidden)return;
    if(event.key==='Escape'){event.preventDefault();close();}
    if(event.key==='Tab'){
      const controls=[...dialog.querySelectorAll('button,input')].filter(node=>!node.disabled),first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  return {open,close,refresh,start,get busy(){return Boolean(controller);}};
}
