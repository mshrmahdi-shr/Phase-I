import {defineImageryProvider} from '../provider-registry.mjs';
import {fetchWmsCapabilitiesXml,wmsAllLayerDescriptors} from '../wms-client.mjs';

const ORIGIN='https://datacube.services.geo.ca';
const CAPABILITIES_URL=`${ORIGIN}/web/aerial.xml?request=GetCapabilities&service=WMS&version=1.3.0`;
const GETMAP_SERVICE=`${ORIGIN}/ows/aerial`;
const LICENSE_URL='https://open.canada.ca/en/open-government-licence-canada';
const ATTRIBUTION='Natural Resources Canada — National Air Photo Library';
// A broad national envelope, used only as a cheap upfront skip before the capabilities fetch.
const COVERAGE=Object.freeze({west:-141,south:41.5,east:-52,north:70});
const MAX_EXPORT_DIMENSION=4096;

function contains(coverage,point){return point.lat>=coverage.south&&point.lat<=coverage.north&&point.lng>=coverage.west&&point.lng<=coverage.east;}

async function search({location,signal,fetchImpl=globalThis.fetch,domParserImpl}={}){
  if(!contains(COVERAGE,location))return [];
  const options={signal,fetchImpl,domParserImpl,allowedOrigins:[ORIGIN],allowedRoots:[`${ORIGIN}/web/`,`${ORIGIN}/ows/`]};
  const doc=await fetchWmsCapabilitiesXml(CAPABILITIES_URL,options);
  const values=[];
  for(const layer of wmsAllLayerDescriptors(doc)){
    if(!contains(layer.coverage,location))continue;
    for(const {iso,year} of layer.times){
      const url=new URL(GETMAP_SERVICE);url.searchParams.set('LAYERS',layer.name);url.searchParams.set('TIME',iso);
      values.push({
        id:`${layer.name}-${year}`,providerId:'napl',title:`NAPL ${layer.title} aerial imagery ${year}`,year,
        resolutionMeters:null,coverage:layer.coverage,
        preview:{kind:'wms-export',url:url.href},
        export:{kind:'wms-export',url:url.href,maxWidth:MAX_EXPORT_DIMENSION,maxHeight:MAX_EXPORT_DIMENSION},
        policy:'exportable',sourceUrl:CAPABILITIES_URL,licenseUrl:LICENSE_URL,attribution:ATTRIBUTION
      });
    }
  }
  return values.sort((left,right)=>left.year-right.year||left.id.localeCompare(right.id,'en'));
}

export const NAPL_IMAGERY_PROVIDER=defineImageryProvider({
  id:'napl',label:'National Air Photo Library (NAPL) historical imagery',organization:'Natural Resources Canada',priority:40,
  coverage:COVERAGE,licenseUrl:LICENSE_URL,attribution:ATTRIBUTION,policy:'exportable',
  allowedOrigins:Object.freeze([ORIGIN,'https://open.canada.ca']),
  allowedRoots:Object.freeze([`${ORIGIN}/web/`,`${ORIGIN}/ows/`,'https://open.canada.ca/en/']),
  covers:point=>contains(COVERAGE,point),search
});
export {CAPABILITIES_URL as naplCapabilitiesUrl,GETMAP_SERVICE as NAPL_GETMAP_SERVICE};
