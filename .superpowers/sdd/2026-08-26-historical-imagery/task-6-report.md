# Task 6 report: Project package backup and end-to-end historical verification

## Status

Task 6 was implemented on the approved Task 5 head `88bf61945f8e9f88478c793c4ebb8b8bfd86bf58`. It adds the recommended versioned `.phasei-project.zip` export/inspect/commit workflow, retains Legacy JSON as explicitly labelled metadata-only compatibility, updates the application and documentation, and produces inspectable artifacts outside the worktree. AutoCAD packaging was not implemented.

## Package implementation

- `exportProjectPackage` freezes validated project schema v6 and company-profile schema v1 state, reads only referenced assets by ID, checks exact metadata/blob kind, MIME, bounded image dimensions, byte size and SHA-256, and rejects missing, stale, foreign-kind or policy-ineligible assets. Company logos and permission-confirmed manual imagery are embedded. Official imagery remains metadata-only and is never fetched by packaging.
- Canonical package schema v1 uses stable recursively sorted JSON, a fixed 1980 ZIP timestamp, STORE compression and deterministic entry order. Every manifest entry records its canonical path, kind, media type, size, SHA-256, asset ID/dimensions/timestamp, owner, reference IDs and redistribution policy/evidence. Filenames use a bounded Windows-safe `.phasei-project.zip` suffix.
- `inspectProjectPackage` reads a maximum 72 MiB archive with no state callbacks. Raw ZIP validation precedes JSZip extraction and rejects multi-disk/ZIP64/commented archives, encryption, unsupported flags/methods/extra fields, suspicious external attributes and symlinks, hidden/overlapping data, every security-relevant local/central header disagreement including CRC-32, absolute/traversal/backslash/NUL/control/encoded paths, NFKC/case-fold collisions, exact duplicate central records, more than 68 entries, entries over 16 MiB, totals over 64 MiB and compression ratios over 200. Inflation is streamed with CRC, declared-size and cancellation checks.
- Inspection requires exactly one `project.json`, one `company-profile.json`, one `README.txt` and exactly one eligible entry for every referenced local asset, in deterministic order. It rejects every declared extra, duplicate role/asset, arbitrary metadata file and nested archive. Canonical JSON/current schemas, project/profile snapshot identity, hashes, size, kind, ownership, references and redistribution evidence are exact. PNG/JPEG/TIFF bytes then pass the existing bounded complete manual-image structural and browser decode boundary, with decoded media and dimensions checked against metadata. Untrusted names remain inert normalized data. Candidates are deeply frozen and tracked in a private `WeakSet`, so commit accepts only a direct inspected candidate.
- `commitProjectPackage` validates and reuses only byte-identical pre-existing assets and stages new assets through atomic `addIfAbsent` writes carrying unguessable operation tokens. Cleanup can call `deleteOwned` only with the exact durable ownership receipt; a `ConstraintError`, ambiguous result or concurrent same-byte insert without that receipt is preserved. A proven write-then-throw can still be compensated. Shared, reused, colliding and unrelated company assets are never inferred to be owned by the import.
- Publication carries a transaction token. Failure rollback first rereads the two-key state and proceeds only when it still exactly equals the imported after-state; the application callback independently rechecks the transaction token plus exact memory and localStorage values. Later project/company edits are preserved and a rollback conflict is surfaced. Only after a successful scoped metadata rollback is the prior UI reinitialized; owned, unreferenced staged assets are then compensated.

## Application and UI integration

The application now persists the project and company profile as one compensated logical state transition over their two existing localStorage keys, with a transaction token and compare-before-rollback guard. Initialization cancels drawing/print state, invalidates pending geology loads, clears runtime geology/layers and refreshes map, company, historical, preflight and export controllers. A failed initialization reinitializes the previous state only when the imported state is still owned; later edits remain authoritative.

The accessible Project Package dialog provides progress, cancellation, actionable errors, a text-only inspection summary and explicit confirmation. During an active cancellation it remains visible, enabled and focused with a cancelling status until the promise settles; it then moves focus to the visible launcher before hiding. Escape, focus trap/restore, busy locking, destruction, generation invalidation and no-late-download behavior are covered. Mobile actions stack below 540 px. The export panel calls `.phasei-project.zip` the recommended backup/share format; Legacy JSON buttons and `.legacy.json` filenames state that logos and local imagery bytes are omitted.

README and the dated verification record now cover current historical search/manual placement/H-sheet/PDF behavior, package steps, permission boundaries, metadata-only official records, storage limitations and the continued DXF/AutoCAD limitation.

## TDD evidence

The implementation followed RED/GREEN cycles:

- The first core test run failed because `src/project-package.mjs` did not exist. Clean two-manual-image/profile/logo round-trip, deterministic bytes, metadata-only official imagery, export failure cases, inspection adversaries and staged compensation were written before product code.
- The first package UI run failed 0/4 because the controller and package controls did not exist. After the initial UI implementation, behavioral failures remained for cancellation/focus and import confirmation; each was fixed against its failing test.
- A UI-initialization rollback assertion was added and observed RED at 6/7 core tests because the restored UI was not initialized. Commit compensation was extended, then the focused suite passed.
- A cancellation regression was observed RED because an abort while hashing a reused asset became an asset-collision error. `sameStoredAsset` now preserves `AbortError`.
- The original final audit added a write-then-abort regression. Fix round 1 replaced the resulting same-byte ownership inference: a proven durable write carries an exact receipt and is compensated while preserving `AbortError`; an identical asset without that receipt is retained.
- Fix round 1 reproduced all six review findings before product changes: manifest-declared extras/duplicate roles/nested archives and raw local/central header mismatches failed 2/11; a forged 24-byte PNG was accepted; the new asset-store ownership API was absent 0/2; a concurrent same-byte insert was deleted; a post-publication edit was rolled back; and Cancel hid the modal while focus remained inside it.
- GREEN regressions now enforce fixed package cardinality and header parity, route inspected images through the bounded complete decoder, gate cleanup on atomic ownership receipts, compare exact after-state plus transaction tokens before rollback, and keep cancellation visible/focused until settlement. The focused asset-store/package/package-UI/app command passes **47/47** including nested app subtests.

