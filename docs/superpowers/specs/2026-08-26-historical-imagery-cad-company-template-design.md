# Historical Imagery, Editable CAD Package, and Company Template Design

**Date:** 2026-08-26
**Repository:** `mshrmahdi-shr/Phase-I`
**Status:** Proposed for user review

## 1. Objective

Extend the existing browser-only Phase I ESA map generator so a non-technical user can:

- search legal Ontario government and municipal imagery sources by year;
- review exact-year and nearby-year results;
- zoom, crop, approve, and add one or more images per year to a project;
- upload and place an image manually when no suitable online result exists;
- reuse the existing SITE, site boundary, and building boundary on historical sheets;
- export selected A-E figures and historical sheets as one PDF;
- export an editable AutoCAD package containing vectors, georeferenced rasters, and attachment instructions;
- store a reusable company logo and title-block profile locally, export it as a shareable template, and restore it after browser data is cleared;
- use unrestricted user-selected map views while retaining only technical safety checks;
- finish boundary drawing with right-click or Enter; and
- see `AB-12345` as the project-number example without accidentally exporting it as real project data.

The application remains a static GitHub Pages site. It will not add accounts, a paid backend, unrestricted web scraping, or a dependency on Google Earth imagery extraction.

## 2. Guiding Constraints

### 2.1 Legal source use

The application will query only curated official APIs and map services. It will not scrape portal HTML or bypass access controls. Each provider definition must include:

- official organization and service URL;
- geographic coverage;
- available or discoverable acquisition years;
- preview and export capabilities;
- required attribution;
- license URL and an explicit `exportable`, `link-only`, or `unknown` policy;
- service limits such as maximum image size and scale range.

Only `exportable` results may be embedded in PDF or CAD packages. `link-only` and `unknown` results may be shown to the user with their official source page but cannot be downloaded or embedded by the application. Manual uploads require the user to enter a source/citation and acknowledge that they have permission to use the file.

Initial official providers:

1. Ontario Geospatial Ontario imagery catalogue and Ontario Imagery Web Map Service.
2. City of Toronto public ArcGIS imagery services.
3. City of Ottawa public ArcGIS imagery services.

Additional municipal providers are added only after their official API, browser CORS behavior, coverage, license, attribution, and export operation have automated tests. Municipalities without a verified embeddable service remain link-only suggestions with a manual-upload fallback.

Primary references:

- Ontario imagery catalogue: <https://data.ontario.ca/en/dataset/open-ontario-imagery>
- Ontario Imagery Web Map Service: <https://www.arcgis.com/home/item.html?id=101295c5d3424045917bdd476f322c02>
- Toronto ArcGIS imagery directory: <https://gis.toronto.ca/arcgis/rest/services/basemap>
- Toronto Open Government Licence: <https://open.toronto.ca/open-data-licence/>
- Ottawa aerial imagery information: <https://ottawa.ca/en/planning-development-and-construction/developing-property/geomatic-services/geospatial-analytics-technology-and-solutions/aerial-photography-base-mapping-and-lidar>

### 2.2 Static and low-cost operation

All search orchestration, preview, crop selection, persistence, PDF generation, DXF generation, coordinate conversion, and ZIP creation run in the browser. No proxy or paid service is required. The provider registry must remain compatible with a future optional backend, but the initial implementation cannot depend on one.

### 2.3 Honest output quality

The application may crop or resample an authorized image but may not imply that resampling increases source detail. Every output records the source year, nominal resolution when available, provider, attribution, and whether the acquisition date has been independently verified.

## 3. User Experience

## 3.1 Company profile setup

On first use, the application opens a required **Company Profile** setup panel. It contains:

- company legal/display name;
- address;
- phone;
- email;
- website;
- optional prepared-by and reviewed-by defaults;
- PNG or JPEG logo upload;
- logo placement preview and simple scale/alignment controls.

SVG is not accepted in the initial version because untrusted SVG can contain executable or external content. Logo dimensions, decoded file type, and size are validated before storage.

The header always exposes **Edit Company Profile**, **Export Company Template**, and **Import Company Template**. PDF, historical sheets, DXF, and CAD ZIP exports remain unavailable until the required company fields and logo are valid, because the user specified that this identity is mandatory on every output.

The profile is stored in IndexedDB and reused by every project in that browser. Clearing browser site data removes it; the supported recovery mechanisms are:

- import a previously exported company template; or
- import a project package containing a snapshot of the profile used for that project.

## 3.2 Shareable company template

The shareable file uses the extension `.phasei-template.zip` and contains:

- `template.json` with a versioned, validated schema;
- `logo.png` or `logo.jpg`;
- `README.txt` with import instructions.

