const PROFILE_SCHEMA_VERSION=1;
const TEXT_FIELDS=['companyName','address','phone','email','website','preparedBy','reviewedBy'];
const LOGO_MIMES=new Set(['image/png','image/jpeg']);
const LOGO_ALIGNS=new Set(['left','center','right']);

function profileId(){
  return globalThis.crypto?.randomUUID?.() || `company-${Date.now()}`;
}

function isPlainObject(value){
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function requirePlainObject(value,label){
  if(!isPlainObject(value)) throw new Error(`${label} must be a plain object.`);
  return value;
}

function text(value,field,defaultValue=''){
  if(value===undefined) return defaultValue;
  if(typeof value!=='string') throw new Error(`${field} must contain text.`);
  return value;
}

function nonNegativeDimension(value,field){
  if(value===undefined) return 0;
  if(!Number.isSafeInteger(value)||value<0) throw new Error(`Logo dimensions must use non-negative whole numbers (${field}).`);
  return value;
}

function logoPlacement(value){
  if(value===undefined) return {align:'center',scale:1};
  requirePlainObject(value,'Logo placement');
  if(!LOGO_ALIGNS.has(value.align)) throw new Error('Logo alignment must be left, center, or right.');
  if(!Number.isFinite(value.scale)||value.scale<=0) throw new Error('Logo scale must be a positive number.');
  return {align:value.align,scale:value.scale};
}

function timestamp(value){
  if(value===undefined) return new Date().toISOString();
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||Number.isNaN(Date.parse(value))) throw new Error('updatedAt must be an ISO timestamp.');
  return value;
}

export function emptyCompanyProfile(){
  return {
    schemaVersion:PROFILE_SCHEMA_VERSION,
    id:profileId(),
    companyName:'',address:'',phone:'',email:'',website:'',
    preparedBy:'',reviewedBy:'',
    logoAssetId:'',logoMime:'',logoWidth:0,logoHeight:0,
    logoPlacement:{align:'center',scale:1},
    updatedAt:new Date().toISOString()
  };
}

export function normalizeCompanyProfile(value){
  requirePlainObject(value,'Company profile');
  if(value.schemaVersion!==undefined&&value.schemaVersion!==PROFILE_SCHEMA_VERSION) throw new Error('Unsupported company profile schema version.');
  const profile=emptyCompanyProfile();
  profile.id=text(value.id,'id',profile.id);
  profile.updatedAt=timestamp(value.updatedAt);
  for(const field of TEXT_FIELDS) profile[field]=text(value[field],field);
  profile.logoAssetId=text(value.logoAssetId,'logoAssetId');
  profile.logoMime=text(value.logoMime,'logoMime');
  if(profile.logoMime&&!LOGO_MIMES.has(profile.logoMime)) throw new Error('Logo must be a PNG or JPEG image.');
  profile.logoWidth=nonNegativeDimension(value.logoWidth,'logoWidth');
  profile.logoHeight=nonNegativeDimension(value.logoHeight,'logoHeight');
  profile.logoPlacement=logoPlacement(value.logoPlacement);

  const hasLogo=Boolean(profile.logoAssetId||profile.logoMime||profile.logoWidth||profile.logoHeight);
  if(hasLogo&&(!profile.logoAssetId||!profile.logoMime||!profile.logoWidth||!profile.logoHeight)){
    throw new Error('Logo metadata must include an asset ID, PNG or JPEG MIME type, and positive dimensions.');
  }
  return profile;
}

export function validateCompanyProfile(value,{requireLogo=true}={}){
  const profile=normalizeCompanyProfile(value);
  const errors=[];
  for(const field of ['companyName','address','phone','email','website']){
    if(!profile[field].trim()) errors.push({field,message:`Enter the company ${field.replace(/[A-Z]/g,letter=>` ${letter.toLowerCase()}`)}.`});
  }
  if(requireLogo&&!profile.logoAssetId) errors.push({field:'logoAssetId',message:'Upload a decoded PNG or JPEG logo.'});
  return errors;
}

export function snapshotCompanyProfile(value){
  return structuredClone(normalizeCompanyProfile(value));
}
