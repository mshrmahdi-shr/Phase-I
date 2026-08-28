import {emptyCompanyProfile,normalizeCompanyProfile,snapshotCompanyProfile,validateCompanyProfile} from './company-profile.mjs';
import {commitCompanyTemplate,exportCompanyTemplate,inspectCompanyTemplate} from './company-template.mjs';

const MAX_LOGO_BYTES=4*1024*1024;
const MAX_LOGO_PIXELS=16_000_000;
const LOGO_ASSET_FIELDS=Object.freeze(['blob','metadata']);
const LOGO_METADATA_FIELDS=Object.freeze(['createdAt','height','id','kind','mime','sha256','size','width']);
const SHA256=/^[a-f0-9]{64}$/;
const ISO_TIMESTAMP=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const FIELD_IDS={
  companyName:'companyName',address:'companyAddress',phone:'companyPhone',email:'companyEmail',website:'companyWebsite',
  preparedBy:'companyPreparedBy',reviewedBy:'companyReviewedBy'
};
const ERROR_IDS={companyName:'companyNameError',address:'companyAddressError',phone:'companyPhoneError',email:'companyEmailError',website:'companyWebsiteError',logoAssetId:'logoError',logoPlacement:'logoPlacementError'};

function logoMime(bytes){
  if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte))return 'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  return '';
}

async function bitmapDimensions(blob,document){
  const createBitmap=document.defaultView?.createImageBitmap||globalThis.createImageBitmap;
  if(typeof createBitmap==='function'){
    let bitmap;
    try{
      bitmap=await createBitmap(blob);
      return {width:bitmap.width,height:bitmap.height};
    }catch(error){
      throw new Error('The logo could not be decoded as a PNG or JPEG image.',{cause:error});
    }finally{bitmap?.close?.();}
  }
  const ImageConstructor=document.defaultView?.Image;
  const createUrl=globalThis.URL?.createObjectURL;
  if(typeof ImageConstructor!=='function'||typeof createUrl!=='function')throw new Error('This browser cannot decode the selected logo. Use a current browser.');
  const url=createUrl(blob);
  try{
    return await new Promise((resolve,reject)=>{
      const image=new ImageConstructor();
      image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});
      image.onerror=()=>reject(new Error('The logo could not be decoded as a PNG or JPEG image.'));
      image.src=url;
    });
  }finally{globalThis.URL.revokeObjectURL(url);}
}

async function decodeLogo(blob,document){
  if(!blob||!Number.isSafeInteger(blob.size)||typeof blob.arrayBuffer!=='function')throw new Error('Choose a PNG or JPEG logo file.');
  if(blob.size<=0)throw new Error('The logo file is empty.');
  if(blob.size>MAX_LOGO_BYTES)throw new Error('The logo must be 4 MiB or smaller.');
  const bytes=new Uint8Array(await blob.arrayBuffer()),mime=logoMime(bytes);
  if(!mime)throw new Error('The logo byte signature must be PNG or JPEG.');
  if(blob.type&&blob.type!==mime)throw new Error('The logo file type does not match its PNG or JPEG byte signature.');
  const {width,height}=await bitmapDimensions(new Blob([bytes],{type:mime}),document);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0)throw new Error('The decoded logo has invalid dimensions.');
  if(width>Math.floor(MAX_LOGO_PIXELS/height))throw new Error('The decoded logo must not exceed 16 megapixels.');
  return {blob:new Blob([bytes],{type:mime}),bytes,mime,width,height};
}

async function sha256(bytes){
  if(!globalThis.crypto?.subtle)throw new Error('Secure logo hashing is unavailable in this browser.');
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

function dataUrl(bytes,mime,document){
  const encode=globalThis.btoa||document.defaultView?.btoa;
  if(typeof encode!=='function')throw new Error('The logo could not be prepared for preview.');
  let binary='';for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));
  return `data:${mime};base64,${encode(binary)}`;
}

function validProfile(value){
  try{const profile=normalizeCompanyProfile(value);return validateCompanyProfile(profile).length?null:profile;}catch{return null;}
}

