# Combined PDF, Toporama and MRD126 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement and review the tasks in this session.

**Goal:** Implement the approved five changes and verify a real selected-sheet combined PDF.
**Architecture:** Keep the static Leaflet app. Separate official sources/cache, sheet geometry, map raster composition, PDF composition, and live export UI. Batch rendering uses an independent map/canvas, not the editor or a screenshot.
**Tech Stack:** ES modules, Leaflet 1.9.4, Node >=22 tests, jsdom, JSZip, pinned jsPDF and a bundled Unicode font, GitHub Pages.
**Spec:** `docs/superpowers/specs/2026-08-26-combined-pdf-toporama-bedrock-design.md` (approved; binding).

## Global Constraints

- Work ONLY in `mshrmahdi-shr/Phase-I`; preserve the existing app and project compatibility. No backend, authentication, paid API or unrelated project edits.
- A3 landscape 420 × 297 mm, 7 mm margins, a 406 × 283 mm sheet, map left and title block right.
- Preserve minimum figure spans A=500 m, B=100 m, C=1 km, D=2 km, E=20 km.
- Figure C uses `https://maps.geogratis.gc.ca/wms/toporama_en`, layer `WMS-Toporama`, WMS 1.1.1, EPSG:3857. No silent fallback.
- Figure E uses the supplied MRD126-REV1 **With Lowlands** polygon chain. Actual geometry bounds, not NetworkLink Region, determine spatial cache selection. Preserve holes. Official legend mapping must not affect arbitrary custom Bedrock.
- Selected ready sheets only, in A–E order; original figure letters and separate page X of N. A/C/E gives exactly three pages. All-or-nothing download, with cancellation and no download after cancellation.
- Scale is a black/white segmented metric bar derived from the final ground extent, visible on every sheet. Composition DPI is not source detail.
- Preserve Unicode text, wrap at readable sizes, and block overflow rather than clipping. Do not turn user text into HTML/actions.
- Private reference PDFs never enter the repository or public artifact. Generated cache stays outside source commits.
- Do not publish or mutate shared main before verification and release authorization. Report actual verification limits.

## Task 1: Official MRD126 source, legend and spatial cache

**Own files:** create `src/bedrock.mjs`, `src/bedrock-cache.mjs`, `scripts/cache-mrd126.mjs`, `data/mrd126.kml`, `tests/bedrock.test.mjs`, `tests/bedrock-cache.test.mjs`; modify `.gitignore` only for cache. Keep app, workflow, build and package files for later tasks; request dependency changes if essential.

Inputs are `C:/Users/Mahdi/Downloads/doc.kml` and `C:/Users/Mahdi/Downloads/Bed rock-126Rev1_Legend.pdf`. Scratch evidence is in the parent `work/`: `bedrock-paleo-index.kml`, `bedrock-sample.kmz`, `bedrock-legend-extracted.txt`, rendered legend pages. The official source root is `https://www.geologyontario.mndm.gov.on.ca/mines/data/google/MRD126/`; polygon index is `files/paleo/doc.kml` with 468 links. Restrict traversal to that origin/root/branch and reject path escape.

Required interface:

```js
// Shared feature shape matches src/geology.mjs:
// { name, description, unitCode, official, polygon:[[lng,lat]], holes:[rings], color, fillOpacity }
export const BEDROCK_SOURCE; // { id:'MRD126-REV1', name, credits, compilationScale:250000 }
export function parseBedrockKml(text); // official palette only for this parser
export function getBedrockLegend(code); // null for unknown; code, label/material, color
export async function loadBedrockCache(bounds, { fetchImpl=fetch, signal, baseUrl='./mrd126-cache/' } = {});
// resolves {features, coverage:bounds, source:BEDROCK_SOURCE, docs:number}; rejects incomplete manifests
```

Manifest is versioned JSON with source ID, cachedAt, complete, file counts and files `{path,bounds,featureCount}`. Bounds use the existing `{west,south,east,north}` convention if confirmed in source; otherwise match existing convention and document it. File paths remain same-origin under cache. Each cached entry contains parsed features or sanitized local KML. Browser fetches all actual-bounds intersections with bounded concurrency, honors abort, and never loads outside local cache. Empty intersections may resolve empty features; readiness then reports no SITE unit.

