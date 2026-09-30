from __future__ import annotations

import gzip
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.models import BoreholeLog, LabRecord, SectionRequest
from app.parsers.borehole_pdf import parse_borehole_pdf
from app.parsers.dxf_plan import parse_plan_dxf
from app.section_engine import generate_section_dxf

app = FastAPI(title="Borehole Section SaaS", version="0.2.0")
STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class SectionPayload(BaseModel):
    request: SectionRequest
    logs: list[BoreholeLog]
    lab_records: list[LabRecord]


@app.get("/")
def root():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "version": "0.2.0",
        "mode": "stateless",
        "files_persisted": False,
    }


@app.post("/api/parse-plan")
async def parse_plan(file: UploadFile = File(...)):
    name = (file.filename or "plan.dxf").lower()
    is_gzip = name.endswith(".gz") or (file.content_type or "") in {
        "application/gzip",
        "application/x-gzip",
    }
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty plan file")
    if is_gzip:
        try:
            raw = gzip.decompress(raw)
        except Exception as e:
            raise HTTPException(400, f"Could not decompress DXF: {e}")
    if not raw.lstrip().startswith(b"0") and b"SECTION" not in raw[:2000]:
        # ASCII DXF is expected by the current parser. Keep the error explicit.
        raise HTTPException(400, "The uploaded plan does not look like an ASCII DXF.")

    with tempfile.TemporaryDirectory(prefix="bhsec-plan-") as td:
        path = Path(td) / "plan.dxf"
        path.write_bytes(raw)
        try:
            plan = parse_plan_dxf(str(path))
        except Exception as e:
            raise HTTPException(400, f"DXF parse failed: {e}")
    return plan.model_dump()


@app.post("/api/parse-log")
async def parse_log(file: UploadFile = File(...)):
    if Path(file.filename or "").suffix.lower() != ".pdf":
        raise HTTPException(400, "Borehole log must be a PDF file")
    with tempfile.TemporaryDirectory(prefix="bhsec-log-") as td:
        path = Path(td) / (Path(file.filename or "log.pdf").name)
        with path.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        try:
            logs = parse_borehole_pdf(str(path))
        except Exception as e:
            raise HTTPException(400, f"Borehole PDF parse failed: {e}")
    return [x.model_dump() if hasattr(x, "model_dump") else x for x in logs]


@app.post("/api/section")
def section(payload: SectionPayload):
    with tempfile.TemporaryDirectory(prefix="bhsec-out-") as td:
        out = Path(td) / "cross-section.dxf"
        try:
            generate_section_dxf(
                payload.request,
                payload.logs,
                payload.lab_records,
                str(out),
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(500, f"Section generation failed: {e}")
        data = out.read_bytes()
    return Response(
        content=data,
        media_type="application/dxf",
        headers={"Content-Disposition": 'attachment; filename="cross-section.dxf"'},
    )
