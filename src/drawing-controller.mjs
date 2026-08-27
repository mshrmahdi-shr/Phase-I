const TOO_FEW_POINTS='Add at least 3 distinct corners before finishing.';
const INVALID_BOUNDARY='Boundary corners must be distinct and edges cannot cross.';
const CALLBACK_FAILURE='Drawing could not be completed. The current draft is still active.';
const DRAWING_SHORTCUT_SURFACE='[data-drawing-shortcuts]';
const INTERACTIVE_TARGET='button, a[href], area[href], input, textarea, select, option, summary, details, audio[controls], video[controls], [contenteditable], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [role="tab"], [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="treeitem"], [tabindex]';

function copyPoints(points){return points.map(point=>[...point]);}

function isInteractiveTarget(target){
  if(target?.matches?.(DRAWING_SHORTCUT_SURFACE))return false;
  return Boolean(target?.matches?.(INTERACTIVE_TARGET)||target?.closest?.(INTERACTIVE_TARGET));
}

export function createDrawingController({closeRing,validBoundary,onDraft=()=>{},onCommit=()=>{},onCancel=()=>{},onStatus=()=>{}}){
  let mode=null,points=[];

  function safeStatus(message){try{onStatus(message);}catch{}}
  function restoreDraft(previous){try{onDraft(copyPoints(previous.points),previous.mode);}catch{}}
  function publishTransition(nextPoints,nextMode,previous){
    try{onDraft(copyPoints(nextPoints),nextMode);return true;}
    catch{restoreDraft(previous);return false;}
  }
  function fail(){const result={ok:false,message:CALLBACK_FAILURE};safeStatus(result.message);return result;}

  function begin(nextMode){
    const previous=state();
    if(!publishTransition([],nextMode,previous)){safeStatus(CALLBACK_FAILURE);return previous;}
    if(mode!==null){
      try{onCancel(mode);}
      catch{restoreDraft(previous);safeStatus(CALLBACK_FAILURE);return previous;}
    }
    mode=nextMode;points=[];
    safeStatus(mode==='marker'?'Tap site':mode==='site'?'Drawing site':'Drawing building');
    return state();
  }

  function add(point){
    if(mode===null)return undefined;
    const previous=state(),added=[Number(point[0]),Number(point[1])],next=[...points,added];
    if(!publishTransition(next,mode,previous)){safeStatus(CALLBACK_FAILURE);return undefined;}
    points=next;return [...added];
  }

  function undo(){
    if(mode===null||!points.length)return undefined;
    const previous=state(),removed=points.at(-1),next=points.slice(0,-1);
    if(!publishTransition(next,mode,previous)){safeStatus(CALLBACK_FAILURE);return undefined;}
    points=next;return [...removed];
  }

  function cancel(){
    if(mode===null){safeStatus('Idle');return false;}
    const previous=state(),cancelledMode=mode;
    if(!publishTransition([],null,previous)){safeStatus(CALLBACK_FAILURE);return false;}
    try{onCancel(cancelledMode);}
    catch{restoreDraft(previous);safeStatus(CALLBACK_FAILURE);return false;}
    mode=null;points=[];safeStatus('Idle');return true;
  }

  function finish(){
    if(mode===null)return {ok:false,message:'No drawing is active.'};
    if(mode==='marker'){
      return cancel()?{ok:false,message:'Boundary drawing is not active.'}:fail();
    }
    const distinct=new Set(points.map(point=>point.join(','))).size;
    if(points.length<3||distinct<3){
      const result={ok:false,message:TOO_FEW_POINTS};safeStatus(result.message);return result;
    }
    let ring;
    try{ring=closeRing(copyPoints(points));}
    catch{return fail();}
    try{
      if(!validBoundary(ring)){
        const result={ok:false,message:INVALID_BOUNDARY};safeStatus(result.message);return result;
      }
    }
    catch{return fail();}
    const previous=state(),completedMode=mode,completedRing=copyPoints(ring);
    if(!publishTransition([],null,previous))return fail();
    try{onCommit(completedMode,copyPoints(completedRing));}
    catch{restoreDraft(previous);return fail();}
    mode=null;points=[];
    safeStatus(completedMode==='site'?'Site boundary completed.':'Building boundary completed.');
    return {ok:true,mode:completedMode,ring:completedRing};
  }

  function handleKey(event){
    if(mode===null||event.defaultPrevented||event.isComposing||event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||isInteractiveTarget(event.target))return undefined;
    if(event.key==='Enter'||event.code==='NumpadEnter'){event.preventDefault();return finish();}
    if(event.key==='Backspace'){event.preventDefault();return undo();}
    if(event.key==='Escape'){event.preventDefault();return cancel();}
    return undefined;
  }

  function handleContextMenu(event){
    if(mode===null)return undefined;
    event.preventDefault();return finish();
  }

  function state(){return {mode,points:copyPoints(points)};}

  return {begin,add,undo,finish,cancel,handleKey,handleContextMenu,state};
}
