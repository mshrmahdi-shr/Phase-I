import {customGeologySourceDraft,normalizeCustomGeologySource} from './geology-provenance.mjs';

const IDS=['geologyProvenanceDialog','geologyProvenanceForm','geologyProvenanceHeading','geologySourceName','geologySourceCredits','geologySourceUrl','geologySourceLicense','geologyPermissionEvidence','geologyAcquisitionYear','geologyYearVerification','geologyRightsConfirmed','geologyProvenanceStatus','saveGeologyProvenance','cancelGeologyProvenance'];
function fail(message){throw new Error(message);}

export function createGeologyProvenanceController({document,parsePolys,readKmz,Zip,onCommit}={}){
  if(!document?.getElementById||typeof parsePolys!=='function'||typeof readKmz!=='function'||typeof onCommit!=='function')fail('Custom geology provenance dependencies are incomplete.');
  const $=id=>document.getElementById(id),nodes=Object.fromEntries(IDS.map(id=>[id,$(id)]));for(const [id,node] of Object.entries(nodes))if(!node)fail(`Custom geology provenance UI is missing #${id}.`);
  nodes.geologyAcquisitionYear.max=String(new Date().getUTCFullYear()+1);
  let active=null,destroyed=false;
  function fields(source){nodes.geologySourceName.value=source.name;nodes.geologySourceCredits.value=source.credits;nodes.geologySourceUrl.value=source.sourceUrl??'';nodes.geologySourceLicense.value=source.license;nodes.geologyPermissionEvidence.value=source.redistributionEvidence;nodes.geologyAcquisitionYear.value=source.acquisitionYear??'';nodes.geologyYearVerification.value=source.acquisitionYearVerification;nodes.geologyRightsConfirmed.checked=source.permissionConfirmed;nodes.geologyProvenanceStatus.textContent='';}
  function close(value){if(!active)return;const {resolve}=active;active=null;nodes.geologyProvenanceDialog.hidden=true;resolve(value);}
  function open(context,source){if(destroyed)fail('Custom geology provenance UI is unavailable.');if(active)fail('Finish the current custom geology provenance form first.');fields(customGeologySourceDraft(source,{filename:context.filename??''}));nodes.geologyProvenanceHeading.textContent=context.mode==='edit'?'Edit custom geology provenance':`Review ${context.kind} geology provenance`;nodes.geologyProvenanceDialog.hidden=false;nodes.geologySourceName.focus();return new Promise(resolve=>{active={...context,resolve};});}
  async function save(event){event?.preventDefault();if(!active)return false;nodes.saveGeologyProvenance.disabled=true;try{
    const raw={id:'custom',name:nodes.geologySourceName.value,credits:nodes.geologySourceCredits.value,sourceUrl:nodes.geologySourceUrl.value||null,license:nodes.geologySourceLicense.value,redistributionEvidence:nodes.geologyPermissionEvidence.value,acquisitionYear:nodes.geologyAcquisitionYear.value===''?null:Number(nodes.geologyAcquisitionYear.value),acquisitionYearVerification:nodes.geologyYearVerification.value,permissionConfirmed:nodes.geologyRightsConfirmed.checked},source=normalizeCustomGeologySource(raw),context=active;
    await onCommit({...context,source});close(true);return true;
  }catch(error){nodes.geologyProvenanceStatus.textContent=`Cannot save provenance: ${error.message}`;return false;}finally{nodes.saveGeologyProvenance.disabled=false;}}
  async function importFile(file,kind,context={}){if(!file||typeof file.name!=='string'||!['surficial','bedrock'].includes(kind))fail('Choose a KML/KMZ file and geology dataset type.');const content=/\.kmz$/i.test(file.name)?await readKmz(file,Zip):await file.text(),features=parsePolys(content,kind);if(!features.length)fail('This file contains no polygons. Import a self-contained polygon KML/KMZ, not a NetworkLink index.');return open({...context,mode:'import',kind,filename:file.name,features,docs:1,coverage:null},{id:'custom',name:`Custom import: ${file.name}`});}
  function editSource(kind,source){if(!['surficial','bedrock'].includes(kind)||source?.id!=='custom')fail('No custom geology provenance is available to edit.');return open({mode:'edit',kind,filename:''},source);}
  function cancel(){close(false);}
  function keydown(event){if(event.key==='Escape'&&active){event.preventDefault();cancel();}}
  nodes.geologyProvenanceForm.addEventListener('submit',save);nodes.cancelGeologyProvenance.addEventListener('click',cancel);document.addEventListener('keydown',keydown);
  return {importFile,editSource,cancel,destroy(){if(destroyed)return;destroyed=true;cancel();nodes.geologyProvenanceForm.removeEventListener('submit',save);nodes.cancelGeologyProvenance.removeEventListener('click',cancel);document.removeEventListener('keydown',keydown);},get open(){return Boolean(active);}};
}
