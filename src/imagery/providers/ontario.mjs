import {defineImageryProvider} from '../provider-registry.mjs';
import {arcGisExtentToCoverage,fetchArcGisJson} from '../arcgis-client.mjs';

const ROOT='https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_Imagery/';
const ORIGIN='https://ws.lioservices.lrc.gov.on.ca';
const LICENSE_URL='https://www.ontario.ca/page/open-government-licence-ontario';
const LICENSE_ROOT='https://www.ontario.ca/page/';
const SOURCE_SERVICE=new URL('Ontario_Imagery_Web_Map_Service_Source/MapServer',ROOT).href;
const COVERAGE=Object.freeze({west:-95.2,south:41.65,east:-74.25,north:56.9});
const OPEN_COLLECTIONS=new Map([
  ['South_Western_Ontario_Orthophotography_SWOOP_2025_Aerial',{id:'swoop-2025',year:2025,title:'South Western Ontario Orthophotography 2025'}],
  ['Digital Raster Acquisition Project East 2024 (Aerial)',{id:'drape-2024',year:2024,title:'Digital Raster Acquisition Project East 2024'}],
  ['South Central Ontario Orthophotography 2023 (Aerial)',{id:'scoop-2023',year:2023,title:'South Central Ontario Orthophotography 2023'}],
  ['North Western Ontario Orthophotography Project 2022 (Aerial)',{id:'nwoop-2022',year:2022,title:'North Western Ontario Orthophotography Project 2022'}],
  ['Central Ontario Orthophotography Project 2021 (Aerial)',{id:'coop-2021',year:2021,title:'Central Ontario Orthophotography Project 2021'}],
  ['Northwestern Ontario Orthophotography Project 2017 (Aerial)',{id:'nwoop-2017',year:2017,title:'Northwestern Ontario Orthophotography Project 2017'}],
  ['Central Ontario Orthophotography Project 2016 (Aerial)',{id:'coop-2016',year:2016,title:'Central Ontario Orthophotography Project 2016'}],
  ['Algonquin Orthophotography 2015 (Aerial)',{id:'algonquin-2015',year:2015,title:'Algonquin Orthophotography 2015'}],
  ['Digital Raster Acquisition Project East 2014 (Aerial)',{id:'drape-2014',year:2014,title:'Digital Raster Acquisition Project East 2014'}]
]);

function contains(coverage,point){return point.lat>=coverage.south&&point.lat<=coverage.north&&point.lng>=coverage.west&&point.lng<=coverage.east;}

async function search({location,signal,fetchImpl=globalThis.fetch}){
  const options={signal,fetchImpl,allowedOrigins:[ORIGIN],allowedRoots:[ROOT]};
  const source=await fetchArcGisJson(SOURCE_SERVICE,options);
  if(!Array.isArray(source.layers))throw new TypeError('Ontario imagery source layers are missing');
  const entries=source.layers.filter(layer=>Number.isInteger(layer?.id)&&OPEN_COLLECTIONS.has(layer?.name));
  const values=await Promise.all(entries.map(async layer=>{
    const collection=OPEN_COLLECTIONS.get(layer.name);
    const sourceUrl=`${SOURCE_SERVICE}/${layer.id}`;
    const metadata=await fetchArcGisJson(sourceUrl,options);
    const coverage=arcGisExtentToCoverage(metadata.extent??metadata.fullExtent);
    if(!contains(coverage,location))return null;
    return {
      id:collection.id,providerId:'ontario',title:collection.title,year:collection.year,
      resolutionMeters:null,coverage,
      preview:{kind:'official-link',url:sourceUrl},export:null,
      policy:'link-only',sourceUrl,licenseUrl:LICENSE_URL,attribution:'Government of Ontario'
    };
  }));
  return values.filter(Boolean).sort((left,right)=>left.year-right.year||left.id.localeCompare(right.id,'en'));
}

export const ONTARIO_IMAGERY_PROVIDER=defineImageryProvider({
  id:'ontario',label:'Geospatial Ontario imagery',organization:'Government of Ontario',priority:10,
  coverage:COVERAGE,licenseUrl:LICENSE_URL,attribution:'Government of Ontario',policy:'exportable',
  allowedOrigins:Object.freeze([ORIGIN,'https://www.ontario.ca']),allowedRoots:Object.freeze([ROOT,LICENSE_ROOT]),
  covers:point=>contains(COVERAGE,point),search
});
