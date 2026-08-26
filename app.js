import { createProject, closeRing, pointInPolygon, buildDxf } from './src/core.mjs';

const $=id=>document.getElementById(id);
const STORAGE='phase-i-esa-project-v1';
let project=loadProject() || createProject();
let drawMode=null, drawPoints=[];
let siteMarker=null, siteLayer=null, buildingLayer=null, draftLayer=null, geologyLayer=null;
let geologyFeatures=[];
let activeFigure='A';

const map=L.map('map',{zoomControl:true}).setView([43.75,-79.3],11);
const street=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
const satellite=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Tiles © Esri'});

function loadProject(){try{return JSON.parse(localStorage.getItem(STORAGE)||'null')}catch{return null}}
function persist(){project.updatedAt=new Date().toISOString();localStorage.setItem(STORAGE,JSON.stringify(project));$('saveState').textContent='Saved';setTimeout(()=>$('saveState').textContent='Local',900)}
function setStatus(id,msg){$(id).textContent=msg}
function syncInputs(){
  $('projectName').value=project.name||'';$('projectNo').value=project.projectNo||'';$('address').value=project.address||'';$('projectDate').value=project.date||'';$('dpi').value=String(project.dpi||300);$('dpiBadge').textContent=`${project.dpi||300} DPI`;
  if(project.location){map.setView([project.location.lat,project.location.lng],16);ensureSiteMarker(project.location)}
  redrawStoredGeometry();renderFigures();renderAerials();refreshPrintFields();
}
function bindField(id,key){$(id).addEventListener('input',e=>{project[key]=e.target.value;persist();refreshPrintFields()})}
for(const [id,key] of [['projectName','name'],['projectNo','projectNo'],['address','address'],['projectDate','date']]) bindField(id,key);
$('dpi').addEventListener('change',e=>{project.dpi=Number(e.target.value);$('dpiBadge').textContent=`${project.dpi} DPI`;persist()});

$('searchAddress').onclick=async()=>{
  const q=$('address').value.trim();if(!q)return;
  setStatus('searchStatus','Searching…');
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,{headers:{'Accept-Language':'en'}});
    const rows=await r.json();if(!rows.length)throw new Error('Address not found');
    const hit=rows[0];project.address=hit.display_name;project.location={lat:Number(hit.lat),lng:Number(hit.lon)};$('address').value=hit.display_name;
    ensureSiteMarker(project.location);map.setView([project.location.lat,project.location.lng],17);persist();setStatus('searchStatus',`Located: ${hit.display_name}`);detectGeology();
  }catch(e){setStatus('searchStatus',`Search failed: ${e.message}`)}
};

