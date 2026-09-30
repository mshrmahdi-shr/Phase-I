from __future__ import annotations
import re
import statistics
from pathlib import Path
from typing import Iterable
import fitz
from app.models import BoreholeLog, Interval, SampleInterval

BH_RE = re.compile(r"REPORT\s+OF\s+BOREHOLE\s*:\s*([^\n\r]+)", re.I)
SAMPLE_RE = re.compile(r"\b(?:WT)?\d{2,8}-\d{3,8}-\d{1,4}\b", re.I)
DEPTH_RANGE_RE = re.compile(r"\(\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*m\s*\)", re.I)


def _clean_bh(value: str) -> str:
    value = re.sub(r"\s+", "", value.upper())
    value = value.replace("MW(", "(") if value.startswith("MW(") else value
    return value


def _normalized_words(page):
    """Return text words in an unrotated page coordinate system."""
    m = page.derotation_matrix
    out = []
    for w in page.get_text("words"):
        r = fitz.Rect(w[:4]) * m
        out.append((float(r.x0), float(r.y0), float(r.x1), float(r.y1), *w[4:]))
    return out


def _fit_depth_axis(words):
    # Find numeric ruler labels by clustering integer depth labels by x-position.
    numeric = []
    for x0, y0, x1, y1, text, *_ in words:
        if re.fullmatch(r"\d+", text or ""):
            d = int(text)
            if 0 <= d <= 60:
                numeric.append((((x0+x1)/2), ((y0+y1)/2), d))
    if len(numeric) < 4:
        return None
    numeric.sort(key=lambda t:t[0])
    clusters = []
    for item in numeric:
        if not clusters or abs(item[0] - statistics.median(x[0] for x in clusters[-1])) > 10:
            clusters.append([item])
        else:
            clusters[-1].append(item)
    candidates = []
    for cl in clusters:
        by_depth = {}
        for x,y,d in cl:
            by_depth.setdefault(d,[]).append(y)
        pts = sorted((d,statistics.median(ys)) for d,ys in by_depth.items())
        # require a meaningful ruler sequence, usually 1..N
        if len(pts) < 4:
            continue
        slopes=[]
        for (d1,y1),(d2,y2) in zip(pts,pts[1:]):
            if d2!=d1:
                slopes.append((y2-y1)/(d2-d1))
        if not slopes:
            continue
        ppm=statistics.median(slopes)
        if abs(ppm) < 8:
            continue
        y_zero=statistics.median([y-ppm*d for d,y in pts])
        residuals=[abs((y_zero+ppm*d)-y) for d,y in pts]
        err=statistics.median(residuals) if residuals else 999
        xmed=statistics.median(x for x,_,_ in cl)
        diffs=[b[0]-a[0] for a,b in zip(pts,pts[1:])]
        seq_ratio=(sum(1 for d in diffs if d==1)/len(diffs)) if diffs else 0.0
        candidates.append((seq_ratio, len(pts), -err, -xmed, y_zero, ppm))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    _,_,_,_,y_zero,ppm=candidates[0]
    return y_zero, ppm

def _horizontal_segments(page):
    segs = []
    m = page.derotation_matrix
    for d in page.get_drawings():
        for it in d.get("items", []):
            if it[0] == "l":
                p1, p2 = it[1] * m, it[2] * m
                if abs(p1.y - p2.y) <= 0.35:
                    segs.append((min(p1.x, p2.x), max(p1.x, p2.x), float((p1.y+p2.y)/2)))
            elif it[0] == "re":
                r = it[1] * m
                segs.append((float(r.x0), float(r.x1), float(r.y0)))
                segs.append((float(r.x0), float(r.x1), float(r.y1)))
    return segs

def _nearest_bounds(y: float, x: float, segs, min_span: float = 20.0):
    ys = []
    for x0, x1, yy in segs:
        if x0 - 0.5 <= x <= x1 + 0.5 and (x1 - x0) >= min_span:
            ys.append(yy)
    ys = sorted(set(round(v, 3) for v in ys))
    above = [v for v in ys if v < y - 0.5]
    below = [v for v in ys if v > y + 0.5]
    return (max(above) if above else None, min(below) if below else None)


