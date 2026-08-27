import {figureDefaults,validBoundary} from './core.mjs';
import {validatePrintRequirements} from './print-validation.mjs';
import {sheetGeometry} from './sheet-layout.mjs';
import {sourceForFigure} from './map-sources.mjs';
import {containsBounds,siteFeature} from './geology.mjs';
import {validateBedrockRing} from './bedrock.mjs';
import {historicalCode,historicalSheetGeometry,orderedHistoricalItems} from './historical-layout.mjs';
import {validateImageryProvider,validateProviderUrl} from './imagery/provider-registry.mjs';
import {ONTARIO_IMAGERY_PROVIDER} from './imagery/providers/ontario.mjs';
import {TORONTO_IMAGERY_PROVIDER} from './imagery/providers/toronto.mjs';
import {OTTAWA_IMAGERY_PROVIDER} from './imagery/providers/ottawa.mjs';

const DEFAULT_PROVIDERS=Object.freeze([ONTARIO_IMAGERY_PROVIDER,TORONTO_IMAGERY_PROVIDER,OTTAWA_IMAGERY_PROVIDER]);

function selectionKey(selection){return selection?.kind==='figure'?`figure:${selection.code}`:selection?.kind==='historical'?`historical:${selection.id}`:'';}
function cropSpan(bounds){return `${bounds.west.toFixed(5)}, ${bounds.south.toFixed(5)} to ${bounds.east.toFixed(5)}, ${bounds.north.toFixed(5)}`;}
function providerMap(providers){const result=new Map();for(const provider of providers||DEFAULT_PROVIDERS){try{validateImageryProvider(provider);if(!result.has(provider.id))result.set(provider.id,provider);}catch{}}return result;}
function covers(coverage,bounds){return bounds.west>=coverage.west&&bounds.east<=coverage.east&&bounds.south>=coverage.south&&bounds.north<=coverage.north;}

function figureRows({project,datasets,companyProfile}){
  return Object.entries(figureDefaults()).map(([code,defaults])=>{
    const kind=code==='D'?'surficial':code==='E'?'bedrock':null,dataset=datasets[kind],reasons=[];let geometry,loaded=false,hit=null;
    try{geometry=sheetGeometry(project,code,150);}catch(error){reasons.push(error.message);}
    if(kind&&dataset?.features?.length){
      try{
        for(const feature of dataset.features)for(const ring of [feature.polygon,...(feature.holes||[])]){
          validateBedrockRing(ring);if(ring.length<4||ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])throw Error('Geology polygons must be closed.');
        }
        const source=typeof dataset.source==='string'?dataset.source:dataset.source?.name;loaded=Boolean(source?.trim());if(!loaded)reasons.push('Reload a labelled geology source.');
        if(geometry&&!containsBounds(dataset.coverage,geometry.bounds)){loaded=false;reasons.push('The geology data does not cover the final sheet extent. Reload this source.');}hit=siteFeature(dataset.features,project.location);
      }catch(error){reasons.push(`Invalid ${kind} geometry: ${error.message}`);}
    }
    reasons.push(...validatePrintRequirements({project,companyProfile,figureCode:code,geologyLoaded:loaded,geologySiteUnit:hit?.name}).map(error=>error.message));
    if(project.buildingBoundary?.length&&!validBoundary(project.buildingBoundary))reasons.push('Correct the invalid building boundary.');
    if(code!=='B'&&project.siteBoundary?.length&&!validBoundary(project.siteBoundary))reasons.push('Correct the invalid site boundary.');
    const selection={kind:'figure',code};return {kind:'figure',key:selectionKey(selection),code,title:project.figures?.[code]?.title||defaults.title,source:sourceForFigure(code),selection,ready:reasons.length===0,reasons};
  });
}

