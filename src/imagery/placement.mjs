const EARTH_RADIUS=6378137;
const DEGREES=Math.PI/180;
const MAX_MERCATOR_LATITUDE=85.0511287798066;
const WORLD_LIMIT=Math.PI*EARTH_RADIUS;
const MAX_SOURCE_PIXELS=32_000_000;

function fail(message){throw new Error(message);}
function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value))fail(`${label} must be finite.`);return value;}

export function projectWebMercator(point){
  if(!Array.isArray(point)||point.length!==2)fail('Web Mercator input must be [longitude, latitude].');
  const lng=finite(point[0],'Longitude'),lat=finite(point[1],'Latitude');
  if(lng < -180||lng > 180||lat < -MAX_MERCATOR_LATITUDE||lat > MAX_MERCATOR_LATITUDE)fail('Coordinate is outside supported Web Mercator bounds.');
  return [EARTH_RADIUS*lng*DEGREES,EARTH_RADIUS*Math.log(Math.tan(Math.PI/4+lat*DEGREES/2))];
}

export function unprojectWebMercator(point){
  if(!Array.isArray(point)||point.length!==2)fail('Projected coordinate must be [x, y].');
  const x=finite(point[0],'Projected x'),y=finite(point[1],'Projected y');
  if(Math.abs(x)>WORLD_LIMIT||Math.abs(y)>WORLD_LIMIT)fail('Projected coordinate is outside supported Web Mercator bounds.');
  return [x/EARTH_RADIUS/DEGREES,(2*Math.atan(Math.exp(y/EARTH_RADIUS))-Math.PI/2)/DEGREES];
}

function normalizedRotation(value){
  finite(value,'Placement rotation');
  const normalized=((value+180)%360+360)%360-180;
  return Object.is(normalized,-0)?0:normalized;
}

function sourceDimensions(width,height){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width>Math.floor(MAX_SOURCE_PIXELS/height))fail('Placement source dimensions must be positive safe integers within the pixel limit.');
}

function normalizedBounds(bounds){
  if(!bounds||typeof bounds!=='object'||Array.isArray(bounds))fail('Placement bounds must contain west, south, east and north.');
  const value={};for(const key of ['west','south','east','north'])value[key]=finite(bounds[key],`Placement bounds.${key}`);
  if(value.west>0&&value.east<0)fail('Antimeridian-crossing placement bounds are not supported.');
  if(value.west < -180||value.east > 180||value.south < -MAX_MERCATOR_LATITUDE||value.north > MAX_MERCATOR_LATITUDE||value.west>=value.east||value.south>=value.north)fail('Placement bounds must be a normalized nondegenerate Web Mercator extent.');
  return value;
}

export function placementFromExtent({bounds,width,height,rotationDegrees=0}={}){
  const extent=normalizedBounds(bounds);sourceDimensions(width,height);
  const sw=projectWebMercator([extent.west,extent.south]),ne=projectWebMercator([extent.east,extent.north]);
  return {center:[(sw[0]+ne[0])/2,(sw[1]+ne[1])/2],groundWidth:ne[0]-sw[0],groundHeight:ne[1]-sw[1],
    sourceWidth:width,sourceHeight:height,rotationDegrees:normalizedRotation(rotationDegrees)};
}

function checkedPlacement(placement){
  if(!placement||typeof placement!=='object'||Array.isArray(placement))fail('Placement must be an object.');
  if(!Array.isArray(placement.center)||placement.center.length!==2)fail('Placement centre must be a projected [x, y] pair.');
  const center=[finite(placement.center[0],'Placement centre x'),finite(placement.center[1],'Placement centre y')];
  const groundWidth=finite(placement.groundWidth,'Placement ground width'),groundHeight=finite(placement.groundHeight,'Placement ground height');
  if(!(groundWidth>0&&groundHeight>0)||groundWidth>WORLD_LIMIT*2||groundHeight>WORLD_LIMIT*2)fail('Placement ground dimensions must be positive and safely within Web Mercator.');
  sourceDimensions(placement.sourceWidth,placement.sourceHeight);
  return {center,groundWidth,groundHeight,sourceWidth:placement.sourceWidth,sourceHeight:placement.sourceHeight,rotationDegrees:normalizedRotation(placement.rotationDegrees)};
}

