import {createProject,restoreProject,closeRing,validBoundary,figureBounds,buildDxf} from './src/core.mjs';
import {parsePolys,resolveLinks,readKmz,relevantFeatures,relevantUnits,siteFeature,containsBounds} from './src/geology.mjs';
import {createPreflight} from './print-preflight.mjs';
import {createPrintSession,waitForMapTiles} from './src/print-session.mjs';
const $=id=>document.getElementById(id), STORAGE='phase-i-esa-project-v2', MRD='./data/mrd128.kml';
let project=(()=>{for(const k of [STORAGE,'phase-i-esa-project-v1']){try{const v=localStorage.getItem(k);if(v)return restoreProject(JSON.parse(v))}catch{}}return createProject()})();
let active='A',draw=null,pts=[],siteMarker,siteLayer,buildingLayer,draft,geoLayer,preflight,printSession;
let locationRevision=0;
const geoCoverage={surficial:null,bedrock:null},geoReady={surficial:false,bedrock:false},geoRequest={surficial:0,bedrock:0};
const geo={surficial:[],bedrock:[]}, geoSource={surficial:null,bedrock:null};
const map=L.map('map',{zoomSnap:0,fadeAnimation:false,zoomAnimation:false}).setView([43.75,-79.3],11), street=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,crossOrigin:true,attribution:'© OpenStreetMap contributors'}).addTo(map), sat=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,crossOrigin:true,attribution:'Tiles © Esri'});
map.createPane('geology');map.getPane('geology').style.zIndex=350;
L.control.scale({imperial:false,maxWidth:160}).addTo(map);
const north=L.control({position:'topright'});north.onAdd=()=>{const e=L.DomUtil.create('div','north-arrow');e.innerHTML='<div class="north-n">N</div><div class="north-glyph">▲</div>';return e};north.addTo(map);
const legendControl=L.control({position:'bottomright'});legendControl.onAdd=()=>{const e=L.DomUtil.create('div','map-legend');e.id='mapLegend';return e};legendControl.addTo(map);
function save(){
  project.updatedAt=new Date().toISOString();
  try{localStorage.setItem(STORAGE,JSON.stringify(project));$('saveState').textContent='Saved';}
  catch{ $('saveState').textContent='Not saved';status('saveMessage','Browser storage is unavailable or full. Export Project now to keep a backup.','error');preflight?.refresh();return false; }
  status('saveMessage','Saved in this browser. Export Project for a backup.');
  preflight?.refresh();return true;
}
function status(id,t,k=''){$(id).textContent=t;$(id).dataset.kind=k}
function sync(){for(const [id,k] of [['projectName','name'],['projectNo','projectNo'],['address','address'],['projectDate','date']])$(id).value=project[k]||'';$('dpi').value=project.dpi||300;$('dpiBadge').textContent=`${project.dpi||300} DPI`;if(project.location){map.setView([project.location.lat,project.location.lng],16);setMarker(project.location)};redraw();renderFigures();renderAerials();refreshPrint();updateLegend()}
for(const [id,k] of [['projectName','name'],['projectNo','projectNo'],['address','address'],['projectDate','date']])$(id).oninput=e=>{project[k]=e.target.value;save();refreshPrint()};$('dpi').onchange=e=>{project.dpi=+e.target.value;$('dpiBadge').textContent=`${project.dpi} DPI`;save()};
$('searchAddress').onclick=async()=>{
  const q=$('address').value.trim();if(!q)return;
  const button=$('searchAddress');button.disabled=true;status('searchStatus','Searching…');
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,{headers:{'Accept-Language':'en'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('Address service is unavailable. Try again later or use Set SITE.');
    const a=await r.json();if(!a.length)throw Error('Address not found. Try a more complete address or use Set SITE.');
    project.address=a[0].display_name;$('address').value=project.address;
    siteChanged({lat:+a[0].lat,lng:+a[0].lon});zoom(active);
    status('searchStatus',`Located: ${project.address}`,'ok');
  }catch(e){status('searchStatus',e.name==='TimeoutError'?'Address search timed out. Try again or use Set SITE.':e.message,'error');}
  finally{setTimeout(()=>button.disabled=false,1000);}
};
function siteChanged(location){
  project.location=location;locationRevision++;setMarker(location);detect();save();refreshPrint();
}
function setMarker(p){
  siteMarker?.remove();
  const icon=L.divIcon({className:'',html:'<div class="site-marker"></div>',iconSize:[18,18],iconAnchor:[9,9]});
  siteMarker=L.marker([p.lat,p.lng],{icon,draggable:true}).addTo(map).bindTooltip('SITE',{permanent:true,direction:'top',offset:[0,-8]});
  siteMarker.on('dragend',()=>{const q=siteMarker.getLatLng();siteChanged({lat:q.lat,lng:q.lng});});
  $('coords').textContent=`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
}
function stopDrawing(){draw=null;pts=[];draft?.remove();draft=null;$('drawState').textContent='Idle';map.getContainer().style.cursor='';map.doubleClickZoom.enable();}
function begin(mode){stopDrawing();draw=mode;$('drawState').textContent=mode==='marker'?'Tap site':mode==='site'?'Drawing site':'Drawing building';map.getContainer().style.cursor='crosshair';map.doubleClickZoom.disable();$('map').scrollIntoView({behavior:'smooth',block:'center'});}
function drawDraft(){draft?.remove();draft=pts.length?L.polyline(pts.map(([x,y])=>[y,x]),{color:'#fbbf24',dashArray:'7 5'}).addTo(map):null;}
$('setSite').onclick=()=>begin('marker');$('drawSite').onclick=()=>begin('site');$('drawBuilding').onclick=()=>begin('building');
$('undoPoint').onclick=()=>{pts.pop();drawDraft();};
$('clearGeometry').onclick=()=>{stopDrawing();project.siteBoundary=[];project.buildingBoundary=[];redraw();save();};
map.on('click',e=>{
  if(!draw)return;
  if(draw==='marker'){siteChanged({lat:e.latlng.lat,lng:e.latlng.lng});stopDrawing();return;}
  pts.push([e.latlng.lng,e.latlng.lat]);drawDraft();
});
$('finishDraw').onclick=()=>{
  if(!draw)return;
  if(draw==='marker'){stopDrawing();return;}
  const ring=closeRing(pts);
  if(!validBoundary(ring)){$('drawState').textContent='Use 3+ corners; no crossing edges';return;}
  if(draw==='site')project.siteBoundary=ring;else project.buildingBoundary=ring;
  stopDrawing();redraw();save();
};
function redraw(){siteLayer?.remove();buildingLayer?.remove();if(project.siteBoundary?.length)siteLayer=L.polygon(project.siteBoundary.map(([x,y])=>[y,x]),{color:'#ef4444',weight:4,fill:false}).addTo(map);if(project.buildingBoundary?.length)buildingLayer=L.polygon(project.buildingBoundary.map(([x,y])=>[y,x]),{color:'#111827',weight:3,dashArray:'6 4',fillColor:'#fff',fillOpacity:.1}).addTo(map)}
function renderFigures(){const h=$('figureList');h.innerHTML='';for(const [c,f] of Object.entries(project.figures)){const d=document.createElement('div');d.className='figure-row'+(c===active?' active':'');d.innerHTML=`<div class="figure-top"><div><div class="figure-code">FIGURE ${c}</div><div class="figure-title">${esc(f.title)}</div></div><span class="badge">${fmt(f.extentMeters)}</span></div><div class="figure-actions"><button>View</button><button>Use for A3</button></div>`;d.children[1].children[0].onclick=()=>selectFig(c,true);d.children[1].children[1].onclick=()=>selectFig(c,false);h.appendChild(d)}}
function fmt(m){return m>=1000?`${m/1000} km`:`${m} m`;}
function currentBounds(){const b=map.getBounds();return{north:b.getNorth(),south:b.getSouth(),east:b.getEast(),west:b.getWest()};}
function requiredGeologyBounds(){return figureBounds(project.location,project.figures.D.extentMeters*2);}
function selectFig(code,fit){
  active=code;stopDrawing();renderFigures();
  if(code==='B')setBasemap('satellite');else setBasemap('street');
  if(fit)zoom(code);renderGeo();detect();refreshPrint();preflight.refresh();
  if(code==='D'&&project.location&&(!geoReady.surficial||!containsBounds(geoCoverage.surficial,requiredGeologyBounds())))loadMRD(false);
}
function zoom(code){
  if(!project.location)return;
  const b=figureBounds(project.location,project.figures[code].extentMeters);
  map.fitBounds([[b.south,b.west],[b.north,b.east]],{padding:[0,0],animate:false});
}
function setBasemap(kind){
  document.querySelectorAll('.basemap').forEach(b=>b.classList.toggle('active',b.dataset.map===kind));
  const selected=kind==='satellite'?sat:street,other=kind==='satellite'?street:sat;
  if(map.hasLayer(other))map.removeLayer(other);if(!map.hasLayer(selected))selected.addTo(map);
}
for(const b of document.querySelectorAll('.basemap'))b.onclick=()=>setBasemap(b.dataset.map);

$('uploadAerial').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;const y=+$('aerialYear').value||new Date().getFullYear(),u=await new Promise((ok,no)=>{const r=new FileReader;r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f)});project.historical=project.historical||[];project.historical.push({id:crypto.randomUUID(),year:y,name:f.name,size:f.size,dataUrl:u});save();renderAerials();status('imageryStatus',`Added ${f.name} for ${y}`,'ok')};function renderAerials(){const a=project.historical||[];$('aerialCount').textContent=a.length;$('aerialList').innerHTML=a.length?a.map(x=>`<div class="aerial-item"><b>${esc(x.year)}</b> — ${esc(x.name)}</div>`).join(''):'No historical imagery added.'}$('openEarth').onclick=()=>project.location?window.open(`https://earth.google.com/web/@${project.location.lat},${project.location.lng},500a,1000d,35y,0h,0t,0r`,'_blank'):alert('Set the site location first.');
$('loadMrd128').onclick=()=>loadMRD(true);
async function loadMRD(user=true){
  if(!project.location){if(user)status('geologyStatus','Locate the property first.','error');return;}
  const ticket=++geoRequest.surficial,revision=locationRevision;
  const bounds=requiredGeologyBounds();
  if(active==='D'){
    const visible=currentBounds();bounds.north=Math.max(bounds.north,visible.north);bounds.south=Math.min(bounds.south,visible.south);
    bounds.east=Math.max(bounds.east,visible.east);bounds.west=Math.min(bounds.west,visible.west);
  }
  geoReady.surficial=false;preflight.refresh();$('loadMrd128').disabled=true;
  status('geologyStatus','Loading local OGS MRD128 cache…');
  try{
    const r=await fetch(MRD,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('The MRD128 index is unavailable.');
    const result=await resolveLinks({text:await r.text(),base:new URL(MRD,location.href).href,cacheRoot:new URL('./mrd128-cache/',location.href).href,kind:'surficial',bounds,JSZip,progress:t=>{if(ticket===geoRequest.surficial)status('geologyStatus',t);}});
    if(ticket!==geoRequest.surficial)return;
    if(revision!==locationRevision){status('geologyStatus','SITE changed while loading. Load MRD128 again for the final location.','error');return;}
    if(!result.features.length)throw Error('No cached geology polygons cover this location.');
    commitDataset(result.features,'surficial','Ontario Geological Survey — MRD128 / MRD128-REV, Surficial Geology of Southern Ontario',result.docs,bounds);
  }catch(e){if(ticket===geoRequest.surficial)status('geologyStatus',`MRD128 load failed: ${e.message} Check the published cache or import a polygon KML/KMZ.`,'error');}
  finally{if(ticket===geoRequest.surficial){$('loadMrd128').disabled=false;preflight.refresh();}}
}
$('uploadGeology').onchange=async e=>{
  const file=e.target.files?.[0];if(!file)return;
  const kind=$('geologyKind').value,ticket=++geoRequest[kind];geoReady[kind]=false;
  try{
    const text=/\.kmz$/i.test(file.name)?await readKmz(file,JSZip):await file.text();
    const features=parsePolys(text,kind);
    if(!features.length)throw Error('This file contains no polygons. Import a self-contained polygon KML/KMZ, not a NetworkLink index.');
    if(ticket===geoRequest[kind])commitDataset(features,kind,file.name,1,null);
  }catch(error){status('geologyStatus',`Import failed: ${error.message}`,'error');}
  finally{preflight.refresh();}
};
function commitDataset(features,kind,name,docs,coverage){
  geo[kind]=features;geoSource[kind]=name;geoCoverage[kind]=coverage;geoReady[kind]=true;
  project.geology[kind]={name,count:features.length,docs};renderGeo();detect();save();refreshPrint();
  status('geologyStatus',`Loaded ${features.length.toLocaleString()} ${kind} polygon(s) from ${name}`,'ok');
}
function geologyKind(){return active==='D'?'surficial':active==='E'?'bedrock':null;}
function renderGeo(){
  geoLayer?.remove();geoLayer=null;const kind=geologyKind();
  if(kind&&geo[kind].length){
    geoLayer=L.layerGroup(relevantFeatures(geo[kind],currentBounds()).map(g=>L.polygon(
      [g.polygon,...g.holes].map(r=>r.map(([x,y])=>[y,x])),
      {pane:'geology',color:'#475569',weight:1,fillColor:g.color,fillOpacity:g.fillOpacity}
    ).bindPopup(`<b>${esc(g.name)}</b><br>${esc(g.description)}`))).addTo(map);
  }
  updateLegend();
}
function detect(){
  for(const kind of ['surficial','bedrock']){
    const hit=siteFeature(geo[kind],project.location);
    if(project.geology[kind])project.geology[kind]={...project.geology[kind],siteUnit:hit?.unitCode||hit?.name||null,siteDescription:hit?.description||null};
  }
  const kind=geologyKind()||'surficial',hit=siteFeature(geo[kind],project.location);
  $('geoUnitBadge').textContent=hit?.unitCode?.toUpperCase()||hit?.name||(geo[kind].length?'No hit':'—');
  $('geoLegend').innerHTML=hit?legendEntry(hit):geo[kind].length?'SITE is outside the loaded geology polygons.':`No ${kind} polygons loaded. Reload the source after reopening a saved project.`;
  updateLegend();preflight?.refresh();
}
function legendEntry(g){return `<div class="legend-row"><span class="swatch" style="background:${esc(g.color)}"></span><div><b>${esc(g.name)}</b><br>${esc(g.description)}</div></div>`;}
function updateLegend(){
  const box=$('mapLegend'),kind=geologyKind();box.style.display=kind?'block':'none';
  if(!kind)return;
  const units=relevantUnits(geo[kind],currentBounds());
  box.innerHTML='<b>LEGEND</b>'+units.map(g=>`<div class="map-legend-row"><span class="swatch" style="background:${esc(g.color)}"></span><span>${esc(g.name)}</span></div>`).join('');
  if(!units.length)box.innerHTML+='<small>No geology in this view</small>';
}
map.on('moveend',()=>{renderGeo();if(printSession?.isOpen)refreshPrint();});

$('saveProject').onclick=save;
$('newProject').onclick=()=>{if(confirm('Start a new local project? Export your current project first if you need a backup.')){localStorage.removeItem(STORAGE);localStorage.removeItem('phase-i-esa-project-v1');location.reload();}};
$('exportJson').onclick=()=>dl(`${safe(project.name||'phase-i-project')}.json`,JSON.stringify(project,null,2),'application/json');
$('importJson').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const imported=restoreProject(JSON.parse(await file.text()));project=imported;if(save())location.reload();}catch(error){status('saveMessage',`Project import failed: ${error.message}`,'error');}};
$('exportDxf').onclick=()=>dl(`${safe(project.name||'phase-i')}.dxf`,buildDxf(project),'application/dxf');
function printState(){
  const kind=geologyKind(),hit=kind?siteFeature(geo[kind],project.location):null;
  const covered=kind!=='surficial'||!project.location||containsBounds(geoCoverage.surficial,requiredGeologyBounds());
  return {project,figureCode:active,geologyLoaded:kind?geoReady[kind]&&covered&&geo[kind].length>0:true,geologySiteUnit:hit?.unitCode||hit?.name||null};
}
preflight=createPreflight({document,getState:printState});
printSession=createPrintSession({document,map,validate:()=>preflight.check(),fit:()=>zoom(active),render:()=>{renderGeo();refreshPrint();},waitForTiles:()=>waitForMapTiles($('map')),onRestore:()=>{renderGeo();}});
$('printA3').onclick=()=>{stopDrawing();printSession.open();};
$('closePrint').onclick=()=>printSession.close();
$('confirmPrint').onclick=()=>{if(!$('confirmPrint').disabled&&preflight.check())window.print();};
window.addEventListener('afterprint',()=>printSession.close());
document.addEventListener('keydown',e=>{if(e.key==='Escape')printSession.close();});
function refreshPrint(){
  const f=project.figures[active];
  $('printProject').textContent=project.name||'—';$('printAddress').textContent=project.address||'—';
  $('printNo').textContent=project.projectNo||'—';$('printDate').textContent=project.date||'—';
  $('printFigure').textContent=active;$('printTitle').textContent=f.title;
  $('printScale').textContent=`AS SHOWN · ${fmt(f.extentMeters)} minimum span`;
  const kind=geologyKind(),units=kind?relevantUnits(geo[kind],currentBounds()):[];
  $('printLegend').innerHTML=kind?(units.length?units.map(legendEntry).join(''):'No geology loaded'):
    '<div class="legend-row"><span class="site-key"></span>SITE</div>'+ (project.siteBoundary.length?'<div class="legend-row"><span class="line-key"></span>Site boundary</div>':'')+(project.buildingBoundary.length?'<div class="legend-row"><span class="building-key"></span>Building boundary</div>':'');
  const base=map.hasLayer(sat)?'Imagery © Esri and its data providers; acquisition date not verified.':'Base map © OpenStreetMap contributors.';
  $('printSource').textContent=[kind?geoSource[kind]:'',base].filter(Boolean).join(' | ');
}

function dl(n,t,ty){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([t],{type:ty}));a.download=n;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}function safe(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64)||'phase-i'}function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
sync();