function historicalRows({project,providers,historicalAssetStates}){
  const registered=providerMap(providers);
  return orderedHistoricalItems(project).map(item=>{
    const reasons=[],code=historicalCode(item);try{historicalSheetGeometry(project,item,150);}catch(error){reasons.push(error.message);}
    if(item.policy!=='exportable')reasons.push(`Saved policy is ${item.policy}; only exportable historical imagery can be embedded.`);
    if(item.mode==='official'){
      const provider=registered.get(item.providerId);if(!provider)reasons.push('The saved official provider is no longer registered.');else{
        if(provider.policy!=='exportable')reasons.push('The current provider policy no longer permits export.');let siteCovered=false;try{siteCovered=provider.covers(project.location)===true;}catch{}
        if(!siteCovered||!covers(provider.coverage,item.bounds))reasons.push('The current provider coverage no longer includes SITE and the approved crop.');if(item.licenseUrl!==provider.licenseUrl)reasons.push('The saved licence no longer matches the current provider policy.');
        for(const [url,label] of [[item.sourceUrl,'source'],[item.licenseUrl,'licence'],[item.officialExport?.url,'export']])try{validateProviderUrl(url,provider,{label:`Historical ${label} URL`});}catch(error){reasons.push(error.message);}
        if(item.officialExport?.kind!=='arcgis-export'||item.officialExport.maxWidth<256||item.officialExport.maxHeight<256)reasons.push('The approved official export descriptor is unavailable or too small.');
      }
    }else if(item.mode==='manual'){
      if(!item.assetId||!item.placement)reasons.push('The approved manual image or affine placement is missing.');const state=historicalAssetStates?.get?.(item.id);if(state&&state.ready===false)reasons.push(state.reason||'The historical image asset is not ready.');
    }else reasons.push('The historical imagery mode is unsupported.');
    const selection={kind:'historical',id:item.id},sourceLabel=item.mode==='official'?(registered.get(item.providerId)?.label||item.providerId):item.attribution;
    return {kind:'historical',key:selectionKey(selection),id:item.id,code,title:item.title,year:item.year,bounds:item.bounds,policy:item.policy,attribution:item.attribution,source:{label:sourceLabel},selection,ready:reasons.length===0,reasons};
  });
}

export function exportRows({project,datasets={},companyProfile,providers=DEFAULT_PROVIDERS,historicalAssetStates}={}){return [...figureRows({project,datasets,companyProfile}),...historicalRows({project,providers,historicalAssetStates})];}
export function selectedReadySelection(rows,selection=[]){const keys=new Set((Array.isArray(selection)?selection:[]).map(selectionKey).filter(Boolean));return rows.filter(row=>row.ready&&keys.has(row.key)).map(row=>({...row.selection}));}
export function selectedReadyCodes(rows,codes=[]){return rows.filter(row=>row.kind==='figure'&&row.ready&&codes.includes(row.code)).map(row=>row.code);}

export function downloadPdf(result,{document,signal}){signal?.throwIfAborted();const url=URL.createObjectURL(result.blob),link=document.createElement('a');try{link.href=url;link.download=result.filename;link.hidden=true;document.body.append(link);signal?.throwIfAborted();link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}}

