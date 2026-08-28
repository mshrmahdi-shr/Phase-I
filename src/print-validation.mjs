import {validLocation,validBoundary} from './core.mjs';
import {validateCompanyProfile} from './company-profile.mjs';
function hasText(v){return typeof v==='string'&&v.trim().length>0}
function validDate(v){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d=new Date(v+'T00:00:00Z');
  return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;
}

export function validatePrintRequirements({project={},companyProfile={},figureCode='A',geologyLoaded=false,geologySiteUnit=null}={}){
  const errors=[];
  if(!hasText(project.name))errors.push({code:'project-name',message:'Enter a project name.'});
  if(!hasText(project.projectNo))errors.push({code:'project-number',message:'Enter the project number.'});
  if(!validDate(project.date))errors.push({code:'project-date',message:'Select a valid project date.'});
  if(!hasText(project.address))errors.push({code:'address',message:'Enter the property address.'});
  if(!validLocation(project.location))errors.push({code:'location',message:'Locate the property on the map using Find or Set SITE.'});
  if(!['A','B','C','D','E'].includes(figureCode))errors.push({code:'figure',message:'Select a valid figure before printing.'});

  const companyCodes={companyName:'company-name',address:'company-address',phone:'company-phone',email:'company-email',website:'company-website',logoAssetId:'company-logo',logoPlacement:'company-logo-placement'};
  try{
    for(const error of validateCompanyProfile(companyProfile))errors.push({code:companyCodes[error.field]||'company-profile',message:error.message});
    if(hasText(companyProfile.companyName)&&companyProfile.companyName.length>160)errors.push({code:'company-name-fit',message:'Shorten the company name so it fits the output title block.'});
    const contact=[companyProfile.address,companyProfile.phone,companyProfile.email,companyProfile.website].filter(value=>typeof value==='string').join(' | ');
    if(contact.length>500||[companyProfile.address,companyProfile.phone,companyProfile.email,companyProfile.website].some(value=>typeof value==='string'&&value.length>220)){
      errors.push({code:'company-contact-fit',message:'Shorten the company contact details so they fit the output title block.'});
    }
  }catch(error){
    errors.push({code:'company-profile-invalid',message:`Company Profile data is invalid or from an older saved version. Open Company Profile, upload the logo again, save it, then apply the template to this project. (${error.message})`});
  }

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

