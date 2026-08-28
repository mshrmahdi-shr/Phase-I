import {defineImageryProvider} from '../provider-registry.mjs';
import {arcGisExtentToCoverage,fetchArcGisJson} from '../arcgis-client.mjs';

const ROOT='https://maps.ottawa.ca/arcgis/rest/services/';
const ORIGIN='https://maps.ottawa.ca';
const LICENSE_URL='https://ottawa.ca/en/city-hall/open-transparent-and-accountable-government/open-data/open-data-licence-version-20';
const LICENSE_ROOT='https://ottawa.ca/en/city-hall/open-transparent-and-accountable-government/open-data/';
const COVERAGE=Object.freeze({west:-76.45,south:44.85,east:-75.0,north:45.65});
const NAME=/^Basemap_Imagery_(\d{4})$/;

function contains(coverage,point){return point.lat>=coverage.south&&point.lat<=coverage.north&&point.lng>=coverage.west&&point.lng<=coverage.east;}

async function search({location,signal,fetchImpl=globalThis.fetch}){
  const options={signal,fetchImpl,allowedOrigins:[ORIGIN],allowedRoots:[ROOT]};
  const directory=await fetchArcGisJson(ROOT,options);
  if(!Array.isArray(directory.services))throw new TypeError('Ottawa ArcGIS directory services are missing');
  const entries=directory.services.filter(service=>service?.type==='MapServer'&&typeof service.name==='string'&&NAME.test(service.name));
  const values=await Promise.all(entries.map(async service=>{
    const year=Number(NAME.exec(service.name)[1]);
    const serviceUrl=new URL(`${service.name}/MapServer`,ROOT).href;
    const metadata=await fetchArcGisJson(serviceUrl,options);
    const coverage=arcGisExtentToCoverage(metadata.fullExtent);
    if(!contains(coverage,location))return null;
    return {
      id:service.name.toLowerCase().replaceAll('_','-'),providerId:'ottawa',title:`City of Ottawa aerial imagery ${year}`,year,
      resolutionMeters:null,coverage,
      preview:{kind:'official-link',url:serviceUrl},
      export:null,policy:'unknown',sourceUrl:serviceUrl,licenseUrl:LICENSE_URL,attribution:'City of Ottawa'
    };
  }));
  return values.filter(Boolean).sort((left,right)=>left.year-right.year||left.id.localeCompare(right.id,'en'));
}

export const OTTAWA_IMAGERY_PROVIDER=defineImageryProvider({
  id:'ottawa',label:'Ottawa historical aerial imagery',organization:'City of Ottawa',priority:30,
  coverage:COVERAGE,licenseUrl:LICENSE_URL,attribution:'City of Ottawa',policy:'unknown',
  allowedOrigins:Object.freeze([ORIGIN,'https://ottawa.ca']),allowedRoots:Object.freeze([ROOT,LICENSE_ROOT]),
  covers:point=>contains(COVERAGE,point),search
});
