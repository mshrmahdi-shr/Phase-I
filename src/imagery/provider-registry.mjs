import {MIN_ACQUISITION_YEAR} from '../acquisition-year.mjs';

export const IMAGERY_POLICIES=Object.freeze(['exportable','link-only','unknown']);
export {MIN_ACQUISITION_YEAR};

const PROVIDER_FIELDS=['allowedOrigins','allowedRoots','attribution','coverage','covers','id','label','licenseUrl','organization','policy','priority','search'];
const RESULT_FIELDS=['attribution','coverage','export','id','licenseUrl','policy','preview','providerId','resolutionMeters','sourceUrl','title','year'];
const COVERAGE_FIELDS=['east','north','south','west'];
const PREVIEW_FIELDS=['kind','layer','tileTemplate','url'];
const EXPORT_FIELDS=['kind','layer','maxHeight','maxWidth','url'];
const IDENTITY=/^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
const PROVIDER_ID=/^[a-z][a-z0-9-]{0,63}$/;
const KIND=/^[a-z][a-z0-9-]{0,63}$/;
const POLICY_RANK=new Map([['unknown',0],['link-only',1],['exportable',2]]);
const MAX_URL_LENGTH=8_192;
const MAX_PATH_DECODE_PASSES=64;

function fail(message){throw new TypeError(message);}
function isObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exactFields(value,allowed,label,required=allowed){
  if(!isObject(value))fail(`${label} must be an object`);
  let prototype,keys;
  try{prototype=Object.getPrototypeOf(value);keys=Reflect.ownKeys(value);}catch{fail(`${label} must be an inspectable plain record`);}
  if(prototype!==Object.prototype&&prototype!==null)fail(`${label} must be a plain record without a custom prototype`);
  const symbols=keys.filter(key=>typeof key==='symbol');
  if(symbols.length)fail(`${label} must not contain symbol fields`);
  const stringKeys=keys.filter(key=>typeof key==='string');
  const unexpected=stringKeys.filter(key=>!allowed.includes(key));
  const missing=required.filter(key=>!stringKeys.includes(key));
  if(unexpected.length||missing.length)fail(`${label} must have exact fields; unexpected: ${unexpected.join(', ')||'none'}; missing: ${missing.join(', ')||'none'}`);
  const snapshot=Object.create(null);
  for(const key of stringKeys){
    let descriptor;
    try{descriptor=Object.getOwnPropertyDescriptor(value,key);}catch{fail(`${label}.${key} must be an inspectable data property`);}
    if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)fail(`${label}.${key} must be an enumerable data property, not an accessor or hidden field`);
    snapshot[key]=descriptor.value;
  }
  return snapshot;
}
function text(value,label){if(typeof value!=='string'||!value.trim())fail(`${label} must be a non-empty string`);}
function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value))fail(`${label} must be a finite number`);}

export function validateAcquisitionYear(year,label='Acquisition year'){
  const maximum=new Date().getUTCFullYear();
  if(typeof year!=='number'||!Number.isInteger(year)||year<MIN_ACQUISITION_YEAR||year>maximum){
    fail(`${label} must be a four-digit integer from ${MIN_ACQUISITION_YEAR} through ${maximum}`);
  }
  return year;
}

export function validateCoverage(coverage,label='Coverage'){
  exactFields(coverage,COVERAGE_FIELDS,label);
  for(const field of COVERAGE_FIELDS)finite(coverage[field],`${label}.${field}`);
  if(coverage.west < -180||coverage.east > 180||coverage.south < -90||coverage.north > 90||
    coverage.west>=coverage.east||coverage.south>=coverage.north)fail(`${label} is not a valid longitude/latitude coverage`);
  return coverage;
}

function inspectDecodedPath(path,label){
  if(/[\\\u0000-\u001f\u007f]/.test(path))fail(`${label} path contains a backslash or control character`);
  if(/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path))fail(`${label} path contains an encoded separator or control character`);
  if(path.split('/').some(segment=>segment==='.'||segment==='..'))fail(`${label} path contains traversal`);
}

