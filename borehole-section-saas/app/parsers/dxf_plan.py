from __future__ import annotations
import math
import re
from pathlib import Path
import ezdxf
from ezdxf import disassemble, bbox as ezbbox
from ezdxf.lldxf.tagwriter import TagCollector
from app.models import PlanData, PlanPolyline, PlanBorehole, LabRecord

BH_ID_RE = re.compile(r"\b((?:BH|MW)\s*\d+(?:\(MW\))?|SVP-?\d+[AB]?|VP\d+[AB]?)\b", re.I)
SAMPLE_ID_RE = re.compile(r"\b(?:WT)?\d{2,8}-\d{3,8}-\d{1,4}\b", re.I)
DEPTH_RE = re.compile(r"\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)m\)", re.I)
COLOR_CMD = re.compile(r"\\C(\d+);")
FORMAT_CMD = re.compile(r"\\[A-Za-z][^;{}]*;|[{}]")


def normalize_id(value: str) -> str:
    return re.sub(r"\s+", "", value.upper())


def _clean_mtext(s: str) -> str:
    s = s.replace("\\P", " ").replace("\\~", " ")
    s = FORMAT_CMD.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


def _red_visible_segments(s: str) -> list[str]:
    out = []
    pos = 0
    color = 256
    for m in COLOR_CMD.finditer(s):
        seg = s[pos:m.start()]
        clean = _clean_mtext(seg)
        if color == 1 and re.search(r"[A-Za-z0-9]", clean):
            out.append(clean)
        color = int(m.group(1))
        pos = m.end()
    clean = _clean_mtext(s[pos:])
    if color == 1 and re.search(r"[A-Za-z0-9]", clean):
        out.append(clean)
    return out


def _table_cells(doc, table):
    c = TagCollector(dxfversion=doc.dxfversion)
    table.export_dxf(c)
    cells = []
    current = None
    for tag in c.tags:
        if tag.code == 301 and tag.value == "CELL_VALUE":
            current = []
        elif current is not None and tag.code == 302:
            current.append(str(tag.value))
        elif current is not None and tag.code == 304 and tag.value == "ACVALUE_END":
            cells.append(current[-1] if current else "")
            current = None
    return cells


def _records_from_table(doc, table):
    cells = _table_cells(doc, table)
    raw = " | ".join(cells)
    hm = BH_ID_RE.search(_clean_mtext(raw))
    if not hm:
        return []
    bh = normalize_id(hm.group(1))
    records = []
    sample_indices = [(i, SAMPLE_ID_RE.search(_clean_mtext(c))) for i, c in enumerate(cells)]
    sample_indices = [(i, m) for i, m in sample_indices if m]
    for idx, (i, sm) in enumerate(sample_indices):
        j = sample_indices[idx + 1][0] if idx + 1 < len(sample_indices) else min(len(cells), i + 5)
        group = cells[i:j]
        group_text = " | ".join(group)
        dm = DEPTH_RE.search(_clean_mtext(group_text))
        reds = []
        for g in group:
            reds.extend(_red_visible_segments(g))
        status = "exceed" if reds else "meet"
        text = _clean_mtext(group_text)
        top = float(dm.group(1)) if dm else None
        bottom = float(dm.group(2)) if dm else None
        records.append(LabRecord(
            borehole_id=bh,
            sample_id=sm.group(0),
            top=top,
            bottom=bottom,
            status=status,
            red_text=reds,
            text=text,
            table_handle=table.dxf.handle,
            table_insert=(float(table.dxf.insert.x), float(table.dxf.insert.y)),
        ))
    if not records:
        dm = DEPTH_RE.search(_clean_mtext(raw))
        reds = []
        for c in cells:
            reds.extend(_red_visible_segments(c))
        records.append(LabRecord(
            borehole_id=bh,
            top=float(dm.group(1)) if dm else None,
            bottom=float(dm.group(2)) if dm else None,
            status="exceed" if reds else "meet",
            red_text=reds,
            text=_clean_mtext(raw),
            table_handle=table.dxf.handle,
            table_insert=(float(table.dxf.insert.x), float(table.dxf.insert.y)),
        ))
    return records


def _block_elevation(doc, block_name: str):
    try:
        block = doc.blocks.get(block_name)
    except Exception:
        return None, None
    label = None
    elev = None
    for e in block:
        if e.dxftype() in {"TEXT", "MTEXT"}:
            t = e.dxf.text if e.dxftype() == "TEXT" else e.text
            clean = _clean_mtext(t)
            if BH_ID_RE.search(clean):
                label = normalize_id(BH_ID_RE.search(clean).group(1))
            if re.fullmatch(r"\d{2,3}(?:\.\d+)?", clean):
                try:
                    v = float(clean)
                    if 50 <= v <= 500:
                        elev = v
                except Exception:
                    pass
    return label, elev


