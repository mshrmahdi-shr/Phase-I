# Phase I verification record

Date: 2026-08-26
Scope: the combined PDF export, source readiness and public Phase I QA workflow.

## Verified evidence

- The MRD126 cache build was independently checked as complete and selected Bedrock unit 55b at the public Toronto QA location from actual polygon geometry; polygon holes and official legend colors were retained. The MRD128 cache was also reported complete.
- The staged application successfully produced actual combined PDFs. The final-code A/C/E smoke produced three A3 landscape pages in A, C, E order, with distinct map images, figure letters, page counters, SITE/boundaries, scale bars, north arrows, title blocks and source credits visible on rendered pages. Console output was clean.
- The full A-E export was checked as five A3 landscape pages. Its rendered pages included the assigned imagery, Toporama and geology sources, visible SITE and legends.
- Figure C retained NRCan Toporama after an editor street-map selection. A real source failure blocked an A/C batch without a partial file. A deliberately delayed request was cancelled without a later download.
- Long text and unsupported Unicode were blocked with explicit messages. Persian project text rendered connected and right-to-left in the actual exported PDF.
- The regression suite now decodes the generated PDF's ToUnicode map and asserts both a supplied custom Bedrock label and the expected shaped Persian Unicode representation.

## Automated verification

The bundled Node runtime completed the full test suite with 93 passing tests and no failures, cancellations or skips. This includes direct jsPDF serialization checks for page order and size, Unicode font embedding, decoded text, source failure, cancellation and cleanup.

## Remaining release checks

Browser viewport emulation could not produce a mobile viewport: a requested 390 x 844 viewport continued to report 1280 x 720, including in a fresh tab. Physical mobile testing, iOS Safari testing and native operating-system print/save dialog testing remain unverified.

No shared-main publication, deployment, workflow run, deployed-version match or live-site verification is claimed here. Final broad review and release authorization remain separate gates.

## Task 6 project-package verification — 2026-08-28

The primary backup/share workflow is now a versioned `.phasei-project.zip`. The real exporter was run twice over the same frozen project, company profile/logo, two permission-confirmed manual historical images and one current Toronto 1978 metadata record; the byte streams were identical. The production inspector accepted the artifact without accessing an asset store after complete structural validation and a deterministic Node bitmap boundary that closed all three decoded-image handles. The unavailable interactive browser decode remains disclosed below. The package is 8,626 bytes with SHA-256 `f7d724b427fde645ed243db14406629414436c8b5e6c8b148babe8e39b0ff23a`.

The archive contains exactly seven canonical entries in this order: `manifest.json`, `project.json`, `company-profile.json`, one company-logo asset, two historical-image assets and `README.txt`. Each asset is a decoded 3 × 2 PNG with strict kind/owner/reference metadata and SHA-256 `def01a425171ccd3292eae0e433d4f6d7cb751304bce46df530bdafcab9dc717`. The Toronto official item remains metadata-only. No remote imagery bytes are present.

Automated verification with the bundled Node runtime and `--test-isolation=none` completed **333/333 tests**, with no failures, cancellations or skips in 7.723 seconds. Task 6 regressions cover deterministic export, policy-controlled inclusion, cancellation/no output, mutation-free inspection, exact fixed archive cardinality, manifest-declared extras/duplicate roles/nested archives, raw ZIP path and size adversaries, every security-relevant local/central header mismatch including CRC-32, complete bounded PNG/JPEG/TIFF validation, exact manifest/schema/hash/kind/ownership/reference validation, atomic ownership receipts, ambiguous concurrent insert preservation, proven-write compensation, conditional transaction-token rollback, and post-publication edit preservation. The package dialog keeps a cancelling modal visible and focused until settlement, blocks late download, then restores focus before hiding. Legacy JSON wiring and labels remain tested.

The build script passed, bundled Node syntax checks passed for the changed JavaScript modules, and `git diff --check` passed. The deterministic package, extracted manifest, artifact hashes, live metadata log, six-page PDF and six 120 DPI PDF renders are in `artifacts/task-6-project-package` outside the worktree. The PDF is the approved real Task 5 A/B/D/D-continuation/H-official/H-manual artifact copied byte-for-byte; its SHA-256 remains `8e634156f8006d306cb49eeb6bf8db523b1c94d9233a25f6e193058dfdd1b891`.

### Official-source read-only checks

On 2026-08-28, the production provider adapters queried only official ArcGIS JSON metadata for their normal SITE locations. No imagery, tile, export body or protected viewer was requested.

- Ontario was available and returned the 2023 and 2025 Toronto-area footprints; both remain `link-only`.
- Toronto was available and returned 22 records from 1931 through 2025; 20 were `exportable`, while 2018 and 2025 failed closed as `unknown` because their current copyright metadata is not the exact allowlisted value.
- Ottawa was available and returned 18 records from 1928 through 2022; every record remains `unknown` and cannot be approved for embedded export. The live `Basemap_Imagery_1976` metadata currently describes 1928 imagery internally, reinforcing the need to keep this provider link-only and require operator review.
- All three configured official licence URLs returned HTTP 200. The checks recorded response status and content type only; licence text was not scraped.

### Browser limitation

The in-app browser's security review denied navigation to the local `127.0.0.1` verification server. Its policy also prohibited routing around that decision through raw browser control or another browser surface. Therefore no fresh interactive local-browser run, mobile viewport screenshot or browser console-cleanliness claim is made for Task 6. Deterministic mocked provider, profile, SITE, exact/nearby, provider isolation, same-year approval, manual placement, reload/delete, combined PDF, package, cancellation and keyboard behavior remain covered by the production-module DOM test suite; the checked PDF renders are output screenshots, not browser screenshots. This limitation must remain visible to release review.
