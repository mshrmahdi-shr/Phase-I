from __future__ import annotations

from dataclasses import dataclass, asdict
import json, math, heapq
from pathlib import Path
import cv2, numpy as np, ezdxf

@dataclass
class Feature:
    points: list
    layer: str = "CONTOUR"
    elevation: float | None = None
    closed: bool = False
    source: str = "trace"
    confidence: float = 1.0

@dataclass
class Spot:
    x: float
    y: float
    z: float
    number: int
    desc: str = "SPOT_ELEV"

@dataclass
class Project:
    image_path: str = ""
    image_width: int = 0
    image_height: int = 0
    scale: float = 1500.0
    dpi: float = 300.0
    origin_e: float = 0.0
    origin_n: float = 0.0
    features: list | None = None
    spots: list | None = None

    def __post_init__(self):
        self.features = self.features or []
        self.spots = self.spots or []

    def dumps(self):
        return json.dumps({
            **asdict(self),
            "features":[asdict(f) if isinstance(f,Feature) else f for f in self.features],
            "spots":[asdict(s) if isinstance(s,Spot) else s for s in self.spots],
        }, indent=2)

    @classmethod
    def loads(cls, text):
        d=json.loads(text)
        fs=[Feature(**x) for x in d.pop("features",[])]
        ss=[Spot(**x) for x in d.pop("spots",[])]
        return cls(**d,features=fs,spots=ss)