function exactRecord(value,fields,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be a plain record.`);const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw new Error(`${label} must be a plain record.`);
  const keys=Reflect.ownKeys(value);if(keys.some(key=>typeof key!=='string')||keys.length!==fields.length||fields.some(key=>!keys.includes(key)))throw new Error(`${label} must contain its exact saved fields.`);
  const result={};for(const key of fields){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new Error(`${label}.${key} must be a saved data field.`);result[key]=descriptor.value;}return result;
}

function downloadBlob({blob,filename},document){
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  try{
    link.href=url;link.download=filename;link.hidden=true;document.body.append(link);link.click();
  }finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),0);}
}

export function createCompanyProfileDialog({document,assetStore,loadProfile,saveProfile,onChanged=()=>{},isAssetReferenced=()=>false,Zip=globalThis.JSZip}={}){
  if(!document?.getElementById)throw new Error('A document is required for the Company Profile dialog.');
  if(!assetStore||typeof assetStore.get!=='function'||typeof assetStore.put!=='function'||typeof assetStore.delete!=='function')throw new Error('A readable and writable asset store is required.');
  if(typeof loadProfile!=='function'||typeof saveProfile!=='function')throw new Error('Company profile load and save functions are required.');
  if(typeof isAssetReferenced!=='function')throw new Error('Company logo reference check must be a function.');
  const byId=id=>document.getElementById(id),dialog=byId('companyProfileDialog'),form=byId('companyProfileForm');
  let current=null,selectedLogo=null,logoSelectionError=null,importCandidate=null,returnFocus=null,background=[],destroyed=false,mutation=null;
  let logoGeneration=0,importGeneration=0,refreshGeneration=0,lifecycleGeneration=0,pendingLogo=null,pendingImport=null;

  function status(message,kind=''){
    const node=byId('companyProfileStatus');node.textContent=message;node.dataset.kind=kind;
  }
  function updateBusy(){
    const preparing=Boolean(pendingLogo||pendingImport),mutating=Boolean(mutation),busy=preparing||mutating;
    form.setAttribute('aria-busy',String(busy));
    for(const id of [...Object.values(FIELD_IDS),'companyLogo','companyLogoAlign','companyLogoScale','importCompanyTemplateFile','importCompanyTemplateInDialog'])byId(id).disabled=mutating;
    byId('saveCompanyProfile').disabled=busy;
    byId('confirmCompanyImport').disabled=busy||!importCandidate;
    byId('cancelCompanyImport').disabled=busy;
    byId('closeCompanyProfile').disabled=mutating||!current;
  }
  function startMutation(kind,message,work){
    if(destroyed)return Promise.resolve(false);
    if(mutation)return mutation.kind===kind?mutation.promise:Promise.resolve(false);
    const record={kind,promise:null,retryFocus:null};mutation=record;refreshGeneration++;status(message);
    record.promise=Promise.resolve().then(()=>work(record)).finally(()=>{
      if(mutation===record){mutation=null;updateBusy();if(record.retryFocus&&!destroyed&&!dialog.hidden)byId(record.retryFocus)?.focus();}
    });
    updateBusy();
    return record.promise;
  }
  function fieldControl(field){return byId(FIELD_IDS[field]||({logoAssetId:'companyLogo',logoPlacement:'companyLogoScale'}[field]));}
  function clearErrors(){for(const [field,id] of Object.entries(ERROR_IDS)){byId(id).textContent='';fieldControl(field)?.removeAttribute('aria-invalid');}}
  function retireManualLogoDraft(){
    logoGeneration++;pendingLogo=null;selectedLogo=null;logoSelectionError=null;
    const input=byId('companyLogo');input.value='';input.removeAttribute('aria-invalid');byId('logoError').textContent='';
  }
  function showErrors(errors){
    clearErrors();
    for(const error of errors){const node=byId(ERROR_IDS[error.field]),control=fieldControl(error.field);if(node)node.textContent=error.message;control?.setAttribute('aria-invalid','true');}
    errors[0]&&fieldControl(errors[0].field)?.focus();
  }
  function placementPreview(){
    const align=byId('companyLogoAlign').value,raw=Number(byId('companyLogoScale').value),scale=Number.isFinite(raw)?Math.min(1.5,Math.max(.5,raw)):1;
    const box=byId('companyLogoPreview').parentElement;box.dataset.logoAlign=align;box.style.setProperty('--logo-scale',String(scale));
    byId('companyLogoPreview').style.transform=`scale(${scale})`;
  }
  function fields(profile){
    for(const [field,id] of Object.entries(FIELD_IDS))byId(id).value=profile?.[field]||'';
    byId('companyLogoAlign').value=profile?.logoPlacement?.align||'left';
    byId('companyLogoScale').value=String(profile?.logoPlacement?.scale||1);
    placementPreview();
  }
  function previewLogo(url,alt){const image=byId('companyLogoPreview');image.src=url||'';image.alt=url?alt:'';image.hidden=!url;placementPreview();}
  function profileFromForm(){
    const old=current||emptyCompanyProfile(),value={...old,updatedAt:new Date().toISOString()};
    for(const [field,id] of Object.entries(FIELD_IDS))value[field]=byId(id).value.trim();
    value.logoPlacement={align:byId('companyLogoAlign').value,scale:Number(byId('companyLogoScale').value)};
    if(selectedLogo){value.logoAssetId=selectedLogo.id;value.logoMime=selectedLogo.mime;value.logoWidth=selectedLogo.width;value.logoHeight=selectedLogo.height;}
    return normalizeCompanyProfile(value);
  }
  async function storedLogo(profile){
    const saved=await assetStore.get(profile.logoAssetId);
    if(!saved)throw new Error('The saved company logo is missing. Upload the PNG or JPEG logo again.');
    const asset=exactRecord(saved,LOGO_ASSET_FIELDS,'Saved company logo'),metadata=exactRecord(asset.metadata,LOGO_METADATA_FIELDS,'Saved company logo metadata');
    if(metadata.id!==profile.logoAssetId||metadata.kind!=='company-logo'||metadata.mime!==profile.logoMime||metadata.width!==profile.logoWidth||metadata.height!==profile.logoHeight||!Number.isSafeInteger(metadata.size)||metadata.size<=0||!(asset.blob instanceof Blob)||asset.blob.size!==metadata.size||asset.blob.type!==metadata.mime||!SHA256.test(metadata.sha256)||typeof metadata.createdAt!=='string'||!ISO_TIMESTAMP.test(metadata.createdAt)||Number.isNaN(Date.parse(metadata.createdAt))){
      throw new Error('The saved company logo metadata does not match the profile. Upload the logo again.');
    }
    const decoded=await decodeLogo(asset.blob,document);
    if(decoded.mime!==profile.logoMime||decoded.width!==profile.logoWidth||decoded.height!==profile.logoHeight)throw new Error('The saved company logo no longer matches its decoded dimensions. Upload the logo again.');
    if(await sha256(decoded.bytes)!==metadata.sha256)throw new Error('The saved company logo hash does not match its bytes. Upload the logo again.');
    const companyLogo=Object.freeze({metadata:Object.freeze({...metadata}),blob:asset.blob});return {decoded,companyLogo};
  }
  async function notify(profile){current=profile?snapshotCompanyProfile(profile):null;await onChanged(current);return current;}
  async function refresh(){
    if(destroyed||mutation)return current;
    const ticket=++refreshGeneration;
    logoGeneration++;importGeneration++;pendingLogo=pendingImport=null;clearErrors();selectedLogo=null;logoSelectionError=null;importCandidate=null;updateBusy();byId('companyImportPreview').hidden=true;
    const loaded=validProfile(await loadProfile());
    if(destroyed||ticket!==refreshGeneration)return current;
    if(!loaded){fields(loaded);previewLogo('','');await notify(null);return null;}
    try{
      const {decoded}=await storedLogo(loaded);if(destroyed||ticket!==refreshGeneration)return current;
      fields(loaded);previewLogo(dataUrl(decoded.bytes,decoded.mime,document),`${loaded.companyName} logo`);
      return await notify(loaded);
    }catch(error){
      if(destroyed||ticket!==refreshGeneration)return current;
      fields(loaded);previewLogo('','');byId('logoError').textContent=error.message;status(error.message,'error');await notify(null);return null;
    }
  }
  async function open(){
    if(destroyed||mutation||!dialog.hidden)return current;
    const ticket=lifecycleGeneration;
    if(!current)await refresh();
    if(destroyed||mutation||ticket!==lifecycleGeneration||!dialog.hidden)return current;
    returnFocus=document.activeElement;dialog.hidden=false;document.body.classList.add('company-profile-open');
    background=[...document.querySelectorAll('body > header, body > main, #exportDialog, #printPreview')].map(node=>[node,node.inert]);
    background.forEach(([node])=>node.inert=true);byId('closeCompanyProfile').disabled=!current;
    status(current?'Review and save your reusable company details.':'Complete every required field and add a decoded PNG or JPEG logo before creating outputs.');
    byId('companyName').focus();return current;
  }
  function releaseDialog(){
    dialog.hidden=true;document.body.classList.remove('company-profile-open');background.forEach(([node,inert])=>node.inert=inert);background=[];
    returnFocus?.focus();returnFocus=null;
  }
  function close(){
    if(mutation||dialog.hidden||!current)return false;
    releaseDialog();return true;
  }
  async function finishSave(profile,newAsset,oldProfile=current){
    let stored=false;
    try{
      if(newAsset){await assetStore.put(newAsset);stored=true;}
      const result=await saveProfile(profile);if(result===false)throw new Error('Company profile metadata could not be saved.');
    }catch(error){
      if(stored)try{await assetStore.delete(profile.logoAssetId);}catch{}
      throw error;
    }
    if(destroyed)current=snapshotCompanyProfile(profile);else await notify(profile);
    let cleanupWarning='';
    if(oldProfile?.logoAssetId&&oldProfile.logoAssetId!==profile.logoAssetId){
      try{if(!await isAssetReferenced(oldProfile.logoAssetId))await assetStore.delete(oldProfile.logoAssetId);}catch{cleanupWarning=' The older logo was retained because its project references could not be verified.';}
    }
    if(!destroyed){
      selectedLogo=null;logoSelectionError=null;importGeneration++;pendingImport=null;importCandidate=null;byId('companyImportPreview').hidden=true;
      status(`Company profile saved.${cleanupWarning}`,'ok');fields(profile);
    }
    return profile;
  }
  async function submitWork(record){
    clearErrors();
    while(pendingLogo){const operation=pendingLogo;await operation;if(destroyed)return false;}
    if(logoSelectionError){showErrors([{field:'logoAssetId',message:logoSelectionError.message}]);record.retryFocus='companyLogo';status('Choose a valid decoded logo before saving.','error');return false;}
    let profile;
    try{profile=profileFromForm();}catch(error){record.retryFocus='saveCompanyProfile';status(error.message,'error');return false;}
    const errors=validateCompanyProfile(profile);if(errors.length){showErrors(errors);record.retryFocus=fieldControl(errors[0].field)?.id||'saveCompanyProfile';status('Correct the highlighted company profile fields.','error');return false;}
    let newAsset=null;
    if(selectedLogo){
      newAsset={metadata:{id:selectedLogo.id,kind:'company-logo',mime:selectedLogo.mime,size:selectedLogo.blob.size,width:selectedLogo.width,height:selectedLogo.height,
        sha256:selectedLogo.sha256,createdAt:selectedLogo.createdAt},blob:selectedLogo.blob};
    }
    status('Saving the company profile and logo. Keep this dialog open…');
    try{await finishSave(profile,newAsset);if(!destroyed)releaseDialog();return true;}
    catch(error){if(!destroyed){status(`Company profile was not replaced: ${error.message}`,'error');record.retryFocus='saveCompanyProfile';}return false;}
  }
  function submit(event){
    event?.preventDefault?.();
    if(destroyed||pendingImport)return Promise.resolve(false);
    return startMutation('save','Preparing the company profile for saving…',submitWork);
  }
  async function selectLogo(event){
    if(destroyed||mutation)return false;
    clearErrors();const file=event?.target?.files?.[0];if(!file)return false;
    const ticket=++logoGeneration;selectedLogo=null;logoSelectionError=null;status('Decoding and securely preparing the selected logo…');
    const operation=(async()=>{
      try{
        const decoded=await decodeLogo(file,document),id=`company-logo-${crypto.randomUUID()}`,hash=await sha256(decoded.bytes);
        if(ticket!==logoGeneration||destroyed)return false;
        selectedLogo={...decoded,id,sha256:hash,createdAt:new Date().toISOString()};
        previewLogo(dataUrl(decoded.bytes,decoded.mime,document),'Selected company logo preview');status('Logo decoded. Save the profile to use it on outputs.','ok');return true;
      }catch(error){
        if(ticket!==logoGeneration||destroyed)return false;
        selectedLogo=null;logoSelectionError=error;previewLogo('','');byId('logoError').textContent=error.message;status(error.message,'error');return false;
      }
    })();
    pendingLogo=operation;updateBusy();
    try{return await operation;}finally{if(pendingLogo===operation){pendingLogo=null;updateBusy();}}
  }
  async function previewImport(event){
    const file=event?.target?.files?.[0];if(!file)return false;
    if(destroyed||mutation)return false;
    if(dialog.hidden)await open();if(destroyed||mutation)return false;
    const ticket=++importGeneration;importCandidate=null;byId('companyImportPreview').hidden=true;status('Inspecting and decoding the company template…');
    const operation=(async()=>{
      try{
        const candidate=await inspectCompanyTemplate(file,{Zip}),decoded=await decodeLogo(candidate.logoBlob,document);
        if(ticket!==importGeneration||destroyed)return false;
        if(decoded.mime!==candidate.logoMetadata.mime||decoded.width!==candidate.logoMetadata.width||decoded.height!==candidate.logoMetadata.height){
          throw new Error('The imported logo decoded dimensions do not match its template metadata.');
        }
        importCandidate={...candidate,logoBlob:decoded.blob};
        byId('companyImportSummary').textContent=[candidate.profile.companyName,candidate.profile.address,candidate.profile.phone,candidate.profile.email,candidate.profile.website].join(' · ');
        const image=byId('companyImportLogo');image.src=dataUrl(decoded.bytes,decoded.mime,document);image.alt=`${candidate.profile.companyName} imported logo`;
        byId('companyImportPreview').hidden=false;status('Review this company template, then confirm replacement.');return true;
      }catch(error){if(ticket===importGeneration&&!destroyed)status(`Company template import failed: ${error.message}`,'error');return false;}
      finally{event.target.value='';}
    })();
    pendingImport=operation;updateBusy();
    try{const result=await operation;if(result&&ticket===importGeneration)byId('confirmCompanyImport').focus();return result;}
    finally{if(pendingImport===operation){pendingImport=null;updateBusy();}}
  }
  async function confirmImportWork(record){
    while(pendingImport){const operation=pendingImport;await operation;if(destroyed)return false;}
    if(!importCandidate)return false;const candidate=importCandidate,old=current;let profile;
    status('Saving the imported company profile and logo. Keep this dialog open…');
    try{
      profile=await commitCompanyTemplate(candidate,{assetStore});
      try{
        const result=await saveProfile(profile);if(result===false)throw new Error('Company profile metadata could not be saved.');
      }catch(error){try{await assetStore.delete(profile.logoAssetId);}catch{}throw error;}
      retireManualLogoDraft();
      if(destroyed)current=snapshotCompanyProfile(profile);else await notify(profile);
      let cleanupWarning='';if(old?.logoAssetId&&old.logoAssetId!==profile.logoAssetId){try{if(!await isAssetReferenced(old.logoAssetId))await assetStore.delete(old.logoAssetId);}catch{cleanupWarning=' The older logo was retained because its project references could not be verified.';}}
      if(!destroyed){
        const importedLogoUrl=byId('companyImportLogo').src;importCandidate=null;byId('companyImportPreview').hidden=true;fields(profile);
        previewLogo(importedLogoUrl,`${profile.companyName} logo`);
        status(`Imported company profile saved.${cleanupWarning}`,'ok');releaseDialog();
      }
      return true;
    }catch(error){if(!destroyed){status(`Company profile was not replaced: ${error.message}`,'error');record.retryFocus='confirmCompanyImport';}return false;}
  }
  function confirmImport(){
    if(destroyed||pendingLogo||(!pendingImport&&!importCandidate))return Promise.resolve(false);
    return startMutation('import','Preparing the imported company profile for saving…',confirmImportWork);
  }
  function cancelImport(){
    if(destroyed||mutation)return false;
    importGeneration++;pendingImport=null;importCandidate=null;updateBusy();byId('companyImportPreview').hidden=true;
    status('Import cancelled. The saved company profile was not changed.');return true;
  }
  async function exportTemplate(){
    if(destroyed||mutation)return false;
    try{
      const profile=current||await refresh();if(!profile)throw new Error('Complete and save the Company Profile first.');
      downloadBlob(await exportCompanyTemplate({profile,assetStore,Zip}),document);status('Company template downloaded.','ok');return true;
    }catch(error){status(`Company template export failed: ${error.message}`,'error');await open();return false;}
  }
  async function outputSnapshot(expected=current){
    const profile=validProfile(expected);if(!profile){
      const errors=validateCompanyProfile(expected||emptyCompanyProfile());
      throw new Error(`Company profile is incomplete: ${errors.map(error=>error.message).join(' ')}`);
    }
    const {decoded,companyLogo}=await storedLogo(profile);
    return Object.freeze({companyProfile:snapshotCompanyProfile(profile),companyLogoDataUrl:dataUrl(decoded.bytes,decoded.mime,document),companyLogo});
  }
  function keydown(event){
    if(dialog.hidden)return;
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab')return;
    const controls=[...dialog.querySelectorAll('button,input,select,textarea')].filter(node=>!node.disabled&&!node.hidden&&node.type!=='hidden'),first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }

  form.onsubmit=submit;byId('companyLogo').onchange=selectLogo;byId('closeCompanyProfile').onclick=close;
  byId('companyLogoAlign').onchange=()=>{if(!mutation)placementPreview();};byId('companyLogoScale').oninput=()=>{if(!mutation)placementPreview();};
  byId('editCompanyProfile').onclick=()=>open();byId('exportCompanyTemplate').onclick=exportTemplate;
  const chooseImport=()=>{if(!mutation)byId('importCompanyTemplateFile').click();};
  byId('importCompanyTemplate').onclick=chooseImport;byId('importCompanyTemplateInDialog').onclick=chooseImport;byId('importCompanyTemplateFile').onchange=previewImport;
  byId('confirmCompanyImport').onclick=confirmImport;byId('cancelCompanyImport').onclick=cancelImport;
  document.addEventListener('keydown',keydown);

  return {open,close,refresh,outputSnapshot,destroy(){
    if(destroyed)return;destroyed=true;lifecycleGeneration++;refreshGeneration++;logoGeneration++;importGeneration++;mutation=null;pendingLogo=pendingImport=null;selectedLogo=null;logoSelectionError=null;importCandidate=null;updateBusy();document.removeEventListener('keydown',keydown);if(!dialog.hidden)releaseDialog();
    for(const id of ['companyProfileForm','companyLogo','companyLogoAlign','companyLogoScale','closeCompanyProfile','editCompanyProfile','exportCompanyTemplate','importCompanyTemplate','importCompanyTemplateInDialog','importCompanyTemplateFile','confirmCompanyImport','cancelCompanyImport']){
      const node=byId(id);if(node){node.onclick=null;node.onchange=null;node.onsubmit=null;}
    }
  }};
}
