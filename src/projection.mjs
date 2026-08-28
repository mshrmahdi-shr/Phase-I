import defaultProj4 from './proj4-runtime.mjs';

const SUPPORTED_ZONES=Object.freeze([15,16,17,18]);
const WEST_LIMIT=-96,EAST_LIMIT=-72,MAX_NORTH_LATITUDE=84,MAX_RING_POINTS=5000;
const ZONE_BOUNDARIES=new Set([-96,-90,-84,-78,-72]);

function fail(message){throw new Error(message);}
function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value))fail(`${label} must be finite.`);return value;}

function checkedLocation(location){
  if(!location||typeof location!=='object'||Array.isArray(location))fail('SITE location must contain latitude and longitude.');
  const lat=finite(location.lat,'SITE latitude'),lng=finite(location.lng,'SITE longitude');
  if(lat<0)fail('SITE must be in the northern hemisphere.');
  if(lat>MAX_NORTH_LATITUDE)fail('SITE latitude is outside supported northern UTM bounds.');
  if(lng< -180||lng>180)fail('SITE longitude is outside geographic bounds.');
  return {lat,lng};
}

function crsForZone(zone){return Object.freeze({zone,epsg:`EPSG:269${zone}`,name:`NAD83 / UTM zone ${zone}N`,units:'m'});}

export function utmZoneForLocation(location){
  const {lat,lng}=checkedLocation(location);
  if(ZONE_BOUNDARIES.has(lng))fail('SITE longitude lies on an ambiguous UTM zone boundary.');
  if(lng<WEST_LIMIT||lng>EAST_LIMIT)fail('SITE longitude is outside supported UTM zones 15-18.');
  const zone=Math.floor((lng+180)/6)+1;
  if(!SUPPORTED_ZONES.includes(zone))fail('SITE longitude is outside supported UTM zones 15-18.');
  return crsForZone(zone);
}

function checkedPair(point,label){
  if(!Array.isArray(point)||point.length!==2)fail(`${label} must be a two-coordinate point.`);
  return [finite(point[0],`${label} first coordinate`),finite(point[1],`${label} second coordinate`)];
}

function checkedGeographicPoint(point){
  const [lng,lat]=checkedPair(point,'Geographic point');
  if(lng<=WEST_LIMIT||lng>=EAST_LIMIT)fail('Longitude is outside supported UTM zones 15-18.');
  if(lat<0)fail('Latitude must be in the northern hemisphere.');
  if(lat>MAX_NORTH_LATITUDE)fail('Latitude is outside supported northern UTM bounds.');
  return [lng,lat];
}

function checkedProjectedPoint(point,label='Projected point'){
  const [easting,northing]=checkedPair(point,label);
  if(easting<100_000||easting>900_000)fail('UTM easting is outside the supported coordinate range.');
  if(northing<0||northing>10_000_000)fail('UTM northing is outside the supported coordinate range.');
  return [easting,northing];
}

function registerDefinitions(proj4Impl){
  if(typeof proj4Impl!=='function'||typeof proj4Impl.defs!=='function')fail('A compatible proj4 implementation is required.');
  for(const zone of SUPPORTED_ZONES)proj4Impl.defs(`EPSG:269${zone}`,`+proj=utm +zone=${zone} +datum=NAD83 +units=m +no_defs`);
}

export function createProjector(location,{proj4Impl=defaultProj4}={}){
  const crs=utmZoneForLocation(location);registerDefinitions(proj4Impl);
  const conversion=proj4Impl('EPSG:4326',crs.epsg);
  if(!conversion||typeof conversion.forward!=='function'||typeof conversion.inverse!=='function')fail('proj4 could not create the NAD83 UTM conversion.');
  return Object.freeze({
    crs,
    forward(point){return checkedProjectedPoint(conversion.forward(checkedGeographicPoint(point)),'Forward projection result');},
    inverse(point){
      return checkedGeographicPoint(conversion.inverse(checkedProjectedPoint(point,'Inverse projection input')));
    }
  });
}

