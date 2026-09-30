from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional, List, Tuple

class Interval(BaseModel):
    top: float
    bottom: float
    material: str = "UNKNOWN"
    description: str = ""

class SampleInterval(BaseModel):
    sample_id: str
    top: float
    bottom: float
    parameters: str = ""
    duplicate: bool = False

class BoreholeLog(BaseModel):
    borehole_id: str
    project_no: Optional[str] = None
    ground_elevation: Optional[float] = None
    total_depth: Optional[float] = None
    lithology: List[Interval] = Field(default_factory=list)
    samples: List[SampleInterval] = Field(default_factory=list)
    source_filename: str = ""
    parser: str = ""
    warnings: List[str] = Field(default_factory=list)

class LabRecord(BaseModel):
    borehole_id: str
    sample_id: Optional[str] = None
    top: Optional[float] = None
    bottom: Optional[float] = None
    status: str = "unknown"  # exceed, meet, unknown
    red_text: List[str] = Field(default_factory=list)
    text: str = ""
    table_handle: Optional[str] = None
    table_insert: Optional[Tuple[float, float]] = None

class PlanBorehole(BaseModel):
    id: str
    x: float
    y: float
    elevation: Optional[float] = None
    source: str = "auto"

class PlanPolyline(BaseModel):
    points: List[Tuple[float, float]]
    color: int = 256
    layer: str = "0"
    closed: bool = False

class PlanData(BaseModel):
    bbox: Tuple[float, float, float, float]
    meters_per_unit: float = 1.0
    polylines: List[PlanPolyline] = Field(default_factory=list)
    boreholes: List[PlanBorehole] = Field(default_factory=list)
    lab_records: List[LabRecord] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)

class SectionPoint(BaseModel):
    x: float
    y: float

class SectionBoreholeSelection(BaseModel):
    id: str
    x: float
    y: float
    elevation: Optional[float] = None

class SectionRequest(BaseModel):
    section_name: str = "A-A'"
    points: List[SectionPoint]
    boreholes: List[SectionBoreholeSelection]
    vertical_exaggeration: float = 1.0
    horizontal_scale: str = "auto"
    vertical_scale: str = "auto"
    meters_per_unit: float = 1.0
