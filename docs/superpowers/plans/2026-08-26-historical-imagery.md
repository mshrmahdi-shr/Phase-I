# Official and Manual Historical Imagery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search curated Ontario government/municipal imagery by year, let users preview/crop/approve multiple images per year, support manual georeferenced placement, and export selected historical A3 sheets.

**Architecture:** Use an allowlisted provider registry with small adapters over official ArcGIS/WMS APIs. Keep search metadata separate from approved immutable project items, store binary assets through the existing IndexedDB repository, and feed historical sheets into the same atomic PDF/page-selection pipeline as A-E.

**Tech Stack:** Browser ES modules, Leaflet 1.9.4, ArcGIS REST/WMS, IndexedDB, GeoTIFF browser decoder, JSZip 3.10.1, jsPDF 4.2.1, Node >=22, node:test, jsdom.

**Spec:** `docs/superpowers/specs/2026-08-26-historical-imagery-cad-company-template-design.md`

## Global Constraints

- Execute after the company-profile and map-editor plans; reuse their asset store, company snapshot, saved bounds, legend continuation, and atomic export behavior.
- Query only curated official endpoints; no HTML scraping, Google Earth extraction, authentication bypass, or license guessing.
- Result policy is one of `exportable`, `link-only`, or `unknown`. Only `exportable` results may produce image/PDF/CAD bytes.
- Exact year first; nearby section contains the three nearest distinct acquisition years and all results for those years; **Show all available years** reveals the rest.
- Multiple approved items in one year are preserved with stable UUIDs.
- SITE, site boundary, and building boundary use the same transform as the approved crop.
- PNG, JPEG, and safely decoded GeoTIFF are supported. Unsupported TIFFs are rejected with conversion instructions.
- Search, preview, decode, composition, persistence, and export are cancellable and bounded.

---

## File Structure

- Create `src/imagery/provider-registry.mjs`: curated provider metadata/policy/coverage.
- Create `src/imagery/arcgis-client.mjs`: safe ArcGIS REST directory/metadata/export helpers.
- Create `src/imagery/search.mjs`: concurrent search, year grouping, ranking, cancellation.
- Create `src/imagery/providers/ontario.mjs`, `toronto.mjs`, `ottawa.mjs`: official adapters.
- Create `src/imagery/manual-image.mjs`: PNG/JPEG/GeoTIFF decode and world-file handling.
- Create `src/imagery/placement.mjs`: affine placement/crop validation and transforms.
- Create `src/imagery/canvas-overlay.mjs`: Leaflet-compatible rotated manual-image preview.
- Create `src/historical-layout.mjs`: codes, sheet geometry, title/source model.
- Create `src/historical-ui.mjs`: search/results/crop/manual/approved-list controller.
- Create provider fixture JSON under `tests/fixtures/imagery/` and corresponding test modules.
- Modify `src/core.mjs`, `src/export-selection.mjs`, `src/pdf-export.mjs`, `src/map-compositor.mjs`, `app.js`, `index.html`, `styles.css`, build files, package/lockfile, and existing tests.

### Task 1: Provider and search contracts

**Files:**
- Create: `src/imagery/provider-registry.mjs`
- Create: `src/imagery/search.mjs`
- Create: `tests/imagery-search.test.mjs`

**Interfaces:**

```js
// Provider
{
  id, label, organization, priority,
  coverage, licenseUrl, attribution,
  covers(location),
  async search({location,year,signal,fetchImpl})
}

// Normalized result
{
  id, providerId, title, year, resolutionMeters,
  coverage:{west,south,east,north},
  preview:{kind,url,layer?,tileTemplate?},
  export:{kind,url,layer?,maxWidth,maxHeight}|null,
  policy:'exportable'|'link-only'|'unknown',
  sourceUrl, licenseUrl, attribution
}

export function validateImageryResult(value);
export function groupImageryResults(results,requestedYear);
// => {exact,nearby,remaining,errors}; nearby uses 3 nearest distinct years
export async function searchOfficialImagery({providers,location,year,signal,fetchImpl=fetch,onProgress=()=>{}});
```

- [ ] **Step 1: Write failing normalization/ranking tests**

Test four-digit year validation, invalid coverage/URL/policy rejection, stable provider result IDs, exact first, three nearest distinct years, all results within a chosen year, resolution/provider tie-breakers, one provider failure alongside successes, timeout, and abort.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/imagery-search.test.mjs`

- [ ] **Step 3: Implement the pure registry/search layer**

Use `Promise.allSettled` with one child AbortController per provider, a 12-second timeout, and final parent abort checks. Accept only `https:` official hosts configured by the registry. Return provider-specific errors without converting them into empty success.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/imagery-search.test.mjs`