It contains no project, property, client, map, or historical-image data. Import shows a preview and asks for confirmation before replacing the current profile. Unknown fields are ignored; invalid versions, paths, files, or logo formats are rejected. Imported text is always treated as text and never as HTML.

## 3.3 Historical imagery search

The Imagery panel is replaced by two clear modes: **Search official sources** and **Manual upload**.

For official search:

1. The user enters a four-digit year and selects **Search**.
2. The application requires a valid SITE.
3. It queries only provider adapters whose jurisdiction or advertised coverage contains SITE.
4. Requests run concurrently with per-provider timeouts and cancellation.
5. Exact-year matches appear first.
6. If no exact match exists, or in a separate collapsed section when exact matches do exist, results from the three nearest distinct acquisition years are shown; **Show all available years** exposes the rest.
7. Results are ranked by exactness, year distance, ground resolution, exportability, and provider priority.
8. Multiple results for one year are retained; no year-based deduplication is performed.

Each result card shows:

- thumbnail;
- acquisition year;
- official provider;
- nominal ground resolution when published;
- coverage status for SITE and the current requested crop;
- exportable or link-only status;
- license and attribution links;
- **Preview and crop** action.

Provider errors do not discard successful results from other providers. A failed provider is shown with a retry action and an intelligible error. Search results are metadata only until the user opens a preview, reducing bandwidth and latency.

## 3.4 Preview, crop, and approval

Opening a result makes it the active map source, zooms to SITE, and overlays the existing SITE marker, site boundary, and building boundary. The user can pan and zoom freely. A visible A3 crop frame shows the exact output area.

The editor provides:

- **Use current crop**;
- **Reset to SITE**;
- **Cancel**;
- **Add to package**.

Adding stores an immutable source record and the approved bounds. The imagery bytes are fetched only when needed for local preview/export and are cached in IndexedDB subject to quota. Reopening an item restores the approved bounds and permits an explicit update. A user may add any number of items for the same year.

Historical items receive stable codes in chronological order, such as `H-1960-1`, `H-1960-2`, and `H-1972-1`. Renumbering is presentation-only; internal UUIDs do not change.

## 3.5 Manual upload and placement

Manual mode asks for:

- year;
- source/citation;
- source URL when available;
- usage-permission acknowledgement;
- image file;
- optional world file or GeoTIFF georeferencing.

Supported first-version display formats are PNG, JPEG, and GeoTIFF. GeoTIFF decoding uses a pinned browser library and accepts only tested compression modes and EPSG:4326, EPSG:3857, or NAD83 UTM zones covering Ontario. Pixel, archive, and memory limits are enforced before full decoding. An unsupported TIFF is rejected with conversion guidance rather than stored as an unusable file. PNG/JPEG uploads may include a matching world file.

When recognized georeferencing is present, the image is placed automatically. Otherwise the user draws an image extent around SITE and can move, resize, and rotate it before approval. This is an affine placement, not rubber-sheet or projective rectification. The interface states that fine registration can be adjusted later in the CAD package.

After placement, the same crop-and-approval workflow applies. Site and building boundaries remain visible so the user can verify alignment.

## 3.6 Historical export selection

The combined export dialog lists A-E first and approved historical items afterward in year order. Every row displays readiness, source, year, crop span, and license status. The user may select or deselect every row independently.

Each selected historical image becomes one A3 landscape sheet with:

- approved crop;
- SITE, site boundary, and building boundary;
- north arrow and computed metric scale bar;
- company logo and company title block;
- project name, address, project number, and date;
- historical year, source, resolution, and attribution;
- stable historical figure code.

The combined PDF is atomic: source or composition failures prevent a partial download and identify the exact affected item.

## 4. Map View and Drawing Changes

## 4.1 User-selected zoom

The fixed minimum ground spans for figures A-E are removed as export blockers. Any finite saved view is accepted when:

- SITE remains inside the view;
- bounds remain within supported Web Mercator latitude/longitude limits;
- the source can render the requested area;
- the raster request remains within the configured memory/pixel budget.

The application retains source maximum zoom and memory safeguards. It warns when the user zooms beyond published source detail instead of claiming extra resolution. It may lower composition dimensions within the selected 150/300 DPI safety profile, but it cannot silently change the approved geographic crop.

Every figure card shows its saved ground span and changes visibly between **View**, **Use for A3**, **View saved**, and **Update A3 view** states. The scale bar is calculated from final exported bounds.

## 4.2 Non-blocking legend layout

Official geology text must not block the complete export merely because it is long. Layout proceeds in this order:

