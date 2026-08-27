import {figureBounds,figureDefaults,validFigureBounds} from './core.mjs';

const R=6378137,GROUND_R=6371000,DEG=Math.PI/180;
export const MAX_RASTER_PIXELS=16000000;
export function projectPoint([lng,lat]){return [R*lng*DEG,R*Math.log(Math.tan(Math.PI/4+lat*DEG/2))];}
export function unprojectPoint([x,y]){return [x/R/DEG,(2*Math.atan(Math.exp(y/R))-Math.PI/2)/DEG];}
export function groundWidth(bounds){
  const centre=unprojectPoint([0,(projectPoint([0,bounds.south])[1]+projectPoint([0,bounds.north])[1])/2])[1];
  return GROUND_R*(bounds.east-bounds.west)*DEG*Math.cos(centre*DEG);
}
export function groundHeight(bounds){return GROUND_R*(bounds.north-bounds.south)*DEG;}
export function metricScale(bounds,pixelWidth,maxPixelWidth=160){
  const width=groundWidth(bounds);
  if(!Number.isFinite(width)||width<=0||!Number.isFinite(pixelWidth)||pixelWidth<=0||!Number.isFinite(maxPixelWidth)||maxPixelWidth<=0)throw new Error('A scale requires a valid final map extent.');
  const maximum=width*Math.min(maxPixelWidth,pixelWidth)/pixelWidth,power=10**Math.floor(Math.log10(maximum));
  const distance=[1,2,5,10].map(n=>n*power).filter(n=>n<=maximum).at(-1)||power/2;
  const pixels=distance/width*pixelWidth,unit=distance>=1000?'km':'m',divisor=unit==='km'?1000:1;
  return {groundWidth:width,distanceMeters:distance,pixelWidth:pixels,label:`${distance/divisor} ${unit}`,unit,
    segments:Array.from({length:4},(_,i)=>({black:i%2===0,pixelWidth:pixels/4,distanceMeters:distance/4})),
    labels:[0,distance/2,distance].map(n=>`${Number((n/divisor).toPrecision(4))}${n===distance?' '+unit:''}`)};
}
export function sheetGeometry(project,code,dpi=300){
  const defaults=figureDefaults(),figure=project?.figures?.[code];
  if(!defaults[code]||!figure)throw new Error('Choose a valid figure A-E.');
  if(![150,300].includes(dpi))throw new Error('Unsafe composition DPI; choose 300 DPI (or 150 DPI).');
  let required;
  if(figure.bounds!=null){
    if(!validFigureBounds(figure.bounds,project.location))throw new Error(`Figure ${code}: keep SITE inside the saved A3 view.`);
    required={...figure.bounds};
  }else required=figureBounds(project.location,defaults[code].extentMeters);
  if(required.west<-180||required.east>180||required.south<-85||required.north>85)throw new Error('This sheet crosses the supported Mercator map bounds; reduce its extent.');
  const mapFrame={x:9.3,y:9.3,width:332.4,height:278.4};
  const sw=projectPoint([required.west,required.south]),ne=projectPoint([required.east,required.north]);
  const cx=(sw[0]+ne[0])/2,cy=(sw[1]+ne[1])/2;
  const height=Math.max(ne[1]-sw[1],(ne[0]-sw[0])*mapFrame.height/mapFrame.width),width=height*mapFrame.width/mapFrame.height;
  const projected={west:cx-width/2,south:cy-height/2,east:cx+width/2,north:cy+height/2};
  const [west,south]=unprojectPoint([projected.west,projected.south]),[east,north]=unprojectPoint([projected.east,projected.north]);
  if(west<-180||east>180||south<-85||north>85)throw new Error('This sheet crosses the supported Mercator map bounds; reduce its extent.');
  const raster={width:Math.round(mapFrame.width/25.4*dpi),height:Math.round(mapFrame.height/25.4*dpi)};
  if(raster.width*raster.height>MAX_RASTER_PIXELS)throw new Error('Unsafe raster dimensions; choose 300 DPI.');
  const bounds={west,south,east,north};
  return {code,dpi,page:{width:420,height:297,margin:7},sheet:{x:7,y:7,width:406,height:283},mapFrame,
    titleFrame:{x:343.7,y:9.3,width:67,height:278.4},bounds,projected,raster,scale:metricScale(bounds,raster.width,raster.width*55/mapFrame.width)};
}
export function captureFigureView(project,code,bounds){
  const defaults=figureDefaults();
  if(!defaults[code]||!project?.figures?.[code])throw new Error('Choose a valid figure A-E.');
  if(!validFigureBounds(bounds,project.location))throw new Error('Keep SITE visible inside the map before saving this A3 view.');
  const draft={...project,figures:{...project.figures,[code]:{...project.figures[code],bounds:{...bounds}}}};
  const geometry=sheetGeometry(draft,code,150);
  return {bounds:geometry.bounds,extentMeters:Math.ceil(groundHeight(geometry.bounds))};
}
export function mapPoint(point,geometry,width=geometry.raster.width,height=geometry.raster.height){
  const [x,y]=projectPoint(point),b=geometry.projected;
  return [(x-b.west)/(b.east-b.west)*width,(b.north-y)/(b.north-b.south)*height];
}
