import {defineImageryProvider} from '../provider-registry.mjs';
import {arcGisExtentToCoverage,arcGisServiceExport,fetchArcGisJson} from '../arcgis-client.mjs';

const ROOT='https://gis.toronto.ca/arcgis/rest/services/basemap/';
const ORIGIN='https://gis.toronto.ca';
const LICENSE_URL='https://open.toronto.ca/open-data-licence/';
const COVERAGE=Object.freeze({west:-79.75,south:43.55,east:-78.95,north:44.0});
const NAME=/^basemap\/(cot_historic_aerial_(\d{4})|cot_ortho_(\d{4})_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)$/;
const COPYRIGHT_ALLOWLIST=new Set(['City of Toronto']);

function contains(coverage,point){return point.lat>=coverage.south&&point.lat<=coverage.north&&point.lng>=coverage.west&&point.lng<=coverage.east;}
function stableIdentity(name){return name.slice('basemap/'.length).toLowerCase().replaceAll('_','-');}
function resolution(name){const match=/_([0-9]+)cm$/.exec(name);return match?Number(match[1])/100:null;}
function metadataOptions(signal,fetchImpl){return {signal,fetchImpl,allowedOrigins:[ORIGIN],allowedRoots:[ROOT]};}

async function search({location,signal,fetchImpl=globalThis.fetch}){
  const options=metadataOptions(signal,fetchImpl);
  const directory=await fetchArcGisJson(ROOT,options);
  if(!Array.isArray(directory.services))throw new TypeError('Toronto ArcGIS directory services are missing');
  const entries=[];
  for(const service of directory.services){
    if(!service||service.type!=='MapServer'||typeof service.name!=='string')continue;
    const match=NAME.exec(service.name);
    if(!match)continue;
    entries.push({service,year:Number(match[2]??match[3])});
  }
  const values=await Promise.all(entries.map(async({service,year})=>{
    const leaf=service.name.slice('basemap/'.length);
    const serviceUrl=new URL(`${leaf}/MapServer`,ROOT).href;
    const metadata=await fetchArcGisJson(serviceUrl,options);
    const coverage=arcGisExtentToCoverage(metadata.fullExtent);
    if(!contains(coverage,location))return null;
    const operation=arcGisServiceExport(metadata);
    const verified=COPYRIGHT_ALLOWLIST.has(typeof metadata.copyrightText==='string'?metadata.copyrightText.trim():'');
    const policy=!verified?'unknown':operation?'exportable':'link-only';
    return {
      id:stableIdentity(service.name),providerId:'toronto',title:`City of Toronto aerial imagery ${year}`,year,
      resolutionMeters:resolution(service.name),coverage,
      preview:policy==='exportable'
        ?{kind:'arcgis-map-service',url:serviceUrl,tileTemplate:`${serviceUrl}/tile/{z}/{y}/{x}`}
        :{kind:'official-link',url:serviceUrl},
      export:policy==='exportable'?{kind:'arcgis-export',url:`${serviceUrl}/export`,maxWidth:operation.maxWidth,maxHeight:operation.maxHeight}:null,
      policy,sourceUrl:serviceUrl,licenseUrl:LICENSE_URL,attribution:'City of Toronto'
    };
  }));
  return values.filter(Boolean).sort((left,right)=>left.year-right.year||left.id.localeCompare(right.id,'en'));
}

export const TORONTO_IMAGERY_PROVIDER=defineImageryProvider({
  id:'toronto',label:'Toronto historical aerial imagery',organization:'City of Toronto',priority:20,
  coverage:COVERAGE,licenseUrl:LICENSE_URL,attribution:'City of Toronto',policy:'exportable',
  allowedOrigins:Object.freeze([ORIGIN,'https://open.toronto.ca']),
  allowedRoots:Object.freeze([ROOT,LICENSE_URL]),covers:point=>contains(COVERAGE,point),search
});
