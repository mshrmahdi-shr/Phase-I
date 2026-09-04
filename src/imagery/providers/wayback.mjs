import {defineImageryProvider} from '../provider-registry.mjs';

const CONFIG_URL='https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
const WAYBACK_APP_URL='https://livingatlas.arcgis.com/wayback/';
const LICENSE_URL='https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9';
const COVERAGE=Object.freeze({west:-180,south:-85,east:180,north:85});
const ORIGINS=Object.freeze(['https://s3-us-west-2.amazonaws.com','https://wayback.maptiles.arcgis.com','https://metadata.maptiles.arcgis.com','https://livingatlas.arcgis.com','https://www.arcgis.com']);
const ROOTS=Object.freeze(['https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/','https://wayback.maptiles.arcgis.com/arcgis/rest/services/','https://metadata.maptiles.arcgis.com/arcgis/rest/services/','https://livingatlas.arcgis.com/wayback/','https://www.arcgis.com/home/']);
function covers(point){return point.lat>=COVERAGE.south&&point.lat<=COVERAGE.north&&point.lng>=COVERAGE.west&&point.lng<=COVERAGE.east;}
export async function searchWayback({location,fetchImpl=globalThis.fetch,signal}={}){
  if(!covers(location))return [];
  const response=await fetchImpl(CONFIG_URL,{signal}); if(!response?.ok)throw new Error(`Wayback configuration request failed (${response?.status??'unknown'})`);
  const data=await response.json(); const entries=Array.isArray(data)?data:Object.values(data||{});
  return entries.map(item=>{const match=/((?:19|20)\d{2})-(\d{2})-(\d{2})/.exec(String(item?.releaseDateLabel||item?.itemTitle||''));if(!match)return null;const year=Number(match[1]);const release=Number(item.releaseNum);if(!Number.isSafeInteger(release)||typeof item.itemURL!=='string')return null;return {id:`wayback:${release}`,providerId:'esri-wayback',title:`Esri World Imagery Wayback ${item.releaseDateLabel}`,year,resolutionMeters:null,coverage:COVERAGE,preview:{kind:'wayback-timeline',url:WAYBACK_APP_URL},export:null,policy:'link-only',sourceUrl:WAYBACK_APP_URL,licenseUrl:LICENSE_URL,attribution:'Esri World Imagery Wayback'};}).filter(Boolean).sort((a,b)=>a.year-b.year||a.id.localeCompare(b.id,'en'));
}
export const ESRI_WAYBACK_PROVIDER=defineImageryProvider({id:'esri-wayback',label:'Esri World Imagery Wayback',organization:'Esri',priority:35,coverage:COVERAGE,licenseUrl:LICENSE_URL,attribution:'Esri World Imagery Wayback',policy:'link-only',allowedOrigins:ORIGINS,allowedRoots:ROOTS,covers,search:searchWayback});
