import {validatePrintRequirements} from './src/print-validation.mjs';

// Read the app's live state, never infer geology from a badge or saved summary.
export function createPreflight({document,getState}){
  const panel=document.getElementById('printValidation');
  let requested=false;
  function refresh({scroll=false}={}){
    if(!requested)return true;
    const errors=validatePrintRequirements(getState());
    panel.replaceChildren();panel.hidden=errors.length===0;
    if(errors.length){
      const title=document.createElement('strong');
      title.textContent='Complete required items before printing';
      const list=document.createElement('ul');
      for(const error of errors){const li=document.createElement('li');li.textContent=error.message;list.appendChild(li);}
      panel.append(title,list);
      if(scroll)panel.scrollIntoView?.({behavior:'smooth',block:'center'});
    }
    return errors.length===0;
  }
  return {refresh,check(){requested=true;return refresh({scroll:true});}};
}
