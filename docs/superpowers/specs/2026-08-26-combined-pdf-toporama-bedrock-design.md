# Phase I: selectable combined PDF, Toporama and MRD126 Bedrock

Date: 2026-08-26
Repository: `mshrmahdi-shr/Phase-I` only
Baseline: `ad1814c2c6f087eb64a9a6d3069c0297b3fcb94d`
Status: chat design and written specification approved by the user (2026-08-26).

## 1. User-visible outcome

The existing application will produce one downloadable PDF containing the user's selected, ready figures. Each figure occupies one A3 landscape page. It remains a static GitHub Pages application: no authentication, paid API, application server or manual PDF merging.

Approved changes:

- Change the project-number example from `FE 26-15876` to `26-15876`. Do not prepend `FE`, change an entered number, or rewrite saved projects.
- Put a clearly visible metric bar scale on every A–E sheet, calculated from that sheet's actual map extent.
- Use the official NRCan Toporama service for Figure C.
- Use the supplied MRD126-REV1 KML index and supplied Bedrock legend for Figure E.
- Add **Export PDF**, with selectable ready sheets, and download them as one combined PDF.
- Retain the established map-left/title-block-right layout and A3 landscape format.

Direct PDF generation is selected. A combined browser-print dialog was considered but is not the primary export path because it depends on operator page-size and print settings. The existing single-sheet print preview remains available.

## 2. Selection and readiness

Export PDF opens a dialog with rows A, B, C, D and E. Each row shows its figure title, checkbox and readiness or the exact missing requirements. Include **Select all ready**, **Clear selection**, **Cancel**, and **Download PDF (N sheets)**. No figure is silently included.

Only ready rows can be checked. Readiness reuses the live project validator and adds source-specific checks. Common project fields and a valid SITE are required for all sheets. B requires a valid site boundary; its building boundary is optional. D/E require the corresponding dataset, sufficient coverage and a detected SITE unit. C requires the configured Toporama source, not the street basemap.

Readiness means project prerequisites are satisfied; source-image loading is checked again during export. Invalidating a selected row removes its selection and displays the reason. Selection does not depend on whichever figure is currently visible in the editor. Disable download when none are selected.

Order is always A–E. For selection A/C/E, the PDF has three pages labelled Figure A, Figure C and Figure E; it does not relabel them A/B/C. Show page X of N separately. Use a sanitized project number in the download name, with a neutral fallback.

## 3. Sources and Bedrock coverage

### Toporama

Use the official HTTPS WMS endpoint `https://maps.geogratis.gc.ca/wms/toporama_en`, layer `WMS-Toporama`, WMS 1.1.1 and EPSG:3857. The service's capabilities list this projection. An Ontario GetMap probe returned a real PNG and `Access-Control-Allow-Origin: *` when an Origin header was supplied. Integration still requires a real browser/CORS test.

Figure C uses Toporama in the editor, single-sheet preview and combined PDF. Include NRCan/Toporama attribution. Do not silently substitute street tiles if Toporama fails. The figure retains its 1 km minimum context; source cartographic detail must not be represented as survey-grade accuracy.

### Supplied MRD126-REV1

The user's `doc.kml` is an official NetworkLink index, not a polygon file. Use its **Bedrock Geology With Lowlands** polygon branch (`MRD126/files/paleo/doc.kml`) as the default surface-bedrock interpretation. Do not combine it with the mutually exclusive underlying-Precambrian interpretation or substitute the PNG overlay branches.

The inspected index has 468 KMZ links. Crucially, their Region boxes are not reliable polygon clipping bounds: one inspected Queenston polygon extends from longitude -80.931 to -79.049 despite residing in the -80 to -79.5 tile. Selecting only the tile containing SITE would omit valid geology.

Extend the build-time mirror approach: download the chosen official polygon dataset, parse each KMZ, and build a manifest from **actual polygon geometry bounds**. Browser selection uses this spatial manifest to load every file intersecting the requested map area. Point-in-polygon and final visible-feature filtering preserve holes. Do not rely on NetworkLink Region alone or nearest-tile selection. The displayed viewport and PDF footprint both determine coverage.

Generated cache and manifest are Pages artifacts, not permanent source commits. Record counts, source, build time and completeness; fail on missing downloads, invalid geometry/index generation, or a size limit exceeded. Measure artifact size before release; never silently truncate the dataset. Restrict traversal to the configured official source and restrict browser requests to the local published cache.

Transcribe MRD126 unit codes, parent material descriptions, subunit names and colors from the supplied seven-page legend. Preserve source attribution and state its 1:250,000 compilation scale. The requested 20 km Figure E context remains; zooming does not increase geological accuracy. Render only relevant legend entries. Apply this mapping only to the identified MRD126 dataset; preserve the existing separate interpretation of arbitrary custom Bedrock imports. Unknown codes remain identifiable and must not receive invented descriptions or colors.

Keep private reference PDFs out of the public artifact. Source code may contain the supplied public KML index, documented legend mapping and tests.

## 4. Page composition and scale

Use a shared sheet specification for single-sheet preview and direct PDF: A3 landscape 420 × 297 mm, 7 mm margins, a 406 × 283 mm sheet, map left and title block right. Carry project name, number, address, date, figure label/title, source credits, north arrow and relevant legend.