function validateRawPath(url,label){
  if(url.length>MAX_URL_LENGTH)fail(`${label} exceeds the ${MAX_URL_LENGTH}-character URL length limit`);
  if(url.startsWith('//'))fail(`${label} must be an absolute https URL, not protocol-relative`);
  const scheme=url.indexOf('://');
  const authorityEnd=scheme<0?-1:url.indexOf('/',scheme+3);
  const raw=authorityEnd<0?'':url.slice(authorityEnd).split(/[?#]/,1)[0];
  let path=raw;
  for(let pass=0;pass<MAX_PATH_DECODE_PASSES;pass++){
    inspectDecodedPath(path,label);
    let decoded;
    try{decoded=decodeURIComponent(path);}catch{fail(`${label} path has invalid encoding`);}
    if(decoded===path)return;
    path=decoded;
  }
  inspectDecodedPath(path,label);
  fail(`${label} path encoding did not stabilize within ${MAX_PATH_DECODE_PASSES} passes`);
}

function parsedHttpsUrl(value,label,{template=false}={}){
  text(value,label);
  validateRawPath(value,label);
  let candidate=value;
  if(template){
    candidate=candidate.replace(/\{(?:z|x|y|s|level|row|col)\}/gi,'0');
    if(/[{}]/.test(candidate))fail(`${label} has an unsupported template placeholder`);
  }
  let url;
  try{url=new URL(candidate);}catch{fail(`${label} must be an absolute https URL`);}
  if(url.protocol!=='https:')fail(`${label} must use https`);
  if(url.username||url.password)fail(`${label} must not contain credentials`);
  if(url.hash)fail(`${label} must not contain a fragment`);
  return url;
}

function normalizedOrigin(value,label){
  const url=parsedHttpsUrl(value,label);
  if(url.pathname!=='/'||url.search)fail(`${label} must contain only an https origin`);
  return url.origin;
}

function normalizedRoot(value,label){
  const url=parsedHttpsUrl(value,label);
  if(url.search)fail(`${label} must not contain a query`);
  if(!url.pathname.endsWith('/'))fail(`${label} must be a directory URL ending in /`);
  return url.href;
}

export function validateProviderUrl(value,provider,{label='URL',template=false}={}){
  const url=parsedHttpsUrl(value,label,{template});
  if(!provider)return value;
  if(!provider.allowedOrigins.includes(url.origin))fail(`${label} origin is not an official provider origin`);
  const insideRoot=provider.allowedRoots.some(root=>{
    const allowed=new URL(root);
    return allowed.origin===url.origin&&url.pathname.startsWith(allowed.pathname);
  });
  if(!insideRoot)fail(`${label} is outside the official provider roots`);
  return value;
}

export function validateImageryProvider(provider){
  exactFields(provider,PROVIDER_FIELDS,'Imagery provider');
  if(typeof provider.id!=='string'||!PROVIDER_ID.test(provider.id))fail('Provider id must be a lowercase stable identifier');
  text(provider.label,'Provider label');text(provider.organization,'Provider organization');text(provider.attribution,'Provider attribution');
  if(typeof provider.priority!=='number'||!Number.isInteger(provider.priority)||provider.priority<0)fail('Provider priority must be a non-negative integer');
  validateCoverage(provider.coverage,'Provider coverage');
  if(typeof provider.covers!=='function')fail('Provider covers must be a function');
  if(typeof provider.search!=='function')fail('Provider search must be a function');
  if(!IMAGERY_POLICIES.includes(provider.policy))fail('Provider policy must be exportable, link-only, or unknown');
  if(!Array.isArray(provider.allowedOrigins)||provider.allowedOrigins.length===0)fail('Provider allowedOrigins must list official origins');
  if(!Array.isArray(provider.allowedRoots)||provider.allowedRoots.length===0)fail('Provider allowedRoots must list official roots');
  const origins=provider.allowedOrigins.map((value,index)=>normalizedOrigin(value,`Provider allowedOrigins[${index}]`));
  if(new Set(origins).size!==origins.length||origins.some((origin,index)=>origin!==provider.allowedOrigins[index]))fail('Provider allowedOrigins must be unique normalized origins');
  const roots=provider.allowedRoots.map((value,index)=>normalizedRoot(value,`Provider allowedRoots[${index}]`));
  if(new Set(roots).size!==roots.length||roots.some((root,index)=>root!==provider.allowedRoots[index]))fail('Provider allowedRoots must be unique normalized official roots');
  if(roots.some(root=>!origins.includes(new URL(root).origin)))fail('Every provider root must belong to an allowed origin');
  validateProviderUrl(provider.licenseUrl,provider,{label:'Provider license URL'});
  return provider;
}

export function defineImageryProvider(value){
  if(!isObject(value))fail('Imagery provider must be an object');
  validateImageryProvider(value);
  const provider={
    ...value,
    coverage:isObject(value.coverage)?Object.freeze({...value.coverage}):value.coverage,
    allowedOrigins:Array.isArray(value.allowedOrigins)?Object.freeze([...value.allowedOrigins]):value.allowedOrigins,
    allowedRoots:Array.isArray(value.allowedRoots)?Object.freeze([...value.allowedRoots]):value.allowedRoots
  };
  validateImageryProvider(provider);
  return Object.freeze(provider);
}

function validateLayer(layer,label){
  if(layer===undefined)return;
  if((typeof layer==='string'&&layer.trim())||(typeof layer==='number'&&Number.isInteger(layer)&&layer>=0))return;
  fail(`${label} layer must be a non-empty string or non-negative integer`);
}

function validatePreview(preview,provider){
  exactFields(preview,PREVIEW_FIELDS,'Imagery preview',['kind','url']);
  if(typeof preview.kind!=='string'||!KIND.test(preview.kind))fail('Imagery preview kind is invalid');
  validateProviderUrl(preview.url,provider,{label:'Imagery preview URL'});
  validateLayer(preview.layer,'Imagery preview');
  if(Object.hasOwn(preview,'tileTemplate'))validateProviderUrl(preview.tileTemplate,provider,{label:'Imagery tile template URL',template:true});
}

function validateExport(descriptor,provider){
  exactFields(descriptor,EXPORT_FIELDS,'Imagery export',['kind','url','maxWidth','maxHeight']);
  if(typeof descriptor.kind!=='string'||!KIND.test(descriptor.kind))fail('Imagery export kind is invalid');
  validateProviderUrl(descriptor.url,provider,{label:'Imagery export URL'});
  validateLayer(descriptor.layer,'Imagery export');
  for(const field of ['maxWidth','maxHeight'])if(typeof descriptor[field]!=='number'||!Number.isInteger(descriptor[field])||descriptor[field]<=0)fail(`Imagery export ${field} must be a positive integer`);
}

export function getImageryResultProviderId(value){
  return exactFields(value,RESULT_FIELDS,'Imagery result').providerId;
}

export function validateImageryResult(value,provider){
  if(!provider)fail('Imagery result validation requires registered provider context');
  validateImageryProvider(provider);
  exactFields(value,RESULT_FIELDS,'Imagery result');
  if(typeof value.providerId!=='string'||!PROVIDER_ID.test(value.providerId))fail('Imagery result providerId is invalid');
  if(value.providerId!==provider.id)fail('Imagery result providerId does not match its provider');
  const prefix=`${value.providerId}:`;
  if(typeof value.id!=='string'||!value.id.startsWith(prefix)||!IDENTITY.test(value.id.slice(prefix.length)))fail('Imagery result id must contain its provider namespace and a stable source identity');
  text(value.title,'Imagery result title');text(value.attribution,'Imagery result attribution');
  validateAcquisitionYear(value.year);
  if(value.resolutionMeters!==null&&(typeof value.resolutionMeters!=='number'||!Number.isFinite(value.resolutionMeters)||value.resolutionMeters<=0))fail('Imagery result resolutionMeters must be positive or null');
  validateCoverage(value.coverage,'Imagery result coverage');
  if(!IMAGERY_POLICIES.includes(value.policy))fail('Imagery result policy must be exportable, link-only, or unknown');
  if(POLICY_RANK.get(value.policy)>POLICY_RANK.get(provider.policy))fail('Imagery result policy exceeds the provider legal policy');
  validatePreview(value.preview,provider);
  if(value.policy==='exportable'){
    if(value.export===null)fail('Exportable imagery result requires an export descriptor');
    validateExport(value.export,provider);
  }else if(value.export!==null)fail('Link-only or unknown imagery result must not contain an export descriptor');
  validateProviderUrl(value.sourceUrl,provider,{label:'Imagery source URL'});
  validateProviderUrl(value.licenseUrl,provider,{label:'Imagery license URL'});
  if(value.licenseUrl!==provider.licenseUrl)fail('Imagery result license URL must match the registered provider license');
  return value;
}

export function normalizeProviderResult(provider,value){
  validateImageryProvider(provider);
  if(!isObject(value))fail('Imagery result must be an object');
  const fields=exactFields(value,RESULT_FIELDS,'Imagery result');
  if(fields.providerId!==provider.id)fail('Imagery result providerId does not match its provider');
  let identity=fields.id;
  const prefix=`${provider.id}:`;
  if(typeof identity==='string'&&identity.startsWith(prefix))identity=identity.slice(prefix.length);
  if(typeof identity!=='string'||!IDENTITY.test(identity))fail('Imagery result source identity is invalid or has an ambiguous namespace');
  const coverage=exactFields(fields.coverage,COVERAGE_FIELDS,'Imagery result coverage');
  const preview=exactFields(fields.preview,PREVIEW_FIELDS,'Imagery preview',['kind','url']);
  const exportDescriptor=fields.export===null?null:exactFields(fields.export,EXPORT_FIELDS,'Imagery export',['kind','url','maxWidth','maxHeight']);
  const normalized={
    id:prefix+identity,providerId:fields.providerId,title:fields.title,year:fields.year,
    resolutionMeters:fields.resolutionMeters,
    coverage:{west:coverage.west,south:coverage.south,east:coverage.east,north:coverage.north},
    preview:{kind:preview.kind,url:preview.url,...(Object.hasOwn(preview,'layer')?{layer:preview.layer}:{}),
      ...(Object.hasOwn(preview,'tileTemplate')?{tileTemplate:preview.tileTemplate}:{})},
    export:exportDescriptor===null?null:{kind:exportDescriptor.kind,url:exportDescriptor.url,
      ...(Object.hasOwn(exportDescriptor,'layer')?{layer:exportDescriptor.layer}:{}),
      maxWidth:exportDescriptor.maxWidth,maxHeight:exportDescriptor.maxHeight},
    policy:fields.policy,sourceUrl:fields.sourceUrl,licenseUrl:fields.licenseUrl,attribution:fields.attribution
  };
  validateImageryResult(normalized,provider);
  return normalized;
}
