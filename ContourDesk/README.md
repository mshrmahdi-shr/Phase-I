# ContourDesk

ContourDesk is a clean-room desktop raster-to-vector application built from scratch after inspecting the packaging of the supplied R2V installer and studying the public R2V workflow documentation. It does **not** copy R2V's proprietary source code or algorithms.

The supplied installer is an Inno Setup 6.7.0 Windows package, signed by Able Software LLC; the loader was built with Embarcadero Delphi for Win32. The compressed application payload does not disclose the proprietary tracing implementation.

ContourDesk reproduces the useful workflow concepts for survey/topographic scans:

- Prepare/threshold and skeletonize TIFF/PNG/JPEG/PDF maps.
- **Auto Trace (2 clicks):** click twice on the same contour to give the tracer direction/context.
- **Multi Trace:** draw a crossing line and trace several intersected contour lines.
- **Label Contours:** draw a crossing line, enter starting elevation and contour interval.
- Manual contour/building/property-boundary digitizing on separate layers.
- Buildings and boundaries export at Z=0.
- Manual spot elevations.
- Project save/load.
- Civil 3D DXF export with 3D contour polylines and Softdesk-compatible POINT blocks containing ELEV / POINT / DESC attributes, so Civil 3D can convert them to COGO points.

This semi-automatic design is intentional: on one-bit survey scans, contour lines, building edges, property lines, symbols and text are all black. A user seed is much safer than pretending a fully automatic classifier can reliably separate every feature.

## Windows build

GitHub Actions builds a portable `ContourDesk.exe`. Open the workflow artifact named **ContourDesk-Windows**.

## Usage

1. Open TIFF/PDF.
2. Click **Prepare**.
3. Select **Auto Trace** and click twice along one contour.
4. Use **Multi Trace** for a family of contours.
5. Use **Label Contours** across the traced contours.
6. Trace buildings/boundaries on their dedicated layers.
7. Export Civil 3D DXF.
