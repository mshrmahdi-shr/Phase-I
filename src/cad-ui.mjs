import {utmZoneForLocation} from './projection.mjs';
import {validateCompanyProfile} from './company-profile.mjs';
import {normalizeCustomGeologySource} from './geology-provenance.mjs';

const PHASE_LABELS=Object.freeze({
  preflight:'Validating project, company, sources, and package limits…',
  sheet:'Composing images…',imagery:'Composing images…',
  assembling:'Writing CAD drawing, world files, and manifests…',
  'pdf-complete':'Writing PDF…',
  compressing:'Compressing the complete AutoCAD package…',
  complete:'AutoCAD package complete. Preparing the download…'
});

function abortError(){return new DOMException('Export cancelled.','AbortError');}
function throwIfAborted(signal){if(signal?.aborted)throw abortError();}
const defaultScheduleRevoke=callback=>setTimeout(callback,0);
function imageLabel(count){return `${count} ${count===1?'image':'images'}`;}
function cloneData(value,label){try{return structuredClone(value);}catch(error){throw new Error(`${label} could not be safely copied: ${error.message}`,{cause:error});}}
function checkedElements(document){
  const byId=id=>document.getElementById(id),elements={button:byId('downloadCad'),count:byId('cadSelectionCount'),crs:byId('cadCrs'),readiness:byId('cadReadiness'),progress:byId('exportProgress'),meter:byId('exportMeter'),cancel:byId('cancelExport'),dialog:byId('exportDialog')};
  for(const [name,node] of Object.entries(elements))if(!node)throw new Error(`CAD export UI is missing the ${name} control.`);
  return elements;
}

function readiness(snapshot){
  const blockers=Array.isArray(snapshot?.blockers)?snapshot.blockers.filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()):[];
  const selection=Array.isArray(snapshot?.selection)?snapshot.selection:[];
  if(!selection.length)blockers.push('Select at least one ready map or historical image.');
  for(const item of selection){
    const kind=item?.kind==='figure'&&item.code==='D'?'surficial':item?.kind==='figure'&&item.code==='E'?'bedrock':null;
    if(!kind)continue;
    const source=snapshot?.datasets?.[kind]?.source,fields=['name','credits','license','redistributionEvidence'];
    try{if(source?.id==='custom')normalizeCustomGeologySource(source);else if(!source||fields.some(field=>typeof source[field]!=='string'||!source[field].trim()))throw new Error('missing official provenance');}
    catch(error){blockers.push(`Figure ${item.code} geology source, credits, licence, permission evidence, rights confirmation, and acquisition year must be valid before CAD export. Edit custom source details to correct them. ${error.message}`);}
  }
  if(snapshot?.companyProfile==null){
    blockers.push('Project branding is not assigned. Click Apply Current Template to this project, then export again.');
  }else try{for(const error of validateCompanyProfile(snapshot.companyProfile))blockers.push(`${error.message} Open Company Profile, save it, then apply the template to this project before exporting.`);}catch(error){blockers.push(`Company Profile data is invalid or from an older saved version. Open Company Profile, upload the logo again, save it, then apply the template to this project. (${error.message})`);}
  let crs=null;try{crs=utmZoneForLocation(snapshot?.project?.location);}catch(error){blockers.push(`CAD coordinate system unavailable: ${error.message}`);}
  if(snapshot?.ready===false&&!blockers.length)blockers.push('The selected export rows are not ready. Correct the highlighted rows and try again.');
  return {selection,crs,blockers:[...new Set(blockers)],ready:snapshot?.ready!==false&&selection.length>0&&blockers.length===0};
}

function exportInput(source,selection){
  const copy={...source,project:cloneData(source.project,'Project'),companyProfile:cloneData(source.companyProfile,'Company Profile'),selection:cloneData(selection,'CAD selection'),datasets:cloneData(source.datasets||{},'Map datasets')};
  if(source.companyLogo)copy.companyLogo={metadata:cloneData(source.companyLogo.metadata,'Company logo metadata'),blob:source.companyLogo.blob};
  delete copy.blockers;delete copy.ready;
  return copy;
}

/** Download a completed atomic package. The URL is owned and revoked by this call on every path. */
export function downloadCadPackage(result,{document,signal,scheduleRevoke=defaultScheduleRevoke}={}){
  throwIfAborted(signal);if(!result||!(result.blob instanceof Blob)||result.blob.type!=='application/zip')throw new Error('The completed CAD package is not a ZIP Blob.');if(typeof result.filename!=='string'||!result.filename.trim())throw new Error('The completed CAD package filename is missing.');
  if(typeof scheduleRevoke!=='function')throw new Error('CAD download cleanup scheduler is unavailable.');const url=URL.createObjectURL(result.blob),link=document.createElement('a');let clicked=false;
  try{link.href=url;link.download=result.filename;link.hidden=true;document.body.append(link);throwIfAborted(signal);link.click();clicked=true;if(scheduleRevoke===defaultScheduleRevoke){link.hidden=false;link.textContent=`Download ${result.filename}`;link.style.cssText='position:fixed;right:1rem;bottom:1rem;z-index:10000;padding:.7rem 1rem;background:#078dcc;color:#fff;border-radius:.4rem;font:600 14px system-ui;';setTimeout(()=>link.remove(),30000);}}
  finally{if(clicked){if(scheduleRevoke!==defaultScheduleRevoke)link.remove();try{scheduleRevoke(()=>URL.revokeObjectURL(url));}catch{URL.revokeObjectURL(url);}}else{link.remove();URL.revokeObjectURL(url);}}
}

