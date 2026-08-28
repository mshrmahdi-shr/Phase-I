import {createProject,restoreProject,closeRing,validBoundary,buildDxf} from './src/core.mjs';
import {parsePolys,resolveLinks,readKmz,relevantFeatures,relevantUnits,siteFeature,containsBounds} from './src/geology.mjs';
import {createPreflight} from './print-preflight.mjs';
import {createPrintSession,waitForMapTiles} from './src/print-session.mjs';
import {sourceForFigure} from './src/map-sources.mjs';
import {sheetGeometry,metricScale,captureFigureView} from './src/sheet-layout.mjs';
import {loadBedrockCache} from './src/bedrock-cache.mjs';
import {createExportDialog} from './src/export-selection.mjs';
import {exportCombinedPdf,planPdfExport} from './src/pdf-export.mjs';
import {createAssetStore} from './src/asset-store.mjs';
import {normalizeCompanyProfile,validateCompanyProfile} from './src/company-profile.mjs';
import {createCompanyProfileDialog} from './src/company-ui.mjs';
import {createProjectPackageUI} from './src/project-package-ui.mjs';
import {createDrawingController} from './src/drawing-controller.mjs';
import {createHistoricalImageryUI,migrateLegacyHistoricalImagery} from './src/historical-ui.mjs';
import {ONTARIO_IMAGERY_PROVIDER} from './src/imagery/providers/ontario.mjs';
import {TORONTO_IMAGERY_PROVIDER} from './src/imagery/providers/toronto.mjs';
import {OTTAWA_IMAGERY_PROVIDER} from './src/imagery/providers/ottawa.mjs';
const HISTORICAL_PROVIDERS=Object.freeze([ONTARIO_IMAGERY_PROVIDER,TORONTO_IMAGERY_PROVIDER,OTTAWA_IMAGERY_PROVIDER]);
const $=id=>document.getElementById(id), STORAGE='phase-i-esa-project-v2', COMPANY_STORAGE='phase-i-esa-company-profile-v1', MRD='./data/mrd128.kml';
const DRAWING_BINDINGS=Symbol.for('phase-i-esa.drawing-bindings');
document[DRAWING_BINDINGS]?.abort();
const drawingBindings=new window.AbortController();document[DRAWING_BINDINGS]=drawingBindings;
let project=(()=>{for(const k of [STORAGE,'phase-i-esa-project-v1']){try{const v=localStorage.getItem(k);if(v)return restoreProject(JSON.parse(v))}catch{}}return createProject()})();
let active='A',siteMarker,siteLayer,buildingLayer,draft,geoLayer,preflight,printSession,exportDialog,historicalUI,packageUI,exportBusy=false,companyProfile=null,printBranding=null;
const assetStore=createAssetStore();
function loadCompanyProfile(){try{const saved=localStorage.getItem(COMPANY_STORAGE);return saved?normalizeCompanyProfile(JSON.parse(saved)):null;}catch{return null;}}
function saveCompanyProfile(profile){const normalized=normalizeCompanyProfile(profile);localStorage.setItem(COMPANY_STORAGE,JSON.stringify(normalized));return normalized;}
const companyDialog=createCompanyProfileDialog({document,assetStore,loadProfile:loadCompanyProfile,saveProfile:saveCompanyProfile,Zip:JSZip,onChanged:profile=>{
  companyProfile=profile;preflight?.refresh();exportDialog?.refresh();if(!printSession?.isOpen)refreshPrint();
}});
let locationRevision=0;
const geoCoverage={surficial:null,bedrock:null},geoReady={surficial:false,bedrock:false},geoRequest={surficial:0,bedrock:0};
// Imports supersede dataset commits, but only an official request owns its load button.
const officialLoading={surficial:0,bedrock:0};
const geo={surficial:[],bedrock:[]}, geoSource={surficial:null,bedrock:null};
const map=L.map('map',{zoomSnap:0,fadeAnimation:false,zoomAnimation:false}).setView([43.75,-79.3],11);
map.getContainer().setAttribute('data-drawing-shortcuts','');
const baseSources={street:sourceForFigure('A'),satellite:sourceForFigure('B'),toporama:sourceForFigure('C')};
const baseLayers=Object.fromEntries(Object.entries(baseSources).map(([kind,source])=>[kind,source.createLayer(L)]));
let basemapKind='street';const sourceErrors=new Set();baseLayers.street.addTo(map);
for(const [kind,layer] of Object.entries(baseLayers)){
  layer.on('loading',()=>{sourceErrors.delete(kind);updateMapSourceStatus();});
  layer.on('tileerror',()=>{sourceErrors.add(kind);updateMapSourceStatus();});
}
map.createPane('geology');map.getPane('geology').style.zIndex=350;
const scaleControl=L.control({position:'bottomleft'});
scaleControl.onAdd=()=>{const element=L.DomUtil.create('div','metric-scale');element.id='metricScale';return element;};scaleControl.addTo(map);
function updateScale(){
  const box=$('metricScale'),width=map.getSize().x;if(!box||!width)return;
  const scale=metricScale(currentBounds(),width,printSession?.isOpen?208:160);
  const title=document.createElement('div');title.className='scale-caption';title.textContent='Approximate ground scale';
  const bar=document.createElement('div');bar.className='scale-bar';bar.style.width=`${scale.pixelWidth}px`;
  for(const segment of scale.segments){const span=document.createElement('span');span.className='scale-segment';span.style.background=segment.black?'#000':'#fff';bar.append(span);}
  const labels=document.createElement('div');labels.className='scale-labels';labels.style.width=`${scale.pixelWidth}px`;
  for(const label of scale.labels){const span=document.createElement('span');span.textContent=label;labels.append(span);}
  box.replaceChildren(title,bar,labels);
}
const north=L.control({position:'topright'});north.onAdd=()=>{const e=L.DomUtil.create('div','north-arrow');e.innerHTML='<div class="north-n">N</div><div class="north-glyph">▲</div>';return e};north.addTo(map);
const legendControl=L.control({position:'bottomright'});legendControl.onAdd=()=>{const e=L.DomUtil.create('div','map-legend');e.id='mapLegend';return e};legendControl.addTo(map);
function save(){
  project.updatedAt=new Date().toISOString();
  try{localStorage.setItem(STORAGE,JSON.stringify(project));$('saveState').textContent='Saved';}
  catch{ $('saveState').textContent='Not saved';status('saveMessage','Browser storage is unavailable or full. Export Project now to keep a backup.','error');preflight?.refresh();return false; }
  status('saveMessage','Saved in this browser. Export Project for a backup.');
  preflight?.refresh();exportDialog?.refresh();return true;
}
function persistHistoricalProject(next){
  const scoped=restoreProject({...project,historical:next.historical,historicalSequenceCounters:next.historicalSequenceCounters,updatedAt:new Date().toISOString()});
  try{localStorage.setItem(STORAGE,JSON.stringify(scoped));}
  catch{status('saveMessage','Browser storage is unavailable or full. Export Project now to keep a backup.','error');return false;}
  project=scoped;try{$('saveState').textContent='Saved';status('saveMessage','Saved in this browser. Export Project for a backup.');}catch{}return true;
}
function readPackageState(){return {project:structuredClone(project),companyProfile:companyProfile?structuredClone(companyProfile):null};}
function normalizedPackageState(next,{requireProfile=true}={}){
  if(!next||typeof next!=='object')throw new Error('Project package state is invalid.');
  const nextProject=restoreProject(next.project),nextProfile=next.companyProfile===null?null:normalizeCompanyProfile(next.companyProfile);
  if(nextProfile&&validateCompanyProfile(nextProfile).length||requireProfile&&!nextProfile)throw new Error('Project package company profile is incomplete.');
  if(requireProfile&&JSON.stringify(nextProject.companyProfileSnapshot)!==JSON.stringify(nextProfile))throw new Error('Project package company snapshot does not match its active company profile.');
  return {project:nextProject,companyProfile:nextProfile};
}
function restoreStorageValue(key,value){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}
async function persistPackageState(next,context={}){
  const normalized=normalizedPackageState(next,{requireProfile:context.phase!=='rollback'}),previousMemory=readPackageState(),previousProject=localStorage.getItem(STORAGE),previousCompany=localStorage.getItem(COMPANY_STORAGE);
  try{
    localStorage.setItem(STORAGE,JSON.stringify(normalized.project));if(normalized.companyProfile)localStorage.setItem(COMPANY_STORAGE,JSON.stringify(normalized.companyProfile));else localStorage.removeItem(COMPANY_STORAGE);project=normalized.project;companyProfile=normalized.companyProfile;return true;
  }catch(error){
    project=previousMemory.project;companyProfile=previousMemory.companyProfile;const failures=[];
    for(const [key,value] of [[STORAGE,previousProject],[COMPANY_STORAGE,previousCompany]])try{restoreStorageValue(key,value);}catch(restoreError){failures.push(restoreError);}
    if(failures.length)throw new AggregateError([error,...failures],'Project/profile metadata persistence and local rollback failed.',{cause:error});throw error;
  }
}
function status(id,t,k=''){$(id).textContent=t;$(id).dataset.kind=k}
function loadingButton(id,value){const button=$(id);button.dataset.loading=String(value);button.disabled=value||exportBusy;}
function sync(){for(const [id,k] of [['projectName','name'],['projectNo','projectNo'],['address','address'],['projectDate','date']])$(id).value=project[k]||'';$('dpi').value=project.dpi||300;$('dpiBadge').textContent=`${project.dpi||300} DPI`;if(project.location){map.setView([project.location.lat,project.location.lng],16);setMarker(project.location)};redraw();renderFigures();historicalUI?.refresh();refreshPrint();updateLegend();updateScale();updateMapSourceStatus()}
for(const [id,k] of [['projectName','name'],['projectNo','projectNo'],['address','address'],['projectDate','date']])$(id).oninput=e=>{project[k]=e.target.value;save();refreshPrint()};$('dpi').onchange=e=>{project.dpi=+e.target.value;$('dpiBadge').textContent=`${project.dpi} DPI`;save()};
$('searchAddress').onclick=async()=>{
  const q=$('address').value.trim();if(!q)return;
  loadingButton('searchAddress',true);status('searchStatus','Searching…');
  const revision=locationRevision;
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,{headers:{'Accept-Language':'en'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('Address service is unavailable. Try again later or use Set SITE.');
    const a=await r.json();if(!a.length)throw Error('Address not found. Try a more complete address or use Set SITE.');
    if(exportBusy||revision!==locationRevision)return;
    project.address=a[0].display_name;$('address').value=project.address;
    siteChanged({lat:+a[0].lat,lng:+a[0].lon});zoom(active);
    status('searchStatus',`Located: ${project.address}`,'ok');
  }catch(e){status('searchStatus',e.name==='TimeoutError'?'Address search timed out. Try again or use Set SITE.':e.message,'error');}
  finally{loadingButton('searchAddress',false);}
};
function siteChanged(location){
  if(exportBusy)return;
  const moved=!project.location||project.location.lat!==location.lat||project.location.lng!==location.lng;
  project.location=location;
  if(moved)for(const figure of Object.values(project.figures))delete figure.bounds;
  locationRevision++;setMarker(location);detect();renderFigures();save();historicalUI?.refresh();refreshPrint();
}
function setMarker(p){
  siteMarker?.remove();
  const icon=L.divIcon({className:'',html:'<div class="site-marker"></div>',iconSize:[18,18],iconAnchor:[9,9]});
  siteMarker=L.marker([p.lat,p.lng],{icon,draggable:true}).addTo(map).bindTooltip('SITE',{permanent:true,direction:'top',offset:[0,-8]});
  siteMarker.on('dragend',()=>{const q=siteMarker.getLatLng();siteChanged({lat:q.lat,lng:q.lng});});
  $('coords').textContent=`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
}
function deactivateDrawing(){map.getContainer().style.cursor='';map.doubleClickZoom.enable();}
const drawingController=createDrawingController({closeRing,validBoundary,
  onDraft:points=>{draft?.remove();draft=points.length?L.polyline(points.map(([x,y])=>[y,x]),{color:'#fbbf24',dashArray:'7 5'}).addTo(map):null;},
  onCommit:(mode,ring)=>{if(mode==='site')project.siteBoundary=ring;else project.buildingBoundary=ring;deactivateDrawing();redraw();save();},
  onCancel:()=>deactivateDrawing(),onStatus:message=>$('drawState').textContent=message
});
function beginDrawing(mode){if(exportBusy)return;drawingController.begin(mode);map.getContainer().style.cursor='crosshair';map.doubleClickZoom.disable();$('map').scrollIntoView({behavior:'smooth',block:'center'});}
$('setSite').onclick=()=>beginDrawing('marker');$('drawSite').onclick=()=>beginDrawing('site');$('drawBuilding').onclick=()=>beginDrawing('building');
$('undoPoint').onclick=()=>drawingController.undo();
$('finishDraw').onclick=()=>drawingController.finish();
$('clearGeometry').onclick=()=>{drawingController.cancel();project.siteBoundary=[];project.buildingBoundary=[];redraw();save();};
map.on('click',e=>{
  const mode=drawingController.state().mode;
  if(!mode||exportBusy)return;
  if(mode==='marker'){siteChanged({lat:e.latlng.lat,lng:e.latlng.lng});drawingController.cancel();return;}
  drawingController.add([e.latlng.lng,e.latlng.lat]);
});
document.addEventListener('keydown',event=>drawingController.handleKey(event),{signal:drawingBindings.signal});
map.getContainer().addEventListener('contextmenu',event=>drawingController.handleContextMenu(event),{signal:drawingBindings.signal});
window.addEventListener('pagehide',event=>{if(event.persisted)return;packageUI?.destroy();historicalUI?.destroy();drawingBindings.abort();if(document[DRAWING_BINDINGS]===drawingBindings)delete document[DRAWING_BINDINGS];},{signal:drawingBindings.signal});
function redraw(){siteLayer?.remove();buildingLayer?.remove();if(project.siteBoundary?.length)siteLayer=L.polygon(project.siteBoundary.map(([x,y])=>[y,x]),{color:'#ef4444',weight:4,fill:false}).addTo(map);if(project.buildingBoundary?.length)buildingLayer=L.polygon(project.buildingBoundary.map(([x,y])=>[y,x]),{color:'#111827',weight:3,dashArray:'6 4',fillColor:'#fff',fillOpacity:.1}).addTo(map)}
function renderFigures(){const h=$('figureList');h.innerHTML='';for(const [c,f] of Object.entries(project.figures)){const d=document.createElement('div');d.className='figure-row'+(c===active?' active':'');d.innerHTML=`<div class="figure-top"><div><div class="figure-code">FIGURE ${c}</div><div class="figure-title">${esc(f.title)}</div></div><span class="badge" title="${f.bounds?'Saved A3 map span':'Default A3 map span'}">${fmt(f.extentMeters)}</span></div><div class="figure-actions"><button title="${f.bounds?'Restore the saved A3 map position and zoom':'Show the current A3 map extent'}">${f.bounds?'View saved':'View'}</button><button title="Save the current map position and zoom for A3/PDF">${f.bounds?'Update A3 view':'Use for A3'}</button></div>`;d.children[1].children[0].onclick=()=>selectFig(c,true);d.children[1].children[1].onclick=()=>useForA3(c);h.appendChild(d)}}
function fmt(m){return m>=1000?`${m/1000} km`:`${m} m`;}
function currentBounds(){const b=map.getBounds();return{north:b.getNorth(),south:b.getSouth(),east:b.getEast(),west:b.getWest()};}
function requiredGeologyBounds(kind='surficial',includeView=false){
  const code=kind==='surficial'?'D':'E',bounds={...sheetGeometry(project,code,150).bounds};
  if(includeView&&active===code){const visible=currentBounds();for(const key of ['north','east'])bounds[key]=Math.max(bounds[key],visible[key]);for(const key of ['south','west'])bounds[key]=Math.min(bounds[key],visible[key]);}
  return bounds;
}
function selectFig(code,fit){
  if(exportBusy)return;
  active=code;drawingController.cancel();renderFigures();
  setBasemap(assignedBasemap());
  if(fit)zoom(code);renderGeo();detect();refreshPrint();preflight.refresh();
  const kind=geologyKind();
  if(kind&&project.location){
    const custom=geoSource[kind]?.id==='custom'||project.geology[kind]?.source?.id==='custom';
    if(custom){if(!geoReady[kind])status('geologyStatus','Reimport the custom geology file, or explicitly load the official source.','error');}
    else if(!geoReady[kind]||!containsBounds(geoCoverage[kind],requiredGeologyBounds(kind,true)))kind==='surficial'?loadMRD(false):loadOfficialBedrock(false);
  }
  if(fit)status('mapSourceStatus',`Figure ${code} A3 view restored (${fmt(project.figures[code].extentMeters)}). Output source: ${sourceForFigure(code).label}.`,'ok');
}
function useForA3(code){
  selectFig(code,false);
  try{
    const captured=captureFigureView(project,code,currentBounds());
    project.figures[code]={...project.figures[code],...captured};
    renderFigures();save();refreshPrint();preflight.refresh();
    status('mapSourceStatus',`Figure ${code} A3 view saved (${fmt(captured.extentMeters)}). Click View saved to restore it.`,'ok');
  }catch(error){status('mapSourceStatus',error.message,'error');}
}
function zoom(code,strict=false){
  if(!project.location)return;
  try{const b=sheetGeometry(project,code,150).bounds;map.fitBounds([[b.south,b.west],[b.north,b.east]],{padding:[0,0],animate:false});}
  catch(error){if(strict)throw error;status('mapSourceStatus',error.message,'error');}
}
function assignedBasemap(){return active==='B'?'satellite':active==='C'?'toporama':'street';}
function updateMapSourceStatus(){
  const source=baseSources[basemapKind],assigned=sourceForFigure(active);
  status('mapSourceStatus',sourceErrors.has(basemapKind)?`${source.label} source failed to load. Check the connection and retry; no substitute source is used.`:
    `Viewing ${source.label}. Figure ${active} output: ${assigned.label}. ${source.credits}`,
    sourceErrors.has(basemapKind)?'error':'');
}
function setBasemap(kind){
  if(exportBusy)return;
  if(active==='C')kind='toporama';
  basemapKind=kind;
  document.querySelectorAll('.basemap').forEach(b=>b.classList.toggle('active',b.dataset.map===kind));
  for(const [key,layer] of Object.entries(baseLayers)){if(key!==kind&&map.hasLayer(layer))map.removeLayer(layer);}
  if(!map.hasLayer(baseLayers[kind]))baseLayers[kind].addTo(map);updateMapSourceStatus();
}
for(const b of document.querySelectorAll('.basemap'))b.onclick=()=>setBasemap(b.dataset.map);

$('openEarth').onclick=()=>project.location?window.open(`https://earth.google.com/web/@${project.location.lat},${project.location.lng},500a,1000d,35y,0h,0t,0r`,'_blank','noopener,noreferrer'):alert('Set the site location first.');
$('loadMrd128').onclick=()=>loadMRD(true);
async function loadMRD(user=true){
  if(exportBusy)return;
  if(!project.location){if(user)status('geologyStatus','Locate the property first.','error');return;}
  const ticket=++geoRequest.surficial,revision=locationRevision;
  let bounds;try{bounds=requiredGeologyBounds('surficial',true);}catch(error){status('geologyStatus',error.message,'error');return;}
  officialLoading.surficial=ticket;
  geoReady.surficial=false;preflight.refresh();exportDialog?.refresh();loadingButton('loadMrd128',true);
  status('geologyStatus','Loading local OGS MRD128 cache…');
  try{
    const r=await fetch(MRD,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('The MRD128 index is unavailable.');
    const result=await resolveLinks({text:await r.text(),base:new URL(MRD,location.href).href,cacheRoot:new URL('./mrd128-cache/',location.href).href,kind:'surficial',bounds,JSZip,progress:t=>{if(ticket===geoRequest.surficial)status('geologyStatus',t);}});
    if(ticket!==geoRequest.surficial)return;
    if(exportBusy){status('geologyStatus','Reload MRD128 after PDF export finishes.');return;}
    if(revision!==locationRevision){status('geologyStatus','SITE changed while loading. Load MRD128 again for the final location.','error');return;}
    if(!result.features.length)throw Error('No cached geology polygons cover this location.');
    commitDataset(result.features,'surficial',{id:'MRD128-REV',name:'MRD128 / MRD128-REV, Surficial Geology of Southern Ontario',credits:'Ontario Geological Survey'},result.docs,bounds);
  }catch(e){if(ticket===geoRequest.surficial)status('geologyStatus',`MRD128 load failed: ${e.message} Check the published cache or import a polygon KML/KMZ.`,'error');}
  finally{if(ticket===officialLoading.surficial){officialLoading.surficial=0;loadingButton('loadMrd128',false);preflight.refresh();exportDialog?.refresh();}}
}
$('loadBedrock').onclick=()=>loadOfficialBedrock(true);
async function loadOfficialBedrock(user=true){
  if(exportBusy)return;
  if(!project.location){if(user)status('geologyStatus','Locate the property first.','error');return;}
  const ticket=++geoRequest.bedrock,revision=locationRevision;
  let bounds;try{bounds=requiredGeologyBounds('bedrock',true);}catch(error){status('geologyStatus',error.message,'error');return;}
  officialLoading.bedrock=ticket;
  geoReady.bedrock=false;preflight.refresh();exportDialog?.refresh();loadingButton('loadBedrock',true);
  status('geologyStatus','Loading local MRD126-REV1 With Lowlands geometry cache…');
  try{
    const result=await loadBedrockCache(bounds,{baseUrl:new URL('./mrd126-cache/',location.href).href});
    if(ticket!==geoRequest.bedrock)return;
    if(exportBusy){status('geologyStatus','Reload MRD126 Bedrock after PDF export finishes.');return;}
    if(revision!==locationRevision){status('geologyStatus','SITE changed while loading. Load MRD126 Bedrock again for the final location.','error');return;}
    if(!result.features.length)throw Error('No cached bedrock polygons cover this extent.');
    commitDataset(result.features,'bedrock',result.source,result.docs,result.coverage);
  }catch(error){if(ticket===geoRequest.bedrock)status('geologyStatus',`MRD126 Bedrock load failed: ${error.message} Check the published cache or import a polygon KML/KMZ.`,'error');}
  finally{if(ticket===officialLoading.bedrock){officialLoading.bedrock=0;loadingButton('loadBedrock',false);preflight.refresh();exportDialog?.refresh();}}
}
$('uploadGeology').onchange=async e=>{
  const file=e.target.files?.[0];if(!file||exportBusy)return;
  const kind=$('geologyKind').value,ticket=++geoRequest[kind];geoReady[kind]=false;exportDialog?.refresh();
  try{
    const text=/\.kmz$/i.test(file.name)?await readKmz(file,JSZip):await file.text();
    const features=parsePolys(text,kind);
    if(!features.length)throw Error('This file contains no polygons. Import a self-contained polygon KML/KMZ, not a NetworkLink index.');
    if(ticket===geoRequest[kind]&&!exportBusy)commitDataset(features,kind,{id:'custom',name:`Custom import: ${file.name}`},1,null);
  }catch(error){status('geologyStatus',`Import failed: ${error.message}`,'error');}
  finally{preflight.refresh();exportDialog?.refresh();}
};
function commitDataset(features,kind,source,docs,coverage){
  geo[kind]=features;geoSource[kind]=source;geoCoverage[kind]=coverage;geoReady[kind]=true;
  project.geology[kind]={name:source.name,source,count:features.length,docs};renderGeo();detect();save();refreshPrint();
  status('geologyStatus',`Loaded ${features.length.toLocaleString()} ${kind} polygon(s) from ${source.name}`,'ok');
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
map.on('moveend resize',()=>{renderGeo();updateScale();if(printSession?.isOpen)refreshPrint();});

$('saveProject').onclick=save;
$('newProject').onclick=()=>{if(confirm('Start a new local project? Export your current project first if you need a backup.')){localStorage.removeItem(STORAGE);localStorage.removeItem('phase-i-esa-project-v1');location.reload();}};
$('exportJson').onclick=()=>{dl(`${safe(project.name||'phase-i-project')}.legacy.json`,JSON.stringify(project,null,2),'application/json');status('saveMessage','Legacy JSON exported. It does not include the company logo or local historical image files; use Project Package for a complete backup.');};
$('importJson').onchange=async e=>{const file=e.target.files?.[0];if(!file||exportBusy)return;try{const imported=restoreProject(JSON.parse(await file.text()));if(exportBusy){status('saveMessage','Reimport the Legacy JSON after export finishes.');return;}project=imported;if(save())location.reload();}catch(error){status('saveMessage',`Legacy JSON project import failed: ${error.message}`,'error');}finally{e.target.value='';}};
$('exportDxf').onclick=async()=>{try{const branding=await companyDialog.outputSnapshot(companyProfile);dl(`${safe(project.name||'phase-i')}.dxf`,buildDxf(project,{companyProfile:branding.companyProfile}),'application/dxf');}catch(error){status('saveMessage',`DXF blocked: ${error.message}`,'error');await companyDialog.refresh();await companyDialog.open();}};
function printState(){
  const kind=geologyKind(),hit=kind?siteFeature(geo[kind],project.location):null;
  let covered=true;try{if(kind&&project.location)covered=containsBounds(geoCoverage[kind],requiredGeologyBounds(kind));}catch{covered=false;}
  return {project,companyProfile:printBranding?.companyProfile||companyProfile,figureCode:active,geologyLoaded:kind?geoReady[kind]&&covered&&geo[kind].length>0:true,geologySiteUnit:hit?.unitCode||hit?.name||null};
}
preflight=createPreflight({document,getState:printState});
printSession=createPrintSession({document,map,validate:()=>preflight.check(),fit:()=>zoom(active,true),render:()=>{renderGeo();refreshPrint();updateScale();},waitForTiles:()=>waitForMapTiles($('map')),onRestore:()=>{renderGeo();updateScale();}});
$('printA3').onclick=async()=>{if(exportBusy)return false;drawingController.cancel();setBasemap(assignedBasemap());try{printBranding=await companyDialog.outputSnapshot(companyProfile);renderCompanyBrand(printBranding);return await printSession.open();}catch(error){printBranding=null;status('saveMessage',`A3 output blocked: ${error.message}`,'error');await companyDialog.refresh();preflight.check();await companyDialog.open();return false;}};
$('closePrint').onclick=()=>{printSession.close();printBranding=null;};
$('confirmPrint').onclick=()=>{if(!$('confirmPrint').disabled&&preflight.check())window.print();};
window.addEventListener('afterprint',()=>{printSession.close();printBranding=null;},{signal:drawingBindings.signal});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('exportDialog').hidden&&$('companyProfileDialog').hidden){printSession.close();printBranding=null;}},{signal:drawingBindings.signal});
function datasets(){return Object.fromEntries(['surficial','bedrock'].map(kind=>[kind,{features:geoReady[kind]?geo[kind]:[],source:geoSource[kind],coverage:geoCoverage[kind]}]));}
let busyControls=[],busyHandlers=[];
function setExportBusy(value){
  exportBusy=value;
  if(value){
    busyControls=[...document.querySelectorAll('header button, main button, main input, main select')].map(node=>[node,node.disabled]);
    busyControls.forEach(([node])=>node.disabled=true);
    busyHandlers=[map.dragging,map.touchZoom,map.doubleClickZoom,map.scrollWheelZoom,map.boxZoom,map.keyboard,siteMarker?.dragging].filter(Boolean).map(handler=>[handler,handler.enabled()]);
    busyHandlers.forEach(([handler])=>handler.disable());
  }else{
    busyControls.forEach(([node,disabled])=>node.disabled=node.dataset.loading===undefined?disabled:node.dataset.loading==='true');busyControls=[];
    busyHandlers.forEach(([handler,enabled])=>{if(enabled)handler.enable();});busyHandlers=[];
  }
}
async function exportBrandedPdf(args){const branding=await companyDialog.outputSnapshot(args.companyProfile);return exportCombinedPdf({...args,...branding});}
exportDialog=createExportDialog({document,getState:()=>({project,datasets:datasets(),companyProfile,providers:HISTORICAL_PROVIDERS,assetStore}),save,setBusy:setExportBusy,exportPdf:exportBrandedPdf,planPdf:planPdfExport});
$('exportPdf').onclick=()=>{if(!printSession.isOpen)return exportDialog.open();};
function refreshPrint(){
  const f=project.figures[active];
  $('printProject').textContent=project.name||'—';$('printAddress').textContent=project.address||'—';
  $('printNo').textContent=project.projectNo||'—';$('printDate').textContent=project.date||'—';
  $('printFigure').textContent=active;$('printTitle').textContent=f.title;
  $('printScale').textContent='AS SHOWN';
  const kind=geologyKind(),units=kind?relevantUnits(geo[kind],currentBounds()):[];
  $('printLegend').innerHTML='<div class="legend-row"><span class="site-key"></span>SITE</div>'+ (project.siteBoundary.length?'<div class="legend-row"><span class="line-key"></span>Site boundary</div>':'')+(project.buildingBoundary.length?'<div class="legend-row"><span class="building-key"></span>Building boundary</div>':'')+(kind?(units.length?units.map(legendEntry).join(''):'No geology loaded'):'');
  const base=sourceForFigure(active).credits,source=kind?geoSource[kind]:null;
  $('printSource').textContent=[source?[source.name,source.credits].filter(Boolean).join('. '):'',base,active==='B'?'Imagery acquisition date not verified.':''].filter(Boolean).join(' | ');
}

function renderCompanyBrand({companyProfile:profile,companyLogoDataUrl}){
  $('printCompanyLogo').src=companyLogoDataUrl;$('printCompanyLogo').alt=`${profile.companyName} logo`;
  $('printCompanyName').textContent=profile.companyName;
  $('printCompanyContact').textContent=[profile.address,profile.phone,profile.email,profile.website].filter(Boolean).join(' · ');
  $('printCompanyLogo').closest('.tb-brand').dataset.logoAlign=profile.logoPlacement.align;$('printCompanyLogo').style.transform=`scale(${profile.logoPlacement.scale})`;
}

function dl(n,t,ty){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([t],{type:ty}));a.download=n;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}function safe(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64)||'phase-i'}function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}