function ensureSiteMarker(loc){
  if(siteMarker) siteMarker.remove();
  const icon=L.divIcon({className:'',html:'<div class="site-marker"></div>',iconSize:[18,18],iconAnchor:[9,9]});
  siteMarker=L.marker([loc.lat,loc.lng],{icon,draggable:true}).addTo(map).bindTooltip('SITE',{permanent:true,direction:'top',offset:[0,-8]});
  siteMarker.on('dragend',()=>{const p=siteMarker.getLatLng();project.location={lat:p.lat,lng:p.lng};$('coords').textContent=`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;persist();detectGeology()});
  $('coords').textContent=`${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
}

function startDraw(mode){drawMode=mode;drawPoints=[];if(draftLayer){draftLayer.remove();draftLayer=null}$('drawState').textContent=mode==='site'?'Drawing site':'Drawing building';map.getContainer().style.cursor='crosshair'}
$('setSite').onclick=()=>{drawMode='marker';$('drawState').textContent='Tap site';map.getContainer().style.cursor='crosshair'};
$('drawSite').onclick=()=>startDraw('site');$('drawBuilding').onclick=()=>startDraw('building');
$('undoPoint').onclick=()=>{drawPoints.pop();redrawDraft()};
$('finishDraw').onclick=()=>finishDraw();
$('clearGeometry').onclick=()=>{project.siteBoundary=[];project.buildingBoundary=[];redrawStoredGeometry();persist()};

map.on('click',e=>{
  if(!drawMode)return;
  if(drawMode==='marker'){project.location={lat:e.latlng.lat,lng:e.latlng.lng};ensureSiteMarker(project.location);drawMode=null;$('drawState').textContent='Idle';map.getContainer().style.cursor='';persist();detectGeology();return}
  drawPoints.push([e.latlng.lng,e.latlng.lat]);redrawDraft();
});
function redrawDraft(){if(draftLayer)draftLayer.remove();if(!drawPoints.length)return;draftLayer=L.polyline(drawPoints.map(([lng,lat])=>[lat,lng]),{color:'#fbbf24',weight:3,dashArray:'7 5'}).addTo(map)}
function finishDraw(){
  if(!drawMode||drawMode==='marker'||drawPoints.length<3){drawMode=null;$('drawState').textContent='Idle';map.getContainer().style.cursor='';return}
  const ring=closeRing(drawPoints);if(drawMode==='site')project.siteBoundary=ring;else project.buildingBoundary=ring;
  drawMode=null;drawPoints=[];if(draftLayer){draftLayer.remove();draftLayer=null}$('drawState').textContent='Idle';map.getContainer().style.cursor='';redrawStoredGeometry();persist();
}
function redrawStoredGeometry(){
  if(siteLayer)siteLayer.remove();if(buildingLayer)buildingLayer.remove();
  if(project.siteBoundary?.length)siteLayer=L.polygon(project.siteBoundary.map(([lng,lat])=>[lat,lng]),{color:'#ef4444',weight:4,fill:false}).addTo(map);
  if(project.buildingBoundary?.length)buildingLayer=L.polygon(project.buildingBoundary.map(([lng,lat])=>[lat,lng]),{color:'#111827',weight:3,dashArray:'6 4',fillColor:'#fff',fillOpacity:.10}).addTo(map);
}

function renderFigures(){
  const host=$('figureList');host.innerHTML='';
  for(const [code,f] of Object.entries(project.figures)){
    const row=document.createElement('div');row.className='figure-row'+(code===activeFigure?' active':'');
    row.innerHTML=`<div class="figure-top"><div><div class="figure-code">FIGURE ${code}</div><div class="figure-title">${f.title}</div></div><span class="badge">${Math.round(f.extentMeters/100)/10} km</span></div><div class="figure-meta">Context: ${f.extentMeters.toLocaleString()} m • ${f.status}</div><div class="figure-actions"><button data-action="view">View extent</button><button data-action="select">Use for A3</button></div>`;
    row.querySelector('[data-action="view"]').onclick=()=>zoomFigure(code);row.querySelector('[data-action="select"]').onclick=()=>{activeFigure=code;renderFigures();refreshPrintFields()};host.appendChild(row);
  }
}
function zoomFigure(code){const loc=project.location;if(!loc)return;const meters=project.figures[code].extentMeters;const radius=Math.max(80,meters/2);map.fitBounds(L.circle([loc.lat,loc.lng],{radius}).getBounds(),{padding:[24,24]})}

for(const b of document.querySelectorAll('.basemap')) b.onclick=()=>{
  document.querySelectorAll('.basemap').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  if(b.dataset.map==='satellite'){map.removeLayer(street);satellite.addTo(map)}else{map.removeLayer(satellite);street.addTo(map)}
};

$('uploadAerial').addEventListener('change',async e=>{
  const file=e.target.files?.[0];if(!file)return;const year=Number($('aerialYear').value)||new Date().getFullYear();
  const dataUrl=await fileToDataUrl(file);project.historical=project.historical||[];project.historical.push({id:crypto.randomUUID(),year,name:file.name,size:file.size,dataUrl});persist();renderAerials();setStatus('imageryStatus',`Added ${file.name} (${Math.round(file.size/1024)} KB) for ${year}.`);e.target.value='';
});
function fileToDataUrl(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)})}
function renderAerials(){
  const items=project.historical||[];$('aerialCount').textContent=items.length;
  $('aerialList').innerHTML=items.length?items.map(x=>`<div style="margin:5px 0">${x.year} — ${escapeHtml(x.name)}</div>`).join(''):'No historical imagery added.';
}
$('openEarth').onclick=()=>{if(!project.location)return alert('Set the site location first.');window.open(`https://earth.google.com/web/@${project.location.lat},${project.location.lng},500a,1000d,35y,0h,0t,0r`,'_blank')};