/** Controls the CAD action inside the shared PDF/CAD selection dialog. */
export function createCadExportController({document,getSnapshot,setBusy,exportPackage,download=downloadCadPackage,onBusyChange=()=>{}}={}){
  if(!document||typeof getSnapshot!=='function'||typeof setBusy!=='function'||typeof exportPackage!=='function'||typeof download!=='function'||typeof onBusyChange!=='function')throw new Error('CAD export controller dependencies are incomplete.');
  const elements=checkedElements(document);let active=null,destroyed=false,lastReady=false,currentRun=Promise.resolve();

  function read(){const source=getSnapshot();if(!source||typeof source!=='object')throw new Error('CAD export snapshot is unavailable.');return {source,...readiness(source)};}
  function refresh(){
    if(destroyed||active)return false;let state;
    try{state=read();}catch(error){elements.button.textContent='Download AutoCAD ZIP (0 images)';elements.count.textContent='0 images selected';elements.crs.textContent='NAD83 / UTM unavailable';elements.readiness.textContent=`CAD export blocked: ${error.message}`;elements.button.disabled=true;lastReady=false;return false;}
    const count=state.selection.length;elements.button.textContent=`Download AutoCAD ZIP (${imageLabel(count)})`;elements.count.textContent=`${imageLabel(count)} selected`;elements.crs.textContent=state.crs?`${state.crs.name} — metres`:'NAD83 / UTM unavailable';elements.readiness.textContent=state.blockers.length?`CAD export blocked: ${state.blockers.join(' ')}`:'Ready for a complete editable CAD package. Rasters remain externally referenced images.';elements.button.disabled=!state.ready;lastReady=state.ready;return state.ready;
  }
  function progress(event={}){
    if(!active||active.signal.aborted)return;const label=PHASE_LABELS[event.phase]||'Building the AutoCAD package…';elements.progress.textContent=label;
    const total=Number(event.total),completed=Number(event.completed),percent=Number(event.percent);if(Number.isFinite(total)&&total>0&&Number.isFinite(completed)){elements.meter.max=total;elements.meter.value=Math.min(total,Math.max(0,completed));}else if(Number.isFinite(percent)){elements.meter.max=100;elements.meter.value=Math.min(100,Math.max(0,percent));}else elements.meter.removeAttribute('value');
  }
  function cancel(){if(!active||active.signal.aborted)return false;active.abort();elements.progress.textContent='Cancelling AutoCAD package export…';return true;}
  async function run(){
    if(destroyed||active)return;let state;try{state=read();}catch(error){elements.progress.textContent=`CAD export blocked: ${error.message}`;refresh();return;}
    refresh();if(!state.ready){elements.progress.textContent=`CAD export blocked: ${state.blockers.join(' ')}`;return;}
    let input;try{input=exportInput(state.source,state.selection);}catch(error){elements.progress.textContent=`CAD export blocked: ${error.message}`;return;}
    const pending=new AbortController();active=pending;onBusyChange(true);const controls=[...elements.dialog.querySelectorAll('button,input,select')].filter(node=>node!==elements.cancel),disabled=controls.map(node=>[node,node.disabled]);controls.forEach(node=>node.disabled=true);elements.cancel.disabled=false;elements.cancel.textContent='Cancel export';elements.meter.hidden=false;elements.meter.removeAttribute('value');elements.progress.textContent=PHASE_LABELS.preflight;
    try{
      setBusy(true);const result=await exportPackage({...input,signal:pending.signal,onProgress:progress});throwIfAborted(pending.signal);download(result,{document,signal:pending.signal});throwIfAborted(pending.signal);elements.progress.textContent=`Downloaded ${imageLabel(result.imageCount)} with ${result.pageCount} PDF ${result.pageCount===1?'sheet':'sheets'} in one AutoCAD ZIP.`;
    }catch(error){elements.progress.textContent=pending.signal.aborted||error?.name==='AbortError'?'AutoCAD export cancelled. No ZIP downloaded.':`Export blocked: ${error?.message||String(error)}`;}
    finally{active=null;let cleanupError=null;try{setBusy(false);}catch(error){cleanupError=error;}disabled.forEach(([node,value])=>node.disabled=value);elements.cancel.textContent='Close';elements.meter.hidden=true;refresh();onBusyChange(false);if(cleanupError)elements.progress.textContent=`Export finished, but editing controls could not be restored: ${cleanupError.message}`;}
  }
  function start(){if(destroyed||active)return;currentRun=run();return currentRun;}
  function onKeydown(event){if(event.key==='Escape'&&active){event.preventDefault();cancel();}}
  function onCancel(){cancel();}
  elements.button.addEventListener('click',start);elements.cancel.addEventListener('click',onCancel);document.addEventListener('keydown',onKeydown);refresh();
  return {start,cancel,refresh,whenIdle(){return currentRun;},destroy(){if(destroyed)return;destroyed=true;cancel();elements.button.removeEventListener('click',start);elements.cancel.removeEventListener('click',onCancel);document.removeEventListener('keydown',onKeydown);},get busy(){return Boolean(active);},get ready(){return lastReady;}};
}