try{
  const migration=await migrateLegacyHistoricalImagery({project,assetStore,saveProject:persistHistoricalProject});
  if(!migration.migrated)project=migration.project;else status('imageryStatus','Legacy historical imagery was validated and moved to IndexedDB. Export Project for a fresh backup.','ok');
}catch(error){status('imageryStatus',error.message,'error');status('saveMessage','Legacy imagery was not changed. Export Project now to preserve the original data before retrying.','error');}
historicalUI=createHistoricalImageryUI({document,map,L,assetStore,providers:HISTORICAL_PROVIDERS,getProject:()=>project,
  saveProject:persistHistoricalProject,isAssetReferencedOutsideHistorical:id=>(companyProfile||loadCompanyProfile())?.logoAssetId===id,onChanged:()=>{preflight?.refresh();exportDialog?.refresh();}});
async function initializePackageState(next,context={}){
  const normalized=normalizedPackageState(next,{requireProfile:context.phase!=='rollback'});project=normalized.project;companyProfile=normalized.companyProfile;drawingController.cancel();printSession?.close();printBranding=null;locationRevision++;
  for(const kind of ['surficial','bedrock']){geoRequest[kind]++;geo[kind].length=0;geoSource[kind]=null;geoCoverage[kind]=null;geoReady[kind]=false;}
  geoLayer?.remove();geoLayer=null;siteMarker?.remove();siteMarker=null;siteLayer?.remove();siteLayer=null;buildingLayer?.remove();buildingLayer=null;active='A';$('coords').textContent='No site selected';
  sync();await companyDialog.refresh();await historicalUI.refresh();preflight?.refresh();exportDialog?.refresh();return true;
}
packageUI=createProjectPackageUI({document,assetStore,Zip:JSZip,getState:readPackageState,readState:readPackageState,persistState:persistPackageState,initialize:initializePackageState,
  isAssetReferenced:(id,state)=>state?.companyProfile?.logoAssetId===id||state?.project?.historical?.some(item=>item.assetId===id),setBusy:setExportBusy,
  onCommitted:()=>{status('saveMessage','Project package imported and saved in this browser. Remote official imagery will be revalidated before export.','ok');preflight?.refresh();exportDialog?.refresh();}});
const openHistorical=()=>{if(exportBusy)return;drawingController.cancel();historicalUI.open();};
$('manageHistorical').onclick=openHistorical;$('manageHistoricalHeader').onclick=openHistorical;
sync();await companyDialog.refresh();if(!companyProfile)await companyDialog.open();
