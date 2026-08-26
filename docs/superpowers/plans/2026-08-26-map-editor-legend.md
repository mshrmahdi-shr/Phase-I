# Map View, Drawing, and Non-Blocking Legend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow any user-approved map view that contains SITE, add keyboard/right-click drawing completion, and prevent long official geology legends from blocking PDF export.

**Architecture:** Treat the saved geographic bounds as the authoritative crop while preserving source and memory safety. Move drawing input rules and legend fitting into pure modules, then integrate continuation legend pages into the atomic PDF page plan.

**Tech Stack:** Browser ES modules, Leaflet 1.9.4, jsPDF 4.2.1, Node >=22, node:test, jsdom.

**Spec:** `docs/superpowers/specs/2026-08-26-historical-imagery-cad-company-template-design.md`

## Global Constraints

- Execute after `2026-08-26-company-profile-storage.md`; preserve its required company snapshot/output interfaces.
- Any finite Web Mercator crop containing SITE is valid regardless of the old A-E minimum span.
- Retain bounds validation, SITE containment, 150/300 DPI, `MAX_RASTER_PIXELS`, source maximum zoom, tile/image failure detection, and atomic download.
- Never silently change approved geographic bounds to satisfy output layout.
- Long official legend text must wrap/fit or create continuation sheets; it must not be clipped or replaced with invented abbreviations.
- Right-click suppresses the context menu only during active boundary drawing.
- Existing Finish Draw and Undo Point controls remain functional and share the same completion logic.

---

## File Structure

- Modify `src/sheet-layout.mjs`, `tests/sheet-layout.test.mjs`: authoritative saved crop and scale.
- Create `src/drawing-controller.mjs`, `tests/drawing-controller.test.mjs`: drawing input state/commands.
- Create `src/legend-layout.mjs`, `tests/legend-layout.test.mjs`: wrap/fit/multi-column/continuation plan.
- Modify `src/pdf-export.mjs`, `tests/pdf-export.test.mjs`: continuation-page composition and page numbering.
- Modify `app.js`, `index.html`, `styles.css`, `tests/ui.test.mjs`: input events and visible feedback.

### Task 1: Remove artificial figure-span export limits

**Files:**
- Modify: `src/sheet-layout.mjs`
- Modify: `tests/sheet-layout.test.mjs`
- Modify: `src/print-validation.mjs`
- Modify: `tests/print-validation.test.mjs`

**Interfaces:**
- Preserve: `sheetGeometry(project,code,dpi)`, `captureFigureView(project,code,bounds)`, `metricScale(bounds,pixelWidth,maxPixelWidth)`.
- New rule: `figure.bounds` is authoritative after aspect fitting; `figure.extentMeters` is a display/migration value, not a minimum blocker.

- [ ] **Step 1: Replace minimum-span tests with failing unrestricted-view regressions**

```js
test('saved A-E crops may be smaller or larger than old defaults',()=>{
  const p=createProject();p.location={lat:43.7,lng:-79.3};
  for(const code of ['A','B','C','D','E']){
    p.figures[code].bounds={north:43.7002,south:43.6998,east:-79.2997,west:-79.3003};
    const g=sheetGeometry(p,code,150);
    assert.ok(g.bounds.north>=p.figures[code].bounds.north);
    assert.ok(g.bounds.south<=p.figures[code].bounds.south);
  }
});
```

Also test huge but safe crops, SITE outside crop, Mercator overflow, NaN, 600 DPI, and raster pixel overflow.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/sheet-layout.test.mjs tests/print-validation.test.mjs`

Expected: old default-minimum assertions or implementation reject the small saved crops.

- [ ] **Step 3: Implement authoritative saved bounds**

When no saved bounds exist, continue to derive the initial view from the figure default. When saved bounds exist, validate them with `validFigureBounds(bounds,project.location)`, fit only their aspect ratio to the A3 map frame, and do not union them with `figureBounds(defaultExtent)`. Compute the displayed span from final ground height.

- [ ] **Step 4: Run full tests and commit**

Run: `pnpm exec node --test --test-isolation=none tests/sheet-layout.test.mjs tests/print-validation.test.mjs tests/ui.test.mjs`

Run: `pnpm test`

```bash
git add -- src/sheet-layout.mjs src/print-validation.mjs tests/sheet-layout.test.mjs tests/print-validation.test.mjs tests/ui.test.mjs
git commit -m "Allow user-selected A3 map views"
```

### Task 2: Unified keyboard and right-click drawing controller

**Files:**
- Create: `src/drawing-controller.mjs`
- Create: `tests/drawing-controller.test.mjs`
- Modify: `app.js`
- Modify: `tests/ui.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Produces:

```js
export function createDrawingController({closeRing,validBoundary,onDraft,onCommit,onCancel,onStatus});
// methods: begin(mode), add([lng,lat]), undo(), finish(), cancel(),
// handleKey(event), handleContextMenu(event), state()
```

- `finish()` returns `{ok:true,mode,ring}` or `{ok:false,message}` and preserves invalid drafts.

- [ ] **Step 1: Write failing command tests**

