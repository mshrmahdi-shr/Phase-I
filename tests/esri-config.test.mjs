import test from 'node:test';
import assert from 'node:assert/strict';
import {createEsriKeyStore,withEsriApiKey} from '../src/esri-config.mjs';

test('stores a trimmed Esri key locally and removes it when blank',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const store=createEsriKeyStore(storage);
  assert.equal(store.load(),null);
  store.save('  test-key-1234567890  ');
  assert.equal(store.load(),'test-key-1234567890');
  store.save('   ');
  assert.equal(store.load(),null);
});

test('adds the key only to an Esri HTTPS URL without overwriting other query parameters',()=>{
  assert.equal(withEsriApiKey('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/10/20/30','abc-123'),'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/10/20/30?token=abc-123');
  assert.equal(withEsriApiKey('https://example.test/map?f=json','abc-123'),'https://example.test/map?f=json');
  assert.throws(()=>withEsriApiKey('http://server.arcgisonline.com/map','abc-123'),/HTTPS/i);
  assert.equal(withEsriApiKey('https://server.arcgisonline.com/tiles/{z}/{y}/{x}','abc-123'),'https://server.arcgisonline.com/tiles/{z}/{y}/{x}?token=abc-123');
});
