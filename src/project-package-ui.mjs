import {commitProjectPackage,exportProjectPackage,inspectProjectPackage} from './project-package.mjs';

function required(document,id){const element=document.getElementById(id);if(!element)throw new Error(`Project package UI requires #${id}.`);return element;}
function abortError(){return new DOMException('Cancelled','AbortError');}
function aborted(error){return error?.name==='AbortError';}
function defaultDownload({blob,filename},document,signal){
  if(signal?.aborted)throw signal.reason??abortError();const create=globalThis.URL?.createObjectURL,revoke=globalThis.URL?.revokeObjectURL;
  if(typeof create!=='function'||typeof revoke!=='function')throw new Error('This browser cannot download the completed project package.');const url=create(blob),link=document.createElement('a');
  try{if(signal?.aborted)throw signal.reason??abortError();link.href=url;link.download=filename;link.hidden=true;document.body.append(link);link.click();}finally{link.remove();setTimeout(()=>revoke(url),0);}
}

export function createProjectPackageUI({document,assetStore,Zip=globalThis.JSZip,getState,readState,persistState,initialize,onCommitted=()=>{},isAssetReferenced=async()=>false,setBusy=()=>{},
  exportPackage=exportProjectPackage,inspectPackage=inspectProjectPackage,commitPackage=commitProjectPackage,download=(output,_document,signal)=>defaultDownload(output,document,signal)}={}){
  if(!document||typeof getState!=='function'||typeof readState!=='function'||typeof persistState!=='function'||typeof initialize!=='function')throw new Error('Project package UI requires document and state lifecycle callbacks.');
  const dialog=required(document,'projectPackageDialog'),status=required(document,'projectPackageStatus'),meter=required(document,'projectPackageMeter'),preview=required(document,'projectPackagePreview'),summary=required(document,'projectPackageSummary'),companySummary=required(document,'projectPackageCompanySummary'),assetSummary=required(document,'projectPackageAssetSummary'),confirmButton=required(document,'confirmProjectPackageImport'),cancelButton=required(document,'cancelProjectPackage'),exportButton=required(document,'exportProjectPackage'),importButton=required(document,'importProjectPackage'),input=required(document,'importProjectPackageFile');
  let candidate=null,operation=null,generation=0,launcher=null,restoreFocus=null,destroyed=false,pending=Promise.resolve();
  function text(message,kind=''){status.textContent=message;status.dataset.kind=kind;}
  function setOperationBusy(value){
    exportButton.disabled=value;importButton.disabled=value;confirmButton.disabled=value||!candidate;cancelButton.textContent=value?'Cancel':'Close';meter.hidden=!value;setBusy(value);
    if(!value&&dialog.hidden&&restoreFocus){const target=restoreFocus;restoreFocus=null;target.focus?.();}
  }
  function open(source=document.activeElement){
    if(destroyed)return false;if(dialog.hidden){launcher=source&&typeof source.focus==='function'?source:exportButton;dialog.hidden=false;document.body.classList.add('project-package-open');}
    cancelButton.focus();return true;
  }
  function close({abort=true}={}){
    if(destroyed||dialog.hidden)return false;if(abort)operation?.controller.abort(abortError());generation++;candidate=null;preview.hidden=true;confirmButton.disabled=true;
    restoreFocus=launcher;dialog.hidden=true;document.body.classList.remove('project-package-open');launcher=null;meter.hidden=true;if(!operation){const target=restoreFocus;restoreFocus=null;target?.focus?.();}return true;
  }
  function progress(update={}){
    if(update.phase==='reading-assets'&&Number.isSafeInteger(update.completed)&&Number.isSafeInteger(update.total)){
      text(`Validating referenced files: ${update.completed} of ${update.total}.`);meter.removeAttribute('value');return;
    }
    if(update.phase==='compressing'&&Number.isFinite(update.percent)){meter.max=100;meter.value=Math.max(0,Math.min(100,update.percent));text(`Building the complete project package: ${Math.round(meter.value)}%.`);return;}
    text('Preparing the complete project package…');meter.removeAttribute('value');
  }
  function run(kind,work){
    if(destroyed||operation)return Promise.resolve(false);const controller=new AbortController(),token=++generation;operation={kind,controller,token};setOperationBusy(true);
    const task=(async()=>{try{return await work({controller,token});}finally{if(operation?.token===token){operation=null;setOperationBusy(false);}}})();pending=task.catch(()=>false);return task;
  }
  async function exportWork(){
    if(operation||destroyed)return false;candidate=null;preview.hidden=true;open(exportButton);text('Validating the project, company profile, and referenced files…');meter.removeAttribute('value');
    try{return await run('export',async({controller,token})=>{
      const state=getState(),output=await exportPackage({...state,assetStore,Zip,signal:controller.signal,onProgress:update=>{if(operation?.token===token)progress(update);}});
      if(controller.signal.aborted||token!==generation)throw controller.signal.reason??abortError();await download(output,document,controller.signal);if(controller.signal.aborted||token!==generation)throw controller.signal.reason??abortError();text('Recommended project package downloaded. Keep it with the project records.','ok');return true;
    });}catch(error){if(!aborted(error)&&!destroyed)text(`Project package was not downloaded: ${error.message}`,'error');return false;}
  }
  async function inspectWork(event){
    const file=event?.target?.files?.[0];if(!file||operation||destroyed)return false;open(document.activeElement);candidate=null;preview.hidden=true;confirmButton.disabled=true;text('Inspecting the project package without changing this browser…');meter.removeAttribute('value');
    try{return await run('inspect',async({controller,token})=>{
      const inspected=await inspectPackage(file,{Zip,signal:controller.signal});if(controller.signal.aborted||token!==generation)throw controller.signal.reason??abortError();candidate=inspected;
      summary.textContent=`Project: ${inspected.project.name||'(unnamed)'} · ${inspected.project.projectNo||'No project number'} · ${inspected.project.address||'No address'}`;
      companySummary.textContent=`Company profile: ${inspected.companyProfile.companyName} · ${inspected.companyProfile.address}`;
      assetSummary.textContent=`Referenced local files: ${inspected.assets.length}. Official remote imagery remains metadata-only and must pass current provider checks after import.`;
      preview.hidden=false;confirmButton.disabled=false;text('Inspection passed. Review the summary, then confirm replacement. Current data has not changed.','ok');confirmButton.focus();return true;
    });}catch(error){if(!aborted(error)&&!destroyed)text(`Project package was rejected; current project and company data were not changed: ${error.message}`,'error');return false;}
    finally{try{event.target.value='';}catch{}}
  }
  async function confirmImport(){
    if(!candidate||operation||destroyed)return false;const selected=candidate;text('Restoring referenced files before replacing project metadata…');meter.removeAttribute('value');
    try{return await run('commit',async({controller,token})=>{
      const result=await commitPackage(selected,{assetStore,signal:controller.signal,readState,persistState,initialize,isAssetReferenced});if(controller.signal.aborted||token!==generation)throw controller.signal.reason??abortError();await onCommitted(result);
      if(controller.signal.aborted||token!==generation)throw controller.signal.reason??abortError();candidate=null;preview.hidden=true;confirmButton.disabled=true;text(`Project package imported. ${result.addedAssetIds.length} local files restored; ${result.reusedAssetIds.length} existing verified files reused.`,'ok');return true;
    });}catch(error){if(!aborted(error)&&!destroyed)text(`Project package was not imported; the previous project and company profile were preserved: ${error.message}`,'error');return false;}
  }
  function cancel(){if(operation)operation.controller.abort(abortError());return close({abort:false});}
  function keydown(event){
    if(dialog.hidden)return;if(event.key==='Escape'){event.preventDefault();cancel();return;}if(event.key!=='Tab')return;
    const controls=[...dialog.querySelectorAll('button,input')].filter(node=>!node.disabled&&!node.hidden&&node.type!=='hidden'),first=controls[0],last=controls.at(-1);if(!first)return;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  const chooseImport=()=>{if(!operation)input.click();};
  exportButton.addEventListener('click',exportWork);importButton.addEventListener('click',chooseImport);input.addEventListener('change',inspectWork);confirmButton.addEventListener('click',confirmImport);cancelButton.addEventListener('click',cancel);document.addEventListener('keydown',keydown);
  return {open,close,cancel,whenIdle:()=>pending,destroy(){if(destroyed)return;operation?.controller.abort(abortError());destroyed=true;generation++;candidate=null;document.removeEventListener('keydown',keydown);exportButton.removeEventListener('click',exportWork);importButton.removeEventListener('click',chooseImport);input.removeEventListener('change',inspectWork);confirmButton.removeEventListener('click',confirmImport);cancelButton.removeEventListener('click',cancel);if(!dialog.hidden){launcher?.focus?.();dialog.hidden=true;document.body.classList.remove('project-package-open');}setBusy(false);}};
}
