import {validLocation,validBoundary} from './core.mjs';
function hasText(v){return typeof v==='string'&&v.trim().length>0}
function validDate(v){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d=new Date(v+'T00:00:00Z');
  return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;
}

export function validatePrintRequirements({project={},figureCode='A',geologyLoaded=false,geologySiteUnit=null}={}){
  const errors=[];
  if(!hasText(project.name))errors.push({code:'project-name',message:'Enter a project name.'});
  if(!hasText(project.projectNo))errors.push({code:'project-number',message:'Enter the project number.'});
  if(!validDate(project.date))errors.push({code:'project-date',message:'Select a valid project date.'});
  if(!hasText(project.address))errors.push({code:'address',message:'Enter the property address.'});
  if(!validLocation(project.location))errors.push({code:'location',message:'Locate the property on the map using Find or Set SITE.'});
  if(!['A','B','C','D','E'].includes(figureCode))errors.push({code:'figure',message:'Select a valid figure before printing.'});

  if(figureCode==='B'&&!validBoundary(project.siteBoundary)){
    errors.push({code:'site-boundary',message:'Draw and finish the Site Boundary before printing Figure B.'});
  }

  if(figureCode==='D'){
    if(!geologyLoaded)errors.push({code:'surficial-layer',message:'Load the MRD128 Surficial Geology layer for Figure D.'});
    if(!hasText(geologySiteUnit))errors.push({code:'surficial-unit',message:'A Surficial Geology unit must be detected at the SITE location.'});
  }

  if(figureCode==='E'){
    if(!geologyLoaded)errors.push({code:'bedrock-layer',message:'Load or import the Bedrock Geology layer for Figure E.'});
    if(!hasText(geologySiteUnit))errors.push({code:'bedrock-unit',message:'A Bedrock Geology unit must be detected at the SITE location.'});
  }

  return errors;
}
