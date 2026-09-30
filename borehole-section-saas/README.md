# Borehole Section SaaS — Web MVP 0.2.0

Stateless browser app for generating editable borehole cross-section DXF files from:
- a Plan DXF containing boreholes and analytical ACAD_TABLE results;
- vector borehole-log PDFs;
- a user-drawn section polyline and user-selected boreholes.

## Current behavior
- Parses Fisher-style vector borehole logs without OCR.
- Reads ACAD_TABLE content from DXF and treats visible ACI 1/red MTEXT spans as exceedances.
- Reads sample/screen intervals from plan result tables.
- Lets the user draw a section polyline and manually select/assign boreholes.
- Projects boreholes to the section and generates editable DXF.
- Exceeded intervals render as red vertical bars over the actual sample depth range; meet/pass intervals render green.
- Uses browser gzip compression for large ASCII DXF uploads.
- Stateless on Vercel: uploads are processed in temporary function storage and are not retained.

## Vercel
Set project Root Directory to `borehole-section-saas`.
The included `api/index.py` exports the FastAPI app and `vercel.json` routes requests to it.

## Safety
Do not commit real client DXF/PDF files to this public repository. Use anonymized fixtures only.

## MVP limitations
This is not engineering-signoff ready. ACAD_TABLE cell styling is not cloned cell-by-cell yet; table collision avoidance/leader routing is basic; monitoring-well construction and water-level geometry are not fully reproduced.