Keep SITE visible over polygons. Draw site/building boundaries when supplied with distinct existing styles. Every page gets a black/white segmented scale bar with zero, distance labels and m/km units, on an opaque light background within the map frame. Derive its length from the final map bounds and projected positions, using ground distance at the map centre. Do not infer scale from the nominal figure span, current editor zoom, or browser viewport width.

Preserve minimum figure spans A=500 m, B=100 m, C=1 km, D=2 km, E=20 km. The longer sheet dimension and basemap zoom limits may add context; the actual bar scale remains correct. Label the ground scale as approximate where projection/source limitations apply.

Long project text and legends must wrap and fit. If content cannot fit at the minimum readable font size, identify the affected figure and block the export instead of clipping, dropping entries or adding unexpected overflow pages.

## 5. PDF generation and state safety

Use a pinned, tested browser PDF library such as jsPDF, packaged with the public build. Generate PDF pages directly, not through `window.print()`, browser screenshots, a remote rendering service or a user-side merge step.

Separate responsibilities:

- A source/basemap module owns Street, Esri and Toporama configuration and credits.
- A readiness/selection module evaluates all figures from live project and dataset state.
- A sheet-layout/scale module produces common dimensions, text blocks and scale geometry.
- A map-image compositor draws loaded basemap imagery, geology, SITE and boundaries into the correctly sized map image.
- A PDF composer combines the map image with crisp PDF text, scale, legend and title-block elements.
- An export coordinator owns progress, cancellation, snapshot consistency and cleanup.

Render one page at a time in a dedicated export map surface with a real nonzero layout size. The editor's map and active figure must not be destructively moved or changed during batch generation. Snapshot the selected figures and project at start and prevent conflicting edits until cancellation or completion. Use the same projection and final bounds for base imagery and all overlays.

Wait for all required visible source images. Cross-origin image reading must succeed without a proxy. Missing images, source errors, invalid data, unreadable fonts, canvas/security errors or overflow block the file. Do not output a blank map or quietly skip a selected sheet. Error text identifies the sheet and remedy. A failed batch downloads nothing; the user can correct it or deselect the affected figure and explicitly try again.

Show progress by figure, and support cancellation. Do not download after cancellation. Release page canvases, temporary map instances, object URLs and event listeners; restore normal editing in every exit path. Prevent duplicate concurrent exports.

Use 300 DPI as the normal composition preference; preserve the existing 600 DPI preference only where the chosen dimensions pass memory/dimension safety limits. If too large, explain and ask the user to choose 300 DPI rather than silently reducing it. Fetch only the selected extents, with bounded request concurrency and no unrelated tile prefetch. State clearly that composition DPI does not create detail missing from the source imagery. Preserve Unicode project text through appropriate font support; never turn user input into executable HTML or PDF actions.

## 6. Persistence and exclusions

Preserve current JSON/local project compatibility and entered values. Persist selected figure codes and known source identifiers as preferences, but recompute readiness after reopening. Cached geology metadata is not proof that geometry has been loaded. Imported user data and project fields are not uploaded to a new service by PDF export.

This change does not implement historical-aerial alignment, large-image storage, CAD raster ZIP/IMAGEDEF output, new figure types, arbitrary page reordering or a login/backend. Figure B in this batch uses the currently supported Esri aerial/site-plan source; stored historical-image filenames must not be presented as rendered historical maps.

## 7. Verification and release acceptance

Extend existing tests and add module tests only where there is no suitable existing home. Cover:

- Number example without FE; preservation of entered/saved numbers.
- Correct readiness per figure, disabled incomplete rows, select-all-ready, invalidated selections, no selection, and A/C/E ordering.
- Independent map extents and metric bar lengths for every figure; scale unaffected by editor pan or viewport size.
- Toporama WMS URL/projection and visible source failure handling.
- MRD126 relative KMZ traversal, true geometry-bound indexing across nominal tile boundaries, holes, SITE detection, official parent/subunit legend and separation from custom Bedrock.
- PDF page count and A3 landscape dimensions, distinct page images, figure titles, project fields, scale labels, cancellation, source failure, overflow and cleanup.
- Legacy project import and existing single-sheet print/drawing flows.

Produce an actual combined PDF through the application using a public Ontario test location, not an illustrative substitute. Inspect its page count/dimensions/text and render every page to verify map, marker, applicable boundaries, north arrow, bar scale, legend and title block. Verify selection of non-consecutive figures. Test mobile selection/download and a failed-source case. Bedrock acceptance must use the supplied source chain and an independently checked site-unit result.

Before claiming release: all tests pass; both caches build completely; the existing Pages workflow succeeds; public `version.json` matches released main; and the live source/selection/export flow is checked. Inspect any failed run before changing or retrying it. Report anything not actually verified, including browser/device-specific limitations.

## Sources checked during design

- User files: `doc.kml` and `Bed rock-126Rev1_Legend.pdf`.
- Toporama viewer: https://atlas.gc.ca/toporama/en/index.html
- Toporama WMS: https://maps.geogratis.gc.ca/wms/toporama_en
- jsPDF image API: https://parallax.github.io/jsPDF/docs/module-addImage.html
- jsPDF project: https://github.com/parallax/jsPDF

## Self-review

Scope is limited to the approved changes in this repository. The default Bedrock interpretation, page order, download method, readiness rules and all-or-nothing failure behaviour are explicit. The spatial-index requirement addresses the observed source geometry issue. Existing aerial/CAD limitations remain explicit. No implementation code or production deployment is part of this design commit.
