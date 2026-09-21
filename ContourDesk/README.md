# ContourDesk

Clean-room desktop raster-to-vector prototype inspired by the documented workflow of classic map digitizers such as R2V. No proprietary R2V source code is copied.

## What is included

- Two-click Auto Trace with continuity-based line following and small-gap bridging.
- Multi Trace: draw a cut line across many contours and trace the crossings.
- Contour labeling: draw across contours, enter starting elevation and interval, and assign Z values sequentially.
- Semantic layers for contours, buildings, property boundaries, and miscellaneous linework.
- Manual spot elevations.
- Civil 3D-friendly DXF export:
  - 3D contour polylines with Z,
  - buildings/boundaries at Z=0,
  - Softdesk-compatible POINT blocks with ELEV / POINT / DESC attributes for conversion to COGO points.
- TIFF/PNG/JPEG/PDF input.
- Project save/load.
- Portable Windows EXE build workflow via GitHub Actions.

Source package: `ContourDesk_v0.1_clean.zip`.

The supplied `r2vsetup.exe` was inspected statically only. It is an Inno Setup 6.7.0 installer whose loader is built with Embarcadero Delphi for Win32. The proprietary application payload is compressed, so the installer itself does not reveal the R2V tracing algorithm. The workflow implemented here comes from public R2V documentation and is reimplemented from scratch.