```bash
git add -- src/imagery/provider-registry.mjs src/imagery/search.mjs tests/imagery-search.test.mjs
git commit -m "Define legal historical imagery search contracts"
```

### Task 2: Safe ArcGIS client and official Ontario/Toronto/Ottawa adapters

**Files:**
- Create: `src/imagery/arcgis-client.mjs`
- Create: `src/imagery/providers/ontario.mjs`
- Create: `src/imagery/providers/toronto.mjs`
- Create: `src/imagery/providers/ottawa.mjs`
- Create: `tests/imagery-providers.test.mjs`
- Create: `tests/fixtures/imagery/ontario-source.json`
- Create: `tests/fixtures/imagery/toronto-directory.json`
- Create: `tests/fixtures/imagery/ottawa-directory.json`
- Create: `tests/fixtures/imagery/map-service.json`

**Interfaces:**

```js
export async function fetchArcGisJson(url,{signal,fetchImpl=fetch,allowedOrigins,allowedRoots});
export function arcGisExportUrl({serviceUrl,bounds,width,height,format='png32'});
export const ONTARIO_IMAGERY_PROVIDER;
export const TORONTO_IMAGERY_PROVIDER;
export const OTTAWA_IMAGERY_PROVIDER;
```

Official roots:

- Ontario: `https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_Imagery/`
- Toronto: `https://gis.toronto.ca/arcgis/rest/services/basemap/`
- Ottawa: `https://maps.ottawa.ca/arcgis/rest/services/`

- [ ] **Step 1: Save minimal non-copyrightable metadata fixtures**

Fixtures contain only fields needed by tests: service names, years, extents, spatial reference, maximum image dimensions, export operations, attribution/license flags, and URLs. Do not copy raster tiles or portal prose.

- [ ] **Step 2: Write failing adapter tests**

Test SITE coverage, year extraction only from approved service naming/metadata, EPSG:3857 extent normalization, official-root confinement, redirect/traversal/cross-origin refusal, malformed JSON, maximum image dimensions, service without Export Map becoming link-only, and license allowlist behavior.

- [ ] **Step 3: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/imagery-providers.test.mjs`

- [ ] **Step 4: Implement generic client and three adapters**

Ontario adapter queries only catalogue/service-source entries documented as open collections and intersects their published footprints. Toronto adapter enumerates `cot_historic_aerial_YYYY` and `cot_ortho_YYYY_*` MapServers under the official basemap folder. Ottawa adapter enumerates `Basemap_Imagery_YYYY` services under the official server. Policy comes from a checked-in curated policy table with official license URLs; blank or unverified license metadata is `unknown`, never exportable by assumption.

- [ ] **Step 5: Verify live metadata read-only, then commit**

Run fixture tests first. Then perform a read-only smoke query against each official root and compare normalized metadata; do not make tests depend on the network.

Run: `pnpm test`

```bash
git add -- src/imagery/arcgis-client.mjs src/imagery/providers/ontario.mjs src/imagery/providers/toronto.mjs src/imagery/providers/ottawa.mjs tests/imagery-providers.test.mjs tests/fixtures/imagery
git commit -m "Add official Ontario municipal imagery adapters"
```

### Task 3: Manual image decoding, world files, and affine placement

**Files:**
- Create: `src/imagery/manual-image.mjs`
- Create: `src/imagery/placement.mjs`
- Create: `src/imagery/canvas-overlay.mjs`
- Create: `tests/manual-image.test.mjs`
- Create: `tests/imagery-placement.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/build-site.mjs`
- Modify: `tests/build.test.mjs`

**Interfaces:**

```js
export async function decodeManualImage(file,{signal,maxBytes=64_000_000,maxPixels=32_000_000});
// => {blob,mime,width,height,geo:null|{crs,transform:[a,b,c,d,e,f]}}
export function parseWorldFile(text);
export function placementFromExtent({bounds,width,height,rotationDegrees=0});
export function validatePlacement(placement,{location});
export function placementCorners(placement);
export function createCanvasImageOverlay({L,map,image,placement});
```

- [ ] **Step 1: Add the pinned GeoTIFF dependency**

Run: `pnpm add --save-exact geotiff`

Stage the browser entry and license through the build allowlist; do not load it from a CDN.

- [ ] **Step 2: Write failing decoder and transform tests**

Use tiny generated PNG/JPEG and GeoTIFF fixtures. Test magic bytes rather than filename, EXIF orientation, pixel/byte limits before canvas allocation, unsupported compression/CRS, six-line world-file parsing, bounds/rotation transforms, SITE containment, and abort during decode.

- [ ] **Step 3: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/manual-image.test.mjs tests/imagery-placement.test.mjs tests/build.test.mjs`

