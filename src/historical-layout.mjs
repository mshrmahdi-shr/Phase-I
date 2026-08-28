import {validBoundary,validFigureBounds,validHistoricalA3Bounds} from './core.mjs';
import {MAX_RASTER_PIXELS,metricScale,projectPoint} from './sheet-layout.mjs';

const DPI_VALUES=new Set([150,300]);
const PAGE=Object.freeze({width:420,height:297,margin:7});
const MAP_HEIGHT=280;
const MAP_WIDTH=MAP_HEIGHT*PAGE.width/PAGE.height;

function fail(message){throw new Error(message);}
function same(left,right){return JSON.stringify(left)===JSON.stringify(right);}

export function historicalCode(item){
  if(!item||!Number.isInteger(item.year)||!Number.isInteger(item.sequence)||item.sequence<=0)fail('The approved historical item has an invalid year or sequence.');
  return `H-${item.year}-${item.sequence}`;
}

export function historicalSheetGeometry(project,item,dpi=300){
  if(!DPI_VALUES.has(dpi))fail('Unsafe composition DPI; choose 300 DPI (or 150 DPI).');
  if(!project||!item||!Array.isArray(project.historical))fail('Choose an approved historical item.');
  const approved=project.historical.find(candidate=>candidate?.id===item.id);
  if(!approved||!same(approved,item))fail('The selected approved historical item or crop has changed. Reopen the export dialog.');
  if(!validFigureBounds(item.bounds,project.location))fail('The approved historical crop must be valid and keep SITE inside.');
  if(!validHistoricalA3Bounds(item.bounds))fail('The approved crop does not retain the projected A3 landscape aspect. Reopen the crop editor and approve it again.');
  for(const key of ['siteBoundary','buildingBoundary'])if(project[key]?.length&&!validBoundary(project[key]))fail('The project contains an invalid boundary.');
  const sw=projectPoint([item.bounds.west,item.bounds.south]),ne=projectPoint([item.bounds.east,item.bounds.north]);
  if(!sw.every(Number.isFinite)||!ne.every(Number.isFinite)||ne[0]<=sw[0]||ne[1]<=sw[1])fail('The approved historical crop is outside supported Web Mercator bounds.');
  const mapFrame={x:(PAGE.width-MAP_WIDTH)/2,y:(PAGE.height-MAP_HEIGHT)/2,width:MAP_WIDTH,height:MAP_HEIGHT};
  const raster={width:Math.round(mapFrame.width/25.4*dpi),height:Math.round(mapFrame.height/25.4*dpi)};
  if(raster.width*raster.height>MAX_RASTER_PIXELS)fail('Unsafe raster dimensions; choose 300 DPI.');
  const projected={west:sw[0],south:sw[1],east:ne[0],north:ne[1]},bounds={...item.bounds};
  return {code:historicalCode(item),itemId:item.id,dpi,page:{...PAGE},sheet:{x:7,y:7,width:406,height:283},mapFrame,
    titleFrame:{x:mapFrame.x+4,y:mapFrame.y+mapFrame.height-42,width:mapFrame.width-8,height:38},
    bounds,projected,raster,scale:metricScale(bounds,raster.width,raster.width*52/mapFrame.width)};
}

export function orderedHistoricalItems(project){
  if(!Array.isArray(project?.historical))return [];
  return [...project.historical].sort((left,right)=>left.year-right.year||left.sequence-right.sequence||String(left.id).localeCompare(String(right.id),'en'));
}
