import {sourceForFigure} from './map-sources.mjs';
import {mapPoint,MAX_RASTER_PIXELS} from './sheet-layout.mjs';

const WORLD=2*Math.PI*6378137,MAX_TILES=36;
export function throwIfAborted(signal){if(signal?.aborted)throw new DOMException('Export cancelled.','AbortError');}
export function imageryPlan(code,geometry){
  const source=sourceForFigure(code),b=geometry.projected,{width,height}=geometry.raster;
  if(source.kind==='wms'){
    const requestWidth=1536,requestHeight=Math.round(requestWidth*height/width),url=new URL(source.url);
    for(const [key,value] of Object.entries({SERVICE:'WMS',REQUEST:'GetMap',VERSION:source.version,LAYERS:source.layer,STYLES:'',SRS:source.crs,BBOX:[b.west,b.south,b.east,b.north].join(','),WIDTH:requestWidth,HEIGHT:requestHeight,FORMAT:'image/png',TRANSPARENT:'FALSE',EXCEPTIONS:'application/vnd.ogc.se_xml'}))url.searchParams.set(key,value);
    return [{url:url.href,x:0,y:0,width,height,expectedWidth:requestWidth,expectedHeight:requestHeight}];
  }
  // Request only visible native tiles, not a print-DPI zoom stack. B may overzoom.
  let zoom=Math.max(0,Math.min(source.maxNativeZoom,Math.floor(Math.log2(WORLD/(b.east-b.west)*(geometry.mapFrame.width/25.4*96)/256))));
  let tiles;
  do{
    const span=WORLD/2**zoom;
    const xmin=Math.floor((b.west+WORLD/2)/span),xmax=Math.ceil((b.east+WORLD/2)/span)-1;
    const ymin=Math.floor((WORLD/2-b.north)/span),ymax=Math.ceil((WORLD/2-b.south)/span)-1;
    tiles=[];
    for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++)tiles.push({url:source.url.replace('{z}',zoom).replace('{x}',x).replace('{y}',y),
      x:(x*span-WORLD/2-b.west)/(b.east-b.west)*width,y:(b.north-(WORLD/2-y*span))/(b.north-b.south)*height,
      width:span/(b.east-b.west)*width,height:span/(b.north-b.south)*height,expectedWidth:256,expectedHeight:256});
    if(tiles.length<=MAX_TILES)break;zoom--;
  }while(zoom>=0);
  return tiles;
}
async function decodeImage(blob,signal){
  throwIfAborted(signal);
  if(typeof createImageBitmap==='function'){
    // Native bitmap decoding has no AbortSignal support. Abandon our wait as
    // soon as it is cancelled, but retain a handler to close any late result.
    return new Promise((resolve,reject)=>{
      let abandoned=false;
      const abort=()=>{abandoned=true;signal?.removeEventListener('abort',abort);reject(new DOMException('Export cancelled.','AbortError'));};
      signal?.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>{throwIfAborted(signal);return createImageBitmap(blob);}).then(bitmap=>{
        signal?.removeEventListener('abort',abort);
        if(abandoned)bitmap.close();else resolve(bitmap);
      },error=>{
        signal?.removeEventListener('abort',abort);if(!abandoned)reject(error);
      });
      if(signal?.aborted)abort();
    });
  }
  const url=URL.createObjectURL(blob),img=new Image();
  try{
    await new Promise((resolve,reject)=>{
      const finish=fn=>value=>{signal?.removeEventListener('abort',abort);img.onload=img.onerror=null;fn(value);};
      const abort=finish(()=>{img.src='';reject(new DOMException('Export cancelled.','AbortError'));});
      signal?.addEventListener('abort',abort,{once:true});img.onload=finish(resolve);img.onerror=finish(()=>reject(new Error('Map image could not be decoded.')));img.src=url;
    });return img;
  }finally{URL.revokeObjectURL(url);}
}
function pathRing(ctx,ring,geometry){
  ring.forEach((point,i)=>{const [x,y]=mapPoint(point,geometry);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.closePath();
}
export function paintMapOverlays(ctx,{project,features=[],geometry}){
  const factor=geometry.dpi/25.4;
  for(const feature of features){
    ctx.beginPath();for(const ring of [feature.polygon,...(feature.holes||[])])pathRing(ctx,ring,geometry);
    ctx.fillStyle=/^#[0-9a-f]{6}$/i.test(feature.color)?feature.color:'#5fa8d3';ctx.globalAlpha=Number.isFinite(feature.fillOpacity)?Math.min(1,Math.max(0,feature.fillOpacity)):.6;
    ctx.fill('evenodd');ctx.globalAlpha=1;ctx.strokeStyle='#475569';ctx.lineWidth=.18*factor;ctx.stroke();
  }
  for(const [key,color,lineWidth,dash] of [['siteBoundary','#ef4444',.8,[]],['buildingBoundary','#111111',.5,[2*factor,1.5*factor]]]){
    if(!project[key]?.length)continue;
    ctx.beginPath();pathRing(ctx,project[key],geometry);ctx.strokeStyle=color;ctx.lineWidth=lineWidth*factor;ctx.setLineDash(dash);ctx.stroke();
  }
  ctx.setLineDash([]);const [x,y]=mapPoint([project.location.lng,project.location.lat],geometry);
  ctx.beginPath();ctx.arc(x,y,1.6*factor,0,Math.PI*2);ctx.fillStyle='#ef4444';ctx.fill();ctx.strokeStyle='#ffffff';ctx.lineWidth=.6*factor;ctx.stroke();
  ctx.font=`bold ${3.5*factor}px sans-serif`;ctx.lineWidth=.9*factor;ctx.strokeStyle='#ffffff';ctx.strokeText('SITE',x+3*factor,y-2*factor);ctx.fillStyle='#111111';ctx.fillText('SITE',x+3*factor,y-2*factor);
}
/** Independently sized raster, including map overlays. Never reads or mutates the editor. */
export async function composeMap({project,code,features=[],geometry,signal,onProgress=()=>{},requestTimeoutMs=30000}){
  throwIfAborted(signal);
  if(typeof document==='undefined')throw new Error('Map composition requires a browser canvas.');
  const {width,height}=geometry.raster;
  if(!(width>0&&height>0)||width*height>MAX_RASTER_PIXELS)throw new Error('Unsafe canvas size; choose 300 DPI.');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  // This visible, independent surface has real layout dimensions and source credit.
  // It never moves, resizes or reads the editor map.
  const preview=document.createElement('div'),caption=document.createElement('div');
  preview.setAttribute('aria-label',`Composing Figure ${code}`);
  Object.assign(preview.style,{position:'fixed',right:'16px',bottom:'16px',zIndex:'7000',width:'240px',background:'white',color:'#111',padding:'6px',border:'1px solid #475569',font:'11px sans-serif',pointerEvents:'none'});
  Object.assign(canvas.style,{display:'block',width:'240px',height:`${240*height/width}px`});
  caption.textContent=`Figure ${code} · ${sourceForFigure(code).credits}`;preview.append(canvas,caption);document.body.append(preview);
  let disposed=false;const dispose=()=>{if(!disposed){disposed=true;canvas.width=canvas.height=0;preview.remove();}};
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  let firstError;
  try{
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('The browser could not allocate a map canvas.');
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    const requests=imageryPlan(code,geometry);let cursor=0,complete=0;
    async function worker(){
      while(cursor<requests.length&&!controller.signal.aborted){
        const request=requests[cursor++];let image;
        const timeout=setTimeout(()=>{firstError??=new Error(`${sourceForFigure(code).label} image request timed out. Check your connection and retry.`);controller.abort();},Math.max(1,Math.min(45000,requestTimeoutMs||30000)));
        try{
          throwIfAborted(controller.signal);
          const response=await fetch(request.url,{mode:'cors',signal:controller.signal});
          if(!response.ok)throw new Error(`${sourceForFigure(code).label} image request failed (HTTP ${response.status}).`);
          if(!/^image\/(png|jpeg|webp)/i.test(response.headers.get('content-type')||''))throw new Error(`${sourceForFigure(code).label} returned an error instead of a map image.`);
          const blob=await response.blob();if(blob.size>16000000)throw new Error('Map image response exceeds the safe size.');
          image=await decodeImage(blob,controller.signal);throwIfAborted(controller.signal);
          if(image.width!==request.expectedWidth||image.height!==request.expectedHeight)throw new Error('Map service returned unexpected image dimensions.');
          ctx.drawImage(image,request.x,request.y,request.width,request.height);
          onProgress({phase:'imagery',code,completed:++complete,total:requests.length});
        }catch(error){firstError??=error;controller.abort();}finally{clearTimeout(timeout);image?.close?.();}
      }
    }
    await Promise.all(Array.from({length:Math.min(4,requests.length)},worker));
    throwIfAborted(signal);if(firstError)throw firstError;
    paintMapOverlays(ctx,{project,features,geometry});throwIfAborted(signal);
    const dataUrl=canvas.toDataURL('image/jpeg',.94);if(!dataUrl.startsWith('data:image/jpeg'))throw new Error('Map canvas encoding failed.');
    return {dataUrl,width,height,bounds:geometry.bounds,dispose};
  }catch(error){dispose();throw error;}finally{signal?.removeEventListener('abort',cancel);}
}
