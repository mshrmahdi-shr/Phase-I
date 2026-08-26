import test from 'node:test';
import assert from 'node:assert/strict';
import { cachePathForMrd128Url, rewriteMrd128Href, extractHrefValues, rewriteKmlLinks, shouldFollowSurficialLink } from '../src/mrd128-cache.mjs';

test('cachePathForMrd128Url keeps files inside the MRD128 mirror', () => {
  const u='http://www.geologyontario.mndm.gov.on.ca/mines/data/google/mrd128/polygons/doc.kml';
  assert.equal(cachePathForMrd128Url(u),'mrd128-cache/polygons/doc.kml');
});

test('rewriteMrd128Href keeps the local mirror folder name in nested links', () => {
  const base='http://www.geologyontario.mndm.gov.on.ca/mines/data/google/mrd128/polygons/doc.kml';
  const child='http://www.geologyontario.mndm.gov.on.ca/mines/data/google/mrd128/polygons/43/-79/doc.kml';
  assert.equal(rewriteMrd128Href(child, base),'../../mrd128-cache/polygons/43/-79/doc.kml');
});

test('extractHrefValues finds network-link hrefs from KML', () => {
  const kml='<kml><NetworkLink><Link><href>tiles/a.kml</href></Link></NetworkLink><NetworkLink><Url><href>https://x.test/b.kml</href></Url></NetworkLink></kml>';
  assert.deepEqual(extractHrefValues(kml),['tiles/a.kml','https://x.test/b.kml']);
});

test('rewriteKmlLinks rewrites mirrored MRD128 polygon hrefs but leaves unrelated links unchanged', () => {
  const base='https://www.geologyontario.mndm.gov.on.ca/mines/data/google/mrd128/polygons/doc.kml';
  const kml='<kml><href>https://www.geologyontario.mndm.gov.on.ca/mines/data/google/mrd128/polygons/tiles/a.kml</href><href>https://example.com/x.kml</href></kml>';
  const out=rewriteKmlLinks(kml,base);
  assert.match(out,/<href>\.\.\/\.\.\/mrd128-cache\/polygons\/tiles\/a\.kml<\/href>/);
  assert.match(out,/<href>https:\/\/example\.com\/x\.kml<\/href>/);
});

test('shouldFollowSurficialLink follows mirrored MRD128 KMZ tiles', () => {
  assert.equal(shouldFollowSurficialLink({name:'-79.5_43.5_-79_44',href:'../../mrd128-cache/polygons/files/-79.5_43.5_-79_44.kmz'}),true);
  assert.equal(shouldFollowSurficialLink({name:'Logo',href:'../Logo/doc.kml'}),false);
});
