from __future__ import annotations
import math
import re
from pathlib import Path
from typing import Iterable
import ezdxf
from ezdxf.enums import TextEntityAlignment
from shapely.geometry import LineString, Point
from app.models import BoreholeLog, LabRecord, SectionRequest
from app.parsers.dxf_plan import normalize_id

MATERIAL_COLORS = {
    "ASPHALT": 8,
    "FILL": 32,
    "SAND": 2,
    "SILTY SAND": 42,
    "SAND AND GRAVEL": 34,
    "SILT": 9,
    "CLAY": 30,
    "CLAYEY SILT": 31,
    "GRAVEL": 33,
    "NO RECOVERY": 250,
    "UNKNOWN": 254,
}


def _lookup_log(logs: Iterable[BoreholeLog], bid: str):
    nid = normalize_id(bid)
    def key(x): return normalize_id(x).replace("(MW)", "")
    for log in logs:
        if key(log.borehole_id) == key(nid):
            return log
    return None


def _records_for(records: Iterable[LabRecord], bid: str):
    key = normalize_id(bid).replace("(MW)", "")
    return [r for r in records if normalize_id(r.borehole_id).replace("(MW)", "") == key]


def _project_chainage(line: LineString, x: float, y: float, meters_per_unit: float = 1.0):
    p = Point(x, y)
    return float(line.project(p))*meters_per_unit, float(p.distance(line))*meters_per_unit


