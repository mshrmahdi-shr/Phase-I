function copyBoundary(value){return Array.isArray(value)?value.map(point=>Array.isArray(point)?[Number(point[0]),Number(point[1])]:[0,0]):[];}

function snapshot(value={}){
  return {siteBoundary:copyBoundary(value.siteBoundary),buildingBoundary:copyBoundary(value.buildingBoundary)};
}

function equal(left,right){return JSON.stringify(left)===JSON.stringify(right);}

export function createGeometryHistory(){
  const past=[],future=[];
  return {
    record(before,after){
      const start=snapshot(before),end=snapshot(after);
      if(equal(start,end))return false;
      past.push({before:start,after:end});
      future.length=0;
      return true;
    },
    undo(){
      const action=past.pop();
      if(!action)return null;
      future.push(action);
      return snapshot(action.before);
    },
    redo(){
      const action=future.pop();
      if(!action)return null;
      past.push(action);
      return snapshot(action.after);
    },
    clear(){past.length=0;future.length=0;},
    canUndo(){return past.length>0;},
    canRedo(){return future.length>0;}
  };
}
