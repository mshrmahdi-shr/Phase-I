# Editable AutoCAD Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a low-friction ZIP containing NAD83/UTM vector linework, every selected exportable raster with world files, an attachment script, combined PDF, company branding, source manifests, and plain instructions.

**Architecture:** Convert all geometry through one pinned NAD83/UTM projection service, generate simple editable DXF entities on named layers, derive world files from the exact raster transforms, and assemble an immutable all-or-nothing ZIP from the same selection snapshot used by PDF export.

**Tech Stack:** Browser ES modules, proj4, JSZip 3.10.1, existing map/historical compositors and jsPDF, Node >=22, node:test.

**Spec:** `docs/superpowers/specs/2026-08-26-historical-imagery-cad-company-template-design.md`

## Global Constraints

- Execute after the company, map-editor, and historical-imagery plans.
- Use NAD83 / UTM in metres with zone chosen from SITE; support and test Ontario zones 15-18 only.
- Selected A-E and approved historical items are included only when ready and `exportable`.
- Vector boundaries, labels, title block, company text, logo frame, notes, and image frames must remain editable DXF entities.
- Map pixels and company logo remain external raster files; never claim they are editable vectors.
- All paths inside ZIP, DXF labels, SCR commands, and manifests are deterministic, relative, traversal-safe, and ASCII-safe where AutoCAD command parsing requires it.
- ZIP generation is cancellable and atomic. No partial download or orphaned object URL.
- Source resolution, year, attribution, license, coordinate system, bounds, dimensions, and file hash are recorded.

---

## File Structure

- Create `src/projection.mjs`, `tests/projection.test.mjs`: UTM zone and coordinate conversion.
- Create `src/world-file.mjs`, `tests/world-file.test.mjs`: affine raster georeferencing.
- Create `src/cad-dxf.mjs`, `tests/cad-dxf.test.mjs`: editable vector DXF.
- Create `src/cad-manifest.mjs`, `tests/cad-manifest.test.mjs`: CSV/JSON/source/readme/script text.
- Create `src/cad-package.mjs`, `tests/cad-package.test.mjs`: atomic ZIP coordinator.
- Create `src/cad-ui.mjs`, `tests/cad-ui.test.mjs`: selection/progress/download controller.
- Modify `app.js`, `index.html`, `styles.css`, build/package files, `src/core.mjs` compatibility wrapper, and existing tests/docs.

### Task 1: NAD83/UTM projection service

**Files:**
- Create: `src/projection.mjs`
- Create: `tests/projection.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/build-site.mjs`
- Modify: `tests/build.test.mjs`

**Interfaces:**

```js
export function utmZoneForLocation({lat,lng});
// => {zone:15|16|17|18,epsg:'EPSG:26917',name:'NAD83 / UTM zone 17N',units:'m'}
export function createProjector(location,{proj4Impl});
// => {crs,forward([lng,lat]),inverse([easting,northing])}
export function projectRing(ring,projector);
export function projectedBounds(points);
```

- [ ] **Step 1: Add the pinned projection dependency**

Run: `pnpm add --save-exact proj4`

Stage the browser module and license locally; no CDN import.

- [ ] **Step 2: Write failing zone/control-point tests**

Test longitudes in Ontario zones 15-18, exact zone boundaries, invalid latitude/longitude, location outside supported zones, forward/inverse round-trip under 2 cm, and at least one authoritative known control point per supported zone within documented tolerance.

- [ ] **Step 3: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/projection.test.mjs tests/build.test.mjs`

- [ ] **Step 4: Implement explicit NAD83 UTM definitions**

Register EPSG:26915 through EPSG:26918 with `+proj=utm +zone=<n> +datum=NAD83 +units=m +no_defs`. Reject southern hemisphere and locations outside Ontario-supported zones instead of silently choosing WGS84 UTM.

- [ ] **Step 5: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/projection.test.mjs tests/build.test.mjs`

Run: `pnpm test`

```bash
git add -- src/projection.mjs tests/projection.test.mjs package.json pnpm-lock.yaml scripts/build-site.mjs tests/build.test.mjs
git commit -m "Add NAD83 UTM projection for CAD exports"
```

### Task 2: World files for composed and manually rotated imagery

**Files:**
- Create: `src/world-file.mjs`
- Create: `tests/world-file.test.mjs`

**Interfaces:**

```js
export function worldFileFromCorners({upperLeft,upperRight,lowerLeft,pixelWidth,pixelHeight});
// => {coefficients:[A,D,B,E,C,F],text:'six newline-terminated values'}
export function pixelToGround([column,row],coefficients);
export function worldFileExtension(imageExtension); // png=>pgw, jpg/jpeg=>jgw, tif=>tfw
```