Test Enter finish, NumpadEnter finish, right-click preventDefault and finish, Backspace preventDefault/undo, Escape cancel, inactive context menu untouched, invalid two-point finish preserved, self-intersection preserved, and button methods using the same controller.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/drawing-controller.test.mjs tests/ui.test.mjs`

- [ ] **Step 3: Implement the pure controller and integrate it once**

Replace duplicated `draw`, `pts`, finish, undo, and cancel mutations in `app.js` with controller callbacks. Bind `document.keydown` and map-container `contextmenu`; do not bind a document-wide context-menu blocker. Keep `Finish Draw` and `Undo Point` buttons as controller method calls.

- [ ] **Step 4: Add visible help/status text**

Update the help copy to state: left-click adds points; Enter/right-click finishes; Backspace removes; Escape cancels. On success show `Site boundary completed.` or `Building boundary completed.`

- [ ] **Step 5: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/drawing-controller.test.mjs tests/ui.test.mjs`

Run: `pnpm test`

```bash
git add -- src/drawing-controller.mjs app.js index.html tests/drawing-controller.test.mjs tests/ui.test.mjs
git commit -m "Finish map boundaries with keyboard or right click"
```

### Task 3: Deterministic legend fitting and continuation planning

**Files:**
- Create: `src/legend-layout.mjs`
- Create: `tests/legend-layout.test.mjs`

**Interfaces:**
- Produces:

```js
export function planLegend({entries,measure,box,fontSizes=[7.5,7,6.5,6,5.5],columnCounts=[1,2]});
// => {
//   map:{fontSize,columnCount,columns:[entries]},
//   continuations:[{title:'LEGEND — CONTINUED',fontSize,columnCount,columns:[entries]}]
// }
```

- `measure(entry,{fontSize,width})` returns finite millimetre height after wrapping.
- Every input entry appears exactly once in order across map and continuation pages.

- [ ] **Step 1: Write failing layout tests**

Test short single-column content, two-column improvement, long Figure D entries, one unbreakable word, deterministic ordering, no duplicate/missing entries, bounded font choices, and continuation pages that each fit.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/legend-layout.test.mjs`

- [ ] **Step 3: Implement greedy measured pagination**

Try font sizes largest-first and one/two columns. Prefer a single map-page legend when it fits. Otherwise retain the site/boundary symbols and as many geology entries as fit on the map page, then paginate remaining complete entries on continuation pages. If one entry cannot fit at minimum size and full continuation-page width, reject with a precise `Legend entry <code> exceeds the supported text length.` error.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/legend-layout.test.mjs`

```bash
git add -- src/legend-layout.mjs tests/legend-layout.test.mjs
git commit -m "Plan geology legend continuation sheets"
```

### Task 4: Integrate continuation pages into atomic PDF output

**Files:**
- Modify: `src/pdf-export.mjs`
- Modify: `tests/pdf-export.test.mjs`
- Modify: `src/export-selection.mjs`
- Modify: `tests/export-selection.test.mjs`
- Modify: `app.js`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `planLegend` and the company-profile snapshot from the preceding plan.
- Produces: an internal immutable page plan:

```js
[
  {kind:'map',code:'D',sheet,legendPlan},
  {kind:'legend',code:'D',continuationIndex:1,entries:[/* complete entries */]}
]
```

- [ ] **Step 1: Add failing real-PDF tests**

Create a Figure D dataset with enough long official entries to exceed the current box. Assert export succeeds, page count is greater than selected figure count, the first page contains Figure D, continuation text is extractable, every unit code is present, and page X of N uses final physical page count. Confirm a source-image failure still yields no Blob.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/pdf-export.test.mjs tests/export-selection.test.mjs`

- [ ] **Step 3: Refactor validation into a complete page plan**

Prepare all map sheets, measure all legend text with the real embedded font, call `planLegend`, and calculate physical pages before any remote map composition. Draw continuation pages with company title block, project details, source attribution, figure code, and no fabricated map/scale.

- [ ] **Step 4: Update selection messaging**

Replace `Text does not fit` blocking readiness for legitimate official legend content with `Figure D will include N legend continuation sheet(s).` Keep blocking for invalid project/company fields, unsupported glyphs, missing imagery, unsafe memory, and malformed geometry.

- [ ] **Step 5: Run full verification**

Run: `pnpm test`

Run: `pnpm build`

Run: `git diff --check`

Render the long-legend PDF to PNG and visually inspect map legend, continuation pages, company block, page numbering, and no clipped text.

- [ ] **Step 6: Commit**

```bash
git add -- src/pdf-export.mjs src/export-selection.mjs app.js styles.css tests/pdf-export.test.mjs tests/export-selection.test.mjs
git commit -m "Continue oversized geology legends in PDF"
```

## Plan Self-Review

- Spec coverage: unrestricted saved views, retained technical safeguards, scale recalculation, right-click/Enter/Backspace/Escape controls, and legend continuation all have focused tasks.
- Type consistency: existing sheet/capture APIs remain stable; `planLegend` is the only new PDF dependency.
- Atomic behavior: complete physical pages are planned before imagery; continuation does not weaken source, geometry, company, or memory validation.
- Accessibility: keyboard commands supplement visible controls and help text; no permanent context-menu suppression is introduced.
