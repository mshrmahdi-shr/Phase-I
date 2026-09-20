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

## Civil 3D COGO export

Use **Civil 3D PNEZD (.csv)** for the most predictable COGO-point import. The generated file is headerless and follows **Point Number, Northing, Easting, Elevation, Description**. The default raw description is `SPOT_ELEV`, so a Civil 3D Point Group can include points by Raw Description `SPOT_ELEV` (or the custom description entered in the UI). A LandXML COGO export is also provided. The 3D DXF remains available for generic CAD use, but DXF POINT entities are not Civil 3D COGO points and therefore are not the preferred input for Point Groups.

## High-recall detection

High Recall is enabled by default. It raises the processing width from 6500 px to 9000 px, increases tile overlap, sends lossless PNG OCR tiles, and upscales OCR tiles 1.35× before PaddleOCR-VL 1.6. OCR text polygons are mapped back to original-image coordinates. A broader local dot/cross search is then used to attach the elevation label to the survey mark. Labels without a plausible nearby survey mark remain orange REVIEW candidates instead of being silently exported as spot points.
