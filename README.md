# Phase I ESA Mapping & Figure Generator

Static, local-project mapping app. Live site: https://mshrmahdi-shr.github.io/Phase-I/

## Stage 1 readiness

- Address lookup, adjustable SITE, separate site/building boundaries.
- A–E minimum ground spans: 500 m, 100 m, 1 km, 2 km, 20 km. The map aspect adds context; imagery can be overzoomed without increasing its source detail. A shared segmented metric bar shows approximate ground scale from the final extent.
- MRD128 polygons fetched at build time and read from the same-origin Pages cache, including adjacent KMZ tiles and polygon holes. SITE detection and visible-unit legends use the actual polygon geometry.
- Official MRD126-REV1 Bedrock uses the supplied With Lowlands polygon chain, compiled at 1:250,000. The complete cache manifest selects files from actual geometry bounds and preserves holes. Official legend mappings are separate from custom imports, which retain their names, descriptions and KML colors.
- Figure C uses NRCan Toporama WMS 1.1.1, EPSG:3857, layer `WMS-Toporama`. A/D/E use OpenStreetMap and B uses Esri World Imagery. Editor source failures are visible; there is no silent fallback. Preview and PDF enforce their assigned figure sources.
- Historical Imagery searches curated official Ontario, Toronto and Ottawa catalog endpoints by year and SITE proximity. Exact and nearby candidates remain distinct, provider errors are visible, and each result retains its current provider policy. Link-only/unknown records cannot be approved for embedding; exportable records still require operator confirmation.
- Uploaded historical imagery is validated locally, stored in IndexedDB and placed explicitly against SITE. Multiple approved images may share a year. Figure H sheets are composed in a stable year/order sequence and can be included with A–E in one combined A3 PDF.
- **Export PDF / AutoCAD** selects ready figures independently of the editor. Its PDF action downloads one combined A3 PDF in A–E/H order; progress, cancellation and all-or-nothing source/text checks prevent partial exports.
- The same checked A–E/H rows can produce one **AutoCAD ZIP** in SITE-selected NAD83 / UTM metres. It includes the combined PDF, editable layered DXF linework/text, normalized referenced rasters, world files, logo, attachment script, hashes, source/licence records and beginner instructions.
- A3 landscape preview with live map, SITE, boundaries, scale, north arrow, relevant legend, project fields and credits. Missing project/geology data or missing visible tiles blocks printing.
- A completed company profile and logo are required before report export. The saved profile is snapshotted into the project so a later profile change is visible and never silently changes an existing project.
- The recommended versioned `.phasei-project.zip` package backs up project JSON, the profile/logo and permission-confirmed local imagery. Import is inspection-first and requires confirmation. Legacy JSON remains available as a clearly labelled metadata-only format.

## Run and test

Node 22+ and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
cd _site
node ../scripts/cache-mrd128.mjs
node ../scripts/cache-mrd126.mjs
python -m http.server 8000
```

Open `http://localhost:8000`. Serve the built `_site`, which includes the packaged PDF library and Unicode font. Both cache builds require network access to OGS: MRD128 is roughly 177 MB; MRD126 produces about 57 MB across 468 data files plus its manifest. Both builders fail on incomplete data. Do not commit `_site`, either generated cache, private reference PDFs or `node_modules`.

## Combined PDF workflow

1. Enter project name, number, date and address; locate SITE. Entered project numbers are preserved verbatim in project data and sheets; only download filenames are sanitized.
2. B requires a completed site boundary. D/E require loaded geometry, coverage of the fitted sheet and a detected SITE unit. Use the official load buttons or import self-contained polygon KML/KMZ. Selecting D/E loads missing official data; custom datasets are never silently replaced with official data. H requires approved, placed historical imagery and an unchanged company-profile snapshot.
3. Press **Export PDF / AutoCAD**. Check specific ready rows or **Select all ready**. Incomplete rows explain what is missing. Saved checkbox preferences are revalidated, and invalid selections are removed.
4. Press **Download PDF (N sheets)**. Editing is locked during composition. Cancel or Escape stops the batch; no partial PDF downloads. On success, the browser downloads one file with original figure letters and separate page counters.
   The adjacent **Download AutoCAD ZIP (N images)** action uses those exact checked rows; its count is raster images, not PDF sheets. The dialog previews the SITE-selected NAD83 / UTM zone and blocks incomplete company/logo, missing asset, stale official source, link-only/unknown policy, or unsafe projection input.
5. Use 150 or 300 composition DPI. Existing 600 DPI preferences are retained but rejected with a choose-300 message because the A3 raster exceeds safe limits. Higher composition DPI does not create source detail. Unicode is embedded with DejaVu Sans; unsupported characters and text that cannot fit at readable sizes explicitly block export. Historical sheets preserve image dates and catalog/source attribution; they do not imply that catalog metadata or an operator-entered date was independently verified.

Source images still need an internet connection and CORS access when the dialog reports ready. Geology metadata in saved JSON is not loaded geometry. Reload datasets after reopening a project. Imported geometry and project fields are not uploaded by PDF composition.