def _material_name(text: str, previous: str | None = None) -> str:
    t = text.upper()
    if "AS ABOVE" in t and previous:
        return previous
    if "ASPHALT" in t:
        return "ASPHALT"
    if "FILL" in t:
        return "FILL"
    if "CLAY" in t and "SILT" in t:
        return "CLAYEY SILT"
    if "SILT" in t and "SAND" in t:
        return "SILTY SAND"
    if "CLAY" in t:
        return "CLAY"
    if "SILT" in t:
        return "SILT"
    if "GRAVEL" in t and "SAND" in t:
        return "SAND AND GRAVEL"
    if "SAND" in t:
        return "SAND"
    if "GRAVEL" in t:
        return "GRAVEL"
    if "NO RECOVERY" in t:
        return "NO RECOVERY"
    return previous or "UNKNOWN"


def _parse_geometry_page(page, filename: str) -> BoreholeLog:
    text = page.get_text("text")
    words = _normalized_words(page)
    bh_match = BH_RE.search(text)
    if bh_match:
        bh_id = _clean_bh(bh_match.group(1).split()[0])
    else:
        # Older reports often have the ID as a standalone header line.
        m = re.search(r"\b(BH\s*\d+(?:\(MW\))?|MW\s*\d+)\b", text, re.I)
        bh_id = _clean_bh(m.group(1)) if m else Path(filename).stem.upper()

    job = None
    m = re.search(r"(?:Job\s*No|PROJECT\s*NO)\s*:?\s*([0-9-]+)", text, re.I)
    if m:
        job = m.group(1)

    total_depth = None
    for pat in [r"Terminated\s+at\s+([0-9.]+)\s*Meters", r"End\s+of\s+borehole\s+at\s+([0-9.]+)\s*m?"]:
        m = re.search(pat, text, re.I)
        if m:
            total_depth = float(m.group(1))
            break

    ground_elev = None
    m = re.search(r"([0-9]{2,3}(?:\.[0-9]+)?)\s*m\s*asl", text, re.I)
    if m:
        ground_elev = float(m.group(1))

    axis = _fit_depth_axis(words)
    segs = _horizontal_segments(page)
    samples: list[SampleInterval] = []

    # Prefer explicit depth ranges when available (older Fisher format).
    lines = page.get_text("text").splitlines()
    joined = " ".join(lines)
    for sm in SAMPLE_RE.finditer(joined):
        sid = sm.group(0)
        window = joined[sm.end(): sm.end() + 180]
        dm = DEPTH_RANGE_RE.search(window)
        if dm:
            top, bottom = map(float, dm.groups())
            samples.append(SampleInterval(sample_id=sid, top=top, bottom=bottom, duplicate="DUP" in window.upper()))

    # Geometry-derived sample intervals for logs where ranges are not printed.
    if axis:
        y_zero, ppm = axis
        existing = {s.sample_id.upper() for s in samples}
        for w in words:
            sid = w[4]
            if not SAMPLE_RE.fullmatch(sid or "") or sid.upper() in existing:
                continue
            cx = (w[0] + w[2]) / 2
            cy = (w[1] + w[3]) / 2
            top_y, bottom_y = _nearest_bounds(cy, cx, segs, min_span=25)
            if top_y is None or bottom_y is None:
                continue
            d1 = (top_y - y_zero) / ppm
            d2 = (bottom_y - y_zero) / ppm
            top = max(0.0, min(d1, d2))
            bottom = max(top, max(d1, d2))
            samples.append(SampleInterval(sample_id=sid, top=round(top, 3), bottom=round(bottom, 3)))

    # Infer parameters by nearest text around each sample word.
    for s in samples:
        for w in words:
            if w[4].upper() == s.sample_id.upper():
                cy = (w[1] + w[3]) / 2
                nearby = [ww[4] for ww in words if 95 <= ww[0] <= 210 and abs(((ww[1]+ww[3])/2)-cy) < 20]
                s.parameters = " ".join(nearby).strip()
                break

    lithology: list[Interval] = []
    if axis:
        y_zero, ppm = axis
        # Fisher logs place the material description column around 46%-76% of page width.
        norm_rect = page.rect * page.derotation_matrix
        material_xs = []
        for ww in words:
            if re.search(r"ASPHALT|FILL|SAND|SILT|CLAY|GRAVEL|RECOVERY", ww[4] or "", re.I):
                material_xs.append((ww[0]+ww[2])/2)
        mat_x = statistics.median(material_xs) if material_xs else norm_rect.width * 0.58
        x_left = max(0.0, mat_x - norm_rect.width * 0.14)
        x_right = min(norm_rect.width, mat_x + norm_rect.width * 0.20)
        candidate_y = set()
        for x0, x1, yy in segs:
            if x0 <= mat_x <= x1 and (x1-x0) >= norm_rect.width*0.10:
                candidate_y.add(round(yy, 3))
        if total_depth is not None:
            candidate_y.add(round(y_zero + total_depth * ppm, 3))
        candidate_y.add(round(y_zero, 3))
        ys = sorted(candidate_y)
        prev_mat = None
        for a, b in zip(ys, ys[1:]):
            d1 = (a - y_zero) / ppm
            d2 = (b - y_zero) / ppm
            top = min(d1, d2)
            bottom = max(d1, d2)
            if bottom <= 0 or top >= (total_depth or 999):
                continue
            top = max(0.0, top)
            bottom = min(total_depth or bottom, bottom)
            if bottom - top < 0.03:
                continue
            body = [ww[4] for ww in words if x_left <= ww[0] <= x_right and a - 1 <= (ww[1]+ww[3])/2 <= b + 1]
            desc = " ".join(body).strip()
            if not desc:
                continue
            # Ignore header/date/construction text that happens to fall between
            # horizontal lines on multi-page logs. A real lithology interval must
            # contain a material keyword (or the explicit continuation phrase).
            if not re.search(r"ASPHALT|FILL|SAND|SILT|CLAY|GRAVEL|NO\s+RECOVERY|AS\s+ABOVE", desc, re.I):
                continue
            mat = _material_name(desc, prev_mat)
            prev_mat = mat
            lithology.append(Interval(top=round(top, 3), bottom=round(bottom, 3), material=mat, description=desc))

    warnings = []
    if ground_elev is None:
        warnings.append("Ground elevation was not present in this borehole log; use the DXF plan elevation or enter it manually.")
    if not samples:
        warnings.append("No sample intervals could be extracted automatically.")
    if not lithology:
        warnings.append("Lithology boundaries could not be reconstructed from page geometry.")

    return BoreholeLog(
        borehole_id=bh_id,
        project_no=job,
        ground_elevation=ground_elev,
        total_depth=total_depth,
        lithology=lithology,
        samples=samples,
        source_filename=filename,
        parser="fisher-vector-geometry-v1",
        warnings=warnings,
    )


