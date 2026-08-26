import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parsePolys, siteFeature} from '../src/geology.mjs';
import {BEDROCK_SOURCE, getBedrockLegend, parseBedrockKml} from '../src/bedrock.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
// Independently labelled synthetic fixture: a 55b rectangle contains Toronto,
// although its NetworkLink Region would be -80..-79.5, 43.5..44.
const outer = '-80,43 -79,43 -79,44 -80,44 -80,43';
const hole = '-79.5,43.5 -79.2,43.5 -79.2,43.8 -79.5,43.8 -79.5,43.5';
const kml = (code, inner = '', ring = outer) => `<kml><Document>
  <Style id="custom"><PolyStyle><color>ff332211</color></PolyStyle></Style>
  <Placemark><name>${code}</name><description><![CDATA[User é & 東京 <script>unsafe()</script>description]]></description>
  <styleUrl>#custom</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs>
  ${inner ? `<innerBoundaryIs><LinearRing><coordinates>${inner}</coordinates></LinearRing></innerBoundaryIs>` : ''}
  </Polygon></Placemark></Document></kml>`;

test('official 55b polygon contains SITE beyond nominal tile bounds', () => {
  const features = parseBedrockKml(kml('55b'));
  assert.equal(siteFeature(features, {lat:43.65,lng:-79.38}).unitCode, '55b');
  assert.equal(features[0].color, '#00b4cc');
  assert.match(features[0].description, /Shale, limestone, dolostone, siltstone/);
  assert.match(features[0].description, /Georgian Bay Fm.; Blue Mountain Fm.; Billings Fm.; Collingwood Mb.; Eastview Mb./);
  assert.equal(BEDROCK_SOURCE.compilationScale, 250000);
});

test('official parser preserves a hole excluding SITE', () => {
  const features = parseBedrockKml(kml('55b', hole));
  assert.equal(features[0].holes.length, 1);
  assert.equal(siteFeature(features, {lat:43.65,lng:-79.38}), null);
});

test('parent, subunit and geophysical prefix retain authoritative descriptions', () => {
  assert.equal(getBedrockLegend('55').material, 'Shale, limestone, dolostone, siltstone');
  assert.equal(getBedrockLegend('55b').color, '#00b4cc');
  assert.match(getBedrockLegend('G12a').label, /Biotite tonalite to granodiorite/);
  assert.match(getBedrockLegend('G12a').detail, /geophysical/i);
  assert.match(getBedrockLegend('4b').label, /Mafic metavolcanic rocks, metasedimentary rocks and pyroclastic rocks/);
  assert.equal(getBedrockLegend('1').color, '#0f7c80');
  assert.equal(getBedrockLegend('63b').label, 'Evans Strait Fm.');
  assert.equal(getBedrockLegend('33a').color, '#4e4e4e');
});

test('unknown codes are not assigned a parent interpretation and custom Bedrock stays custom', () => {
  for (const code of ['55z', '62', '999', '55b<script>', '']) assert.equal(getBedrockLegend(code), null);
  const unknown = parseBedrockKml(kml('55z'))[0];
  assert.equal(unknown.official, null);
  assert.equal(unknown.color, '#112233');
  assert.match(unknown.description, /User é & 東京/);
  assert.doesNotMatch(unknown.description, /unsafe|<script/);
  const custom = parsePolys(kml('55b'), 'bedrock')[0];
  assert.equal(custom.official, null);
  assert.equal(custom.color, '#112233');
  assert.doesNotMatch(custom.description, /Georgian Bay/);
});

test('official parser rejects invalid outer or inner coordinates instead of dropping geometry', () => {
  assert.throws(() => parseBedrockKml('<kml>'), /KML|XML/);
  assert.throws(() => parseBedrockKml(kml('55b', '', '-80,43 nope,43 -79,44 -80,43')), /boundary|coordinate/i);
  assert.throws(() => parseBedrockKml(kml('55b', '-79.5,43.5 -79.2,43.5')), /boundary|coordinate/i);
  assert.throws(() => parseBedrockKml(kml('55b', '', '-80,43 -79,43 -78,43 -80,43')), /boundary|area/i);
});

test('official parser refuses multiply defined outer boundaries rather than truncating them', () => {
  const text=kml('55b').replace('</Polygon>','<outerBoundaryIs><LinearRing><coordinates>-80,43 -79,43 -79,44 -80,44 -80,43</coordinates></LinearRing></outerBoundaryIs></Polygon>');
  assert.throws(()=>parseBedrockKml(text),/outer boundary/i);
});
