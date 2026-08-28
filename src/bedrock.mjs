import {parsePolys} from './geology.mjs';
import {validLocation} from './core.mjs';

export const BEDROCK_SOURCE = Object.freeze({
  id:'MRD126-REV1', name:'1:250 000 Scale Bedrock Geology of Ontario — With Lowlands',
  credits:'Ontario Geological Survey 2011. Miscellaneous Release—Data 126-Revision 1.',
  sourceUrl:'https://www.geologyontario.mndm.gov.on.ca/mndmaccess/mndm_dir.asp?type=pub&id=MRD126-REV1',
  license:'https://www.ontario.ca/page/open-government-licence-ontario',
  redistributionEvidence:'official-open-government-licence',
  compilationScale:250000,
});

// MRD126-REV1 legend, pages 1–6; page 7 contains scale/use notes, not units.
// Colors are the PDF's RGB swatch fills, rounded to 8-bit channels and visually
// checked against all pages. Subunits inherit their parent polygon swatch.
// Unit 33 is a dike line (grey); 62 is not numbered in the supplied legend.
const parents = `
63|e3d7a4|Kaolinitic clay, clay, sand, lignite
61|5a8667|Shale: Port Lambton Gp.
60|6da785|Shale
59|7ab58b|Limestone, dolostone, shale
58|e6bd9f|Sandstone, dolostone, limestone
57|e1c37c|Limestone, dolostone, shale, sandstone, gypsum, salt
56|e3d0a4|Sandstone, shale, dolostone, siltstone
55|00b4cc|Shale, limestone, dolostone, siltstone
54|0dbcd9|Limestone, dolostone, shale, arkose, sandstone
53|8fe4e6|Dolostone, sandstone: Beekmantown Gp.
52|efe151|Conglomerate, sandstone, shale, dolostone: Potsdam Gp.; Nepean Fm.; Covey Hill Fm.
51|8f0c40|Tectonite unit: tectonites, straight gneisses, porphyroclastic gneisses, unsubdivided gneisses in major deformation zones, mylonites, protomylonites
50|b31818|Late felsic plutonic rocks: granodiorite, granite, syenite, pegmatite, alkalic granite, migmatitic gneisses
49|0f7b82|Mafic to ultramafic plutonic rocks: diorite, gabbro, peridotite, pyroxenite, anorthosite, derived metamorphic rocks
48|f38447|Alkalic plutonic rocks: nepheline syenite, alkalic syenite, fenite; associated mafic, ultramafic and carbonatitic rocks
47|fe4f4f|Early felsic plutonic rocks: granodiorite, tonalite, monzogranite, syenogranite; derived gneisses and migmatites
46|56e6fe|Carbonate metasedimentary rocks: marble, calc-silicate rocks, skarn, tectonic breccias
45|dfeb1c|Clastic metasedimentary rocks: conglomerate, wacke, quartz arenite, arkose, limestone, siltstone, chert, minor iron formation, minor metavolcanic rocks
44|16a40e|Mafic to felsic metavolcanic rocks: flows, tuffs, breccias, minor iron formation, minor metasedimentary rocks; includes reworked pyroclastic units, amphibolite
43|fd916c|Felsic igneous rocks: tonalite, granodiorite, monzonite, granite, syenite; derived gneisses
42|af005e|Anorthosite and alkalic igneous rocks: anorthosite, anorthositic gabbro, gabbro and related gneisses, nepheline syenite, alkalic syenite
41|d5b09c|Migmatitic rocks and gneisses of undetermined protolith: commonly layered biotite gneisses and migmatites; locally includes quartzofeldspathic gneisses, orthogneisses, paragneisses
40|8eca06|Mafic rocks: amphibolite, gabbro, diorite, mafic gneisses
39|d18a8d|Gneisses of metasedimentary origin: quartzofeldspathic gneisses, pelitic to semi-pelitic gneisses, calc-silicate gneisses, minor quartzite, minor marble and marble breccia
38|ca0683|Carbonate-alkalic intrusive suite (443.7 Ma to 600 Ma): carbonatite, nepheline syenite, alkalic syenite, ijolite, fenite; associated mafic and ultramafic intrusions
37|fb6400|Mafic intrusive rocks
36|b3af5c|Sandstone, shale, conglomerate: Jacobsville Gp.; Oronto Gp.
35|8f008d|Alkalic intrusive suite and carbonatite (circa 1.1 to 1.2 Ga): alkalic syenite, ijolite, nepheline syenite, fenite, associated mafic and ultramafic rocks, and minor carbonatite
34|fdc577|Mafic dikes and related intrusive rocks (Keweenawan age) (circa 1.1 to 1.2 Ga)
33|4e4e4e|Mafic intrusive rocks and mafic dikes
32|d0cd93|Osler Gp., Mamainse Point Fm., Michipicoten Island Fm.
31|e4da6f|Sibley Gp. (circa 1.34 Ga): conglomerate, sandstone, shale
30|cd0072|Felsic intrusive rocks
29|ab0000|Sudbury Igneous Complex (1850 Ma): norite, gabbro, granophyre
28|758925|Whitewater Gp.: fragmental rocks, mudstone, wacke
27|71467a|Carbonatite-alkalic intrusive suite (circa 1.8 to 1.9 Ga): carbonatite complexes, nepheline syenite, alkalic syenite, ijolite, fenite; associated mafic and ultramafic rocks
26|018200|Mafic intrusive rocks, mafic dikes and mafic sills
25|92988d|Trans-Hudson Orogen Supracrustal rocks / sedimentary rocks (Sutton Inliers): dolostone, chert breccias, argillite, wacke, conglomerate, iron formation
24|91977a|Sedimentary rocks (Animikie Group): wacke, shale, iron formation, limestone, minor volcanic rocks, conglomerate, taconite, algal chert, carbonate rocks, argillite-tuff
23|ebd3f8|Mafic and related intrusive rocks and mafic dikes
22|ef898b|Felsic intrusive rocks (Murray Granite 2388 Ma, Creighton Granite 2333 Ma): granite
21|c57943|Cobalt Gp.: siltstone, argillite, sandstone, conglomerate
20|9a9fd8|Quirke Lake Gp.: sandstone, siltstone, conglomerate, limestone, dolostone
19|bdc0d5|Hough Lake Gp.: siltstone, wacke, argillite, quartz-feldspar sandstone, conglomerate, sandstone
18|727dd7|Elliot Lake Gp.: siltstone, wacke, argillite, quartz-feldspar sandstone, conglomerate, mafic, intermediate and felsic metavolcanic rocks, intercalated metasedimentary rocks and epiclastic rocks
17|003cc8|Mafic and ultramafic intrusive rocks and mafic dikes
16|f6d2fb|Hornblendite - nepheline syenite suite: pyroxenite, diorite, monzonite, syenite, nepheline syenite (saturated to undersaturated suite)
15|fc5580|Massive granodiorite to granite: massive to foliated granodiorite to granite
14|e37da6|Diorite-monzodiorite-granodiorite suite: diorite, quartz diorite, minor tonalite, monzonite, granodiorite, syenite and hypabyssal equivalents (saturated to oversaturated suite)
13|fed1e9|Muscovite-bearing granitic rocks: muscovite-biotite and cordierite-biotite granite, granodiorite-tonalite
12|fdbdbf|Foliated tonalite suite: tonalite to granodiorite - foliated to massive
11|fdd3c1|Gneissic tonalite suite: tonalite to granodiorite - foliated to gneissic - with minor supracrustal inclusions
10|4aadfc|Mafic and ultramafic rocks: gabbro, anorthosite, ultramafic rocks
9|fef6a4|Coarse clastic metasedimentary rocks: mainly coarse clastic metasedimentary rocks, with minor, mainly alkalic, mafic to felsic metavolcanic flows, tuffs and breccias
8|596591|Migmatized supracrustal rocks: metavolcanic rocks, minor metasedimentary rocks, mafic gneisses of uncertain protolith, granitic gneisses
7|d2d2d2|Metasedimentary rocks: wacke, siltstone, arkose, argillite, slate, mudstone, marble, chert, iron formation, minor metavolcanic rocks, conglomerate, arenite, paragneiss, migmatites
6|dcd085|Felsic to intermediate metavolcanic rocks: rhyolitic, rhyodacitic, dacitic and andesitic flows, tuffs and breccias, chert, iron formation, minor metasedimentary and intrusive rocks; related migmatites
5|8faa7c|Mafic to intermediate metavolcanic rocks: basaltic and andesitic flows, tuffs and breccias, chert, iron formation, minor metasedimentary and intrusive rocks, related migmatites
4|47889c|Mafic to ultramafic metavolcanic rocks: mafic metavolcanic and basaltic rocks with minor komatiitic flows, metasedimentary and pyroclastic rocks
3|12769a|Mafic metavolcanic and metasedimentary rocks: mafic metavolcanic rocks, minor iron formation
2|b1e436|Felsic to intermediate metavolcanic rocks: rhyolitic, rhyodacitic, dacitic and andesitic flows, tuffs and breccias
1|0f7c80|Metasedimentary rocks and mafic to ultramafic metavolcanic rocks: coarse clastic metasedimentary rocks, marble, quartz arenite, iron formation, komatiite, mafic metavolcanic rocks, and minor felsic metavolcanic rocks
`;
const subunits = `
63a|Mattagami Fm.; Mistuskwia Beds
63b|Evans Strait Fm.
60a|Kettle Point Fm.
60b|Long Rapids Fm.
59a|Hamilton Gp.
59b|Marcellus Fm.
59c|Dundee Fm.
59d|Detroit River Gp.; Onondaga Fm.
59e|Williams Island Fm.
59f|Murray Island Fm.
59g|Moose River Fm.
59h|Kwataboahegan Fm.
58a|Bois Blanc Fm.; Oriskany Fm.
58b|Stooping River Fm.
58c|Sextant Fm.
57a|Bass Islands Fm.
57b|Bertie Fm.
57c|Salina Fm.
57d|Kenogami River Fm. (Upper Silurian to Lower Devonian)
56a|Guelph Fm. (also present in the Upper Silurian)
56b|Lockport Fm.
56c|Amabel Fm.
56d|Clinton Gp.; Cataract Gp.
56e|Thornloe Fm.; Earlton Fm.
56f|Wabi Gp.
56g|Attawapiskat Fm. (also present in the Upper Silurian)
56h|Ekwan River Fm.
56i|Severn River Fm.
55a|Queenston Fm.
55b|Georgian Bay Fm.; Blue Mountain Fm.; Billings Fm.; Collingwood Mb.; Eastview Mb.
55c|Liskeard Gp.
55d|Red Head Rapids Fm.
55e|Churchill River Gp.
55f|Bad Cache Rapids Gp.
54a|Ottawa Gp.; Simcoe Gp.; Shadow Lake Fm. (now considered Upper Ordovician)
54b|Chazy Gp.; Rockcliffe Fm.
50a|Granitic and syenitic gneisses
50b|Granitic gneisses with metasedimentary xenoliths, migmatites, injection gneisses, pegmatites
49a|Gabbro
49b|Diorite
49c|Anorthosite, gabbroic anorthosite
48a|Syenite
48b|Nepheline syenite
47a|Monzo- and syenogranite
47b|Granodiorite
47c|Trondhjemite
47d|Tonalite
38a|Intrusions of uncertain age
37a|Grenville or Rideau mafic dike swarm (575-590 Ma)
37b|Frontenac mafic dike swarm (circa 1160 Ma)
37c|Gabbro, diorite, ultramafic rocks, and granophyre
35a|Martison Carbonatite Complex
34a|Logan and Nipigon mafic sills (circa 1100-1115 Ma)
34b|Mafic sills and dikes (circa 1130-1180 Ma), including the Mine Centre dike (circa 1137±20 Ma), the Empey Lake dike (circa 1178±31 Ma), and the Kipling (Abitibi) dike (circa 1140 Ma)
34c|Ultramafic, gabbroic and granophyric intrusions (probably related to unit 35)
34d|Felsic to intermediate intrusive rocks
34e|Abitibi swarm (1141 Ma) mafic dikes
33a|Mackenzie mafic dike swarm (1267 Ma)
33b|Sudbury mafic dike swarm (circa 1235-1238 Ma)
32a|Basalt and associated conglomerate and arkose
32b|Rhyolite, quartz-feldspar porphyry; associated conglomerate and arkose
30a|Granite, alkali granite, granodiorite, quartz-feldspar porphyry; minor related volcanic rocks (1.5 to 1.6 Ga)
30b|Killarney monzogranite and granitic rocks (1.7 and 1.4 Ga)
30c|Intermediate to felsic volcanic rocks (1.8 to 1.9 Ga)
29a|Granophyre
29b|Norite-gabbro, quartz norite, sublayer and offset rocks
28a|Chelmsford Formation: wacke, minor siltstone
28b|Onwatin Formation: carbonaceous slate
28c|Onaping Formation: lapilli tuff, breccia, felsic flows and intrusions, minor carbonate and chert
26a|Molson mafic dike swarm (circa 1889 to 1871 Ma) and mafic sills of the Sutton Inliers (circa 1871 Ma)
26b|Pickle Crow mafic dike; normally magnetized northwest-trending subswarm (Molson swarm) (circa 1876 Ma)
26c|Pickle Crow mafic dike; reversely magnetized northwest-trending subswarm (Molson swarm) (circa 1876 Ma)
26d|Mafic dikes and mafic plutons of uncertain age; gabbro, diorite, quartz diorite
26e|North Channel mafic dike swarm
25a|Mafic and ultramafic metavolcanic rocks, metasedimentary rocks, differentiated mafic to ultramafic intrusions of the Fox River belt
25b|Undifferentiated clastic and carbonate metasedimentary rocks
25c|Sutton Inliers – Sutton Ridges Formation: unsubdivided clastic metasedimentary rocks (including wacke, siltstone, argillite, chert breccia and conglomerate), and chert-banded and clastic iron formation
25d|Sutton Inliers – Nowashe Formation: carbonate metasedimentary rocks (dolomite, cherty dolomite, stromatolitic dolomite, argillaceous dolomite)
25e|Undifferentiated clastic metasedimentary migmatite
24a|Rove Formation: argillite, shale, wacke, minor volcanic rocks
24b|Gunflint Formation: conglomerate, taconite, algal chert, chert, carbonate rocks, argillite-tuff
23a|Marathon mafic dike; north-northwest to north-northeast-trending subswarm (circa 2101 to 2126 Ma)
23b|Fort Frances mafic dike; northwest-trending subswarm (circa 2075 Ma)
23c|Marathon, Kapuskasing or Biscotasing mafic dike; northeast-trending subswarm (circa 2101-2126 or circa 2167-2171 Ma)
23d|Nipissing mafic sills (2219 Ma): mafic sills, mafic dikes and related granophyre
23e|Biscotasing mafic dike; north-northeast-trending swarm (circa 2167-2171 Ma)
23f|Mafic dikes of uncertain age
23g|Mafic plutons of uncertain age
21a|Bar River Formation: quartz sandstone, hematitic sandstone, sandstone
21b|Gordon Lake Formation: siltstone, argillite, sandstone
21c|Lorrain Formation: quartz sandstone, minor conglomerate, siltstone
21d|Gowganda Formation: conglomerate, sandstone, siltstone, argillite
20a|Serpent Formation: quartz-feldspar sandstone, sandstone with minor siltstone, calcareous siltstone and conglomerate
20b|Espanola Formation: limestone, dolostone, siltstone, sandstone
20c|Bruce Formation: conglomerate with minor sandstone and siltstone
19a|Mississagi Formation: quartz-feldspar sandstone, argillite and conglomerate
19b|Pecors Formation: siltstone, argillite, wacke, minor sandstone
19c|Ramsay Lake Formation: conglomerate, minor sandstone, siltstone
18a|McKim Formation: siltstone, wacke, argillite
18b|Matinenda Formation: quartz-feldspar sandstone, conglomerate, sandstone
18c|Volcanic rocks: includes mafic, intermediate and felsic metavolcanic rocks, intercalated metasedimentary rocks and epiclastic rocks
17a|Matachewan mafic dike swarm (circa 2454 Ma)
17b|Gabbro, anorthosite
16a|Hornblendite, pyroxenite
16b|Gabbro, diorite, monzonite
16c|Syenite, nepheline and/or foid-bearing syenite
15a|Potassium feldspar megacrystic units
14a|Diorite, monzonite, quartz monzonite
14b|Granodiorite, granite
14c|Syenite
12a|Biotite tonalite to granodiorite
12b|Hornblende tonalite to granodiorite
10a|Gabbro
10b|Anorthosite
10c|Ultramafic rocks
9a|Metasedimentary rocks: conglomerate, arkose, arenite, wacke, sandstone, siltstone, argillite
9b|Alkaline metavolcanic rocks: mafic to felsic metavolcanic flows, tuffs and breccias
7a|Wacke, siltstone, arkose
7b|Argillite, slate, mudstone
7c|Marble, chert, iron formation, minor metavolcanic rocks
7d|Conglomerate and arenite
7e|Paragneiss and migmatites
6a|Dacitic and andesitic flows, tuffs and breccias
6b|Rhyolitic, rhyodacitic flows, tuffs and breccias
5a|Andesitic flows, tuffs and breccias with minor rhyolites
5b|Basaltic and andesitic flows, tuffs and breccias
4a|Ultramafic metavolcanic rocks
4b|Mafic metavolcanic rocks, metasedimentary rocks and pyroclastic rocks
`;
const legend = new Map();
for (const line of parents.trim().split('\n')) {
  const [code,color,material] = line.split('|');
  legend.set(code, Object.freeze({code,label:material,title:material,material,detail:'',color:'#'+color}));
}
for (const line of subunits.trim().split('\n')) {
  const [code,label] = line.split('|'), parent = legend.get(code.match(/^\d+/)[0]);
  legend.set(code, Object.freeze({...parent,code,label,title:label,detail:label}));
}

