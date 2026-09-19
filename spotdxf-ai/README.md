# SpotDXF AI

Standalone subproject inside `mshrmahdi-shr/Phase-I`. It does **not** modify or depend on the Phase-I application.

## Purpose

Upload a TIFF/JPEG/PNG survey drawing, detect elevation-like numeric labels with **PaddleOCR-VL 1.6 Spotting**, review the detected point locations, and export selected points as CSV or AutoCAD DXF 3D `POINT` entities where `Z = elevation`.

## Current architecture

- Browser: TIFF decode with vendored `UTIF.js`, image downscale capped at 6500 px width, overlapping 800×600 OCR tiles, point review UI, CSV/DXF generation.
- Serverless API: `api/spot.js` calls the official PaddleOCR-VL 1.6 Hugging Face demo Spotting endpoint and returns `rec_texts` + rotated polygons.
- No Tesseract / EasyOCR path is used.
- `.00` readings without a nearby dot are treated as likely contour labels and are excluded by default; all uncertain cases remain editable.

## Tested state (2026-09-19)

A real crop from the target survey was sent through the PaddleOCR-VL 1.6 Spotting endpoint. The engine returned 31 text polygons; 27 values matched valid 3-digit decimal elevation format. A DXF self-test produced 27 `POINT` entities and a CSV with 27 data rows. This proves the OCR → coordinate → export plumbing is non-empty. Full-sheet accuracy still requires review because survey labels can be extremely small/rotated and contour labels can resemble spot elevations.

## Local test

```bash
npm test
```

## Deploy as a separate Vercel project

Import the existing GitHub repository, then set **Root Directory** to:

```text
spotdxf-ai
```

Do not set the repository root as the Vercel project root; this folder is intentionally isolated from the Phase-I application.

## Confidentiality warning

The current prototype sends OCR tiles to PaddlePaddle's public Hugging Face demo endpoint. Do not upload confidential company drawings unless that external processing is permitted. Production should replace `PADDLE_GRADIO_BASE` with a private GPU-hosted PaddleOCR-VL endpoint.
