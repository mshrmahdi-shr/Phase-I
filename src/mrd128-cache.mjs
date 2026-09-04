const MARK='/mines/data/google/mrd128/';

export async function fetchWithRetry(fetchImpl,url,{attempts=3,timeoutMs=20_000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),signal,headers}={}){
  if(typeof fetchImpl!=='function')throw new TypeError('fetchWithRetry requires a fetch function.');
  const total=Math.max(1,Math.min(5,Number(attempts)||1));let last;
  for(let attempt=1;attempt<=total;attempt++){
    if(signal?.aborted)throw signal.reason??new DOMException('The operation was aborted','AbortError');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('request timeout')),Math.max(1,Number(timeoutMs)||1));
    const abort=()=>controller.abort(signal.reason??new DOMException('The operation was aborted','AbortError'));
    signal?.addEventListener('abort',abort,{once:true});
    try{
      const response=await fetchImpl(url,{signal:controller.signal,headers});
      if(response?.ok===false)throw new Error(`HTTP ${response.status}`);
      return response;
    }catch(error){last=error;if(attempt<total)await sleep(Math.min(2000,250*2**(attempt-1)));}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  throw last??new Error('Fetch failed');
}

export function assertCompleteCache({saved,failed,pending}){
  if(saved<2||failed>0||pending>0)throw new Error(`Incomplete MRD128 cache: ${saved} saved, ${failed} failed, ${pending} pending.`);
}

export function extractHrefValues(kml=''){
  return [...String(kml).matchAll(/<href>\s*([^<]+?)\s*<\/href>/gi)].map(m=>m[1].trim());
}

export function cachePathForMrd128Url(url){
  const u=new URL(url);
  const i=u.pathname.toLowerCase().indexOf(MARK);
  if(i<0) throw new Error('URL is outside MRD128');
  const rel=u.pathname.slice(i+MARK.length).replace(/^\/+/, '');
  return `mrd128-cache/${rel || 'index.kml'}`;
}

export function rewriteMrd128Href(href, baseUrl){
  const absolute=new URL(href,baseUrl);
  const basePath=cachePathForMrd128Url(baseUrl);
  const childPath=cachePathForMrd128Url(absolute.href);
  const baseDir=basePath.split('/').slice(0,-1);
  return `${'../'.repeat(baseDir.length)}${childPath}`;
}

export function rewriteKmlLinks(kml, baseUrl){
  return String(kml).replace(/<href>\s*([^<]+?)\s*<\/href>/gi,(m,href)=>{
    try{
      const u=new URL(href.trim(),baseUrl);
      if(!u.pathname.toLowerCase().includes('/mines/data/google/mrd128/polygons/')) return m;
      return `<href>${rewriteMrd128Href(u.href,baseUrl)}</href>`;
    }catch{return m}
  });
}

export function shouldFollowSurficialLink({name='',href=''}={}){
  const n=String(name).trim().toLowerCase();
  const h=String(href).trim().toLowerCase();
  if(n==='surficial geology') return true;
  if(!/\.(?:kml|kmz)(?:[?#].*)?$/.test(h)) return false;
  return h.includes('/mrd128/polygons/') || h.includes('/mrd128-cache/polygons/') || h.includes('mrd128-cache/polygons/');
}
