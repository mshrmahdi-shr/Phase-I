# Combined PDF verification record

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
