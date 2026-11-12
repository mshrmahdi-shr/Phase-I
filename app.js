import {applyCompanyProfileToProject,createProject,requireProjectCompanyProfile,restoreProject,closeRing,validBoundary,buildDxf} from './src/core.mjs';
import {parsePolys,resolveLinks,readKmz,relevantFeatures,relevantUnits,siteFeature,containsBounds,geologyLegendLabel} from './src/geology.mjs';
import {createPreflight} from './print-preflight.mjs';
import {createPrintSession,waitForMapTiles} from './src/print-session.mjs';
import {sourceForFigure} from './src/map-sources.mjs';
import {sheetGeometry,metricScale,captureFigureView,geologySheetBounds} from './src/sheet-layout.mjs';
import {loadBedrockCache} from './src/bedrock-cache.mjs';
import {createExportDialog} from './src/export-selection.mjs';
import {exportCombinedPdf,planPdfExport} from './src/pdf-export.mjs';
import {exportCadPackage} from './src/cad-package.mjs';
import {createAssetStore} from './src/asset-store.mjs';
import {normalizeCompanyProfile,validateCompanyProfile} from './src/company-profile.mjs';
import {createCompanyProfileDialog} from './src/company-ui.mjs';
import {createProjectPackageUI} from './src/project-package-ui.mjs';
import {createDrawingController} from './src/drawing-controller.mjs';
import {createGeometryHistory} from './src/geometry-history.mjs';
import {createGeologyProvenanceController} from './src/geology-provenance-ui.mjs';
import {createHistoricalImageryUI,migrateLegacyHistoricalImagery} from './src/historical-ui.mjs';
import {ONTARIO_IMAGERY_PROVIDER} from './src/imagery/providers/ontario.mjs';
import {TORONTO_IMAGERY_PROVIDER} from './src/imagery/providers/toronto.mjs';
import {OTTAWA_IMAGERY_PROVIDER} from './src/imagery/providers/ottawa.mjs';
import {NAPL_IMAGERY_PROVIDER} from './src/imagery/providers/napl.mjs';
import {ESRI_WAYBACK_PROVIDER} from './src/imagery/providers/wayback.mjs';
import {createEsriKeyStore} from './src/esri-config.mjs';
const HISTORICAL_PROVIDERS=Object.freeze([ONTARIO_IMAGERY_PROVIDER,TORONTO_IMAGERY_PROVIDER,OTTAWA_IMAGERY_PROVIDER,NAPL_IMAGERY_PROVIDER,ESRI_WAYBACK_PROVIDER]);
const $=id=>document.getElementById(id), STORAGE='phase-i-esa-project-v2', COMPANY_STORAGE='phase-i-esa-company-profile-v1', MRD='./data/mrd128.kml';
const DRAWING_BINDINGS=Symbol.for('phase-i-esa.drawing-bindings');
document[DRAWING_BINDINGS]?.abort();
const drawingBindings=new window.AbortController();document[DRAWING_BINDINGS]=drawingBindings;
function loadCompanyProfile(){try{const saved=localStorage.getItem(COMPANY_STORAGE);return saved?normalizeCompanyProfile(JSON.parse(saved)):null;}catch{return null;}}
function saveCompanyProfile(profile){const normalized=normalizeCompanyProfile(profile);localStorage.setItem(COMPANY_STORAGE,JSON.stringify(normalized));return normalized;}
const assetStore=createAssetStore();
function dataUrlToBlob(dataUrl){
  const match=/^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if(!match)throw new Error('The bundled default logo data is invalid.');
  const bytes=Uint8Array.from(atob(match[2]),character=>character.charCodeAt(0));
  return new Blob([bytes],{type:match[1]});
}
async function ensureDefaultCompanyProfile(){
  const existing=loadCompanyProfile();
  if(existing)return existing;
  const logo=await assetStore.get(DEFAULT_FISHER_LOGO_ASSET_ID);
  if(!logo)await assetStore.addIfAbsent({metadata:DEFAULT_FISHER_LOGO_METADATA,blob:dataUrlToBlob(DEFAULT_FISHER_LOGO_DATA_URL)},{ownerToken:'fisher-default-profile-v1'});
  return saveCompanyProfile(normalizeCompanyProfile(DEFAULT_FISHER_PROFILE));
}
let companyProfile=loadCompanyProfile();
if(!companyProfile)companyProfile=await ensureDefaultCompanyProfile();
let project=(()=>{for(const k of [STORAGE,'phase-i-esa-project-v1']){try{const v=localStorage.getItem(k);if(v)return restoreProject(JSON.parse(v))}catch{}}return createProject({companyProfileSnapshot:companyProfile})})();
let active='A',siteMarker,siteLayer,buildingLayer,draft,geoLayer,preflight,printSession,exportDialog,historicalUI,packageUI,geologyProvenance,exportBusy=false,printBranding=null,packagePersistenceToken=null;
let annotationMode=null,annotationTarget=null;const annotationLayers=[];
let requestProjectImport=()=>false;
const companyDialog=createCompanyProfileDialog({document,assetStore,loadProfile:loadCompanyProfile,saveProfile:saveCompanyProfile,Zip:JSZip,isAssetReferenced:id=>project.companyProfileSnapshot?.logoAssetId===id,onOpenProject:()=>requestProjectImport(),onChanged:profile=>{
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
  return {project:nextProject,companyProfile:nextProfile};
}
function restoreStorageValue(key,value){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}
function samePackageState(left,right){return JSON.stringify(left)===JSON.stringify(right);}
function storageMatchesPackageState(expected){
  return localStorage.getItem(STORAGE)===JSON.stringify(expected.project)&&localStorage.getItem(COMPANY_STORAGE)===(expected.companyProfile?JSON.stringify(expected.companyProfile):null);
}
async function persistPackageState(next,context={}){
  if(!['commit','rollback'].includes(context.phase)||typeof context.transactionToken!=='string'||context.transactionToken.length<16||context.transactionToken.length>256)throw new Error('Project package persistence context is invalid.');
  if(context.phase==='rollback'){
    const expected=normalizedPackageState(context.expected);
    if(packagePersistenceToken!==context.transactionToken||!samePackageState(readPackageState(),expected)||!storageMatchesPackageState(expected))throw new Error('Project package rollback conflict: later project or company edits were preserved.');
  }
  const normalized=normalizedPackageState(next,{requireProfile:context.phase!=='rollback'}),previousMemory=readPackageState(),previousProject=localStorage.getItem(STORAGE),previousCompany=localStorage.getItem(COMPANY_STORAGE),previousToken=packagePersistenceToken;
  try{
    localStorage.setItem(STORAGE,JSON.stringify(normalized.project));if(normalized.companyProfile)localStorage.setItem(COMPANY_STORAGE,JSON.stringify(normalized.companyProfile));else localStorage.removeItem(COMPANY_STORAGE);project=normalized.project;companyProfile=normalized.companyProfile;packagePersistenceToken=context.phase==='commit'?context.transactionToken:null;return true;
  }catch(error){
    project=previousMemory.project;companyProfile=previousMemory.companyProfile;packagePersistenceToken=previousToken;const failures=[];
    for(const [key,value] of [[STORAGE,previousProject],[COMPANY_STORAGE,previousCompany]])try{restoreStorageValue(key,value);}catch(restoreError){failures.push(restoreError);}
    if(failures.length)throw new AggregateError([error,...failures],'Project/profile metadata persistence and local rollback failed.',{cause:error});throw error;
  }
}
const workflowErrors=new Map(),workflowLabels={searchStatus:'Address search',saveMessage:'Project save',imageryStatus:'Imagery',geologyStatus:'Geology',geologyProvenanceStatus:'Geology source',historicalStatus:'Historical imagery',companyProfileStatus:'Company profile',projectPackageStatus:'Project package',mapSourceStatus:'Map source',exportProgress:'Export'};
let errorCenterDismissed=false;
function renderWorkflowIssues(newError){
  const panel=$('errorCenter');if(!panel)return;
  if(!workflowErrors.size){panel.hidden=true;errorCenterDismissed=false;return;}
  if(newError)errorCenterDismissed=false;
  if(errorCenterDismissed){panel.hidden=true;return;}
  const list=$('errorCenterList');list.replaceChildren();
  for(const [id,message] of workflowErrors){const item=document.createElement('li');item.textContent=`${workflowLabels[id]||id}: ${message}`;list.append(item);}
  $('errorCenterTitle').textContent=workflowErrors.size===1?'Problem requiring attention':`${workflowErrors.size} problems requiring attention`;
  panel.hidden=false;
}
function status(id,t,k=''){const node=$(id);if(!node)return;node.textContent=t;node.dataset.kind=k;if(k==='error'&&t)workflowErrors.set(id,t);else if(k!=='error')workflowErrors.delete(id);renderWorkflowIssues(k==='error'&&Boolean(t));}
$('dismissErrorCenter').onclick=()=>{errorCenterDismissed=true;$('errorCenter').hidden=true;};
function loadingButton(id,value){const button=$(id);if(!button)return;button.dataset.loading=String(value);button.disabled=value||exportBusy;}
function sync(){for(const [id,k] of [['projectName','name'],['projectNo','projectNo'],['address','address'],['projectDate','date']])$(id).value=project[k]||'';$('dpi').value=project.dpi||300;$('dpiBadge').textContent=`${project.dpi||300} DPI`;if(project.location){map.setView([project.location.lat,project.location.lng],16);setMarker(project.location)};redraw();renderFigures();historicalUI?.refresh();refreshPrint();updateLegend();updateScale();updateMapSourceStatus()}
for(const [id,k] of [['projectName','name'],['projectNo','projectNo'],['address','address'],['projectDate','date']])$(id).oninput=e=>{project[k]=e.target.value;save();refreshPrint()};$('dpi').onchange=e=>{project.dpi=+e.target.value;$('dpiBadge').textContent=`${project.dpi} DPI`;save()};
$('searchAddress').onclick=async()=>{
  const q=$('address').value.trim();if(!q)return;
  loadingButton('searchAddress',true);status('searchStatus','Searching…');
  const revision=locationRevision;
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&limit=1&q=${encodeURIComponent(q)}`,{headers:{'Accept-Language':'en'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('Address service is unavailable. Try again later or use Set SITE.');
    const a=await r.json();if(!a.length)throw Error('Address not found. Try a more complete address or use Set SITE.');
    if(exportBusy||revision!==locationRevision)return;
    project.address=a[0].display_name;$('address').value=project.address;
    siteChanged({lat:+a[0].lat,lng:+a[0].lon});const suggested=geocoderBoundary(a[0]);if(!project.siteBoundary?.length&&suggested){const before=geometrySnapshot();project.siteBoundary=suggested;recordGeometryChange(before);redraw();save();status('searchStatus',`Located: ${project.address}. An editable boundary was added from the address source; review it before export.`,'ok');}else status('searchStatus',`Located: ${project.address}`,'ok');zoom(active);
  }catch(e){status('searchStatus',e.name==='TimeoutError'?'Address search timed out. Try again or use Set SITE.':e.message,'error');}
  finally{loadingButton('searchAddress',false);}
};
function siteChanged(location){
  if(exportBusy)return;
  const moved=!project.location||project.location.lat!==location.lat||project.location.lng!==location.lng;
  project.location=location;
  if(moved){
    for(const kind of ['surficial','bedrock']){if(officialLoading[kind]){geoRequest[kind]++;officialLoading[kind]=0;}}
    for(const figure of Object.values(project.figures))delete figure.bounds;
  }
  locationRevision++;setMarker(location);detect();renderFigures();save();historicalUI?.refresh();refreshPrint();autoLoadOfficialGeology();
}
function geocoderBoundary(result){const geometry=result?.geojson;if(!geometry||!['Polygon','MultiPolygon'].includes(geometry.type))return null;const candidates=geometry.type==='Polygon'?[geometry.coordinates?.[0]]:(geometry.coordinates||[]).map(polygon=>polygon?.[0]);const rings=candidates.filter(ring=>Array.isArray(ring)&&ring.length>=4).map(ring=>ring.map(point=>[Number(point?.[0]),Number(point?.[1])])).filter(ring=>ring.every(point=>Number.isFinite(point[0])&&Number.isFinite(point[1])));if(!rings.length)return null;const ring=rings.sort((a,b)=>b.length-a.length)[0],closed=closeRing(ring);return validBoundary(closed)?closed:null;}
function setMarker(p){
  siteMarker?.remove();
  const icon=L.divIcon({className:'',html:'<div class="site-marker"></div>',iconSize:[18,18],iconAnchor:[9,9]});
  siteMarker=L.marker([p.lat,p.lng],{icon,draggable:true}).addTo(map).bindTooltip('SITE',{permanent:true,direction:'top',offset:[0,-8]});
  siteMarker.on('dragend',()=>{const q=siteMarker.getLatLng();siteChanged({lat:q.lat,lng:q.lng});});
  $('coords').textContent=`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
}
function deactivateDrawing(){map.getContainer().style.cursor='';map.doubleClickZoom.enable();}
const geometryHistory=createGeometryHistory();
let geometryEditMode=null,geometryHandles=[],geometryDragBefore=null,drawingBefore=null;
function geometrySnapshot(){return {siteBoundary:(project.siteBoundary||[]).map(point=>[...point]),buildingBoundary:(project.buildingBoundary||[]).map(point=>[...point])};}
function updateGeometryHistoryButtons(){
  const undo=$('undoPoint'),redo=$('redoPoint');
  if(undo)undo.disabled=exportBusy||(!drawingController.state().mode&&!geometryHistory.canUndo());
  if(redo)redo.disabled=exportBusy||Boolean(drawingController.state().mode)||!geometryHistory.canRedo();
}
function recordGeometryChange(before){if(before&&geometryHistory.record(before,geometrySnapshot()))updateGeometryHistoryButtons();}
function removeGeometryHandles(){while(geometryHandles.length)geometryHandles.pop().remove();}
function openBoundary(mode){
  const boundary=mode==='site'?project.siteBoundary:project.buildingBoundary;
  if(!Array.isArray(boundary)||boundary.length<4)return [];
  const closed=boundary.length>1&&boundary[0][0]===boundary.at(-1)[0]&&boundary[0][1]===boundary.at(-1)[1];
  return closed?boundary.slice(0,-1):boundary.slice();
}
function movedBoundaryVertex(mode,index,latlng){
  const open=openBoundary(mode);if(index<0||index>=open.length)return null;
  open[index]=[latlng.lng,latlng.lat];return closeRing(open);
}
function updateBoundaryLayer(mode,ring){
  const layer=mode==='site'?siteLayer:buildingLayer;
  layer?.setLatLngs(ring.map(([x,y])=>[y,x]));
}
function renderGeometryHandles(mode){
  removeGeometryHandles();
  for(const [index,[lng,lat]] of openBoundary(mode).entries()){
    const handle=L.marker([lat,lng],{draggable:true,icon:L.divIcon({className:'geometry-vertex-handle',html:'<span></span>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map);
    handle.on('dragstart',()=>{geometryDragBefore=geometrySnapshot();});
    handle.on('drag',event=>{
      const candidate=movedBoundaryVertex(mode,index,event.target.getLatLng());
      if(candidate&&validBoundary(candidate))updateBoundaryLayer(mode,candidate);
    });
    handle.on('dragend',event=>{
      const candidate=movedBoundaryVertex(mode,index,event.target.getLatLng()),before=geometryDragBefore;
      geometryDragBefore=null;
      if(!candidate||!validBoundary(candidate)){
        status('drawState','That corner would make the boundary invalid. The previous position was restored.','error');
        redraw();renderGeometryHandles(mode);return;
      }
      if(mode==='site')project.siteBoundary=candidate;else project.buildingBoundary=candidate;
      recordGeometryChange(before);save();redraw();renderGeometryHandles(mode);
      status('drawState',mode==='site'?'Editing SITE corners — drag a handle or choose Undo.':'Editing building corners — drag a handle or choose Undo.','ok');
    });
    geometryHandles.push(handle);
  }
}
function startGeometryEdit(mode){
  const boundary=openBoundary(mode);if(boundary.length<3){status('drawState','Draw the '+(mode==='site'?'SITE':'building')+' boundary first.','error');return false;}
  geometryEditMode=mode;redraw();renderGeometryHandles(mode);
  status('drawState',mode==='site'?'Editing SITE corners — drag a handle.':'Editing building corners — drag a handle.','ok');
  return true;
}
function stopGeometryEdit(message='Idle'){removeGeometryHandles();geometryEditMode=null;geometryDragBefore=null;status('drawState',message);}
function applyGeometrySnapshot(next){
  const editMode=geometryEditMode;
  project.siteBoundary=next.siteBoundary.map(point=>[...point]);project.buildingBoundary=next.buildingBoundary.map(point=>[...point]);
  redraw();if(editMode)renderGeometryHandles(editMode);save();updateGeometryHistoryButtons();
}
function undoGeometry(){
  if(drawingController.state().mode)return drawingController.undo();
  const next=geometryHistory.undo();if(!next){status('drawState','Nothing to undo.');return undefined;}
  applyGeometrySnapshot(next);status('drawState',geometryEditMode?'Last corner change undone.':'Last geometry change undone.','ok');return next;
}
function redoGeometry(){
  if(drawingController.state().mode)return undefined;
  const next=geometryHistory.redo();if(!next){status('drawState','Nothing to redo.');return undefined;}
  applyGeometrySnapshot(next);status('drawState',geometryEditMode?'Corner change restored.':'Geometry change restored.','ok');return next;
}
function toggleGeometryEdit(mode){
  if(exportBusy)return;
  if(geometryEditMode===mode){stopGeometryEdit();return;}
  if(drawingController.state().mode)drawingController.cancel();
  startGeometryEdit(mode);
}
const drawingController=createDrawingController({closeRing,validBoundary,onUndo:undoGeometry,onRedo:redoGeometry,
  onDraft:points=>{draft?.remove();draft=points.length?L.polyline(points.map(([x,y])=>[y,x]),{color:'#fbbf24',dashArray:'7 5'}).addTo(map):null;},
  onCommit:(mode,ring)=>{if(mode==='site')project.siteBoundary=ring;else project.buildingBoundary=ring;recordGeometryChange(drawingBefore);drawingBefore=null;deactivateDrawing();redraw();save();updateGeometryHistoryButtons();},
  onCancel:()=>deactivateDrawing(),onStatus:message=>$('drawState').textContent=message
});
function beginDrawing(mode){if(exportBusy)return;stopGeometryEdit();drawingBefore=mode==='site'||mode==='building'?geometrySnapshot():null;drawingController.begin(mode);map.getContainer().style.cursor='crosshair';map.doubleClickZoom.disable();$('map').scrollIntoView({behavior:'smooth',block:'center'});}
$('setSite').onclick=()=>beginDrawing('marker');$('drawSite').onclick=()=>beginDrawing('site');$('drawBuilding').onclick=()=>beginDrawing('building');
$('undoPoint').onclick=()=>reportDrawResult(undoGeometry());$('redoPoint').onclick=()=>reportDrawResult(redoGeometry());$('editSiteCorners').onclick=()=>toggleGeometryEdit('site');$('editBuildingCorners').onclick=()=>toggleGeometryEdit('building');
function reportDrawResult(result){if(result&&result.ok===false)status('drawState',result.message,'error');return result;}
$('finishDraw').onclick=()=>reportDrawResult(drawingController.finish());
$('clearGeometry').onclick=()=>{const before=geometrySnapshot();stopGeometryEdit();drawingController.cancel();project.siteBoundary=[];project.buildingBoundary=[];recordGeometryChange(before);redraw();save();updateGeometryHistoryButtons();};
function annotationText(){const text=$('annotationText').value.trim();if(!text)throw new Error('Enter annotation text first.');return text;}
function cancelAnnotation(message='No annotation tool active.'){annotationMode=null;annotationTarget=null;map.getContainer().style.cursor='';status('annotationStatus',message);}
function beginAnnotation(mode){if(exportBusy)return;try{annotationText();drawingController.cancel();annotationMode=mode;annotationTarget=null;map.getContainer().style.cursor='crosshair';status('annotationStatus',mode==='text'?`Click the Figure ${active} map to place the masked text.`:`Click the arrow point on Figure ${active}, then click the label position.`,'ok');$('map').scrollIntoView({behavior:'smooth',block:'center'});}catch(error){status('annotationStatus',error.message,'error');$('annotationText').focus();}}
$('placeText').onclick=()=>beginAnnotation('text');$('placeLeader').onclick=()=>beginAnnotation('leader-target');
function annotationId(){return globalThis.crypto?.randomUUID?.()||`note-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;}
function commitAnnotation(position,target=null){project.annotations.push({id:annotationId(),figureCode:active,text:annotationText(),position:{lat:position.lat,lng:position.lng},target:target?{lat:target.lat,lng:target.lng}:null,mask:true});cancelAnnotation(`Annotation added to Figure ${active}.`);redrawAnnotations();save();refreshPrint();}
$('clearAnnotations').onclick=()=>{const before=project.annotations.length;project.annotations=project.annotations.filter(item=>item.figureCode!==active);cancelAnnotation(before===project.annotations.length?`Figure ${active} has no notes.`:`Notes cleared from Figure ${active}.`);redrawAnnotations();save();refreshPrint();};
map.on('click',e=>{
  if(annotationMode&&!exportBusy){
    if(annotationMode==='text'){commitAnnotation(e.latlng);return;}
    if(annotationMode==='leader-target'){annotationTarget=e.latlng;annotationMode='leader-label';status('annotationStatus','Arrow point set. Now click where the masked label should sit.','ok');return;}
    if(annotationMode==='leader-label'){commitAnnotation(e.latlng,annotationTarget);return;}
  }
  const mode=drawingController.state().mode;
  if(!mode||exportBusy)return;
  if(mode==='marker'){siteChanged({lat:e.latlng.lat,lng:e.latlng.lng});drawingController.cancel();return;}
  drawingController.add([e.latlng.lng,e.latlng.lat]);
});
document.addEventListener('keydown',event=>{if(annotationMode&&event.key==='Escape'){event.preventDefault();cancelAnnotation('Annotation placement cancelled.');return;}reportDrawResult(drawingController.handleKey(event));},{signal:drawingBindings.signal});
map.getContainer().addEventListener('contextmenu',event=>reportDrawResult(drawingController.handleContextMenu(event)),{signal:drawingBindings.signal});
window.addEventListener('pagehide',event=>{if(event.persisted)return;packageUI?.destroy();historicalUI?.destroy();geologyProvenance?.destroy();drawingBindings.abort();if(document[DRAWING_BINDINGS]===drawingBindings)delete document[DRAWING_BINDINGS];},{signal:drawingBindings.signal});
function redraw(){siteLayer?.remove();buildingLayer?.remove();siteLayer=buildingLayer=null;if(project.siteBoundary?.length)siteLayer=L.polygon(project.siteBoundary.map(([x,y])=>[y,x]),{color:'#ef4444',weight:4,fill:false}).addTo(map);if(active==='B'&&project.buildingBoundary?.length)buildingLayer=L.polygon(project.buildingBoundary.map(([x,y])=>[y,x]),{color:'#111827',weight:3,dashArray:'6 4',fillColor:'#fff',fillOpacity:.1}).addTo(map);redrawAnnotations()}
function annotationBearing(target,position){const lat=(target.lat+position.lat)/2*Math.PI/180;return Math.atan2((position.lng-target.lng)*Math.cos(lat),position.lat-target.lat)*180/Math.PI;}
function annotationIcon(annotation){const wrapper=document.createElement('div');wrapper.className='map-annotation-label';wrapper.textContent=annotation.text;return L.divIcon({className:'annotation-icon-shell',html:wrapper.outerHTML,iconSize:null,iconAnchor:[0,18]});}
function redrawAnnotations(){while(annotationLayers.length)annotationLayers.pop().remove();const list=$('annotationList');list.replaceChildren();const items=(project.annotations||[]).filter(item=>item.figureCode===active);for(const item of items){
  if(item.target){annotationLayers.push(L.polyline([[item.position.lat,item.position.lng],[item.target.lat,item.target.lng]],{color:'#111827',weight:2.2,interactive:false}).addTo(map));const arrow=document.createElement('span');arrow.className='annotation-arrow-tip';arrow.style.transform=`rotate(${annotationBearing(item.target,item.position)}deg)`;annotationLayers.push(L.marker([item.target.lat,item.target.lng],{interactive:false,icon:L.divIcon({className:'annotation-arrow-shell',html:arrow.outerHTML,iconSize:[16,16],iconAnchor:[8,8]})}).addTo(map));}
  annotationLayers.push(L.marker([item.position.lat,item.position.lng],{interactive:false,icon:annotationIcon(item)}).addTo(map));
  const row=document.createElement('div');row.className='annotation-list-row';const text=document.createElement('span');text.textContent=item.text;const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.onclick=()=>{project.annotations=project.annotations.filter(value=>value.id!==item.id);redrawAnnotations();save();refreshPrint();};row.append(text,remove);list.append(row);
  }if(!items.length){const empty=document.createElement('p');empty.className='helper';empty.textContent=`No notes on Figure ${active}.`;list.append(empty);}}
function renderFigures(){const h=$('figureList');h.innerHTML='';for(const [c,f] of Object.entries(project.figures)){const d=document.createElement('div');d.className='figure-row'+(c===active?' active':'');d.innerHTML=`<div class="figure-top"><div><div class="figure-code">FIGURE ${c}</div><div class="figure-title">${esc(f.title)}</div></div><span class="badge" title="${f.bounds?'Saved A3 map span':'Default A3 map span'}">${fmt(f.extentMeters)}</span></div><div class="figure-actions"><button title="${f.bounds?'Restore the saved A3 map position and zoom':'Show the current A3 map extent'}">${f.bounds?'View saved':'View'}</button><button title="Save the current map position and zoom for A3/PDF">${f.bounds?'Update A3 view':'Use for A3'}</button></div>`;d.children[1].children[0].onclick=()=>selectFig(c,true);d.children[1].children[1].onclick=()=>useForA3(c);h.appendChild(d)}}
function fmt(m){return m>=1000?`${m/1000} km`:`${m} m`;}
function currentBounds(){const b=map.getBounds();return{north:b.getNorth(),south:b.getSouth(),east:b.getEast(),west:b.getWest()};}
function requiredGeologyBounds(kind='surficial'){return geologySheetBounds(project,kind,150);}
function selectFig(code,fit){
  if(exportBusy)return;
  active=code;drawingController.cancel();cancelAnnotation();redraw();renderFigures();
  setBasemap(assignedBasemap());
  if(fit)zoom(code);renderGeo();detect();refreshPrint();preflight.refresh();refreshGeologyProvenanceAction();
  const kind=geologyKind();
  if(kind&&project.location){
    const custom=geoSource[kind]?.id==='custom'||project.geology[kind]?.source?.id==='custom';
    if(custom){if(!geoReady[kind])status('geologyStatus','Reimport the custom geology file, or explicitly load the official source.','error');}
    else if(!geoReady[kind]||!containsBounds(geoCoverage[kind],requiredGeologyBounds(kind)))kind==='surficial'?loadMRD(false):loadOfficialBedrock(false);
  }
  if(fit)status('mapSourceStatus',`Figure ${code} A3 view restored (${fmt(project.figures[code].extentMeters)}). Output source: ${sourceForFigure(code).label}.`,'ok');
}
function useForA3(code){
  selectFig(code,false);
  try{
    const captured=captureFigureView(project,code,currentBounds());
    project.figures[code]={...project.figures[code],...captured};
    renderFigures();save();refreshPrint();preflight.refresh();autoLoadOfficialGeology();
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

$('openEarth').onclick=()=>project.location?window.open(`https://earth.google.com/web/@${project.location.lat},${project.location.lng},500a,1000d,35y,0h,0t,0r`,'_blank','noopener,noreferrer'):status('imageryStatus','Set the site location first.','error');
const esriKeyStore=createEsriKeyStore();
function refreshEsriKeyStatus(){const configured=Boolean(esriKeyStore.load());status('esriKeyStatus',configured?'Esri API key is configured in this browser. It is not included in project packages or source files.':'Optional: enter an Esri API key for this browser only. It is never included in project exports.',configured?'ok':'');}
$('saveEsriApiKey').onclick=()=>{try{esriKeyStore.save($('esriApiKey').value);$('esriApiKey').value='';refreshEsriKeyStatus();status('imageryStatus','Esri key saved locally. Reloading the map layers…','ok');setTimeout(()=>location.reload(),150);}catch(error){status('esriKeyStatus',error.message,'error');}};
refreshEsriKeyStatus();
async function loadMRD(user=true){
  if(exportBusy)return;
  if(!project.location){if(user)status('geologyStatus','Locate the property first.','error');return;}
  const ticket=++geoRequest.surficial,revision=locationRevision;
  let bounds;try{bounds=requiredGeologyBounds('surficial');}catch(error){status('geologyStatus',error.message,'error');return;}
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
    commitDataset(result.features,'surficial',{id:'MRD128-REV',name:'MRD128 / MRD128-REV, Surficial Geology of Southern Ontario',credits:'Ontario Geological Survey',sourceUrl:'https://www.geologyontario.mndm.gov.on.ca/mndmaccess/mndm_dir.asp?type=pub&id=MRD128-REV',license:'https://www.ontario.ca/page/open-government-licence-ontario',redistributionEvidence:'official-open-government-licence'},result.docs,bounds);
  }catch(e){if(ticket===geoRequest.surficial)status('geologyStatus',`MRD128 load failed: ${e.message} Check the published cache or import a polygon KML/KMZ.`,'error');}
  finally{if(ticket===officialLoading.surficial){officialLoading.surficial=0;loadingButton('loadMrd128',false);preflight.refresh();exportDialog?.refresh();}}
}
async function loadOfficialBedrock(user=true){
  if(exportBusy)return;
  if(!project.location){if(user)status('geologyStatus','Locate the property first.','error');return;}
  const ticket=++geoRequest.bedrock,revision=locationRevision;
  let bounds;try{bounds=requiredGeologyBounds('bedrock');}catch(error){status('geologyStatus',error.message,'error');return;}
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
function autoLoadOfficialGeology(){
  if(!project.location||exportBusy)return;
  const needsOfficial=kind=>project.geology[kind]?.source?.id!=='custom'&&(!geoReady[kind]||!containsBounds(geoCoverage[kind],requiredGeologyBounds(kind)));
  if(needsOfficial('surficial')&&!officialLoading.surficial)void loadMRD(false);
  if(needsOfficial('bedrock')&&!officialLoading.bedrock)void loadOfficialBedrock(false);
}
geologyProvenance=createGeologyProvenanceController({document,parsePolys,readKmz,Zip:JSZip,onCommit:async({mode,kind,source,features,docs,coverage,requestToken})=>{
  if(exportBusy)throw new Error('Finish the current export before changing geology provenance.');
  if(mode==='import'){if(requestToken!==geoRequest[kind])throw new Error('A newer geology request replaced this import. Reopen the final file.');commitDataset(features,kind,source,docs,coverage);return;}
  if(project.geology[kind]?.source?.id!=='custom')throw new Error('The saved custom geology source is no longer current.');const previousProject=project,previousRuntime=geoSource[kind];project={...project,geology:{...project.geology,[kind]:{...project.geology[kind],name:source.name,source}}};if(geoSource[kind]?.id==='custom')geoSource[kind]=source;if(!save()){project=previousProject;geoSource[kind]=previousRuntime;throw new Error('The corrected provenance could not be saved.');}refreshGeologyProvenanceAction();status('geologyStatus',`Updated ${kind} custom source details.`,'ok');
}});
$('uploadGeology').onchange=async e=>{const file=e.target.files?.[0];if(!file||exportBusy)return;const kind=$('geologyKind').value,ticket=++geoRequest[kind];try{const committed=await geologyProvenance.importFile(file,kind,{requestToken:ticket});if(!committed)status('geologyStatus','Custom geology import cancelled; the current dataset was not changed.');}catch(error){status('geologyStatus',`Import failed: ${error.message}`,'error');}finally{e.target.value='';preflight.refresh();exportDialog?.refresh();refreshGeologyProvenanceAction();}};
$('editGeologyProvenance').onclick=async()=>{if(exportBusy)return;const kind=geologyKind()||$('geologyKind').value,source=geoSource[kind]||project.geology[kind]?.source;try{await geologyProvenance.editSource(kind,source);}catch(error){status('geologyStatus',error.message,'error');}};
$('geologyKind').onchange=refreshGeologyProvenanceAction;
function refreshGeologyProvenanceAction(){const kind=geologyKind()||$('geologyKind').value,source=geoSource[kind]||project.geology[kind]?.source;$('editGeologyProvenance').hidden=source?.id!=='custom';}
function commitDataset(features,kind,source,docs,coverage){
  geo[kind]=features;geoSource[kind]=source;geoCoverage[kind]=coverage;geoReady[kind]=true;
  project.geology[kind]={name:source.name,source,count:features.length,docs};renderGeo();detect();save();refreshPrint();
  refreshGeologyProvenanceAction();status('geologyStatus',`Loaded ${features.length.toLocaleString()} ${kind} polygon(s) from ${source.name}`,'ok');
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
function legendEntry(g){const label=geologyLegendLabel(g);return `<div class="legend-row geology-legend-row" data-unit-code="${esc(label.code)}"><span class="swatch" style="background:${esc(g.color)}"></span><div class="legend-copy"><strong>${esc(label.heading)}</strong>${label.description?`<span>${esc(label.description)}</span>`:''}</div></div>`;}
function updateLegend(){
  const box=$('mapLegend'),kind=geologyKind();box.style.display=kind?'block':'none';
  if(!kind)return;
  const units=relevantUnits(geo[kind],currentBounds());
  box.innerHTML='<b>LEGEND</b>'+units.map(g=>{const label=geologyLegendLabel(g);return `<div class="map-legend-row"><span class="swatch" style="background:${esc(g.color)}"></span><span><strong>${esc(label.heading)}</strong></span></div>`;}).join('');
  if(!units.length)box.innerHTML+='<small>No geology in this view</small>';
}
map.on('moveend resize',()=>{renderGeo();updateScale();if(printSession?.isOpen)refreshPrint();});

$('saveProject').onclick=save;
$('applyCompanyTemplate').onclick=async()=>{
  if(exportBusy)return false;
  if(!companyProfile){status('saveMessage','Complete and save the reusable Company Profile before assigning project branding.','error');await companyDialog.open();return false;}
  if(!confirm(`Apply the current reusable company template (${companyProfile.companyName}) to this project? Existing project outputs will use this company and logo after you confirm.`))return false;
  const previous=project;
  try{
    project=applyCompanyProfileToProject(project,companyProfile);
    if(!save())throw new Error('The updated project branding could not be saved in browser storage.');
    status('saveMessage',`Project branding updated explicitly to ${companyProfile.companyName}.`,'ok');refreshPrint();return true;
  }catch(error){project=previous;sync();status('saveMessage',`Project branding was not changed: ${error.message}`,'error');return false;}
};
$('newProject').onclick=()=>{if(confirm('Start a new local project? Export your current project first if you need a backup.')){localStorage.removeItem(STORAGE);localStorage.removeItem('phase-i-esa-project-v1');location.reload();}};
$('exportJson').onclick=()=>{dl(`${safe(project.name||'phase-i-project')}.legacy.json`,JSON.stringify(project,null,2),'application/json');status('saveMessage','Legacy JSON exported. It does not include the company logo or local historical image files; use Project Package for a complete backup.');};
$('importJson').onchange=async e=>{const file=e.target.files?.[0];if(!file||exportBusy)return;try{const imported=restoreProject(JSON.parse(await file.text()));if(exportBusy){status('saveMessage','Reimport the Legacy JSON after export finishes.');return;}project=imported;if(save())location.reload();}catch(error){status('saveMessage',`Legacy JSON project import failed: ${error.message}`,'error');}finally{e.target.value='';}};
$('exportDxf').onclick=async()=>{try{const branding=await companyDialog.outputSnapshot(projectOutputProfile());dl(`${safe(project.name||'phase-i')}.dxf`,buildDxf(project,{companyProfile:branding.companyProfile}),'application/dxf');}catch(error){status('saveMessage',`DXF blocked: ${error.message}`,'error');await companyDialog.refresh();if(!project.companyProfileSnapshot)$('applyCompanyTemplate').focus();else await companyDialog.open();}};
function projectOutputProfile(){return requireProjectCompanyProfile(project);}
function printState(){
  const kind=geologyKind(),hit=kind?siteFeature(geo[kind],project.location):null;
  let covered=true;try{if(kind&&project.location)covered=containsBounds(geoCoverage[kind],requiredGeologyBounds(kind));}catch{covered=false;}
  return {project,companyProfile:printBranding?.companyProfile||project.companyProfileSnapshot,figureCode:active,geologyLoaded:kind?geoReady[kind]&&covered&&geo[kind].length>0:true,geologySiteUnit:hit?.unitCode||hit?.name||null};
}
preflight=createPreflight({document,getState:printState});
printSession=createPrintSession({document,map,validate:()=>preflight.check(),fit:()=>zoom(active,true),render:()=>{renderGeo();refreshPrint();updateScale();},waitForTiles:()=>waitForMapTiles($('map')),onRestore:()=>{renderGeo();updateScale();}});
$('printA3').onclick=async()=>{if(exportBusy)return false;drawingController.cancel();setBasemap(assignedBasemap());try{printBranding=await companyDialog.outputSnapshot(projectOutputProfile());renderCompanyBrand(printBranding);return await printSession.open();}catch(error){printBranding=null;status('saveMessage',`A3 output blocked: ${error.message}`,'error');await companyDialog.refresh();preflight.check();if(!project.companyProfileSnapshot)$('applyCompanyTemplate').focus();else await companyDialog.open();return false;}};
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
    busyHandlers.forEach(([handler,enabled])=>{const marker=handler._marker;if(enabled&&(!marker||marker._map&&marker._icon))handler.enable();});busyHandlers=[];
  }
}
async function exportBrandedPdf(args){const branding=await companyDialog.outputSnapshot(args.companyProfile);return exportCombinedPdf({...args,...branding});}
async function prepareCadBranding(expected,{signal}={}){
  signal?.throwIfAborted();const branding=await companyDialog.outputSnapshot(expected);signal?.throwIfAborted();return Object.freeze({companyProfile:branding.companyProfile,companyLogo:branding.companyLogo});
}
exportDialog=createExportDialog({document,getState:()=>({project,datasets:datasets(),companyProfile:project.companyProfileSnapshot,providers:HISTORICAL_PROVIDERS,assetStore}),save,setBusy:setExportBusy,exportPdf:exportBrandedPdf,planPdf:planPdfExport,prepareCadBranding,exportCadPackage});
$('exportPdf').onclick=()=>{if(!printSession.isOpen)return exportDialog.open();};
function refreshPrint(){
  const f=project.figures[active];
  $('printProject').textContent=project.name||'—';$('printAddress').textContent=project.address||'—';
  $('printNo').textContent=project.projectNo||'—';$('printDate').textContent=project.date||'—';
  $('printFigure').textContent=active;$('printTitle').textContent=f.title;
  $('printScale').textContent='AS SHOWN';
  const kind=geologyKind(),units=kind?relevantUnits(geo[kind],currentBounds()):[];
  $('printLegend').innerHTML='<div class="legend-row"><span class="site-key"></span>SITE</div>'+ (project.siteBoundary.length?'<div class="legend-row"><span class="line-key"></span>Site boundary</div>':'')+(active==='B'&&project.buildingBoundary.length?'<div class="legend-row"><span class="building-key"></span>Building boundary</div>':'')+(kind?(units.length?units.map(legendEntry).join(''):'No geology loaded'):'');
  const base=sourceForFigure(active).credits,source=kind?geoSource[kind]:null;
  $('printSource').textContent=[source?[source.name,source.credits].filter(Boolean).join('. '):'',base,active==='B'?'Imagery acquisition date not verified.':''].filter(Boolean).join(' | ');
}

function renderCompanyBrand({companyProfile:profile,companyLogoDataUrl}){
  $('printCompanyLogo').src=companyLogoDataUrl;$('printCompanyLogo').alt=`${profile.companyName} logo`;
  $('printCompanyName').textContent=profile.companyName;
  $('printCompanyContact').textContent=[profile.address,profile.phone,profile.email,profile.website].filter(Boolean).join(' · ');
  $('printCompanyLogo').closest('.tb-brand').dataset.logoAlign=profile.logoPlacement.align;$('printCompanyLogo').style.transform=`scale(${profile.logoPlacement.scale})`;
}

function dl(n,t,ty){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([t],{type:ty}));a.href=url;a.download=n;a.hidden=true;document.body.append(a);a.click();a.hidden=false;a.textContent='Download '+n;a.style.cssText='position:fixed;right:1rem;bottom:1rem;z-index:10000;padding:.7rem 1rem;background:#078dcc;color:#fff;border-radius:.4rem;font:600 14px system-ui;';setTimeout(()=>{a.remove();URL.revokeObjectURL(url)},30000)}function safe(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64)||'phase-i'}function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}

try{
  const migration=await migrateLegacyHistoricalImagery({project,assetStore,saveProject:persistHistoricalProject});
  if(!migration.migrated)project=migration.project;else status('imageryStatus','Legacy historical imagery was validated and moved to IndexedDB. Export Project for a fresh backup.','ok');
}catch(error){status('imageryStatus',error.message,'error');status('saveMessage','Legacy imagery was not changed. Export Project now to preserve the original data before retrying.','error');}
historicalUI=createHistoricalImageryUI({document,map,L,assetStore,providers:HISTORICAL_PROVIDERS,getProject:()=>project,
  saveProject:persistHistoricalProject,isAssetReferencedOutsideHistorical:id=>companyProfile?.logoAssetId===id||project.companyProfileSnapshot?.logoAssetId===id,onChanged:()=>{preflight?.refresh();exportDialog?.refresh();}});
async function initializePackageState(next,context={}){
  const normalized=normalizedPackageState(next,{requireProfile:context.phase!=='rollback'});project=normalized.project;companyProfile=normalized.companyProfile;drawingController.cancel();printSession?.close();printBranding=null;locationRevision++;
  for(const kind of ['surficial','bedrock']){geoRequest[kind]++;geo[kind].length=0;geoSource[kind]=null;geoCoverage[kind]=null;geoReady[kind]=false;}
  geoLayer?.remove();geoLayer=null;siteMarker?.remove();siteMarker=null;siteLayer?.remove();siteLayer=null;buildingLayer?.remove();buildingLayer=null;active='A';$('coords').textContent='No site selected';
  sync();autoLoadOfficialGeology();await companyDialog.refresh();updateGeometryHistoryButtons();await historicalUI.refresh();preflight?.refresh();exportDialog?.refresh();return true;
}
packageUI=createProjectPackageUI({document,assetStore,Zip:JSZip,getState:readPackageState,readState:readPackageState,persistState:persistPackageState,initialize:initializePackageState,
  isAssetReferenced:(id,state)=>state?.companyProfile?.logoAssetId===id||state?.project?.companyProfileSnapshot?.logoAssetId===id||state?.project?.historical?.some(item=>item.assetId===id),setBusy:setExportBusy,
  onCommitted:()=>{status('saveMessage','Project package imported and saved in this browser. Remote official imagery will be revalidated before export.','ok');preflight?.refresh();exportDialog?.refresh();}});
requestProjectImport=()=>{companyDialog.hideForExternalFlow();return packageUI.selectFile();};
const openHistorical=()=>{if(exportBusy)return;drawingController.cancel();historicalUI.open();};
$('manageHistorical').onclick=openHistorical;$('manageHistoricalHeader').onclick=openHistorical;
sync();autoLoadOfficialGeology();await companyDialog.refresh();if(!companyProfile)status('saveMessage','Complete the Company Profile only when you are ready to create PDF/CAD outputs.');else if(!project.companyProfileSnapshot)status('saveMessage','This legacy project has no assigned branding. Review the reusable Company Profile, then choose Apply Current Template to Project before creating outputs.','error');

async function loadAppVersion(){
  const node=$('appVersion');if(!node)return;
  try{
    const response=await fetch('./version.json',{cache:'no-store'});if(!response.ok)throw new Error('version unavailable');
    const data=await response.json(),revision=String(data.revision||'local').trim()||'local';
    node.textContent=`Version ${revision==='local-development'?'local':revision.slice(0,8)}`;
    node.title=data.builtAt?`Build ${data.builtAt}`:'Application build version';
  }catch{node.textContent='Version local';}
}
loadAppVersion();