1. wrap text within the available legend width;
2. reduce font and spacing down to tested accessibility minima;
3. use a compact multi-column legend when it improves fit;
4. create an automatic A3 legend-continuation sheet when content still does not fit.

The map sheet retains unit codes, colors, and short material names. The continuation sheet retains the complete descriptions and source attribution. Required project/company fields, missing source imagery, corrupt geometry, unsafe memory use, and non-exportable licensing may still block export.

## 4.3 Boundary drawing completion

While drawing a site or building boundary:

- left-click adds a point;
- Backspace removes the most recent point;
- Enter or right-click closes the ring to its first point and finishes;
- Escape cancels the current unfinished drawing;
- the normal browser context menu is suppressed only while drawing.

The existing Finish Draw and Undo Point buttons remain available. Completion requires at least three distinct vertices, a closed non-degenerate ring, and no self-intersections. Failure preserves the draft and explains the correction. Success updates the visible polygon, persists it, and reports completion.

## 4.4 Project number example

`AB-12345` becomes the project-number placeholder and documentation example. The stored value for a new project remains blank so a sample number cannot be exported accidentally. Export validation continues to require a real project number.

## 5. Persistence and Project Packages

Binary assets move from localStorage to an IndexedDB asset store. localStorage retains only the lightweight current-project manifest needed for quick startup. The storage layer provides:

- versioned schemas and migrations;
- asset UUIDs and content hashes;
- quota checks before writes;
- transactional add/remove operations;
- detection of missing assets;
- explicit cleanup of unreferenced assets;
- no silent deletion of project content.

The existing JSON project import remains supported for backward compatibility. The primary backup becomes `.phasei-project.zip`, containing project JSON, company-profile snapshot, manual imagery, approved cached crops that are legally redistributable, and a manifest. Remote imagery that cannot be redistributed is recorded as metadata and must be refetched or replaced after import.

Company-template import and project import never overwrite the current profile or project without a confirmation preview.

## 6. AutoCAD Package

## 6.1 Coordinate system

The CAD package uses NAD83 / UTM in metres, with the UTM zone selected from SITE longitude and recorded as an EPSG code. Ontario locations outside the tested supported zone set fail clearly rather than receiving guessed coordinates. Coordinate conversion uses a pinned, locally staged projection library and is verified against authoritative control points.

The DXF declares metre units. WGS84 source coordinates are transformed once through the shared projection service; PDF map positioning and CAD positioning use the same approved geographic bounds.

## 6.2 ZIP contents

`<project-number>-cad-package.zip` contains:

```text
Project.dxf
Combined-Phase-I.pdf
Attach-Images.scr
README.txt
Sources-and-Licences.txt
Manifest.csv
Manifest.json
company/logo.png
images/Figure-A.png
images/Figure-B.jpg
images/Figure-C.png
images/Figure-D.png
images/Figure-E.png
images/H-1960-1.jpg
images/H-1960-1.jgw
...
```

Only selected, ready, exportable figures are included. The exact extension follows the encoded image type; each georeferenced image has the matching six-parameter world file.

## 6.3 Editable DXF structure

The DXF uses plain, clearly named layers:

- `SITE_MARKER`;
- `SITE_BOUNDARY`;
- `BUILDING_BOUNDARY`;
- `IMAGE_FRAMES`;
- `IMAGE_LABELS`;
- `TITLE_BLOCK`;
- `COMPANY_TEXT`;
- `COMPANY_LOGO_FRAME`;
- `NOTES`.

Boundaries, frames, labels, company text, and title-block geometry are vector entities. The logo and map imagery remain external raster references so a normal AutoCAD user can move, scale, rotate, clip, detach, or replace them without editing DXF internals. Raster pixels are not represented as editable CAD vectors, and the UI/readme states this limitation.

`Attach-Images.scr` uses relative image paths and the generated insertion, scale, and rotation values. `README.txt` gives short numbered instructions for extracting the ZIP, opening `Project.dxf`, running the script when automatic references are unavailable, and relinking the `images` folder. It also explains how to make common edits.

`Manifest.csv` is readable by non-technical users. `Manifest.json` is machine-readable and includes file hashes, UTM zone/EPSG, geographic and projected bounds, pixel dimensions, source year, source resolution, attribution, and license.

## 7. Internal Modules

The feature is split into focused modules rather than expanding `app.js` further:

