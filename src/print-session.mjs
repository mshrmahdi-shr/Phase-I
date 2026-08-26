export function createPrintSession({document,map,validate,fit,render,waitForTiles,onRestore}){
  const byId=id=>document.getElementById(id);
  let view=null,generation=0;
  async function open(){
    if(view||!validate())return false;
    const ticket=++generation;
    view={center:map.getCenter(),zoom:map.getZoom()};
    byId('printPreview').hidden=false;
    document.body.classList.add('print-preview');
    byId('confirmPrint').disabled=true;
    byId('printStatus').textContent='Preparing A3 map. Waiting for all visible map tiles…';
    byId('printMapHost').appendChild(byId('map'));
    try{
      map.invalidateSize(false);fit();render();
      await waitForTiles();
      if(ticket!==generation||!view)return false;
      render();
      const legend=byId('printLegend');
      if(legend&&(legend.scrollHeight>legend.clientHeight+2||legend.scrollWidth>legend.clientWidth+2))throw new Error(`Figure ${byId('printFigure')?.textContent||''}: the legend does not fit this sheet. Choose a smaller extent or a dataset with fewer units.`);
      for(const [selector,label] of [['.tb-project','project name/address'],['.tb-title','figure title'],['.tb-details','project details'],['.tb-source','source credits']]){
        const cell=document.querySelector(selector);
        if(cell&&[cell,...cell.querySelectorAll('span,div')].some(node=>node.scrollHeight>node.clientHeight+2||node.scrollWidth>node.clientWidth+2)){
          throw new Error(`Figure ${byId('printFigure')?.textContent||''}: ${label} does not fit at a readable size. Shorten this field.`);
        }
      }
      byId('confirmPrint').disabled=false;
      document.body.classList.add('print-ready');
      byId('printStatus').textContent='Ready. Print at A3 landscape, 100% scale, with browser headers and footers disabled.';
      return true;
    }catch(error){
      if(ticket===generation)byId('printStatus').textContent=`Print blocked: ${error.message} Close preview, check the source and try again.`;
      return false;
    }
  }
  function close(){
    generation++;
    if(!view)return;
    const previous=view;view=null;
    byId('mapHome').appendChild(byId('map'));
    byId('printPreview').hidden=true;
    byId('confirmPrint').disabled=true;
    document.body.classList.remove('print-preview','print-ready');
    map.invalidateSize(false);map.setView(previous.center,previous.zoom,{animate:false});
    onRestore();
  }
  return {open,close,get isOpen(){return Boolean(view);}};
}

export async function waitForMapTiles(container,{timeoutMs=20000}={}){
  // Leaflet keeps a buffer of offscreen tiles; only the sheet's visible tiles
  // determine whether it can be printed. Layout has already been sized/fitted.
  const viewport=container.getBoundingClientRect();
  const images=[...container.querySelectorAll('.leaflet-tile')].filter(img=>{
    const r=img.getBoundingClientRect();
    return r.right>viewport.left&&r.left<viewport.right&&r.bottom>viewport.top&&r.top<viewport.bottom;
  });
  if(!images.length)throw new Error('No map tiles are available for this figure.');
  await Promise.all(images.map(img=>new Promise((resolve,reject)=>{
    if(img.complete){img.naturalWidth?resolve():reject(new Error('A map tile failed to load.'));return;}
    const done=error=>{clearTimeout(timer);img.removeEventListener('load',loaded);img.removeEventListener('error',failed);error?reject(error):resolve();};
    const loaded=()=>done(),failed=()=>done(new Error('A map tile failed to load.'));
    const timer=setTimeout(()=>done(new Error('Map tiles did not finish loading in time.')),timeoutMs);
    img.addEventListener('load',loaded,{once:true});img.addEventListener('error',failed,{once:true});
  })));
}
