import test from 'node:test';
import assert from 'node:assert/strict';

test('Esri Wayback provider exposes multiple dated releases for the project location', async () => {
  const { ESRI_WAYBACK_PROVIDER } = await import('../src/imagery/providers/wayback.mjs');
  const config = { '56102': { itemTitle:'World Imagery (Wayback 2023-12-07)', itemURL:'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/56102/{level}/{row}/{col}', metadataLayerUrl:'https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2023_r11/MapServer', layerIdentifier:'WB_2023_R11', releaseNum:56102, releaseDateLabel:'2023-12-07', releaseDatetime:1701936000000 }, '54000': { itemTitle:'World Imagery (Wayback 2021-01-01)', itemURL:'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/54000/{level}/{row}/{col}', metadataLayerUrl:'https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2021_r01/MapServer', layerIdentifier:'WB_2021_R01', releaseNum:54000, releaseDateLabel:'2021-01-01', releaseDatetime:1609459200000 } };
  const results = await ESRI_WAYBACK_PROVIDER.search({ location:{lat:43.65,lng:-79.38}, year:2023, fetchImpl:async()=>({ok:true, async json(){return config;}}) });
  assert.equal(results.length,2); assert.deepEqual(results.map(value=>value.year),[2021,2023]); assert.equal(results[0].policy,'link-only'); assert.match(results[1].sourceUrl,/livingatlas\.arcgis\.com\/wayback/);
});
