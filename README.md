# Phase I ESA Mapping & Figure Generator

Static, local-project mapping app. Live site: https://mshrmahdi-shr.github.io/Phase-I/

## Stage 1 readiness

- Address lookup, adjustable SITE, separate site/building boundaries.
- A–E minimum ground spans: 500 m, 100 m, 1 km, 2 km, 20 km. The longer map dimension and imagery zoom limits may add context; use the scale bar for the actual displayed scale.
- MRD128 polygons fetched at build time and read from the same-origin Pages cache, including adjacent KMZ tiles and polygon holes. SITE detection and visible-unit legends use the actual polygon geometry.
- Surficial unit descriptions and approximate RGB swatches transcribed from the supplied OGS MRD128 legend PDF. The PDF uses CMYK; RGB values match its Poppler rendering. Map fill is translucent. Bedrock imports retain their own names, descriptions and KML colors.
- A3 landscape preview with live map, SITE, boundaries, scale, north arrow, relevant legend, project fields and credits. Missing project/geology data or missing visible tiles blocks printing.
- JSON project backup/import and local browser saving. Geology files must be reloaded after reopening a saved project; saved unit metadata alone never satisfies print validation.

## Run and test

Node 22+ and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
cd _site
node ../scripts/cache-mrd128.mjs
python -m http.server 8000
```

Open `http://localhost:8000`. The cache build needs network access to OGS and downloads roughly 177 MB. Do not commit `_site`, `mrd128-cache` or `node_modules`.

## Print workflow

1. Enter project name, number, date and address; locate/adjust SITE.
2. Choose a figure. Figure B needs a completed site boundary. D needs loaded MRD128 and a detected site unit. E needs a self-contained bedrock polygon KML/KMZ and a detected site unit.
3. Press **Print A3 / PDF**. Correct every preflight message. Wait until the full-size preview says **Ready**.
4. Press **Print / Save PDF**. Choose **A3**, **landscape**, **100% scale**, and disable browser headers/footers. Check the print dialog before saving. The sheet is 406 × 283 mm within 7 mm page margins.
5. After printing, the map returns to the editor. **Back to map** also cancels the preview safely.

The A3 preview and native print invocation have been tested in the app browser; a saved native PDF and physical printer output still need operator acceptance in the intended browser. Browser print settings, tile-provider availability and source resolution affect the output. Selecting 300/600 DPI does not create additional image detail.

## Known limitations / next stage

- Uploaded aerials currently retain the file and year, but do **not** yet display as aligned map overlays or print imagery. Alignment, large-image storage and full date support remain to be implemented.
- DXF currently contains site/building boundary polylines in longitude/latitude degrees only. No SITE text, projected coordinate system, IMAGE/IMAGEDEF entities or raster ZIP package yet. It is not an accepted AutoCAD report package.
- Figure C is street context, not verified topographic elevation data.
- Bedrock parsing has synthetic regression coverage. Acceptance with the user's actual Bedrock KML/KMZ is still required.
- Geology imports must contain polygons themselves, not only external NetworkLinks. No automatic bedrock data service is configured.
- Browser storage is limited and not a backup. Export project JSON regularly; large aerial files can exceed browser quota.
- Address and basemap services require internet and are external services. No address autocomplete, bulk geocoding or tile prefetch is performed. Check imagery rights, date and suitability before using a figure in a report.
- This software does not replace professional review of site location, geology or environmental conclusions.

## Deployment

The existing GitHub Pages workflow on `main` installs locked test dependencies, runs tests, stages an allowlist of public files, builds the complete OGS cache, then uploads/deploys `_site`. Incomplete caches fail the build. `version.json` identifies the deployed commit and build time. Tests, dependencies, private reference PDFs and source-control metadata are not published.

On a failed deployment, inspect the specific Actions error before changing or rerunning anything. A green local test run is not proof of a successful Pages deployment.
