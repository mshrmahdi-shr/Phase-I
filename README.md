# Phase I ESA Web App

Mobile-friendly browser prototype for Phase I ESA mapping and figure preparation.

## Current prototype
- Address lookup with OpenStreetMap/Nominatim
- Street and satellite review layers
- SITE marker, site boundary, building boundary drawing
- Figure A–E workflow and configurable report context
- Historical aerial image upload with year metadata
- KML/KMZ geology import and point-in-polygon site unit detection
- Local project persistence and JSON backup
- A3 print/PDF layout starter
- DXF geometry export

## Run locally
Serve the repository with any static HTTP server, e.g. `python3 -m http.server 8000`, then open `http://localhost:8000`.

## Notes
This is the core browser test build. Production-grade archival PDF composition, georeferenced raster placement, official Ontario government dataset connectors, and portable DXF image packaging are separate server/export pipeline tasks.