- [ ] **Step 4: Implement decoding and placement**

Accept PNG/JPEG, GeoTIFF in EPSG:4326, EPSG:3857, or NAD83 UTM zones 15-18, and matching `.pgw`/`.jgw` text. For files without georeferencing, initialize a SITE-centered rectangle. Model placement as projected centre, ground width/height, and clockwise rotation; derive corners and canvas transform deterministically.

- [ ] **Step 5: Implement the rotated canvas Leaflet overlay**

Render into an overlay canvas using the map's projected corner positions on `move`, `zoom`, and resize. Dispose listeners, decoded bitmaps, object URLs, and canvas references on remove or abort.

- [ ] **Step 6: Verify and commit**

Run: `pnpm test`

Run: `pnpm build`

```bash
git add -- src/imagery/manual-image.mjs src/imagery/placement.mjs src/imagery/canvas-overlay.mjs tests/manual-image.test.mjs tests/imagery-placement.test.mjs package.json pnpm-lock.yaml scripts/build-site.mjs tests/build.test.mjs
git commit -m "Add manual historical image placement"
```

### Task 4: Historical item schema, crop editor, and persistent UI

**Files:**
- Create: `src/historical-ui.mjs`
- Create: `tests/historical-ui.test.mjs`
- Modify: `src/core.mjs`
- Modify: `tests/core.test.mjs`
- Modify: `app.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `tests/ui.test.mjs`

**Interfaces:**

```js
// Approved project item
{
  id, year, sequence, title, mode:'official'|'manual',
  providerId, sourceUrl, licenseUrl, attribution, policy:'exportable',
  resolutionMeters, bounds, placement, assetId, createdAt, updatedAt
}

export function historicalFigureCode(items,itemId); // H-YYYY-N
export function createHistoricalImageryUI({document,map,L,assetStore,providers,getProject,saveProject,onChanged});
```

- [ ] **Step 1: Write failing schema/migration/UI tests**

Test stable UUIDs, duplicate same-year items, code ordering, exact/nearby/all sections, provider error retry, preview/cancel, crop restore, manual source/permission requirement, import without georef, add/update/delete confirmation, reload from IndexedDB, missing asset readiness, and all dynamic text inserted with `textContent`.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/historical-ui.test.mjs tests/core.test.mjs tests/ui.test.mjs`

- [ ] **Step 3: Extend project schema and asset references**

Migrate legacy `{id,year,name,size,dataUrl}` entries by extracting their data URLs into the asset store during app startup and replacing them with the approved metadata shape. If extraction cannot commit, retain the legacy project and show export-backup guidance; never drop the original data.

- [ ] **Step 4: Implement the automatic and manual UI modes**

Add year/search controls, result cards with thumbnail/source/resolution/license, exact/nearby/all grouping, retry, and **Preview and crop**. Crop mode shows the fixed A3 frame and existing boundaries, with **Use current crop**, **Reset to SITE**, **Cancel**, and **Add to package**. Manual mode adds file, optional world file, source/citation, permission acknowledgement, extent drawing, move/resize/rotation controls, and the same approval buttons.

- [ ] **Step 5: Implement approved-list management**

Group approved items by year, show H-code/readiness/source/crop, and provide View/Edit/Delete. Save item metadata only after official crop/export validation or a successful manual asset transaction.

- [ ] **Step 6: Verify and commit**

Run: `pnpm test`

Run: `pnpm build`

```bash
git add -- src/historical-ui.mjs src/core.mjs app.js index.html styles.css tests/historical-ui.test.mjs tests/core.test.mjs tests/ui.test.mjs
git commit -m "Add historical imagery search and crop workflow"
```

### Task 5: Historical A3 composition and combined PDF selection

**Files:**
- Create: `src/historical-layout.mjs`
- Create: `tests/historical-layout.test.mjs`
- Modify: `src/map-compositor.mjs`
- Modify: `src/pdf-export.mjs`
- Modify: `src/export-selection.mjs`
- Modify: `tests/map-compositor.test.mjs`
- Modify: `tests/pdf-export.test.mjs`
- Modify: `tests/export-selection.test.mjs`

**Interfaces:**

```js
export function historicalSheetGeometry(project,item,dpi=300);
export async function composeHistoricalImage({project,item,geometry,assetStore,signal,onProgress});
// same {dataUrl,width,height,bounds,dispose} contract as composeMap
```

