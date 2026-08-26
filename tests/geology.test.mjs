import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import JSZip from 'jszip';
import {getMrd128Legend,pointInPolygon} from '../src/core.mjs';
import * as geology from '../src/geology.mjs';

const dom=new JSDOM('');
globalThis.DOMParser=dom.window.DOMParser;
globalThis.document=dom.window.document;
const polygon=`<Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 10,0 10,10 0,10 0,0</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>3,3 7,3 7,7 3,7 3,3</coordinates></LinearRing></innerBoundaryIs></Polygon>`;
const kml=(name,description='')=>`<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Style id="shared"><PolyStyle><color>ffdb00ca</color></PolyStyle></Style><StyleMap id="unit"><Pair><key>normal</key><styleUrl>#shared</styleUrl></Pair></StyleMap><Placemark><name>${name}</name><description>${description}</description><styleUrl>#unit</styleUrl>${polygon}</Placemark></Document></kml>`;

test('MRD128 parser preserves holes, uses authoritative colors and both description levels',()=>{
  const [g]=geology.parsePolys(kml('9c deposits'),'surficial');
  assert.equal(g.holes.length,1);
  assert.equal(pointInPolygon([5,5],g.polygon,g.holes),false);
  assert.equal(g.color,getMrd128Legend('9c').color);
  assert.match(g.description,/Sand, gravel, minor silt and clay/);
  assert.match(g.description,/Foreshore and basinal deposits/);
});

test('Bedrock numeric units never acquire a surficial title or color',()=>{
  const [g]=geology.parsePolys(kml('3 Limestone','Bedrock description'),'bedrock');
  assert.equal(g.name,'3 Limestone');
  assert.equal(g.description,'Bedrock description');
  assert.equal(g.official,null);
  assert.equal(g.color,'#ca00db');
});

test('polygon parser rejects malformed XML and skips incomplete coordinate tuples',()=>{
  assert.throws(()=>geology.parsePolys('<kml>'),'surficial');
  assert.equal(geology.parsePolys(kml('9c').replace('0,0 10,0 10,10 0,10 0,0',',0 10, 10,10')).length,0);
});

test('local KMZ traversal includes neighbouring tiles and never fetches OGS',async()=>{
  const origin='https://example.test/Phase-I/';
  const root='<kml><NetworkLink><name>Surficial Geology</name><Link><href>http://www.geologyontario.mndm.gov.on.ca/mines/data/google/mrd128/polygons/doc.kml</href></Link></NetworkLink></kml>';
  const tile=(west,east,file)=>`<NetworkLink><name>tile</name><Region><LatLonAltBox><north>10</north><south>0</south><east>${east}</east><west>${west}</west></LatLonAltBox></Region><Link><href>files/${file}.kmz</href></Link></NetworkLink>`;
  const index=`<kml>${tile(0,5,'a')}${tile(5,10,'b')}${tile(20,30,'far')}</kml>`;
  const zip=await new JSZip().file('doc.kml',kml('8a')).generateAsync({type:'uint8array'});
  const requests=[];
  const fetchFn=async url=>{
    requests.push(url);
    if(url===origin+'mrd128-cache/polygons/doc.kml') return {ok:true,text:async()=>index};
    if([origin+'mrd128-cache/polygons/files/a.kmz',origin+'mrd128-cache/polygons/files/b.kmz'].includes(url)) return {ok:true,arrayBuffer:async()=>zip};
    throw new Error('Unexpected request: '+url);
  };
  const result=await geology.resolveLinks({text:root,base:origin+'data/mrd128.kml',cacheRoot:origin+'mrd128-cache/',kind:'surficial',bounds:{west:4,east:6,south:4,north:6},fetchFn,JSZip});
  assert.equal(result.features.length,2);
  assert.deepEqual(requests,[origin+'mrd128-cache/polygons/doc.kml',origin+'mrd128-cache/polygons/files/a.kmz',origin+'mrd128-cache/polygons/files/b.kmz']);
  const broken=async url=>url.endsWith('/b.kmz')?{ok:false,status:404}:fetchFn(url);
  await assert.rejects(()=>geology.resolveLinks({text:root,base:origin+'data/mrd128.kml',cacheRoot:origin+'mrd128-cache/',kind:'surficial',bounds:{west:4,east:6,south:4,north:6},fetchFn:broken,JSZip}),/404/);
});

test('relevant legend excludes far polygons and units only within a polygon hole',()=>{
  const a=geology.parsePolys(kml('8a'),'surficial')[0];
  const b={...a,name:'Far',unitCode:'9c',polygon:[[20,20],[30,20],[30,30],[20,20]],holes:[]};
  assert.deepEqual(geology.relevantUnits([a,b],{west:1,east:2,south:1,north:2}).map(x=>x.unitCode),['8a']);
  assert.deepEqual(geology.relevantUnits([a],{west:4,east:6,south:4,north:6}),[]);
});

test('visible material between two holes remains in the map and legend',()=>{
  const ring=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n],[w,s]];
  const feature={name:'Material',unitCode:'8a',polygon:ring(0,0,10,10),holes:[ring(1,1,4,9),ring(6,1,9,9)]};
  const bounds={west:2,east:8,south:4,north:6};
  assert.equal(geology.siteFeature([feature],{lng:5,lat:5}),feature);
  assert.deepEqual(geology.relevantFeatures([feature],bounds),[feature]);
});