def _polyline_points(e):
    if e.dxftype() == "LWPOLYLINE":
        return [(float(p[0]), float(p[1])) for p in e.get_points("xy")]
    return []


def _bbox_from_points(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _block_text(doc, block_name: str) -> str:
    try:
        block = doc.blocks.get(block_name)
    except Exception:
        return ""
    parts = []
    for e in block:
        if e.dxftype() == "TEXT":
            parts.append(e.dxf.text)
        elif e.dxftype() == "MTEXT":
            parts.append(e.text)
    return _clean_mtext(" ".join(parts))


def _find_plan_anchor(doc, ms):
    """Find the inserted site-plan block when a DXF also contains section sheets.
    Fisher plan blocks usually contain address/PCA/site wording and many nested entities.
    """
    best = None
    keywords = ("PCA", "SITE", "PROPERTY", "AVE", "STREET", "ROAD", "DRIVE", "BASEMENT")
    for ins in ms.query("INSERT"):
        txt = _block_text(doc, ins.dxf.name).upper()
        if not txt:
            continue
        score = sum(1 for k in keywords if k in txt)
        if score < 2:
            continue
        try:
            ents = list(disassemble.recursive_decompose([ins]))
            ext = ezbbox.extents(ents)
            if not ext.has_data:
                continue
            w = ext.extmax.x - ext.extmin.x
            h = ext.extmax.y - ext.extmin.y
            if w <= 10 or h <= 10:
                continue
            density = len(ents) / max(1.0, w*h)
            pad = 0.45 * max(w, h)
            near_tables = 0
            for t in ms.query("ACAD_TABLE"):
                tx, ty = float(t.dxf.insert.x), float(t.dxf.insert.y)
                if ext.extmin.x-pad <= tx <= ext.extmax.x+pad and ext.extmin.y-pad <= ty <= ext.extmax.y+pad:
                    near_tables += 1
            rank = (near_tables, score, len(ents), density, -float(ins.dxf.insert.x))
            if best is None or rank > best[0]:
                best = (rank, ins, ents, ext)
        except Exception:
            continue
    return best


def _distance_to_bbox(pt, bb):
    x, y = pt
    x0, y0, x1, y1 = bb
    dx = max(x0-x, 0, x-x1)
    dy = max(y0-y, 0, y-y1)
    return math.hypot(dx, dy)


def parse_plan_dxf(path: str) -> PlanData:
    doc = ezdxf.readfile(path)
    ms = doc.modelspace()
    all_pl = []
    for e in ms.query("LWPOLYLINE"):
        pts = _polyline_points(e)
        if len(pts) >= 2:
            all_pl.append((e, pts))

    anchor = _find_plan_anchor(doc, ms)
    nested_polylines = []
    meters_per_unit = 1.0
    scale_warning = None
    if anchor:
        _, anchor_ins, anchor_entities, ext = anchor
        scale = abs(float(anchor_ins.dxf.xscale or 1.0))
        if 0.01 <= scale <= 1000:
            meters_per_unit = 1.0 / scale
        else:
            scale_warning = "Plan block scale was not usable; verify metres per DXF unit manually."
        base_bbox = (float(ext.extmin.x), float(ext.extmin.y), float(ext.extmax.x), float(ext.extmax.y))
        for e in anchor_entities:
            if e.dxftype() == "LWPOLYLINE":
                pts = _polyline_points(e)
                if len(pts) >= 2:
                    nested_polylines.append((e, pts))
            elif e.dxftype() == "LINE":
                nested_polylines.append((e, [(float(e.dxf.start.x),float(e.dxf.start.y)),(float(e.dxf.end.x),float(e.dxf.end.y))]))
        w = base_bbox[2]-base_bbox[0]; h = base_bbox[3]-base_bbox[1]
        pad = max(40.0, 0.45*max(w,h))
        bbox = (base_bbox[0]-pad, base_bbox[1]-pad, base_bbox[2]+pad, base_bbox[3]+pad)
    else:
        pts = [p for _, pl in all_pl for p in pl]
        bbox = _bbox_from_points(pts) if pts else (0, 0, 100, 100)

    x0, y0, x1, y1 = bbox
    plan_regions = [bbox]
    if anchor:
        anchor_name = anchor_ins.dxf.name
        plan_regions = []
        for ins2 in ms.query("INSERT"):
            if ins2.dxf.name != anchor_name:
                continue
            try:
                ents2 = list(disassemble.recursive_decompose([ins2]))
                ex2 = ezbbox.extents(ents2)
                if not ex2.has_data:
                    continue
                w2 = ex2.extmax.x-ex2.extmin.x; h2=ex2.extmax.y-ex2.extmin.y
                pad2 = max(40.0, 0.45*max(w2,h2))
                plan_regions.append((float(ex2.extmin.x-pad2),float(ex2.extmin.y-pad2),float(ex2.extmax.x+pad2),float(ex2.extmax.y+pad2)))
            except Exception:
                pass
        if not plan_regions:
            plan_regions=[bbox]

    polylines = []
    for e, pts in all_pl + nested_polylines:
        if any(x0 <= x <= x1 and y0 <= y <= y1 for x, y in pts):
            color = int(e.dxf.color) if e.dxf.hasattr("color") else 256
            layer = e.dxf.layer if e.dxf.hasattr("layer") else "0"
            closed = bool(getattr(e, "closed", False))
            polylines.append(PlanPolyline(points=pts, color=color, layer=layer, closed=closed))

    elevation_index = {}
    for block in doc.blocks:
        label, elev = _block_elevation(doc, block.name)
        if label and elev is not None:
            elevation_index[normalize_id(label).replace("(MW)","")] = elev

    boreholes = []
    seen = set()
    for ins in ms.query("INSERT"):
        x, y = float(ins.dxf.insert.x), float(ins.dxf.insert.y)
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            continue
        label, elev = _block_elevation(doc, ins.dxf.name)
        if label:
            nid = normalize_id(label)
            if nid not in seen:
                boreholes.append(PlanBorehole(id=nid, x=x, y=y, elevation=elev, source="named-block"))
                seen.add(nid)

    records = []
    tables = []
    for t in ms.query("ACAD_TABLE"):
        try:
            tx, ty = float(t.dxf.insert.x), float(t.dxf.insert.y)
            if not any(rx0 <= tx <= rx1 and ry0 <= ty <= ry1 for rx0,ry0,rx1,ry1 in plan_regions):
                continue
            rr = _records_from_table(doc, t)
            records.extend(rr)
            ve = list(t.virtual_entities())
            ex = ezbbox.extents(ve)
            if ex.has_data:
                tables.append((t, rr, (float(ex.extmin.x),float(ex.extmin.y),float(ex.extmax.x),float(ex.extmax.y))))
        except Exception:
            continue

    leader_candidates = []
    for e, pts in all_pl:
        if e.closed or not (2 <= len(pts) <= 5):
            continue
        if any(x0 <= x <= x1 and y0 <= y <= y1 for x,y in pts):
            leader_candidates.append((e, pts))

    grouped_tables = {}
    for t, rr, tbb in tables:
        if not rr:
            continue
        if _distance_to_bbox((t.dxf.insert.x,t.dxf.insert.y), bbox) > max(x1-x0,y1-y0)*0.75:
            continue
        bh = rr[0].borehole_id
        grouped_tables.setdefault(bh, []).append((t, tbb))

    for bh, titems in grouped_tables.items():
        nid = normalize_id(bh)
        if nid in seen:
            continue
        best = None
        for t, tbb in titems:
            for e, pts in leader_candidates:
                for endpoint_idx in (0,-1):
                    ep = pts[endpoint_idx]
                    d = _distance_to_bbox(ep, tbb)
                    if d > 12.0:
                        continue
                    other = pts[-1] if endpoint_idx == 0 else pts[0]
                    if not (x0 <= other[0] <= x1 and y0 <= other[1] <= y1):
                        continue
                    nearest_insert = None
                    for ins in ms.query("INSERT"):
                        ix,iy=float(ins.dxf.insert.x),float(ins.dxf.insert.y)
                        dd=math.hypot(ix-other[0],iy-other[1])
                        if nearest_insert is None or dd<nearest_insert[0]:
                            nearest_insert=(dd,(ix,iy))
                    snap = nearest_insert[1] if nearest_insert and nearest_insert[0] < 8.0 else other
                    score = d + (nearest_insert[0] if nearest_insert else 20.0)*0.25
                    if best is None or score < best[0]:
                        best=(score,snap)
        if best:
            key=nid.replace("(MW)","")
            elev=elevation_index.get(key)
            boreholes.append(PlanBorehole(id=nid, x=best[1][0], y=best[1][1], elevation=elev, source="table-leader"))
            seen.add(nid)

    warnings = []
    if scale_warning:
        warnings.append(scale_warning)
    if len(boreholes) < 2:
        warnings.append("Automatic borehole point detection is incomplete. Use manual point assignment in the plan workspace.")
    return PlanData(bbox=bbox, meters_per_unit=meters_per_unit, polylines=polylines, boreholes=boreholes, lab_records=records, warnings=warnings)
