const TOO_FEW_POINTS='Add at least 3 distinct corners before finishing.';
const INVALID_BOUNDARY='Boundary corners must be distinct and edges cannot cross.';

function copyPoints(points){return points.map(point=>[...point]);}

function isTextEntry(target){
  const selector='input, textarea, select, [contenteditable], [contenteditable="true"]';
  return Boolean(target?.matches?.(selector)||target?.closest?.(selector));
}

export function createDrawingController({closeRing,validBoundary,onDraft=()=>{},onCommit=()=>{},onCancel=()=>{},onStatus=()=>{}}){
  let mode=null,points=[];

  function publishDraft(){onDraft(copyPoints(points),mode);}
  function clear(){mode=null;points=[];publishDraft();}

  function begin(nextMode){
    if(mode!==null)onCancel(mode);
    mode=nextMode;points=[];publishDraft();
    onStatus(mode==='marker'?'Tap site':mode==='site'?'Drawing site':'Drawing building');
    return state();
  }

  function add(point){
    if(mode===null)return undefined;
    const added=[Number(point[0]),Number(point[1])];
    points.push(added);publishDraft();return [...added];
  }

  function undo(){
    if(mode===null||!points.length)return undefined;
    const removed=points.pop();publishDraft();return [...removed];
  }

  function cancel(){
    const cancelledMode=mode,wasActive=cancelledMode!==null;
    clear();onCancel(cancelledMode);onStatus('Idle');return wasActive;
  }

  function finish(){
    if(mode===null)return {ok:false,message:'No drawing is active.'};
    if(mode==='marker'){
      cancel();
      return {ok:false,message:'Boundary drawing is not active.'};
    }
    const distinct=new Set(points.map(point=>point.join(','))).size;
    if(points.length<3||distinct<3){
      const result={ok:false,message:TOO_FEW_POINTS};onStatus(result.message);return result;
    }
    const ring=closeRing(copyPoints(points));
    if(!validBoundary(ring)){
      const result={ok:false,message:INVALID_BOUNDARY};onStatus(result.message);return result;
    }
    const completedMode=mode,completedRing=copyPoints(ring);
    clear();onCommit(completedMode,copyPoints(completedRing));
    onStatus(completedMode==='site'?'Site boundary completed.':'Building boundary completed.');
    return {ok:true,mode:completedMode,ring:completedRing};
  }

  function handleKey(event){
    if(mode===null||event.defaultPrevented||event.isComposing||event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||isTextEntry(event.target))return undefined;
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
