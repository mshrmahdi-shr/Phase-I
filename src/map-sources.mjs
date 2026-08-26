// One source definition is shared by the editor, prepared sheet and PDF renderer.
const street={id:'osm',kind:'xyz',label:'OpenStreetMap',url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',credits:'© OpenStreetMap contributors',maxNativeZoom:19,maxZoom:24};
const aerial={id:'esri-imagery',kind:'xyz',label:'Esri World Imagery',url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',credits:'Tiles © Esri; source: Esri World Imagery',maxNativeZoom:19,maxZoom:24};
const topo={id:'toporama',kind:'wms',label:'NRCan Toporama',url:'https://maps.geogratis.gc.ca/wms/toporama_en',layer:'WMS-Toporama',version:'1.1.1',crs:'EPSG:3857',credits:'Natural Resources Canada - Toporama',maxNativeZoom:19,maxZoom:24};
export function sourceForFigure(code){
  if(!['A','B','C','D','E'].includes(code))throw new Error('Choose a valid figure A-E.');
  const source=code==='B'?aerial:code==='C'?topo:street;
  return Object.freeze({...source,createLayer(L){
    const options={crossOrigin:true,attribution:source.credits,maxNativeZoom:source.maxNativeZoom,maxZoom:source.maxZoom};
    return source.kind==='wms'?L.tileLayer.wms(source.url,{...options,layers:source.layer,version:source.version,format:'image/png',transparent:false,crs:L.CRS.EPSG3857}):L.tileLayer(source.url,options);
  }});
}