/** Returns projected Web Mercator corners in NW, NE, SE, SW source-pixel order. */
export function placementCorners(placement){
  const value=checkedPlacement(placement),angle=value.rotationDegrees*DEGREES,cos=Math.cos(angle),sin=Math.sin(angle);
  const rotate=([x,y])=>[value.center[0]+x*cos+y*sin,value.center[1]-x*sin+y*cos];
  const x=value.groundWidth/2,y=value.groundHeight/2;
  return [rotate([-x,y]),rotate([x,y]),rotate([x,-y]),rotate([-x,-y])];
}

/** Maps decoded source pixel edges to projected Web Mercator metres using Canvas [a,b,c,d,e,f] order. */
export function placementCanvasTransform(placement){
  const value=checkedPlacement(placement),angle=value.rotationDegrees*DEGREES,cos=Math.cos(angle),sin=Math.sin(angle);
  const clean=number=>Object.is(number,-0)||Math.abs(number)<Number.EPSILON?0:number;
  const a=clean(cos*value.groundWidth/value.sourceWidth),b=clean(-sin*value.groundWidth/value.sourceWidth);
  const c=clean(-sin*value.groundHeight/value.sourceHeight),d=clean(-cos*value.groundHeight/value.sourceHeight);
  const [e,f]=placementCorners(value)[0];
  return [a,b,c,d,e,f];
}

export function geographicPlacementCorners(placement){return placementCorners(placement).map(unprojectWebMercator);}

function inverseNad83Utm([easting,northing],zone){
  finite(easting,'UTM easting');finite(northing,'UTM northing');
  if(easting<100_000||easting>900_000||northing<0||northing>10_000_000)fail('NAD83 UTM coordinate is outside the supported zone.');
  const a=6378137,inverseFlattening=298.257222101,flattening=1/inverseFlattening,eccentricitySquared=flattening*(2-flattening),second=eccentricitySquared/(1-eccentricitySquared),k0=.9996;
  const meridional=northing/k0,mu=meridional/(a*(1-eccentricitySquared/4-3*eccentricitySquared**2/64-5*eccentricitySquared**3/256));
  const root=Math.sqrt(1-eccentricitySquared),e1=(1-root)/(1+root);
  const footprint=mu+(3*e1/2-27*e1**3/32)*Math.sin(2*mu)+(21*e1**2/16-55*e1**4/32)*Math.sin(4*mu)+(151*e1**3/96)*Math.sin(6*mu)+(1097*e1**4/512)*Math.sin(8*mu);
  const sin=Math.sin(footprint),cos=Math.cos(footprint),tan=Math.tan(footprint),N=a/Math.sqrt(1-eccentricitySquared*sin*sin),R=a*(1-eccentricitySquared)/(1-eccentricitySquared*sin*sin)**1.5,T=tan*tan,C=second*cos*cos,D=(easting-500_000)/(N*k0);
  const latitude=footprint-N*tan/R*(D**2/2-(5+3*T+10*C-4*C**2-9*second)*D**4/24+(61+90*T+298*C+45*T**2-252*second-3*C**2)*D**6/720);
  const longitude=((zone-1)*6-180+3)*DEGREES+(D-(1+2*T+C)*D**3/6+(5-2*C+28*T-3*C**2+8*second+24*T**2)*D**5/120)/cos;
  const result=[longitude/DEGREES,latitude/DEGREES],west=zone*6-186,east=zone*6-180;
  if(result[0]<west-1e-8||result[0]>east+1e-8||result[1]<0||result[1]>84)fail('NAD83 UTM coordinate is outside the declared northern zone.');
  return result;
}

function nativeToMercator(crs,point){
  if(crs==='EPSG:3857'){
    const projected=[finite(point[0],'Georeference x'),finite(point[1],'Georeference y')];
    if(projected.some(value=>Math.abs(value)>WORLD_LIMIT))fail('Georeference is outside supported Web Mercator bounds.');
    return projected;
  }
  if(crs==='EPSG:4326')return projectWebMercator(point);
  const match=/^EPSG:269(1[5-8])$/.exec(crs);
  if(match)return projectWebMercator(inverseNad83Utm(point,Number(match[1])));
  fail('Georeference CRS must be EPSG:4326, EPSG:3857, or NAD83 UTM zone 15-18.');
}