export function createExportDialog({document,getState,save,setBusy,exportPdf,planPdf=null,download=downloadPdf}){
  const byId=id=>document.getElementById(id),dialog=byId('exportDialog'),sheetCount=count=>`${count} ${count===1?'sheet':'sheets'}`;
  let controller=null,planning=null,planningController=null,planStates=new Map(),planGeneration=0,returnFocus=null,background=[];
  function projectSelection(project){return Array.isArray(project.exportPreferences?.selection)?project.exportPreferences.selection:(project.exportPreferences?.codes||[]).map(code=>({kind:'figure',code}));}
  function persist(selection){const project=getState().project,codes=selection.filter(value=>value.kind==='figure').map(value=>value.code),current=projectSelection(project);if(JSON.stringify(current)!==JSON.stringify(selection)||JSON.stringify(project.exportPreferences?.codes)!==JSON.stringify(codes)){project.exportPreferences={...project.exportPreferences,codes,selection:selection.map(value=>({...value}))};save();}}
  function rowDetail(row,planned,pending,blocked){if(!row.ready)return row.reasons.join(' ');if(blocked)return planned.error.message;if(pending)return 'Checking PDF layout…';if(row.kind==='historical')return `Ready · Year: ${row.year} · Source: ${row.source.label} · Attribution: ${row.attribution} · Crop: ${cropSpan(row.bounds)} · Licence: ${row.policy}`;const continuations=planned?.continuations||0;return continuations?`Figure ${row.code} will include ${continuations} legend continuation ${continuations===1?'sheet':'sheets'}.`:`Ready · ${row.source.label}`;}
  function render(){
    if(dialog.hidden||controller)return;const state=getState(),rows=exportRows(state),saved=projectSelection(state.project),savedKeys=new Set(saved.map(selectionKey));
    const retained=rows.filter(row=>savedKeys.has(row.key)&&row.ready&&(!planPdf||planStates.get(row.key)?.status!=='error')).map(row=>row.selection);persist(retained);const retainedKeys=new Set(retained.map(selectionKey)),selected=rows.filter(row=>retainedKeys.has(row.key)&&row.ready&&(!planPdf||planStates.get(row.key)?.status==='ready'));const focused=document.activeElement?.id;
    byId('exportRows').replaceChildren();for(const row of rows){
      const label=document.createElement('label');label.className='export-row';label.dataset.exportKind=row.kind;if(row.id)label.dataset.historicalId=row.id;const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.id=row.kind==='figure'?`exportFigure${row.code}`:`exportHistorical${row.id.replaceAll('-','')}`;
      const planned=planStates.get(row.key),pending=Boolean(planPdf&&row.ready&&planned?.status!=='ready'&&planned?.status!=='error'),blocked=Boolean(planPdf&&planned?.status==='error');checkbox.checked=retainedKeys.has(row.key)&&!blocked;checkbox.disabled=!row.ready||pending||blocked;checkbox.value=row.key;
      const text=document.createElement('span'),title=document.createElement('strong'),detail=document.createElement('span');title.textContent=row.kind==='figure'?`Figure ${row.code} — ${row.title}`:`${row.code} — ${row.title}`;detail.className='export-reason';detail.id=`exportReason${row.kind==='figure'?row.code:row.id.replaceAll('-','')}`;detail.textContent=rowDetail(row,planned,pending,blocked);if(planned?.continuations)detail.classList.add('export-continuation');checkbox.setAttribute('aria-describedby',detail.id);
      checkbox.onchange=()=>{const keys=new Set(projectSelection(getState().project).map(selectionKey));checkbox.checked?keys.add(row.key):keys.delete(row.key);persist(selectedReadySelection(exportRows(getState()),rows.filter(candidate=>keys.has(candidate.key)).map(candidate=>candidate.selection)));return refresh();};text.append(title,detail);label.append(checkbox,text);byId('exportRows').append(label);
    }
    const physicalCount=selected.reduce((sum,row)=>sum+1+(planStates.get(row.key)?.continuations||0),0);byId('downloadPdf').textContent=`Download PDF (${sheetCount(physicalCount)})`;byId('downloadPdf').disabled=!selected.length||selected.length!==retained.length;if(focused?.startsWith('exportFigure')||focused?.startsWith('exportHistorical'))byId(focused)?.focus();
  }
  function refresh(){
    if(dialog.hidden||controller)return planning||Promise.resolve();planGeneration++;planningController?.abort();planningController=null;planning=null;planStates=new Map();if(!planPdf){render();return Promise.resolve();}const state=getState(),rows=exportRows(state).filter(row=>row.ready);if(!rows.length){render();return Promise.resolve();}
    const generation=planGeneration,pending=new AbortController();planningController=pending;for(const row of rows)planStates.set(row.key,{status:'pending'});render();const tasks=rows.map(row=>{
      const plain=structuredClone({project:state.project,datasets:state.datasets||{},companyProfile:state.companyProfile,selection:[row.selection],codes:row.kind==='figure'?[row.code]:[]});let request;try{request=planPdf({...plain,providers:state.providers,assetStore:state.assetStore,dpi:plain.project.dpi||300,signal:pending.signal});}catch(error){request=Promise.reject(error);}
      return Promise.resolve(request).then(summary=>{if(generation!==planGeneration||pending.signal.aborted)return;let continuations=0;if(row.kind==='figure'){continuations=summary?.continuationCounts?.[row.code];if(!Number.isInteger(continuations)||continuations<0)throw new Error(`Figure ${row.code}: PDF planning returned an invalid continuation count.`);}else if(!Number.isInteger(summary?.pageCount)||summary.pageCount<1)throw new Error(`${row.code}: PDF planning returned an invalid page count.`);planStates.set(row.key,{status:'ready',continuations});render();}).catch(error=>{if(generation!==planGeneration||pending.signal.aborted)return;planStates.set(row.key,{status:'error',error});render();});
    });
    planning=Promise.allSettled(tasks).then(()=>{if(generation!==planGeneration||pending.signal.aborted)return;const blocked=[...planStates.values()].some(value=>value.status==='error');byId('exportProgress').textContent=blocked?'Some sheets are blocked. Correct their PDF layout or source errors to continue.':'PDF layout checked. Select the sheets to include.';}).finally(()=>{if(generation===planGeneration){planning=null;planningController=null;}});return planning;
  }
  function open(){if(!dialog.hidden||controller)return;returnFocus=document.activeElement;dialog.hidden=false;document.body.classList.add('export-open');background=[...document.querySelectorAll('body > header, body > main, #printPreview')].map(node=>[node,node.inert]);background.forEach(([node])=>node.inert=true);byId('exportProgress').textContent='Select the sheets to include. Source images are checked during export.';byId('cancelExport').textContent='Cancel';byId('exportMeter').hidden=true;byId('selectAllReady').focus();return refresh();}
  function close(){if(controller){controller.abort();byId('exportProgress').textContent='Cancelling export…';return;}if(dialog.hidden)return;planGeneration++;planningController?.abort();planning=null;planningController=null;planStates=new Map();dialog.hidden=true;document.body.classList.remove('export-open');background.forEach(([node,inert])=>node.inert=inert);background=[];returnFocus?.focus();}
  async function start(){
    if(controller)return;render();const state=getState(),selection=selectedReadySelection(exportRows(state),projectSelection(state.project));if(planPdf&&(planning||selection.some(value=>planStates.get(selectionKey(value))?.status!=='ready'))){byId('exportProgress').textContent='Wait for the current PDF layout check before downloading.';return;}if(!selection.length)return;
    const codes=selection.filter(value=>value.kind==='figure').map(value=>value.code),snapshot=structuredClone({project:state.project,datasets:state.datasets||{},companyProfile:state.companyProfile,selection,codes}),pending=new AbortController();controller=pending;const controls=[...dialog.querySelectorAll('button,input')].filter(node=>node.id!=='cancelExport'),disabled=controls.map(node=>[node,node.disabled]);controls.forEach(node=>node.disabled=true);byId('cancelExport').textContent='Cancel export';byId('exportProgress').textContent='Preparing selected sheets…';byId('exportMeter').hidden=false;byId('exportMeter').removeAttribute('value');
    try{setBusy(true);const result=await exportPdf({...snapshot,providers:state.providers,assetStore:state.assetStore,dpi:snapshot.project.dpi||300,signal:pending.signal,onProgress:event=>{if(pending.signal.aborted)return;if(event.phase==='sheet')byId('exportProgress').textContent=`${event.code} · sheet ${event.completed+1} of ${event.total}`;if(event.phase==='imagery')byId('exportProgress').textContent=`${event.code} · ${event.completed} of ${event.total} source images loaded`;if(event.phase==='complete')byId('exportProgress').textContent='All sheets composed. Preparing download…';byId('exportMeter').max=event.total;byId('exportMeter').value=event.completed;}});pending.signal.throwIfAborted();download(result,{document,signal:pending.signal});byId('exportProgress').textContent=`Downloaded ${sheetCount(result.pageCount)} in one PDF.`;}catch(error){byId('exportProgress').textContent=pending.signal.aborted||error.name==='AbortError'?'Export cancelled. No PDF downloaded.':`Export blocked: ${error.message}`;}finally{controller=null;setBusy(false);disabled.forEach(([node,value])=>node.disabled=value);byId('cancelExport').textContent='Close';byId('exportMeter').hidden=true;render();}
  }
  byId('selectAllReady').onclick=()=>{const rows=exportRows(getState()).filter(row=>row.ready&&(!planPdf||planStates.get(row.key)?.status==='ready'));persist(rows.map(row=>row.selection));return refresh();};byId('clearExport').onclick=()=>{persist([]);return refresh();};byId('cancelExport').onclick=close;byId('downloadPdf').onclick=start;
  document.addEventListener('keydown',event=>{if(dialog.hidden)return;if(event.key==='Escape'){event.preventDefault();close();}if(event.key==='Tab'){const controls=[...dialog.querySelectorAll('button,input')].filter(node=>!node.disabled),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}});return {open,close,refresh,start,get busy(){return Boolean(controller);}};
}