def prepare(gray: np.ndarray, threshold=180, otsu=True, min_blob=3):
    if gray.ndim==3:
        gray=cv2.cvtColor(gray,cv2.COLOR_BGR2GRAY)
    if otsu:
        _,bw=cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)
    else:
        _,bw=cv2.threshold(gray,int(threshold),255,cv2.THRESH_BINARY_INV)
    if min_blob>0:
        n,lab,stats,_=cv2.connectedComponentsWithStats((bw>0).astype(np.uint8),8)
        keep=np.zeros_like(bw)
        for i in range(1,n):
            if stats[i,cv2.CC_STAT_AREA]>=min_blob:
                keep[lab==i]=255
        bw=keep
    sk=cv2.ximgproc.thinning(bw, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    return bw, sk

NEI=[(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]

def _snap(sk,p,r=18):
    x,y=int(round(p[0])),int(round(p[1])); h,w=sk.shape
    best=None
    for yy in range(max(0,y-r),min(h,y+r+1)):
        for xx in range(max(0,x-r),min(w,x+r+1)):
            if sk[yy,xx]:
                d=(xx-x)**2+(yy-y)**2
                if best is None or d<best[0]: best=(d,(xx,yy))
    return best[1] if best else None

def _neighbors(sk,p):
    x,y=p;h,w=sk.shape
    out=[]
    for dx,dy in NEI:
        q=(x+dx,y+dy)
        if 0<=q[0]<w and 0<=q[1]<h and sk[q[1],q[0]]:
            out.append(q)
    return out

def _astar(sk,start,goal,max_nodes=120000):
    q=[(math.dist(start,goal),0,start)]
    came={start:None}; cost={start:0.0}; seen=0
    while q and seen<max_nodes:
        _,g,p=heapq.heappop(q); seen+=1
        if p==goal:
            path=[]
            while p is not None:
                path.append(p);p=came[p]
            return path[::-1]
        if g>cost.get(p,1e99)+1e-9: continue
        for n in _neighbors(sk,p):
            ng=g+math.dist(p,n)
            if ng<cost.get(n,1e99):
                cost[n]=ng;came[n]=p
                heapq.heappush(q,(ng+math.dist(n,goal),ng,n))
    return []

def _bridge(sk,p,prev,visited,max_gap):
    if max_gap<=0:return None
    vx,vy=p[0]-prev[0],p[1]-prev[1]; norm=math.hypot(vx,vy) or 1
    vx/=norm;vy/=norm
    h,w=sk.shape;best=None
    r=int(max_gap)
    for yy in range(max(0,p[1]-r),min(h,p[1]+r+1)):
        for xx in range(max(0,p[0]-r),min(w,p[0]+r+1)):
            q=(xx,yy)
            if q in visited or not sk[yy,xx]: continue
            dx,dy=xx-p[0],yy-p[1];d=math.hypot(dx,dy)
            if d<2 or d>max_gap:continue
            dot=(dx*vx+dy*vy)/d
            if dot<0.55:continue
            score=dot*4-d*.12
            if best is None or score>best[0]:best=(score,q)
    return best[1] if best else None

def _extend(sk,start,prev,blocked,max_gap=8,max_steps=200000):
    out=[start];p=start;pr=prev;visited=set(blocked);visited.add(start)
    for _ in range(max_steps):
        cand=[q for q in _neighbors(sk,p) if q not in visited]
        if cand:
            vx,vy=p[0]-pr[0],p[1]-pr[1];n=math.hypot(vx,vy) or 1;vx/=n;vy/=n
            scored=[]
            for q in cand:
                dx,dy=q[0]-p[0],q[1]-p[1];dn=math.hypot(dx,dy) or 1
                dot=(dx*vx+dy*vy)/dn
                degree=len(_neighbors(sk,q))
                scored.append((dot-(0.18 if degree>2 else 0),q))
            scored.sort(reverse=True,key=lambda z:z[0]);q=scored[0][1]
            if scored[0][0]<-0.2:break
        else:
            q=_bridge(sk,p,pr,visited,max_gap)
            if q is None:break
        pr,p=p,q;visited.add(p);out.append(p)
        if p==start and len(out)>10:break
    return out

def trace_two_clicks(sk,p0,p1,max_gap=8):
    a=_snap(sk,p0);b=_snap(sk,p1)
    if not a or not b:return []
    mid=_astar(sk,a,b)
    if len(mid)<2:return []
    blocked=set(mid)
    f=_extend(sk,mid[-1],mid[-2],blocked,max_gap)
    r=_extend(sk,mid[0],mid[1],blocked,max_gap)
    return r[:0:-1]+mid+f[1:]

def _pca_dir(sk,p,r=12):
    x,y=p;h,w=sk.shape
    ys,xs=np.nonzero(sk[max(0,y-r):min(h,y+r+1),max(0,x-r):min(w,x+r+1)])
    if len(xs)<3:return (1.0,0.0)
    xs=xs+max(0,x-r);ys=ys+max(0,y-r)
    pts=np.column_stack([xs-x,ys-y]).astype(float)
    c=np.cov(pts,rowvar=False);vals,vecs=np.linalg.eigh(c);v=vecs[:,np.argmax(vals)]
    return float(v[0]),float(v[1])

def trace_seed(sk,p,max_gap=8):
    a=_snap(sk,p)
    if not a:return []
    vx,vy=_pca_dir(sk,a)
    def lead(sgn):
        target=(a[0]+vx*8*sgn,a[1]+vy*8*sgn)
        b=_snap(sk,target,8)
        if b and b!=a:return b
        ns=_neighbors(sk,a)
        if not ns:return (a[0]-int(round(vx*sgn)),a[1]-int(round(vy*sgn)))
        return max(ns,key=lambda q:(q[0]-a[0])*vx*sgn+(q[1]-a[1])*vy*sgn)
    f=_extend(sk,a,lead(-1),set(),max_gap)
    r=_extend(sk,a,lead(1),set(f),max_gap)
    return r[:0:-1]+f

def cut_hits(sk,p0,p1,spacing=8):
    x0,y0=p0;x1,y1=p1;L=max(1,int(math.hypot(x1-x0,y1-y0)))
    hits=[]
    for i in range(L+1):
        t=i/L;p=(x0+(x1-x0)*t,y0+(y1-y0)*t)
        q=_snap(sk,p,3)
        if q and all(math.dist(q,h)>spacing for h in hits):hits.append(q)
    return hits

def simplify(path,epsilon=1.2):
    if len(path)<3:return [(float(x),float(y)) for x,y in path]
    arr=np.array(path,np.float32).reshape(-1,1,2)
    ap=cv2.approxPolyDP(arr,epsilon,False).reshape(-1,2)
    return [(float(x),float(y)) for x,y in ap]

def _segments(poly):
    for i in range(len(poly)-1):yield poly[i],poly[i+1]
    if len(poly)>2 and poly[0]!=poly[-1]: pass

def _intersect(a,b,c,d):
    ax,ay=a;bx,by=b;cx,cy=c;dx,dy=d
    den=(ax-bx)*(cy-dy)-(ay-by)*(cx-dx)
    if abs(den)<1e-9:return None
    t=((ax-cx)*(cy-dy)-(ay-cy)*(cx-dx))/den
    u=-((ax-bx)*(ay-cy)-(ay-by)*(ax-cx))/den
    if 0<=t<=1 and 0<=u<=1:return t
    return None

def label_contours(features,p0,p1,start,interval):
    crossed=[]
    for i,f in enumerate(features):
        if not f.layer.startswith("CONTOUR") or len(f.points)<2:continue
        best=None
        for a,b in _segments(f.points):
            t=_intersect(p0,p1,a,b)
            if t is not None and (best is None or t<best):best=t
        if best is not None:crossed.append((best,i))
    crossed.sort()
    for n,(_,i) in enumerate(crossed):features[i].elevation=float(start)+n*float(interval)
    return [i for _,i in crossed]

def metres_per_pixel(scale,dpi):
    return 25.4*float(scale)/(float(dpi)*1000.0)

def world(project,x,y,z=0):
    k=metres_per_pixel(project.scale,project.dpi)
    return project.origin_e+x*k, project.origin_n+(project.image_height-y)*k, z

def export_dxf(project,path):
    doc=ezdxf.new("R2018")
    for name,color in [("CONTOUR",3),("CONTOUR_MAJOR",1),("CONTOUR_MINOR",3),("BUILDING_Z0",5),("PROPERTY_BOUNDARY",30),("MISC_LINEWORK",6),("SPOT_ELEVATIONS",4)]:
        if name not in doc.layers:doc.layers.add(name,color=color)
    msp=doc.modelspace()
    for raw in project.features:
        f=raw if isinstance(raw,Feature) else Feature(**raw)
        z=float(f.elevation or 0)
        pts=[world(project,x,y,z) for x,y in f.points]
        if f.closed and pts:pts=pts+[pts[0]]
        if len(pts)>=2:msp.add_polyline3d(pts,dxfattribs={"layer":f.layer})
    if "POINT" not in doc.blocks:
        b=doc.blocks.new("POINT")
        b.add_circle((0,0),0.15,dxfattribs={"layer":"0"})
        b.add_attdef("ELEV",insert=(0.35,0.35),height=.4)
        b.add_attdef("POINT",insert=(0.35,0),height=.4)
        b.add_attdef("DESC",insert=(0.35,-.35),height=.4)
    for raw in project.spots:
        s=raw if isinstance(raw,Spot) else Spot(**raw)
        x,y,z=world(project,s.x,s.y,s.z)
        ref=msp.add_blockref("POINT",(x,y,z),dxfattribs={"layer":"SPOT_ELEVATIONS"})
        ref.add_auto_attribs({"ELEV":f"{z:.3f}","POINT":str(s.number),"DESC":s.desc})
    doc.saveas(path)