- [ ] **Step 1: Write failing affine tests**

Test axis-aligned bounds, rotated rectangles, upper-left pixel-centre convention, negative Y scale, four corner reconstruction within tolerance, invalid/degenerate corners, non-integer pixel dimensions, and deterministic decimal formatting.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/world-file.test.mjs`

- [ ] **Step 3: Implement six-coefficient world files**

Derive column and row vectors from projected upper-left/upper-right/lower-left corners divided by pixel dimensions, then offset C/F to the centre of the first pixel. Emit 12 significant digits with `\n` line endings.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/world-file.test.mjs`

```bash
git add -- src/world-file.mjs tests/world-file.test.mjs
git commit -m "Generate georeferenced raster world files"
```

### Task 3: Plain editable DXF model

**Files:**
- Create: `src/cad-dxf.mjs`
- Create: `tests/cad-dxf.test.mjs`
- Modify: `src/core.mjs`
- Modify: `tests/core.test.mjs`

**Interfaces:**

```js
export function buildCadDxf({project,companyProfile,selection,imageFrames,projector});
// => UTF-8/ASCII-safe DXF string with HEADER, TABLES, BLOCKS, ENTITIES, OBJECTS as required
```

Required layers:

```js
['SITE_MARKER','SITE_BOUNDARY','BUILDING_BOUNDARY','IMAGE_FRAMES','IMAGE_LABELS',
 'TITLE_BLOCK','COMPANY_TEXT','COMPANY_LOGO_FRAME','NOTES']
```

- [ ] **Step 1: Write failing structural tests**

Parse group-code pairs and assert `$INSUNITS=6`, required layer table, projected metre coordinates, closed LWPOLYLINE boundaries, SITE point, one image frame/label per selected item, company/title text as MTEXT/TEXT, safe text escaping, no NaN/Infinity, and no geographic degree coordinates.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/cad-dxf.test.mjs tests/core.test.mjs`

- [ ] **Step 3: Implement focused entity writers**

Create private writers for layer table, LWPOLYLINE, POINT, TEXT/MTEXT, and rectangular frame. Convert all input geometry through the supplied projector. Draw a vector title block near the project geometry without covering it; put company logo placement on `COMPANY_LOGO_FRAME` and leave actual logo attachment to the script.

- [ ] **Step 4: Preserve the old public DXF action through a wrapper**

Keep `buildDxf` available for legacy tests/importers, implemented through or alongside `buildCadDxf` without changing its old WGS84-only contract until the UI switches to CAD package export.

- [ ] **Step 5: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/cad-dxf.test.mjs tests/core.test.mjs`

Run: `pnpm test`

```bash
git add -- src/cad-dxf.mjs src/core.mjs tests/cad-dxf.test.mjs tests/core.test.mjs
git commit -m "Build editable layered CAD drawings"
```

### Task 4: Human-readable manifests, attachment script, and guide

**Files:**
- Create: `src/cad-manifest.mjs`
- Create: `tests/cad-manifest.test.mjs`

**Interfaces:**

```js
export function buildCadManifest({project,companyProfile,crs,files,items});
// => {json,csv,sourcesText,readmeText,attachScript}
```

Each `files` row contains `{path,sha256,mime,bytes,pixelWidth,pixelHeight,worldFilePath}`. Each item contains H/A-E code, year, provider, source resolution, geographic/projected corners, attribution, license, image path, and rotation.

- [ ] **Step 1: Write failing manifest/script tests**

Assert deterministic JSON, RFC 4180 CSV quoting, CRLF `.scr`, relative paths only, `_ -IMAGEATTACH` commands with invariant decimal points, one attachment per raster/logo, no command/newline injection from user text, company/source/license sections, EPSG/name/units, and numbered beginner instructions.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/cad-manifest.test.mjs`

- [ ] **Step 3: Implement safe name allocation and text outputs**

Map display codes to ASCII filenames such as `images/Figure-A.png` and `images/H-1960-1.jpg`; resolve collisions deterministically. The script uses only generated paths/numbers, never raw project/user text. The README explains Extract All, open DXF, run SCRIPT, choose `Attach-Images.scr`, relink the `images` folder, and edit/move/scale/rotate/clip/replace common entities.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/cad-manifest.test.mjs`

```bash
git add -- src/cad-manifest.mjs tests/cad-manifest.test.mjs
git commit -m "Describe and attach CAD package imagery"
```

### Task 5: Atomic CAD ZIP coordinator

**Files:**
- Create: `src/cad-package.mjs`
- Create: `tests/cad-package.test.mjs`
- Modify: `src/map-compositor.mjs`
- Modify: `src/pdf-export.mjs`