function checkedRing(ring){
  if(!Array.isArray(ring)||ring.length<4||ring.length>MAX_RING_POINTS)fail(`Ring must contain between 4 and ${MAX_RING_POINTS} coordinates.`);
  const points=ring.map(checkedGeographicPoint),first=points[0],last=points.at(-1);
  if(first[0]!==last[0]||first[1]!==last[1])fail('Ring must be closed.');
  const vertices=points.slice(0,-1);
  if(new Set(vertices.map(point=>`${point[0]},${point[1]}`)).size!==vertices.length)fail('Ring must contain distinct vertices.');
  const origin=vertices[0],xs=vertices.map(point=>point[0]),ys=vertices.map(point=>point[1]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const scale=Math.max(maxX-minX,maxY-minY),extremes=[vertices[xs.indexOf(minX)],vertices[xs.indexOf(maxX)],vertices[ys.indexOf(minY)],vertices[ys.indexOf(maxY)]];
  let baselineStart=extremes[0],baselineEnd=extremes[0],baselineSquared=0;
  for(let firstIndex=0;firstIndex<extremes.length;firstIndex++)for(let secondIndex=firstIndex+1;secondIndex<extremes.length;secondIndex++){
    const dx=extremes[secondIndex][0]-extremes[firstIndex][0],dy=extremes[secondIndex][1]-extremes[firstIndex][1],distanceSquared=dx*dx+dy*dy;
    if(distanceSquared>baselineSquared){baselineStart=extremes[firstIndex];baselineEnd=extremes[secondIndex];baselineSquared=distanceSquared;}
  }
  const baselineX=baselineEnd[0]-baselineStart[0],baselineY=baselineEnd[1]-baselineStart[1];
  const maxLineOffset=Math.max(...vertices.map(point=>Math.abs(baselineX*(point[1]-baselineStart[1])-baselineY*(point[0]-baselineStart[0]))));
  if(maxLineOffset<=baselineSquared*Number.EPSILON*1024)fail('Ring is degenerate or collinear.');
  let twiceArea=0,compensation=0;
  for(let index=1;index<vertices.length-1;index++){
    const first=[vertices[index][0]-origin[0],vertices[index][1]-origin[1]],second=[vertices[index+1][0]-origin[0],vertices[index+1][1]-origin[1]];
    const term=first[0]*second[1]-first[1]*second[0],sum=twiceArea+term;
    compensation+=Math.abs(twiceArea)>=Math.abs(term)?(twiceArea-sum)+term:(term-sum)+twiceArea;twiceArea=sum;
  }
  twiceArea+=compensation;
  const areaTolerance=scale*scale*Number.EPSILON*256*vertices.length;
  if(!Number.isFinite(twiceArea)||!Number.isFinite(areaTolerance)||Math.abs(twiceArea)<=areaTolerance)fail('Ring is degenerate or collinear.');
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const onSegment=(point,start,end)=>Math.abs(cross(start,end,point))<1e-14&&point[0]>=Math.min(start[0],end[0])&&point[0]<=Math.max(start[0],end[0])&&point[1]>=Math.min(start[1],end[1])&&point[1]<=Math.max(start[1],end[1]);
  for(let firstIndex=0;firstIndex<vertices.length;firstIndex++)for(let secondIndex=firstIndex+2;secondIndex<vertices.length;secondIndex++){
    if(firstIndex===0&&secondIndex===vertices.length-1)continue;
    const a=points[firstIndex],b=points[firstIndex+1],c=points[secondIndex],d=points[secondIndex+1];
    if(onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b)||(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0))fail('Ring must not self-intersect.');
  }
  return points;
}

export function projectRing(ring,projector){
  if(!projector||typeof projector.forward!=='function')fail('Ring projection requires a projector.');
  const projected=checkedRing(ring).map(point=>checkedProjectedPoint(projector.forward(point),'Ring projector result'));
  projected[projected.length-1]=[...projected[0]];
  return projected;
}

export function projectedBounds(points){
  if(!Array.isArray(points)||points.length===0)fail('Projected bounds require at least one point.');
  const checked=points.map(point=>checkedProjectedPoint(point,'Projected bounds point'));
  let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  for(const [x,y] of checked){west=Math.min(west,x);south=Math.min(south,y);east=Math.max(east,x);north=Math.max(north,y);}
  return {west,south,east,north};
}
