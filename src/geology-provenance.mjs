const LIMITS=Object.freeze({name:200,credits:500,sourceUrl:2048,license:1000,redistributionEvidence:1000});
const STATUSES=Object.freeze(['unknown','unverified','verified']);

function text(value,field,{required=true,maximum=500}={}){
  if(typeof value!=='string')throw new Error(`Custom geology ${field} must be text.`);const result=value.trim();
  if(required&&!result)throw new Error(`Custom geology ${field} is required.`);if(result.length>maximum||/[\u0000-\u001f\u007f]/.test(result))throw new Error(`Custom geology ${field} must be bounded safe text.`);return result;
}
function sourceUrl(value){if(value===null||value==='')return null;const result=text(value,'source URL',{maximum:LIMITS.sourceUrl});let url;try{url=new URL(result);}catch{throw new Error('Custom geology source URL must be a valid public HTTP(S) URL.');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Custom geology source URL must be a valid public HTTP(S) URL.');return url.href;}
function year(value){if(value===null||value==='')return null;if(!Number.isSafeInteger(value)||value<1800||value>new Date().getUTCFullYear()+1)throw new Error('Custom geology acquisition/publication year must be a four-digit year from 1800 through next year.');return value;}

/** Safe migration/edit draft. Missing legal evidence remains visibly blank and cannot become CAD-ready. */
export function customGeologySourceDraft(value={}, {filename=''}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Custom geology provenance must be an object.');
  const optional=(field,maximum)=>value[field]==null?'':text(value[field],field,{required:false,maximum});
  const acquisitionYear=value.acquisitionYear==null?null:year(value.acquisitionYear),status=STATUSES.includes(value.acquisitionYearVerification)?value.acquisitionYearVerification:'unknown';
  return {id:'custom',name:optional('name',LIMITS.name)||`Custom import: ${text(filename,'file name',{maximum:160})}`,credits:optional('credits',LIMITS.credits),sourceUrl:value.sourceUrl==null||value.sourceUrl===''?null:sourceUrl(value.sourceUrl),license:optional('license',LIMITS.license),redistributionEvidence:optional('redistributionEvidence',LIMITS.redistributionEvidence),acquisitionYear,acquisitionYearVerification:status,permissionConfirmed:value.permissionConfirmed===true};
}

export function normalizeCustomGeologySource(value){
  const draft=customGeologySourceDraft(value);draft.name=text(draft.name,'source name',{maximum:LIMITS.name});draft.credits=text(draft.credits,'source/organization credits',{maximum:LIMITS.credits});draft.license=text(draft.license,'licence or terms',{maximum:LIMITS.license});draft.redistributionEvidence=text(draft.redistributionEvidence,'redistribution/use permission evidence',{maximum:LIMITS.redistributionEvidence});
  if(draft.acquisitionYear===null&&draft.acquisitionYearVerification!=='unknown')throw new Error('Unknown custom geology year must use unknown verification.');
  if(draft.acquisitionYear!==null&&!['verified','unverified'].includes(draft.acquisitionYearVerification))throw new Error('A known custom geology year needs verified or unverified verification status.');
  if(!draft.permissionConfirmed)throw new Error('Confirm that you have rights or permission to use and redistribute this custom geology in the project outputs.');return Object.freeze(draft);
}