**Interfaces:**

```js
export async function exportCadPackage({
  project,companyProfile,companyLogo,selection,datasets,assetStore,dpi=300,
  signal,onProgress=()=>{},composeMap,composeHistorical,exportPdf,Zip=globalThis.JSZip,proj4Impl
});
// => {blob,filename,pageCount,imageCount,crs}; never downloads
```

- [ ] **Step 1: Write failing real-ZIP tests**

Use injected tiny raster composers plus real JSZip/PDF. Assert exact required files, one raster/world-file pair per selected item, company logo, structurally valid DXF, PDF page count, matching hashes/manifests, UTM coordinates, no unselected items, link-only rejection before composition, cancellation cleanup, one sheet failure preventing Blob, and deterministic safe filenames.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/cad-package.test.mjs`

- [ ] **Step 3: Implement snapshot/preflight and bounded composition**

Freeze project/company/selection/dataset/item metadata, verify asset availability and policies, choose projector, and estimate maximum uncompressed bytes before starting. Compose selected maps sequentially or with the existing bounded concurrency; immediately release canvas/bitmap resources after converting to Blob and hashing.

- [ ] **Step 4: Generate all package artifacts in memory, then ZIP once**

Create world files from the exact projected corners used for each raster, DXF from the same frames, manifests from actual bytes/hashes, and PDF through the existing atomic exporter. Add only normalized relative paths. Recheck abort after every expensive phase and before returning the ZIP Blob.

- [ ] **Step 5: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/cad-package.test.mjs tests/pdf-export.test.mjs tests/map-compositor.test.mjs`

Run: `pnpm test`

```bash
git add -- src/cad-package.mjs src/map-compositor.mjs src/pdf-export.mjs tests/cad-package.test.mjs
git commit -m "Assemble complete editable CAD packages"
```

### Task 6: Ordinary-user CAD export UI and final verification

**Files:**
- Create: `src/cad-ui.mjs`
- Create: `tests/cad-ui.test.mjs`
- Modify: `app.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `src/export-selection.mjs`
- Modify: `tests/export-selection.test.mjs`
- Modify: `tests/ui.test.mjs`
- Modify: `README.md`
- Modify: `docs/verification-2026-08-26.md`

**Interfaces:**
- Consumes: the existing export selection model and `exportCadPackage`.
- Produces:

```js
export function createCadExportController({document,getSnapshot,setBusy,exportPackage,download});
```

- [ ] **Step 1: Write failing UI tests**

Test **Download AutoCAD ZIP**, selected-count label, company/profile readiness, UTM zone preview, missing/link-only rows, phase progress, duplicate-click prevention, Cancel/Escape, no download after late completion, object URL revoke, and editing controls restored on every exit.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/cad-ui.test.mjs tests/export-selection.test.mjs tests/ui.test.mjs`

- [ ] **Step 3: Implement simple shared selection UI**

Use the same checked rows as PDF. Add a second primary action **Download AutoCAD ZIP (N images)**, display `NAD83 / UTM zone NN — metres`, and show short progress phases: validating, composing images, writing CAD, writing PDF, compressing, complete.

- [ ] **Step 4: Run automated verification**

Run: `pnpm test`

Run: `pnpm build`

Run: `git diff --check`

- [ ] **Step 5: Inspect a real package**

Create a public test project with A-E and at least two historical images, download the ZIP through the browser UI, extract it, verify hashes and relative paths, inspect DXF group codes, compare world-file corners to manifest coordinates, render the included PDF, and open/import in an available CAD-compatible viewer. If AutoCAD itself is unavailable, state that limitation and do not claim an AutoCAD-native open test.

- [ ] **Step 6: Commit the UI/docs**

```bash
git add -- src/cad-ui.mjs app.js index.html styles.css src/export-selection.mjs README.md docs/verification-2026-08-26.md tests/cad-ui.test.mjs tests/export-selection.test.mjs tests/ui.test.mjs
git commit -m "Add guided AutoCAD package download"
```

## Plan Self-Review

- Spec coverage: NAD83/UTM auto-zone, vector layers, every selected raster, world files, SCR, PDF, logo, manifests, attribution, beginner guide, and atomic ZIP all map to Tasks 1-6.
- Editability statement is accurate: vector drawing/title/company text is editable; raster pixels remain referenced images that can be repositioned/clipped/replaced.
- Type consistency: projection, world-file corners, image-frame metadata, manifest, and ZIP coordinator use the same projected coordinates.
- Security: only generated relative filenames enter scripts/ZIP paths; raw user text is DXF/manifest escaped and never treated as a command.
- Verification distinguishes structural/CAD-compatible inspection from an actual AutoCAD open test.