Final full suite with the bundled Node runtime and `--test-isolation=none`: **333/333 passed**, 0 failed/cancelled/skipped, 7.723 s. Final verification below was rerun after documentation and artifact regeneration.

## Build and static verification

- `node scripts/build-site.mjs`: passed; `_site` staged successfully.
- Bundled Node `--check`: passed for `app.js`, both new product modules and both new test modules.
- `git diff --check`: passed; Git emitted only expected Windows LF-to-CRLF working-copy notices.

## Artifact inspection

Artifacts are outside the worktree at `C:\Users\Mahdi\Documents\Codex\2026-08-26\new-chat\artifacts\task-6-project-package`.

- Package: `ab-12345.phasei-project.zip`, 8,626 bytes, SHA-256 `f7d724b427fde645ed243db14406629414436c8b5e6c8b148babe8e39b0ff23a`. Two consecutive real exports were byte-identical. The production inspector revalidated the written file through the complete structural decoder with a deterministic Node bitmap boundary; the unavailable interactive browser decode remains disclosed below.
- Canonical entries: `manifest.json`, `project.json`, `company-profile.json`, `assets/company-logo-acme.png`, `assets/3caa1022-b2e7-4c63-8ca8-12f4845e1be1.png`, `assets/d9a64b75-571c-4142-ae5d-cc8ee35f36fa.png`, `README.txt`.
- Embedded assets: one company logo and two permission-confirmed manual historical images. Each is a valid 3 × 2 PNG, 134 bytes, SHA-256 `def01a425171ccd3292eae0e433d4f6d7cb751304bce46df530bdafcab9dc717`. The current Toronto 1978 official record is metadata-only.
- `manifest.json` and `artifact-hashes.json` provide independently inspectable entry and hash records. `generate-task6-artifacts.mjs` regenerates and reinspects the package.
- PDF: `task-6-historical-a3-verification.pdf`, six real A3 pages, unchanged SHA-256 `8e634156f8006d306cb49eeb6bf8db523b1c94d9233a25f6e193058dfdd1b891`. It is the previously approved real Task 5 A/B/D/D-continuation/H-official/H-manual artifact copied byte-for-byte. Six corresponding 120 DPI PNG renders are included as output screenshots; `artifact-hashes.json` records each hash. These are PDF renders, not browser screenshots.

## Deterministic browser and live verification

The production-module deterministic tests cover first-run profile/logo, SITE, exact and nearby groups, isolated provider retry, two same-year approvals, manual permission/placement, reload/missing-asset state, delete with stable sequence, combined PDF selection/composition, clean package round-trip/commit, persistent branding, mobile CSS, keyboard focus, cancellation/no partial output and console-safe text handling.

A fresh interactive local-browser pass could not be completed. The in-app Browser security review denied `http://127.0.0.1:8126`, and its policy explicitly prohibited routing around that decision through raw browser control or another browser surface. No local browser screenshots, mobile viewport result or browser-console-cleanliness claim is made. The prepared production-index harness and attempt context remain in the external artifact directory, but the harness result is not claimed as executed.

With scoped network access, `live-metadata-probe.mjs` ran the production provider adapters against official read-only ArcGIS JSON metadata only. It requested no imagery, tiles, exports or protected viewers:

- Ontario: available; two Toronto-area results (2023, 2025), both `link-only`.
- Toronto: available; 22 results, 20 `exportable`; 2018 and 2025 remain `unknown` because the current copyright metadata is not the exact allowlisted value.
- Ottawa: available; 18 results, all `unknown` and therefore not approvable for embedded export.
- Ontario, Toronto and Ottawa licence URLs each returned HTTP 200; only response headers were recorded and no licence text was scraped.

`live-metadata-results.json` contains the exact timestamp, duration, years, policy counts, source/licence URLs and header results. The live Ottawa `Basemap_Imagery_1976` service currently describes 1928 imagery internally. Since Ottawa remains `unknown`/link-only with no approval action, this inconsistency is surfaced as an operator-review concern rather than treated as trusted acquisition metadata.

## Concerns and limitations

- Release review still needs an authorized interactive browser pass for the complete deterministic flow, mobile viewport, focus behavior and console cleanliness. The automated DOM coverage is comprehensive but is not represented as that missing browser evidence.
- Official endpoints and legal metadata can change. Current-result revalidation remains mandatory; `unknown` or `link-only` records cannot become embedded assets through package import.
- STORE compression favors deterministic, inspectable output and bounded inspection over small package size. The 72 MiB compressed/64 MiB uncompressed limits and per-entry limits may require users with many large images to retain multiple project records or reduce local imagery.
- A failure while compensating localStorage/UI/assets is returned as an `AggregateError` so the original and cleanup failures remain visible. Safety favors retaining an uncertain asset over deleting a possibly shared or changed asset.
- AutoCAD IMAGE/IMAGEDEF/raster packaging remains a separate unimplemented plan. Existing DXF output is not an accepted AutoCAD report package.

## Commits

Original product implementation commit: `57c3f37fb5d5c608a71a8e489c7d51a55d9dca2b`.

Fix-round product/tests/docs commit: reported in the final handoff because a commit cannot contain its own hash.