$('uploadGeology').addEventListener('change',async e=>{
  const file=e.target.files?.[0];if(!file)return;setStatus('geologyStatus','Reading geology file…');
  try{
    let kml='';if(file.name.toLowerCase().endsWith('.kmz')){if(!window.JSZip)throw new Error('KMZ library unavailable');const zip=await JSZip.loadAsync(file);const entry=Object.values(zip.files).find(x=>x.name.toLowerCase().endsWith('.kml'));if(!entry)throw new Error('No KML found inside KMZ');kml=await entry.async('text')}else kml=await file.text();
    geologyFeatures=parseKmlPolygons(kml);if(!geologyFeatures.length)throw new Error('No polygon features found');project.geology=project.geology||{};project.geology[$('geologyKind').value]={name:file.name,count:geologyFeatures.length};renderGeology();persist();detectGeology();setStatus('geologyStatus',`Loaded ${geologyFeatures.length} polygon feature(s) from ${file.name}.`);
  }catch(err){setStatus('geologyStatus',`Import failed: ${err.message}`)}e.target.value='';
});
function parseKmlPolygons(kml){
  const doc=new DOMParser().parseFromString(kml,'application/xml');const placemarks=[...doc.querySelectorAll('Placemark')];const out=[];
  for(const pm of placemarks){const name=pm.querySelector('name')?.textContent?.trim()||'Geology unit';const desc=pm.querySelector('description')?.textContent?.replace(/<[^>]+>/g,' ')?.trim()||'';
    for(const c of pm.querySelectorAll('Polygon outerBoundaryIs LinearRing coordinates')){const pts=c.textContent.trim().split(/\s+/).map(t=>t.split(',').slice(0,2).map(Number)).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1]));if(pts.length>=3)out.push({name,description:desc,polygon:closeRing(pts)})}
  }return out;
}
function renderGeology(){if(geologyLayer)geologyLayer.remove();if(!geologyFeatures.length)return;geologyLayer=L.layerGroup(geologyFeatures.map((g,i)=>L.polygon(g.polygon.map(([lng,lat])=>[lat,lng]),{color:['#22c55e','#06b6d4','#f59e0b','#a78bfa'][i%4],weight:1,fillOpacity:.22}).bindPopup(`<b>${escapeHtml(g.name)}</b><br>${escapeHtml(g.description)}`))).addTo(map)}
function detectGeology(){
  if(!project.location||!geologyFeatures.length)return;const pt=[project.location.lng,project.location.lat];const hit=geologyFeatures.find(g=>pointInPolygon(pt,g.polygon));
  $('geoUnitBadge').textContent=hit?.name||'No hit';$('geoLegend').textContent=hit?`${hit.name}${hit.description?` — ${hit.description}`:''}`:'The site point does not intersect a loaded polygon.';
}

$('saveProject').onclick=persist;
$('newProject').onclick=()=>{if(!confirm('Start a new local project?'))return;project=createProject();localStorage.setItem(STORAGE,JSON.stringify(project));location.reload()};
$('exportJson').onclick=()=>download(`${safeName(project.name||'phase-i-project')}.json`,JSON.stringify(project,null,2),'application/json');
$('importJson').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{project=JSON.parse(await file.text());persist();location.reload()}catch{alert('Invalid project JSON')}});
$('exportDxf').onclick=()=>download(`${safeName(project.name||'phase-i')}.dxf`,buildDxf(project),'application/dxf');
$('printA3').onclick=()=>{refreshPrintFields();window.print()};
function refreshPrintFields(){const f=project.figures[activeFigure];$('printProject').textContent=[project.name,project.address].filter(Boolean).join(' — ')||'—';$('printNo').textContent=project.projectNo||'—';$('printDate').textContent=project.date||'—';$('printFigure').textContent=activeFigure;$('printTitle').textContent=f?.title||''}
function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500)}
function safeName(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64)||'phase-i'}
function escapeHtml(s=''){return s.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}

syncInputs();
