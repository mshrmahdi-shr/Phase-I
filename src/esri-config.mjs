const STORAGE_KEY='phase-i-esri-api-key-v1';
const MAX_KEY_LENGTH=512;

function normalized(value){
  if(typeof value!=='string')throw new TypeError('Esri API key must be text.');
  const key=value.trim();
  if(key.length>MAX_KEY_LENGTH||/[\u0000-\u001f\u007f]/.test(key))throw new TypeError('Esri API key is invalid.');
  return key;
}

export function createEsriKeyStore(storage=globalThis.localStorage){
  return Object.freeze({
    load(){try{const value=storage?.getItem?.(STORAGE_KEY);return value?normalized(value):null;}catch{return null;}},
    save(value){const key=normalized(value);try{if(key)storage?.setItem?.(STORAGE_KEY,key);else storage?.removeItem?.(STORAGE_KEY);}catch{throw new Error('Esri API key could not be saved in this browser.');}return key||null;},
    clear(){try{storage?.removeItem?.(STORAGE_KEY);}catch{}}
  });
}

function isEsriHost(hostname){return hostname==='arcgis.com'||hostname.endsWith('.arcgis.com')||hostname==='arcgisonline.com'||hostname.endsWith('.arcgisonline.com');}

export function withEsriApiKey(value,key){
  const templateParts=String(value).split(/(\{[a-z]+\})/i),parseable=templateParts.map((part,index)=>index%2?'x':part).join('');
  let url;try{url=new URL(parseable);}catch{throw new TypeError('Esri URL is invalid.');}
  if(url.protocol!=='https:')throw new TypeError('Esri URL must use HTTPS.');
  const normalizedKey=typeof key==='string'?key.trim():'';
  if(!normalizedKey||!isEsriHost(url.hostname)||url.searchParams.has('token'))return String(value);
  return `${String(value)}${String(value).includes('?')?'&':'?'}token=${encodeURIComponent(normalizedKey)}`;
}

export {STORAGE_KEY as ESRI_API_KEY_STORAGE};