## AutoCAD package workflow

1. Complete and save Company Profile, including a decoded PNG/JPEG logo. Locate SITE away from an exact UTM zone boundary, prepare A–E and approve any H imagery whose current policy permits embedding.
2. Press **Export PDF / AutoCAD**, then check the required ready A–E/H rows. The PDF and CAD actions share this one ordered selection; blocked rows remain visible with correction instructions.
3. Confirm the displayed `NAD83 / UTM zone NN — metres`, then press **Download AutoCAD ZIP (N images)**. Progress covers validation, image composition, CAD/PDF writing and compression. Cancel or Escape aborts the atomic operation; a late result cannot download.
4. Extract the complete ZIP before opening it. Open `Project.dxf`, run AutoCAD's `SCRIPT` command and choose `Attach-Images.scr`. Keep the relative `images` and `company` folders beside the DXF. `README.txt` explains relinking and common edits.
5. Use `Manifest.json`/`Manifest.csv` and `Sources-and-Licences.txt` for hashes, CRS, resolution, attribution and licence review. Vector boundaries, labels, notes, title block and image frames are editable. Raster pixels and the logo remain referenced images that can be moved, scaled, clipped or replaced.

The raster-to-UTM placement is a disclosed least-squares contextual fit and is not survey-grade control. Have a qualified reviewer confirm geometry, imagery rights and final CAD/PDF appearance before issue.

## Print workflow

1. Enter project name, number, date and address; locate/adjust SITE.
2. Choose a figure. Figure B needs a completed site boundary. D/E need loaded geology, fitted-sheet coverage and a detected site unit.
3. Press **Single-sheet A3 preview**. Correct every preflight message. The assigned figure source is used even after a temporary editor basemap change. Wait until the full-size preview says **Ready**; missing tiles or overflowing title/legend/source fields block native printing.
4. Press **Print / Save PDF**. Choose **A3**, **landscape**, **100% scale**, and disable browser headers/footers. Check the print dialog before saving. The sheet is 406 × 283 mm within 7 mm page margins.
5. After printing, the map returns to the editor. **Back to map** also cancels the preview safely.

Native browser print settings and physical printer output still need operator acceptance in the intended browser. Tile-provider availability and source resolution affect both export paths. Composition DPI does not change native browser print settings.

## Project package workflow

1. Complete the company profile and logo, then save the project. Before packaging an uploaded historical image, confirm that its redistribution policy permits inclusion. Official remote imagery bytes are not copied into the archive; their validated catalog metadata remains in the project record.
2. Press **Download Project Package**. Export validates every referenced asset, computes SHA-256 hashes and creates a deterministic `.phasei-project.zip`. Cancellation or validation failure produces no partial download.
3. Press **Import Project Package** and choose a package. Mutation-free inspection requires the fixed project/profile/README roles plus exactly the referenced eligible assets, compares raw ZIP local/central headers including CRC-32, and checks canonical paths, bounded sizes, hashes, complete PNG/JPEG/TIFF decode, ownership, project/profile relationship and redistribution evidence.
4. Review the text-only summary, then confirm. New assets are staged by atomic add-if-absent writes before state changes. Compensation deletes only assets carrying this import's exact ownership receipt; ambiguous, concurrent, pre-existing and shared assets are preserved. Project/profile rollback also compares the exact imported after-state and transaction token, so edits made after publication are never overwritten.

Official catalog metadata remains in the project record for later revalidation, but remote imagery bytes are never embedded automatically. A package cannot upgrade an image's trust or redistribution status. **Export Legacy JSON** and **Import Legacy JSON** remain compatible with earlier files, but the legacy format omits the logo and all local imagery bytes.

## Known limitations / next stage

- Official historical providers differ in catalog coverage, date precision, deep-link stability and download/redistribution terms. Search results require operator review; the app does not scrape protected viewers or bypass a provider's access controls.
- CAD ZIP structural, affine, hash and rendered-PDF checks are automated, but an actual AutoCAD/native CAD open remains an operator acceptance check on a workstation with that software installed.
- Geology imports must contain polygons themselves, not only external NetworkLinks; the official source buttons use their complete same-origin caches instead.
- Browser storage is limited and is not the only backup. Export a project package regularly; large local imagery can exceed browser quota. Keep the source files and permission evidence outside the browser as well.
- Address and basemap services require internet and are external services. No address autocomplete, bulk geocoding or tile prefetch is performed. Check imagery rights, date and suitability before using a figure in a report.
- This software does not replace professional review of site location, geology or environmental conclusions.

## Deployment

The existing GitHub Pages workflow on `main` installs locked dependencies, runs tests, stages an allowlist of public files, builds both complete OGS caches, then uploads/deploys `_site`. Incomplete caches fail before upload. `version.json` identifies the deployed commit and build time. Only the required jsPDF runtime/license and public font/license are packaged; tests, development dependencies, private reference PDFs and source-control metadata are not published.

On a failed deployment, inspect the specific Actions error before changing or rerunning anything. A green local test run is not proof of a successful Pages deployment.