def parse_borehole_pdf(path: str) -> list[BoreholeLog]:
    doc = fitz.open(path)
    logs: list[BoreholeLog] = []
    # Group consecutive pages by borehole ID. For multipage older logs this merges intervals.
    by_id: dict[str, BoreholeLog] = {}
    for page in doc:
        log = _parse_geometry_page(page, Path(path).name)
        if log.borehole_id in by_id:
            base = by_id[log.borehole_id]
            if log.total_depth and (not base.total_depth or log.total_depth > base.total_depth):
                base.total_depth = log.total_depth
            if base.ground_elevation is None and log.ground_elevation is not None:
                base.ground_elevation = log.ground_elevation
            known = {s.sample_id for s in base.samples}
            base.samples.extend(s for s in log.samples if s.sample_id not in known)
            base.lithology.extend(log.lithology)
            # Keep merged multi-page intervals in depth order and suppress exact
            # duplicates created at page boundaries.
            uniq = {}
            for iv in base.lithology:
                uniq[(round(iv.top, 3), round(iv.bottom, 3), iv.material, iv.description)] = iv
            base.lithology = sorted(uniq.values(), key=lambda iv: (iv.top, iv.bottom))
            base.warnings.extend(w for w in log.warnings if w not in base.warnings)
        else:
            by_id[log.borehole_id] = log
    return list(by_id.values())