/** Converts a pixel-centre affine georeference into the bounded rotated placement model. */
export function placementFromGeoReference({geo,width,height}={}){
  sourceDimensions(width,height);
  if(!geo||typeof geo!=='object'||!Array.isArray(geo.transform)||geo.transform.length!==6||geo.transform.some(value=>typeof value!=='number'||!Number.isFinite(value)))fail('Georeference must contain a finite six-coefficient pixel-centre transform.');
  const [a,b,c,d,e,f]=geo.transform,apply=(column,row)=>nativeToMercator(geo.crs,[a*column+c*row+e,b*column+d*row+f]);
  const corners=[apply(-.5,-.5),apply(width-.5,-.5),apply(width-.5,height-.5),apply(-.5,height-.5)];
  const vectors=[
    [corners[1][0]-corners[0][0],corners[1][1]-corners[0][1]],
    [corners[2][0]-corners[3][0],corners[2][1]-corners[3][1]],
    [corners[3][0]-corners[0][0],corners[3][1]-corners[0][1]],
    [corners[2][0]-corners[1][0],corners[2][1]-corners[1][1]]
  ],length=([x,y])=>Math.hypot(x,y),lengths=vectors.map(length);
  if(lengths.some(value=>!Number.isFinite(value)||value<=0))fail('Georeference creates a degenerate image placement.');
  const groundWidth=(lengths[0]+lengths[1])/2,groundHeight=(lengths[2]+lengths[3])/2;
  const orthogonality=Math.abs((vectors[0][0]*vectors[2][0]+vectors[0][1]*vectors[2][1])/(lengths[0]*lengths[2]));
  const widthMismatch=Math.abs(lengths[0]-lengths[1])/groundWidth,heightMismatch=Math.abs(lengths[2]-lengths[3])/groundHeight;
  if(orthogonality>.02||widthMismatch>.02||heightMismatch>.02)fail('Georeference requires shear or projective rectification; convert it to a north-up affine image.');
  const center=[corners.reduce((sum,point)=>sum+point[0],0)/4,corners.reduce((sum,point)=>sum+point[1],0)/4];
  const placement={center,groundWidth,groundHeight,sourceWidth:width,sourceHeight:height,rotationDegrees:normalizedRotation(Math.atan2(-vectors[0][1],vectors[0][0])/DEGREES)};
  const fitted=placementCorners(placement),maximumError=Math.max(...fitted.map((point,index)=>Math.hypot(point[0]-corners[index][0],point[1]-corners[index][1])));
  if(maximumError>Math.max(groundWidth,groundHeight)*.02)fail('Georeference cannot be represented by the supported affine placement.');
  return placement;
}

export function validatePlacement(placement,{location}={}){
  const value=checkedPlacement(placement),corners=placementCorners(value);
  if(corners.some(([x,y])=>Math.abs(x)>WORLD_LIMIT||Math.abs(y)>WORLD_LIMIT))fail('Placement crosses the antimeridian or supported Web Mercator bounds.');
  if(!location||typeof location!=='object'||typeof location.lng!=='number'||typeof location.lat!=='number')fail('A valid SITE location is required to validate placement.');
  const site=projectWebMercator([location.lng,location.lat]),dx=site[0]-value.center[0],dy=site[1]-value.center[1];
  const angle=value.rotationDegrees*DEGREES,cos=Math.cos(angle),sin=Math.sin(angle);
  const localX=dx*cos-dy*sin,localY=dx*sin+dy*cos,epsilon=1e-7;
  if(Math.abs(localX)>value.groundWidth/2+epsilon||Math.abs(localY)>value.groundHeight/2+epsilon)fail('Keep SITE inside the manual image placement.');
  return true;
}

export const WEB_MERCATOR_LIMIT=Object.freeze({latitude:MAX_MERCATOR_LATITUDE,metres:WORLD_LIMIT});
