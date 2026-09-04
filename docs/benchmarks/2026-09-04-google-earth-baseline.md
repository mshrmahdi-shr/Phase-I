# Phase-I benchmark baseline

This benchmark records the previous Phase-I build before deploying the historical imagery architecture update.

| Check | Result |
|---|---:|
| Node test cases | 451 passed / 0 failed |
| Test duration | 24.7 s |
| Built `_site` files | 620 |
| Built `_site` size | 237,121,223 bytes |

The existing Phase-I application already has the safe workflow required for Google Earth historical imagery: it opens Google Earth for the user, accepts a screenshot or local image through **Manual upload**, records year/source/citation, supports multiple historical items with stable sequences, places and crops each image, and includes approved items in PDF/AutoCAD selection.

The new architecture package is retained separately in `ontario-records-review`; this deployment uses the established Phase-I implementation and its existing export pipeline so the benchmark remains comparable.