Build `node scripts/cache-mrd126.mjs` with `_site` cwd, or explicit output parameter documented in script. Use bounded download/parse concurrency, bounded retries/timeouts, completeness checks and measured byte limit below Pages artifact limits. Preserve full polygons and holes. Do not silently truncate. Full real build is controller verification; unit tests use tiny fixtures and cross-tile geometry.

- [ ] RED: Add tests for an official 55b polygon containing SITE outside its nominal region, a hole excluding SITE, parent/subunit 55/55b descriptions and colors, unknown code and custom parser separation, manifest traversal refusal, partial build rejection, loading all intersecting geometry bounds and cancellation. For example `assert.equal(siteFeature(features, {lat:43.65,lng:-79.38}).unitCode, '55b')` with a genuine appropriate fixture or independently labelled synthetic polygon.
- [ ] Run Node tests and confirm new tests fail because implementation is absent; use bundled Node and escalation only if worker spawn denied.
- [ ] GREEN: Implement parser/legend/cache; transcribe all applicable legend units from all seven pages, verify colors visually. Reuse existing geometry/style helpers instead of duplicating where safe.
- [ ] Run focused and full test suite. Self-review unknown labels, source isolation, cache true bounds, malformed geometry, retry and concurrency limits. Commit only owned files and write report including exact test evidence and interface details.

## Task 2: Sources, shared sheet scale, direct PDF rendering and coordinator

**Own files:** create `src/map-sources.mjs`, `src/sheet-layout.mjs`, `src/pdf-export.mjs`, `src/map-compositor.mjs`, `tests/sheet-layout.test.mjs`, `tests/pdf-export.test.mjs`, `tests/map-compositor.test.mjs`; modify `package.json`, lockfile, `scripts/build-site.mjs`, build tests and public font assets/licenses as needed. Do not edit app/index/styles yet.

Interfaces intended for Task 3:

```js
export function sourceForFigure(code); // source metadata + Leaflet factory/config and credits
export function sheetGeometry(project, code, dpi=300); // physical dimensions + deterministic projected bounds, raster size, scale
export function metricScale(bounds, pixelWidth, maxPixelWidth=160); // segment lengths and metric labels from ground width at centre
export async function composeMap({project, code, features, geometry, signal, onProgress});
// map image {dataUrl,width,height,bounds,dispose}; independent nonzero-size rendering surface; no editor mutation
export async function exportCombinedPdf({project,codes,datasets,dpi,onProgress,signal,compose=composeMap});
// resolves {blob,filename,pageCount}; does NOT download itself; rejects with figure-specific errors
```

Exact signatures may be refined with a documented adapter before UI task; keep clear data-only snapshot input. Dataset entries carry features/source/coverage, not ready flags without geometry. All figure state is explicit and independent of the editor.

Rendering strategy: use deterministic EPSG:3857 footprint fitted from core.figureBounds to the map frame aspect ratio. Fetch only required XYZ tiles or bounded WMS image pieces with CORS and abort; paint onto a real sized canvas. Draw vector polygons/holes, distinct boundaries and SITE with the same transform. A dedicated Leaflet map is acceptable but no screenshots/DOM-to-image. Cap raster size/pixel memory, bounded imagery concurrency, clean canvas/image/objectURL resources on all exits.

PDF uses packaged pinned jsPDF UMD/ESM and bundled appropriate font, vector text/title blocks/legends/scale/north. Font must preserve Persian and other project Unicode in the supported font; report unsupported glyphs instead of corrupt output. Default 300 DPI; reject unsafe 600 DPI with an explicit choose-300 message. Visible image errors block batch; no partial PDF output, no implicit fallback. Validate overflow before final output.

- [ ] RED: Test ground scale at different latitude/extents, each A–E minimum span, nonconsecutive ordering, zero selection, page dimensions/count/text, overflow, aborted/no download, failure attributed to sheet C, distinct map image input per page, and deterministic cleanup. Use real PDF library bytes for page-count/text verification; injected map compositor only in unit tests (real browser verification remains required).
- [ ] Run failing tests before implementation.
- [ ] Verify current jsPDF release/security via official sources; install pinned package and suitable licensed font; stage library/font through allowlist and test they are present while private files remain absent.
- [ ] Implement sources/layout/compositor/PDF coordinator with cancellable bounded work and no hidden partial output. Snapshot project, sort valid unique codes, validate prerequisites or accept clearly validated inputs with explicit guards.
- [ ] Run focused and full tests. Self-review A3 dimensions, approximate metric scale, text/font errors, source failure, memory/cleanup and security. Commit owned files; report exact UI API, test evidence and browser checks still required.

