function hasText(v){return typeof v==='string'&&v.trim().length>0}
function hasLocation(v){return v&&Number.isFinite(Number(v.lat))&&Number.isFinite(Number(v.lng))}
function hasBoundary(v){return Array.isArray(v)&&v.length>=4}

export function validatePrintRequirements({project={},figureCode='A',geologyLoaded=false,geologySiteUnit=null}={}){
  const errors=[];
  if(!hasText(project.name))errors.push({code:'project-name',message:'Enter a project name.'});
  if(!hasText(project.projectNo))errors.push({code:'project-number',message:'Enter the project number.'});
  if(!hasText(project.date))errors.push({code:'project-date',message:'Select the project date.'});
  if(!hasText(project.address))errors.push({code:'address',message:'Enter the property address.'});
  if(!hasLocation(project.location))errors.push({code:'location',message:'Locate the property on the map using Find or Set SITE.'});

  if(figureCode==='B'&&!hasBoundary(project.siteBoundary)){
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
