import {geographicPlacementCorners} from './placement.mjs';

function abortError(signal){return signal?.reason instanceof Error?signal.reason:new DOMException('Cancelled','AbortError');}

export function createCanvasImageOverlay({
  L,map,image,placement,signal,createBitmap,ImageConstructor,createObjectURL,revokeObjectURL
}={}){
  if(!map||typeof map.on!=='function'||typeof map.off!=='function'||typeof map.latLngToLayerPoint!=='function')throw new Error('A Leaflet map is required for the manual image overlay.');
  if(!L||typeof L.latLng!=='function')throw new Error('Leaflet is required for the manual image overlay.');
  if(!image?.blob||typeof image.blob.arrayBuffer!=='function'||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<=0||image.height<=0)throw new Error('A safely decoded manual image is required.');
  if(image.width!==placement?.sourceWidth||image.height!==placement?.sourceHeight)throw new Error('Manual image dimensions do not match its placement.');
  // Corner validation does not require a SITE; it rejects malformed placement data here.
  geographicPlacementCorners(placement);

  const bitmapFactory=createBitmap===undefined?globalThis.createImageBitmap:createBitmap;
  const fallbackImage=ImageConstructor===undefined?globalThis.Image:ImageConstructor;
  const makeUrl=createObjectURL===undefined?globalThis.URL?.createObjectURL?.bind(globalThis.URL):createObjectURL;
  const revokeUrl=revokeObjectURL===undefined?globalThis.URL?.revokeObjectURL?.bind(globalThis.URL):revokeObjectURL;
  let activeMap=null,canvas=null,context=null,bitmap=null,generation=0,ready=Promise.resolve(),cancelCurrent=null,abortListener=null;

  function decodeBlob(token){
    if(typeof bitmapFactory==='function')return Promise.resolve().then(()=>bitmapFactory(image.blob,{imageOrientation:'from-image'}));
    if(typeof fallbackImage!=='function'||typeof makeUrl!=='function'||typeof revokeUrl!=='function')return Promise.reject(new Error('This browser cannot decode the manual image. Use a current browser.'));
    let url=makeUrl(image.blob),revoked=false;
    const revoke=()=>{if(!revoked&&url!==null){revoked=true;revokeUrl(url);url=null;}};
    cancelCurrent?.urls.add(revoke);
    return new Promise((resolve,reject)=>{
      const element=new fallbackImage();
      element.onload=()=>{revoke();resolve(element);};
      element.onerror=()=>{revoke();reject(new Error('The manual image could not be decoded.'))};
      element.src=url;
    }).finally(()=>cancelCurrent?.token===token&&cancelCurrent.urls.delete(revoke));
  }

  function update(){
    if(!activeMap||!canvas||!bitmap||!context)return;
    const size=activeMap.getSize(),topLeft=activeMap.containerPointToLayerPoint([0,0]);
    if(!Number.isFinite(size?.x)||!Number.isFinite(size?.y)||size.x<=0||size.y<=0)return;
    const width=Math.ceil(size.x),height=Math.ceil(size.y);
    if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
    const points=geographicPlacementCorners(placement).map(([lng,lat])=>activeMap.latLngToLayerPoint(L.latLng(lat,lng)));
    const [nw,ne,,sw]=points,origin=topLeft||{x:0,y:0};
    L.DomUtil?.setPosition?L.DomUtil.setPosition(canvas,origin):Object.assign(canvas.style,{left:`${origin.x}px`,top:`${origin.y}px`});
    context=canvas.getContext('2d');if(!context)throw new Error('The browser could not allocate the manual image overlay canvas.');
    context.clearRect(0,0,width,height);
    context.setTransform((ne.x-nw.x)/image.width,(ne.y-nw.y)/image.width,(sw.x-nw.x)/image.height,(sw.y-nw.y)/image.height,nw.x-origin.x,nw.y-origin.y);
    context.drawImage(bitmap,0,0,image.width,image.height);
  }

  function disposeSurface(){
    if(activeMap)activeMap.off('move zoom resize',update);
    if(signal&&abortListener)signal.removeEventListener('abort',abortListener);
    abortListener=null;
    bitmap?.close?.();bitmap=null;
    if(canvas){canvas.width=0;canvas.height=0;canvas.remove?.();if(canvas.parentNode)canvas.parentNode.removeChild(canvas);}
    canvas=null;context=null;activeMap=null;
  }

  function cancel(external=false){
    generation++;const current=cancelCurrent;cancelCurrent=null;
    if(current){for(const revoke of current.urls)revoke();current.urls.clear();current.resolve({cancelled:true,external});}
    disposeSurface();
  }

  const overlay={
    addTo(target=map){
      if(activeMap)return overlay;
      activeMap=target;
      const document=activeMap.getContainer?.().ownerDocument||globalThis.document;
      if(!document?.createElement){activeMap=null;throw new Error('A browser document is required for the manual image overlay.');}
      canvas=document.createElement('canvas');canvas.className='manual-imagery-overlay';Object.assign(canvas.style,{position:'absolute',pointerEvents:'none'});
      context=canvas.getContext('2d');if(!context){disposeSurface();throw new Error('The browser could not allocate the manual image overlay canvas.');}
      activeMap.getPanes().overlayPane.appendChild(canvas);activeMap.on('move zoom resize',update);
      const token=++generation,urls=new Set();let resolveCancel;
      const cancellation=new Promise(resolve=>{resolveCancel=resolve;});cancelCurrent={token,urls,resolve:resolveCancel};
      if(signal){abortListener=()=>cancel(true);signal.addEventListener('abort',abortListener,{once:true});}
      const decoded=decodeBlob(token);
      decoded.then(value=>{if(token!==generation)value?.close?.();},()=>{});
      ready=Promise.race([decoded,cancellation]).then(value=>{
        if(value?.cancelled){if(value.external)throw abortError(signal);return undefined;}
        if(token!==generation){value?.close?.();return undefined;}
        if(!Number.isSafeInteger(value?.width)||!Number.isSafeInteger(value?.height)||value.width!==image.width||value.height!==image.height){value?.close?.();throw new Error('Decoded overlay dimensions do not match the approved manual image.');}
        bitmap=value;cancelCurrent=null;update();return overlay;
      }).catch(error=>{if(token===generation){generation++;cancelCurrent=null;disposeSurface();}throw error;});
      if(signal?.aborted)cancel(true);
      return overlay;
    },
    remove(){if(activeMap||cancelCurrent)cancel(false);return overlay;},
    get ready(){return ready;},
    getElement(){return canvas;},
    redraw(){update();return overlay;}
  };
  return overlay;
}
