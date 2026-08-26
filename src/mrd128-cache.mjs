const MARK='/mines/data/google/mrd128/';

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