- `src/company-profile.mjs`: validation, persistence metadata, template import/export;
- `src/asset-store.mjs`: IndexedDB transactions, quota, hashes, migrations;
- `src/imagery/providers/*.mjs`: one official provider adapter per service family;
- `src/imagery/provider-registry.mjs`: coverage and policy registry;
- `src/imagery/search.mjs`: concurrent search, ranking, cancellation, error aggregation;
- `src/imagery/placement.mjs`: georeferencing, placement, rotation, crop validation;
- `src/historical-layout.mjs`: historical A3 sheet layout;
- `src/legend-layout.mjs`: wrapping, fitting, and continuation sheets;
- `src/projection.mjs`: NAD83/UTM conversion and zone selection;
- `src/cad-package.mjs`: raster/world files, DXF additions, scripts, manifests, ZIP;
- UI controllers for company settings, imagery search/results, crop editor, and export selection.

Provider adapters expose a common interface:

```js
{
  id,
  label,
  covers(location),
  search({location, year, signal}),
  previewLayer(result, L),
  exportPlan({result, bounds, pixels, signal}),
  policy(result)
}
```

Search results and approved historical items use versioned plain-data schemas and contain no live Leaflet objects or executable callbacks.

## 8. Error Handling and Safety

- Every network request has a timeout and AbortSignal.
- Cancelling search, preview, PDF, or CAD work aborts queued and active requests.
- A provider failure is isolated and never fabricates a successful result.
- Cross-origin or tile failures are reported with provider and retry guidance.
- Image dimensions, decoded pixel count, MIME type, and archive expansion size are checked before allocation.
- ZIP paths reject absolute paths, traversal, encoded traversal, duplicate normalized paths, and executable content.
- Company/profile/project import validates schemas before mutating persistent state.
- Export uses an immutable snapshot so edits during generation cannot drift into only part of a package.
- Partial PDFs or ZIPs are never downloaded.
- IndexedDB errors and quota exhaustion leave the prior project intact and instruct the user to export a backup.

## 9. Verification

Implementation uses test-driven development and extends existing tests rather than relying only on browser checks.

Required automated coverage:

- provider coverage, year normalization, exact/nearby ranking, license policy, timeout, cancellation, and malformed-response tests;
- fixture-backed Ontario, Toronto, and Ottawa adapter tests without live-network dependence;
- company profile and template schema, logo validation, import confirmation, text safety, and profile snapshot tests;
- IndexedDB migration, quota, missing-asset, transaction rollback, and cleanup tests;
- manual placement, world-file parsing, rotation, crop, and SITE containment tests;
- unrestricted saved-view regression tests with memory/source safety retained;
- Enter/right-click/Backspace/Escape drawing interaction tests;
- legend wrap, font fitting, multi-column, and continuation-sheet tests;
- historical PDF page order, A3 dimensions, boundaries, company block, attribution, and Unicode tests;
- NAD83/UTM zone and known-coordinate tests;
- DXF layer/entity, world-file, script, manifest, relative-path, and ZIP security tests;
- atomic cancellation/failure tests for PDF and CAD packages;
- build-staging tests for all new modules and pinned browser dependencies.

Browser verification must exercise:

1. first-run company setup, template export, clear-and-restore simulation;
2. official year search, exact and nearby results, preview, crop, approval, and reload;
3. two images in the same year;
4. manual upload and placement;
5. right-click and Enter boundary completion;
6. unrestricted A-E views and long Figure D legend continuation;
7. combined A-E plus historical PDF;
8. CAD ZIP generation, extraction, manifest inspection, image/world-file matching, and DXF structural inspection.

Live deployment verification uses a cache-busted release URL, confirms the Pages workflow, verifies first-party asset revisioning, and smoke-tests official providers without treating a third-party outage as a successful deployment result.

## 10. Delivery Sequence

The work is implemented in reviewable slices while preserving a usable application after each slice:

1. company profile, template backup/restore, IndexedDB asset foundation, and `AB-12345` placeholder;
2. drawing completion shortcuts, unrestricted saved views, and non-blocking legend continuation;
3. provider registry, Ontario/Toronto/Ottawa search adapters, result ranking, and legal policy;
4. preview/crop approval, manual placement, historical list, persistence, and historical PDF sheets;
5. NAD83/UTM projection, editable DXF expansion, world files, attachment script, manifests, and CAD ZIP;
6. full regression, browser verification, documentation, and authorized production deployment.

Each slice must pass the complete existing test suite plus its new regression tests before the next slice begins. Production publication remains a separate user-authorized action after final verification.

## 11. Explicit Non-Goals

- extracting or downloading Google Earth historical imagery;
- unrestricted internet crawling or scraping;
- bypassing municipal authentication, payment, rate limits, or copyright controls;
- cloud accounts or cross-device synchronization;
- photogrammetric orthorectification or rubber-sheet georeferencing;
- converting raster imagery pixels into editable CAD vectors;
- claiming a higher resolution than the official source provides.
