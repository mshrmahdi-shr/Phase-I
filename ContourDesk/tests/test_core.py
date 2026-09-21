import numpy as np
from core import prepare, trace_two_clicks, Feature, Project, label_contours, metres_per_pixel

def test_scale():
    assert abs(metres_per_pixel(1500,300)-0.127)<1e-12

def test_trace_straight():
    g=np.full((80,120),255,np.uint8)
    g[40,10:110]=0
    _,sk=prepare(g,otsu=False,threshold=128,min_blob=1)
    p=trace_two_clicks(sk,(20,40),(80,40),max_gap=3)
    assert len(p)>70
    assert abs(p[0][1]-40)<=1 and abs(p[-1][1]-40)<=1

def test_label_cut():
    fs=[Feature([(10,10),(10,90)],"CONTOUR"),Feature([(20,10),(20,90)],"CONTOUR"),Feature([(30,10),(30,90)],"CONTOUR")]
    ids=label_contours(fs,(0,50),(40,50),100,2)
    assert ids==[0,1,2]
    assert [f.elevation for f in fs]==[100,102,104]

def test_project_roundtrip():
    p=Project(image_path="x.tif",image_width=100,image_height=200,features=[Feature([(1,2),(3,4)],elevation=5)])
    q=Project.loads(p.dumps())
    assert q.features[0].elevation==5
