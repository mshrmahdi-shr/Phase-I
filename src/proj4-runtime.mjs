function fail(message){throw new Error(message);}

function restoreGlobalProj4(previous){
  if(previous)Object.defineProperty(globalThis,'proj4',previous);
  else delete globalThis.proj4;
}

async function loadBrowserProj4(){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'proj4');
  if(previous&&!previous.configurable){
    fail('The host proj4 global cannot be isolated safely.');
  }
  Object.defineProperty(globalThis,'proj4',{value:undefined,writable:true,configurable:true});
  try{
    await import(new URL('../vendor/proj4.umd.mjs',import.meta.url).href);
    if(typeof globalThis.proj4!=='function')fail('The staged projection browser module did not initialize.');
    return globalThis.proj4;
  }finally{
    restoreGlobalProj4(previous);
  }
}

const proj4=typeof window==='undefined'?(await import('proj4')).default:await loadBrowserProj4();

export default proj4;
