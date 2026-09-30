let plan=null, logs=[], sectionPts=[], drawing=false, finished=false, assignBhMode=false, downloadUrl=null;
const canvas=document.getElementById('planCanvas'), ctx=canvas.getContext('2d');

function resize(){
  const r=canvas.getBoundingClientRect();
  canvas.width=Math.max(1,r.width*devicePixelRatio);
  canvas.height=Math.max(1,r.height*devicePixelRatio);
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  draw();
}
window.addEventListener('resize',resize);

function mapFns(){
  if(!plan)return null;
  const [x0,y0,x1,y1]=plan.bbox;
  const w=canvas.clientWidth,h=canvas.clientHeight,pad=30;
  const s=Math.min((w-2*pad)/(x1-x0||1),(h-2*pad)/(y1-y0||1));
  return {
    toScreen:(x,y)=>[pad+(x-x0)*s,h-pad-(y-y0)*s],
    toWorld:(sx,sy)=>[x0+(sx-pad)/s,y0+(h-pad-sy)/s],
    s
  };
}
function color(aci){
  if(aci===1)return '#e33232';
  if(aci===3)return '#487f3b';
  if(aci===6)return '#c02cff';
  if(aci===5)return '#2a60c9';
  if(aci===87)return '#365f33';
  return '#6c7178';
}
function draw(){
  ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
  if(!plan)return;
  const m=mapFns();
  for(const pl of plan.polylines||[]){
    ctx.beginPath();
    pl.points.forEach((p,i)=>{const q=m.toScreen(p[0],p[1]);i?ctx.lineTo(...q):ctx.moveTo(...q)});
    if(pl.closed)ctx.closePath();
    ctx.strokeStyle=color(pl.color);ctx.lineWidth=pl.color===6?2.2:1;ctx.stroke();
  }
  for(const b of plan.boreholes||[]){
    const q=m.toScreen(b.x,b.y);
    ctx.beginPath();ctx.arc(q[0],q[1],6,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
    ctx.strokeStyle='#17202a';ctx.lineWidth=2;ctx.stroke();
    ctx.fillStyle='#17202a';ctx.font='12px sans-serif';ctx.fillText(b.id,q[0]+8,q[1]-8);
  }
  if(sectionPts.length){
    ctx.beginPath();sectionPts.forEach((p,i)=>{const q=m.toScreen(p.x,p.y);i?ctx.lineTo(...q):ctx.moveTo(...q)});
    ctx.strokeStyle='#d000ff';ctx.lineWidth=3;ctx.stroke();
    for(const p of sectionPts){const q=m.toScreen(p.x,p.y);ctx.beginPath();ctx.arc(q[0],q[1],4,0,Math.PI*2);ctx.fillStyle='#d000ff';ctx.fill();}
  }
}

async function gzipBlob(file){
  if(typeof CompressionStream==='undefined') return file;
  const stream=file.stream().pipeThrough(new CompressionStream('gzip'));
  const blob=await new Response(stream).blob();
  if(blob.size >= file.size*0.9) return file;
  return new File([blob], `${file.name}.gz`, {type:'application/gzip'});
}

async function parsePlanFile(file){
  let upload=file;
  if(file.size>3_000_000) upload=await gzipBlob(file);
  const fd=new FormData();fd.append('file',upload);
  const r=await fetch('/api/parse-plan',{method:'POST',body:fd});
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function parseLogFile(file){
  const fd=new FormData();fd.append('file',file);
  const r=await fetch('/api/parse-log',{method:'POST',body:fd});
  if(!r.ok) throw new Error(`${file.name}: ${await r.text()}`);
  return await r.json();
}

function resetProject(){
  plan=null;logs=[];sectionPts=[];drawing=false;finished=false;assignBhMode=false;
  if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=null;}
  document.getElementById('download').classList.add('hidden');
  document.getElementById('uploadStatus').textContent='';
  renderAll();draw();
}

document.getElementById('newProject').onclick=resetProject;
document.getElementById('uploadAll').onclick=async()=>{
  const sf=document.getElementById('uploadStatus');
  const pf=document.getElementById('planFile').files[0];
  const lfs=[...document.getElementById('logFiles').files];
  if(!pf && !lfs.length){sf.textContent='Choose a DXF and/or borehole PDF first.';return;}
  try{
    if(pf){
      sf.textContent=`Compressing/parsing ${pf.name}…`;
      plan=await parsePlanFile(pf);
      document.getElementById('metersPerUnit').value=plan.meters_per_unit||1;
    }
    if(lfs.length){
      logs=[];
      for(let i=0;i<lfs.length;i++){
        sf.textContent=`Parsing borehole log ${i+1}/${lfs.length}: ${lfs[i].name}…`;
        const parsed=await parseLogFile(lfs[i]);
        logs.push(...parsed);
      }
    }
    sf.textContent=`Parsed ${plan?.boreholes?.length||0} plan boreholes, ${logs.length} logs, ${plan?.lab_records?.length||0} lab records.`;
    renderAll();resize();
  }catch(err){
    console.error(err);sf.textContent=`Error: ${err.message||err}`;
  }
};

document.getElementById('drawMode').onclick=()=>{drawing=true;assignBhMode=false;finished=false};
document.getElementById('assignMode').onclick=()=>{assignBhMode=true;drawing=false};
document.getElementById('clearSection').onclick=()=>{sectionPts=[];finished=false;draw()};
document.getElementById('finishSection').onclick=()=>{drawing=false;finished=true;draw()};

canvas.addEventListener('click',e=>{
  if(!plan)return;
  const r=canvas.getBoundingClientRect(),m=mapFns();
  const [x,y]=m.toWorld(e.clientX-r.left,e.clientY-r.top);
  if(assignBhMode){
    const id=document.getElementById('manualBh').value;
    if(id){
      const key=id.replace('(MW)','');
      let b=plan.boreholes.find(q=>q.id.replace('(MW)','')===key);
      const l=logs.find(q=>q.borehole_id.replace('(MW)','')===key);
      if(b){b.x=x;b.y=y;b.source='manual';if(b.elevation==null)b.elevation=l?.ground_elevation??null;}
      else{plan.boreholes.push({id,x,y,elevation:l?.ground_elevation??null,source:'manual'});}
      assignBhMode=false;renderAll();draw();
    }
    return;
  }
  if(!drawing)return;
  sectionPts.push({x,y});draw();
});
canvas.addEventListener('dblclick',()=>{drawing=false;finished=true});
canvas.addEventListener('mousemove',e=>{
  if(!plan)return;
  const r=canvas.getBoundingClientRect(),m=mapFns();
  const [x,y]=m.toWorld(e.clientX-r.left,e.clientY-r.top);
  document.getElementById('cursor').textContent=`X ${x.toFixed(2)}  Y ${y.toFixed(2)}`;
});

function renderAll(){
  const list=document.getElementById('bhList');list.innerHTML='';
  const ids=new Map();
  (plan?.boreholes||[]).forEach(b=>ids.set(b.id,b));
  logs.forEach(l=>{if(!ids.has(l.borehole_id))ids.set(l.borehole_id,{id:l.borehole_id,x:null,y:null,elevation:l.ground_elevation})});
  const sel=document.getElementById('manualBh');sel.innerHTML='';
  for(const [id,b] of ids){
    const opt=document.createElement('option');opt.value=id;opt.textContent=id;sel.appendChild(opt);
    const d=document.createElement('label');d.className='bhitem';
    const found=plan?.boreholes?.find(x=>x.id.replace('(MW)','')===id.replace('(MW)',''));
    const log=logs.find(x=>x.borehole_id.replace('(MW)','')===id.replace('(MW)',''));
    d.innerHTML=`<input type="checkbox" ${found?'checked':''} data-id="${id}"><span>${id}</span><span>${found?(found.source||'plan'):''}${log?' + log':''}</span>`;
    list.appendChild(d);
  }
  document.getElementById('warnings').textContent=(plan?.warnings||[]).join(' · ');
  renderQA();
}

function renderQA(){
  const q=document.getElementById('qa');
  if(!logs.length){q.textContent='No logs parsed yet.';return;}
  let html='<table><tr><th>BH</th><th>Elev</th><th>Depth</th><th>Samples</th></tr>';
  for(const l of logs){
    html+=`<tr><td>${l.borehole_id}</td><td class="${l.ground_elevation==null?'warn':'ok'}">${l.ground_elevation??'DXF/manual'}</td><td>${l.total_depth??'?'}</td><td>${l.samples.length}</td></tr>`;
  }
  html+='</table>';q.innerHTML=html;
}

document.getElementById('generate').onclick=async()=>{
  if(!plan||sectionPts.length<2){alert('Upload files and draw a section line first.');return;}
  const checked=[...document.querySelectorAll('.bhitem input:checked')].map(x=>x.dataset.id);
  const bhs=[];
  for(const id of checked){
    const b=plan.boreholes.find(x=>x.id.replace('(MW)','')===id.replace('(MW)',''));
    const l=logs.find(x=>x.borehole_id.replace('(MW)','')===id.replace('(MW)',''));
    if(b)bhs.push({id,x:b.x,y:b.y,elevation:b.elevation??l?.ground_elevation??null});
  }
  if(!bhs.length){alert('No plan boreholes selected. Assign borehole points manually if automatic detection is incomplete.');return;}
  const request={
    section_name:document.getElementById('sectionName').value,
    points:sectionPts,
    boreholes:bhs,
    vertical_exaggeration:Number(document.getElementById('vex').value),
    horizontal_scale:'auto',vertical_scale:'auto',
    meters_per_unit:Number(document.getElementById('metersPerUnit').value||1)
  };
  const r=await fetch('/api/section',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({request,logs,lab_records:plan.lab_records||[]})
  });
  if(!r.ok){alert(await r.text());return;}
  const blob=await r.blob();
  if(downloadUrl)URL.revokeObjectURL(downloadUrl);
  downloadUrl=URL.createObjectURL(blob);
  const a=document.getElementById('download');a.href=downloadUrl;a.download=`${request.section_name.replace(/[^A-Za-z0-9_-]+/g,'_')}_cross-section.dxf`;a.classList.remove('hidden');a.textContent='Download generated DXF';
};

resize();renderAll();