def generate_section_dxf(req: SectionRequest, logs: list[BoreholeLog], records: list[LabRecord], out_path: str):
    if len(req.points) < 2:
        raise ValueError("Section requires at least two points")
    line = LineString([(p.x, p.y) for p in req.points])
    meters_per_unit = max(1e-9, float(req.meters_per_unit or 1.0))
    section_len = line.length * meters_per_unit
    selected = []
    for b in req.boreholes:
        ch, off = _project_chainage(line, b.x, b.y, meters_per_unit)
        log = _lookup_log(logs, b.id)
        elev = b.elevation if b.elevation is not None else (log.ground_elevation if log else None)
        selected.append((ch, off, b, log, elev, _records_for(records, b.id)))
    selected.sort(key=lambda x: x[0])

    elevs = []
    for _, _, _, log, elev, _ in selected:
        if elev is not None:
            elevs.append(elev)
            if log and log.total_depth:
                elevs.append(elev - log.total_depth)
    if not elevs:
        raise ValueError("No selected borehole has a usable ground elevation")
    ymin = math.floor(min(elevs) - 1)
    ymax = math.ceil(max(elevs) + 1)
    vex = max(0.1, float(req.vertical_exaggeration or 1.0))

    doc = ezdxf.new("R2010", setup=True)
    for layer, color in [("SECTION", 7), ("TEXT", 7), ("BOREHOLE", 7), ("LITHOLOGY", 8), ("LAB_MEET", 3), ("LAB_EXCEED", 1), ("GROUND", 7), ("LEADER", 7)]:
        if layer not in doc.layers:
            doc.layers.add(layer, color=color)
    msp = doc.modelspace()

    x_origin = 0.0
    y_origin = 0.0
    def sx(ch): return x_origin + ch
    def sy(e): return y_origin + (e - ymin) * vex

    msp.add_line((0, sy(ymin)), (section_len, sy(ymin)), dxfattribs={"layer":"SECTION"})
    msp.add_line((0, sy(ymin)), (0, sy(ymax)), dxfattribs={"layer":"SECTION"})
    for e in range(int(ymin), int(ymax)+1):
        yy = sy(e)
        msp.add_line((-0.15, yy), (0, yy), dxfattribs={"layer":"SECTION"})
        msp.add_text(f"{e:.0f}m", dxfattribs={"height":0.18*vex, "layer":"TEXT"}).set_placement((-0.25,yy), align=TextEntityAlignment.MIDDLE_RIGHT)
    for ch in range(0, int(section_len)+1, 5):
        msp.add_line((ch, sy(ymin)), (ch, sy(ymin)-0.12*vex), dxfattribs={"layer":"SECTION"})
        msp.add_text(f"{ch}m", dxfattribs={"height":0.16*vex,"layer":"TEXT"}).set_placement((ch,sy(ymin)-0.3*vex), align=TextEntityAlignment.TOP_CENTER)

    ground_pts = [(sx(ch), sy(elev)) for ch,_,_,_,elev,_ in selected if elev is not None]
    if len(ground_pts) >= 2:
        msp.add_lwpolyline(ground_pts, dxfattribs={"layer":"GROUND"})

    bh_width = max(0.12, min(0.35, section_len/120 if section_len else 0.2))
    table_y = sy(ymax) + 1.2*vex
    table_spacing = 2.1

    for idx,(ch,off,b,log,elev,b_records) in enumerate(selected):
        x = sx(ch)
        if elev is None:
            continue
        total_depth = log.total_depth if log and log.total_depth else max([r.bottom or 0 for r in b_records] + [3.0])
        bottom_e = elev - total_depth
        msp.add_lwpolyline([(x-bh_width/2, sy(elev)),(x+bh_width/2,sy(elev)),(x+bh_width/2,sy(bottom_e)),(x-bh_width/2,sy(bottom_e))], close=True, dxfattribs={"layer":"BOREHOLE"})
        if log:
            for interval in log.lithology:
                t = max(0.0, interval.top); bt = min(total_depth, interval.bottom)
                if bt <= t: continue
                ytop, ybot = sy(elev-t), sy(elev-bt)
                color = MATERIAL_COLORS.get(interval.material, 254)
                hatch = msp.add_hatch(color=color, dxfattribs={"layer":"LITHOLOGY"})
                hatch.paths.add_polyline_path([(x-bh_width/2,ytop),(x+bh_width/2,ytop),(x+bh_width/2,ybot),(x-bh_width/2,ybot)], is_closed=True)
        for r in b_records:
            if r.top is None or r.bottom is None: continue
            rt = max(0.0, float(r.top)); rb = min(float(total_depth), float(r.bottom))
            if rb <= rt:
                continue
            ytop = sy(elev-rt); ybot = sy(elev-rb)
            layer = "LAB_EXCEED" if r.status == "exceed" else "LAB_MEET"
            width = bh_width*0.52 if r.status == "exceed" else bh_width*0.28
            color = 1 if r.status == "exceed" else 3
            hatch = msp.add_hatch(color=color, dxfattribs={"layer":layer})
            hatch.paths.add_polyline_path([(x-width/2,ytop),(x+width/2,ytop),(x+width/2,ybot),(x-width/2,ybot)], is_closed=True)
        msp.add_text(b.id, dxfattribs={"height":0.18*vex,"layer":"TEXT"}).set_placement((x,sy(elev)+0.28*vex), align=TextEntityAlignment.BOTTOM_CENTER)

        if b_records:
            slot_x = max(0.2, min(section_len-3.0, x - 1.5))
            slot_y = table_y + (idx % 3) * table_spacing * vex
            title = f"{b.id}  offset={off:.2f}m"
            rows = [title]
            for r in b_records[:10]:
                depth = f"({r.top:.2f}-{r.bottom:.2f}m)" if r.top is not None and r.bottom is not None else ""
                red = ", ".join(r.red_text[:3])
                if r.status == "exceed":
                    rows.append(f"{r.sample_id or ''} \\C1;{depth} EXCEED {red}\\C256;".strip())
                else:
                    rows.append(f"{r.sample_id or ''} \\C3;{depth} MEET\\C256;".strip())
            txt = "\\P".join(rows)
            mt = msp.add_mtext(txt, dxfattribs={"char_height":0.16*vex,"layer":"TEXT"})
            mt.dxf.insert = (slot_x, slot_y)
            target_y = sy(elev)
            rr = next((r for r in b_records if r.status=="exceed" and r.top is not None and r.bottom is not None), None)
            if rr:
                target_y = sy(elev - (rr.top+rr.bottom)/2)
            msp.add_lwpolyline([(x,target_y),(slot_x-0.15,slot_y-0.1)], dxfattribs={"layer":"LAB_EXCEED" if rr else "LEADER", "color":1 if rr else 7})

    msp.add_text(req.section_name, dxfattribs={"height":0.28*vex,"layer":"TEXT"}).set_placement((0, sy(ymax)+0.4*vex), align=TextEntityAlignment.BOTTOM_LEFT)
    msp.add_text("Generated by Borehole Section SaaS MVP", dxfattribs={"height":0.14*vex,"layer":"TEXT"}).set_placement((section_len, sy(ymin)-0.3*vex), align=TextEntityAlignment.TOP_RIGHT)
    doc.saveas(out_path)
    return out_path
