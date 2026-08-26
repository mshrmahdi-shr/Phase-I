import {validatePrintRequirements} from './src/print-validation.mjs';

const $=id=>document.getElementById(id);
const STORAGE_KEYS=['phase-i-esa-project-v2','phase-i-esa-project-v1'];

function readStoredProject(){
  for(const key of STORAGE_KEYS){
    try{const raw=localStorage.getItem(key);if(raw)return JSON.parse(raw)}catch{}
  }
  return {};
}

function activeFigureCode(){
  const text=document.querySelector('.figure-row.active .figure-code')?.textContent||'FIGURE A';
  return (text.match(/FIGURE\s+([A-E])/i)?.[1]||'A').toUpperCase();
}

function currentProject(){
  const stored=readStoredProject();
  return {
    ...stored,
    name:$('projectName')?.value?.trim()||'',
    projectNo:$('projectNo')?.value?.trim()||'',
    date:$('projectDate')?.value?.trim()||'',
    address:$('address')?.value?.trim()||''
  };
}

function geologyState(figureCode){
  if(!['D','E'].includes(figureCode))return {geologyLoaded:true,geologySiteUnit:'n/a'};
  const kind=figureCode==='D'?'surficial':'bedrock';
  const status=$('geologyStatus');
  const statusText=(status?.textContent||'').toLowerCase();
  const loaded=status?.dataset?.kind==='ok'&&statusText.includes(kind)&&statusText.includes('polygon');
  const badge=($('geoUnitBadge')?.textContent||'').trim();
  const unit=badge&&badge!=='—'&&!/^no hit$/i.test(badge)?badge:null;
  return {geologyLoaded:loaded,geologySiteUnit:unit};
}

function ensurePanel(){
  let panel=$('printValidation');
  if(panel)return panel;
  panel=document.createElement('div');
  panel.id='printValidation';
  panel.setAttribute('role','alert');
  panel.hidden=true;
  panel.style.cssText='margin-top:12px;padding:12px 14px;border:1px solid #ef4444;border-radius:10px;background:rgba(127,29,29,.18);color:#fecaca;font-size:13px;line-height:1.45;';
  const button=$('printA3');
  button?.closest('section')?.appendChild(panel);
  return panel;
}

function showErrors(errors,figureCode){
  const panel=ensurePanel();
  panel.hidden=false;
  panel.innerHTML=`<div style="font-weight:700;color:#fff;margin-bottom:6px">Complete required items before printing Figure ${figureCode}</div><ul style="margin:0;padding-left:18px">${errors.map(e=>`<li style="margin:4px 0">${escapeHtml(e.message)}</li>`).join('')}</ul>`;
  panel.scrollIntoView({behavior:'smooth',block:'center'});
}

function clearErrors(){const panel=$('printValidation');if(panel){panel.hidden=true;panel.innerHTML=''}}
function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}

const printButton=$('printA3');
if(printButton){
  printButton.addEventListener('click',event=>{
    const figureCode=activeFigureCode();
    const project=currentProject();
    const geology=geologyState(figureCode);
    const errors=validatePrintRequirements({project,figureCode,...geology});
    if(errors.length){
      event.preventDefault();
      event.stopImmediatePropagation();
      showErrors(errors,figureCode);
      return;
    }
    clearErrors();
  },true);
}

for(const id of ['projectName','projectNo','projectDate','address','loadMrd128','uploadGeology','finishDraw','setSite']){
  $(id)?.addEventListener('change',clearErrors);
  $(id)?.addEventListener('click',clearErrors);
  $(id)?.addEventListener('input',clearErrors);
}