- `exportCombinedPdf` accepts `selection:[{kind:'figure',code:'A'}|{kind:'historical',id}]` while continuing to accept legacy `codes` through a small adapter.

- [ ] **Step 1: Write failing layout/compositor/PDF tests**

Test A3 size, approved crop preservation, boundary transform, official ArcGIS export dimensions/coverage, manual affine rendering, same-year H-code order, A-E before historical order, company branding, source/year/resolution/attribution text, selection persistence, link-only and missing-asset blockers, cancellation, and no partial Blob.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/historical-layout.test.mjs tests/map-compositor.test.mjs tests/pdf-export.test.mjs tests/export-selection.test.mjs`

- [ ] **Step 3: Implement historical layout and bounded composition**

Use approved bounds unchanged, fit only the A3 frame aspect when the user first approves the crop, and request no more than the final raster viewport. Official export URLs remain under provider roots and respect provider maximum width/height through bounded tiles/pieces. Manual composition reads the asset Blob and affine placement from IndexedDB.

- [ ] **Step 4: Extend the immutable PDF page plan and selection dialog**

List A-E then approved historical items by year/sequence. Snapshot selected item metadata and required assets before remote work. Render one historical A3 map page per item, plus any existing geology continuation pages. Report progress with H-code and abort all sibling requests on failure.

- [ ] **Step 5: Verify real PDF and commit**

Run: `pnpm test`

Run: `pnpm build`

Generate a real A/B/D plus two same-year historical PDF, inspect A3 boxes/text/page order, render every page, and compare crop/boundaries with the editor.

```bash
git add -- src/historical-layout.mjs src/map-compositor.mjs src/pdf-export.mjs src/export-selection.mjs tests/historical-layout.test.mjs tests/map-compositor.test.mjs tests/pdf-export.test.mjs tests/export-selection.test.mjs
git commit -m "Export approved historical aerial sheets"
```

### Task 6: Project package backup and end-to-end historical verification

**Files:**
- Create: `src/project-package.mjs`
- Create: `tests/project-package.test.mjs`
- Modify: `app.js`
- Modify: `index.html`
- Modify: `README.md`
- Modify: `docs/verification-2026-08-26.md`

**Interfaces:**

```js
export async function exportProjectPackage({project,companyProfile,assetStore,Zip=globalThis.JSZip});
export async function inspectProjectPackage(file,{Zip=globalThis.JSZip}={});
export async function commitProjectPackage(candidate,{assetStore});
```

- [ ] **Step 1: Write failing project-package security/round-trip tests**

Round-trip a project with two manual images and company profile. Assert remote redistributable imagery inclusion follows policy, link-only metadata stays metadata, hashes verify, and invalid/traversal/oversized/duplicate archives do not mutate the current project/profile/store.

- [ ] **Step 2: Run and confirm RED, then implement inspect-before-commit package flow**

Run: `pnpm exec node --test --test-isolation=none tests/project-package.test.mjs`

Keep legacy JSON import available and label it as legacy. Make `.phasei-project.zip` the primary backup.

- [ ] **Step 3: Run complete automated verification**

Run: `pnpm test`

Run: `pnpm build`

Run: `git diff --check`

- [ ] **Step 4: Run browser verification against mocked and live official sources**

Verify first-run profile, SITE, exact-year search, nearby fallback, provider error isolation, two same-year approvals, manual placement, reload, delete, combined PDF, project package export/import, mobile controls, cancellation, and console cleanliness. Test live services read-only with public locations in provider coverage; record unavailable sources honestly.

- [ ] **Step 5: Commit documentation/integration**

```bash
git add -- src/project-package.mjs app.js index.html README.md docs/verification-2026-08-26.md tests/project-package.test.mjs
git commit -m "Back up historical imagery project packages"
```

## Plan Self-Review

- Spec coverage: curated legal providers, Ontario/Toronto/Ottawa, exact/nearby/all years, multiple images/year, preview/crop, boundaries, manual PNG/JPEG/GeoTIFF, affine placement, IndexedDB, historical A3 selection/PDF, and project backup all have tasks.
- Policy consistency: provider policy is normalized once; unknown/link-only results never reach raster composition.
- Type consistency: normalized result, approved historical item, placement, and compositor contracts are defined before UI/PDF consumers.
- Network safety: fixture tests cover providers; live services are smoke checks, not unit-test dependencies.
- User data safety: project/template archives are inspected before atomic commit and legacy data is never silently deleted.