export function getBedrockLegend(value) {
  const code = String(value ?? '').trim().toLowerCase();
  if (!/^g?\d{1,2}[a-z]?$/.test(code)) return null;
  const entry = legend.get(code.replace(/^g/,''));
  if (!entry) return null;
  return code.startsWith('g') ? Object.freeze({...entry,code,
    detail:[entry.detail,'Lithologic information interpreted from geophysical data.'].filter(Boolean).join('; ')}) : entry;
}

export function validateBedrockRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3 || ring.some(p => !Array.isArray(p) || p.length !== 2 ||
    !p.every(Number.isFinite) || !validLocation({lng:p[0],lat:p[1]})) || new Set(ring.map(p=>p.join(','))).size < 3) {
    throw new Error('A bedrock polygon boundary has invalid coordinates.');
  }
  const [ox,oy] = ring[0]; let area = 0;
  for (let i=0;i<ring.length;i++) {
    const a=ring[i],b=ring[(i+1)%ring.length];
    area += (a[0]-ox)*(b[1]-oy)-(b[0]-ox)*(a[1]-oy);
  }
  if (!Number.isFinite(area) || area===0) throw new Error('A bedrock polygon boundary has zero area.');
}

export function parseBedrockKml(text) {
  const doc = new DOMParser().parseFromString(text,'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'kml') throw new Error('The file is not valid KML/XML.');
  // parsePolys intentionally tolerates bad custom coordinates; official cache
  // creation must instead fail, never silently drop points, polygons or holes.
  for (const polygon of doc.querySelectorAll('Placemark Polygon')) {
    const outers = polygon.querySelectorAll('outerBoundaryIs LinearRing coordinates');
    if (outers.length!==1) throw new Error('A bedrock polygon must have exactly one outer boundary.');
    const outer=outers[0];
    const boundaries = [outer,...polygon.querySelectorAll('innerBoundaryIs')].map(n =>
      n.localName==='coordinates' ? n : n.querySelector('LinearRing coordinates'));
    for (const node of boundaries) {
      if (!node || !node.textContent.trim()) throw new Error('A bedrock polygon has an empty boundary.');
      const points = node.textContent.trim().split(/\s+/).map(tuple => {
        const values = tuple.split(',');
        if (values.length<2 || values.length>3 || values.some(v=>v.trim()==='' || !Number.isFinite(Number(v)))) {
          throw new Error('A bedrock polygon has invalid coordinates.');
        }
        return values.slice(0,2).map(Number);
      });
      validateBedrockRing(points);
    }
  }
  return parsePolys(text,'bedrock').map(feature => {
    const candidate = feature.unitCode || feature.name;
    const code = String(candidate).trim().match(/^(g?\d{1,2}[a-z]?)(?:\s|$)/i)?.[1].toLowerCase() || null;
    const official = getBedrockLegend(code);
    return {...feature,unitCode:code || feature.unitCode,official,
      ...(official ? {name:`${code.toUpperCase()} — ${official.label}`,
        description:[...new Set([official.material,official.detail].filter(Boolean))].join('; '),
        color:official.color,fillOpacity:0.6} : {})};
  });
}