## Task 3: Live selection dialog and app integration

**Own files:** `app.js`, `index.html`, `styles.css`; create `src/export-selection.mjs`, `tests/export-selection.test.mjs`; modify `src/core.mjs`, existing core/UI/print tests only for persisted export preference and shared source/scale integration; modify `.github/workflows/pages.yml` and build docs for both complete caches.

Use Task 1/2 actual exported interfaces. Preserve current drawing/import/search/single-sheet preview. Replace only project number placeholder `FE 26-15876` → `26-15876`; do not normalize stored/user values.

Add official Bedrock load button with the same stale location-request protection as MRD128. Select Figure E loads official cache when required and commits source metadata only with current request geometry. Coverage for D/E must include batch deterministic footprints, not only current editor view. Custom imported geometry stays supported and is identified separately; reloading official source is explicit. Figure C editor/preview always uses Toporama, with source failure visible and no street fallback.

Add Export PDF button/dialog: rows A–E title/readiness/missing reasons, disabled incomplete checkboxes, Select all ready, Clear selection, Cancel, Download PDF (N sheets), progress and cancellation. Recompute readiness from live project, actual geometry/source/coverage and siteFeature. Common project fields/SITE required, B valid site boundary, D/E detected dataset with adequate footprint. Keep saved checkbox preferences but unselect invalid rows. Do not base selection on active figure. Disable duplicate exports and conflicting editing while busy; snapshot input and restore editing on every path. Only trigger browser download after successful whole PDF and a final cancellation check, then revoke object URL safely.

Use shared segmented bar scale on editor and preview for every A–E; PDF uses the same metric calculations. Credits/source IDs correct in all three views. Preserve selected figure codes and known sources in project preferences through restore/JSON without trusting metadata as ready state.

- [ ] RED: Test ready A/C vs missing B boundary and D/E dataset, selected row invalidation, select-all-ready, none, A/C/E order, preferences restore and project number preservation. Add jsdom UI interaction coverage with real DOM where feasible.
- [ ] Run failing tests, then implement minimal modules and UI wiring.
- [ ] Update Pages workflow to build both complete caches without bundling private files; preserve stage/test gates and version stamp.
- [ ] Run all tests/build and self-review accessibility labels, mobile dialog scrolling/button sizes, cancel/escape behavior, concurrent export prevention, active editor preservation and single-sheet behavior. Commit owned files/report.

## Task 4: Integration verification, targeted corrections and release handoff

**Own files:** focused corrections and regression tests in task-owned files as findings require; repository docs plus user-facing verification results under parent `outputs/` only. Do not introduce unrelated work.

- [ ] Build complete MRD126 and MRD128 artifacts; inspect counts/size/completeness. Independently detect Bedrock SITE at a public Ontario location from supplied source chain; compare official legend.
- [ ] Serve staged site locally, use approved browser skill. Fill public test project and boundaries, load both sources, inspect A–E, single-sheet preview/Back and live readiness. Check console errors and source failures.
- [ ] Through app download actual A/C/E PDF. Inspect PDF page count/A3 dimensions/extracted text and render every page; inspect SITE/scale/legend/north/titleblock. Also verify all-five selection, cancellation, no partial file on source failure, long-text handling, mobile selection/download. Save actual PDF and compact verification report in outputs.
- [ ] For each found bug add a focused failing regression, fix and retest. Existing unimplemented historical aerial/CAD is not part of this change.
- [ ] Run final full suite/build, obtain broad branch review, resolve blocking findings. Release requires explicit shared-main/publish authorization if not already clear; then inspect Actions and version match and verify live flow. Never claim deployed based only on push.

## Plan self-review

Tasks 1/2 produce data-only APIs for Task 3; Task 3 owns app/UI and workflow, avoiding overlapping edits. Task 2 owns package/build dependencies. Task 4 verifies source network, real browser download and PDF visuals rather than replacing those checks with mocks. All requested changes and failure paths map to tests and acceptance checks. Unknown source facts require inspection, not invented labels. Publication is a separate authorization/verification gate.
