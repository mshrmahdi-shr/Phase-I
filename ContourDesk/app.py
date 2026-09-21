from __future__ import annotations
import math
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog

import cv2, numpy as np
from PIL import Image, ImageTk
import fitz

from core import Project, Feature, Spot, prepare, trace_two_clicks, trace_seed, cut_hits, simplify, label_contours, export_dxf

APP="ContourDesk — Raster to Civil 3D"
LAYERS=["CONTOUR","CONTOUR_MAJOR","CONTOUR_MINOR","BUILDING_Z0","PROPERTY_BOUNDARY","MISC_LINEWORK"]
COL={"CONTOUR":"#00d35f","CONTOUR_MAJOR":"#ff365c","CONTOUR_MINOR":"#00d35f","BUILDING_Z0":"#2d7cff","PROPERTY_BOUNDARY":"#ff9800","MISC_LINEWORK":"#c23cff"}

def read_gray(path):
    p=Path(path)
    if p.suffix.lower()==".pdf":
        doc=fitz.open(path)
        page=doc[0]
        pix=page.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False)
        arr=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,pix.n)
        g=cv2.cvtColor(arr,cv2.COLOR_RGB2GRAY)
        doc.close()
        return g
    data=np.fromfile(path,dtype=np.uint8)
    img=cv2.imdecode(data,cv2.IMREAD_GRAYSCALE)
    if img is None:raise ValueError("Could not open raster.")
    return img

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP);self.geometry("1500x900");self.minsize(1050,680)
        self.project=Project();self.gray=None;self.work=None;self.sk=None;self.work_scale=1.0
        self.preview=None;self.preview_tk=None;self.preview_scale=1.0;self.zoom=1.0
        self.mode=tk.StringVar(value="pan");self.layer=tk.StringVar(value="CONTOUR")
        self.otsu=tk.BooleanVar(value=True);self.threshold=tk.IntVar(value=180);self.maxw=tk.IntVar(value=9000);self.gap=tk.IntVar(value=8)
        self.scale=tk.DoubleVar(value=1500);self.dpi=tk.DoubleVar(value=300);self.oe=tk.DoubleVar(value=0);self.on=tk.DoubleVar(value=0)
        self.clicks=[];self.manual=[];self.selected=None
        self._ui();self._keys()

    def _ui(self):
        bar=ttk.Frame(self);bar.pack(fill="x",padx=6,pady=5)
        for text,cmd in [("Open TIFF / PDF",self.open_image),("Prepare",self.do_prepare),("Save Project",self.save_project),("Load Project",self.load_project),("Export Civil 3D DXF",self.do_export)]:
            ttk.Button(bar,text=text,command=cmd).pack(side="left",padx=2)
        ttk.Label(bar,text="Layer").pack(side="left",padx=(14,2))
        ttk.Combobox(bar,textvariable=self.layer,values=LAYERS,state="readonly",width=20).pack(side="left")
        self.status=tk.StringVar(value="Open a raster map to begin.");ttk.Label(bar,textvariable=self.status).pack(side="right",padx=8)

        pan=ttk.Panedwindow(self,orient="horizontal");pan.pack(fill="both",expand=True)
        left=ttk.Frame(pan);right=ttk.Frame(pan,width=330);pan.add(left,weight=5);pan.add(right,weight=1)
        tools=ttk.Frame(left);tools.pack(fill="x",padx=4,pady=3)
        for text,val in [("Pan","pan"),("Auto Trace (2 clicks)","trace"),("Multi Trace","multi"),("Manual Polyline","poly"),("Building","building"),("Boundary","boundary"),("Label Contours","label"),("Add Spot","spot")]:
            ttk.Radiobutton(tools,text=text,variable=self.mode,value=val).pack(side="left",padx=2)

        cf=ttk.Frame(left);cf.pack(fill="both",expand=True)
        self.c=tk.Canvas(cf,bg="#1b1b1b",highlightthickness=0)
        hx=ttk.Scrollbar(cf,orient="horizontal",command=self.c.xview);vy=ttk.Scrollbar(cf,orient="vertical",command=self.c.yview)
        self.c.configure(xscrollcommand=hx.set,yscrollcommand=vy.set)
        self.c.grid(row=0,column=0,sticky="nsew");vy.grid(row=0,column=1,sticky="ns");hx.grid(row=1,column=0,sticky="ew")
        cf.rowconfigure(0,weight=1);cf.columnconfigure(0,weight=1)
        self.c.bind("<Button-1>",self.click);self.c.bind("<MouseWheel>",self.wheel);self.c.bind("<ButtonPress-3>",lambda e:self.c.scan_mark(e.x,e.y));self.c.bind("<B3-Motion>",lambda e:self.c.scan_dragto(e.x,e.y,gain=1))

        ttk.Label(right,text="Raster processing",font=("Segoe UI",11,"bold")).pack(anchor="w",padx=8,pady=(8,3))
        f=ttk.Frame(right);f.pack(fill="x",padx=8)
        ttk.Checkbutton(f,text="Otsu threshold",variable=self.otsu).grid(row=0,column=0,columnspan=2,sticky="w")
        self._pair(f,1,"Threshold",self.threshold);self._pair(f,2,"Work max width",self.maxw);self._pair(f,3,"Bridge gap px",self.gap)
        ttk.Separator(right).pack(fill="x",padx=8,pady=8)
        ttk.Label(right,text="Civil 3D coordinates",font=("Segoe UI",11,"bold")).pack(anchor="w",padx=8,pady=3)
        f=ttk.Frame(right);f.pack(fill="x",padx=8)
        self._pair(f,0,"Scale 1:",self.scale);self._pair(f,1,"DPI",self.dpi);self._pair(f,2,"Origin Easting",self.oe);self._pair(f,3,"Origin Northing",self.on)
        ttk.Separator(right).pack(fill="x",padx=8,pady=8)
        ttk.Label(right,text="Vector features",font=("Segoe UI",11,"bold")).pack(anchor="w",padx=8)
        self.lst=tk.Listbox(right,height=20,exportselection=False);self.lst.pack(fill="both",padx=8)
        self.lst.bind("<<ListboxSelect>>",self.sel)
        ff=ttk.Frame(right);ff.pack(fill="x",padx=8,pady=4)
        ttk.Button(ff,text="Delete",command=self.delete).pack(side="left")
        ttk.Button(ff,text="Set elevation",command=self.set_z).pack(side="left",padx=3)
        ttk.Button(ff,text="Change layer",command=self.change_layer).pack(side="left")
        ttk.Separator(right).pack(fill="x",padx=8,pady=8)
        msg=("Workflow: Prepare → Auto Trace by clicking twice on the same contour. "
             "Multi Trace uses two clicks as a crossing line and follows each contour it meets. "
             "Label Contours uses a crossing line, starting elevation and interval. "
             "Buildings / boundaries are kept on separate Z=0 layers. "
             "Enter or Space finishes manual linework. Esc cancels.")
        ttk.Label(right,text=msg,wraplength=305,justify="left").pack(fill="x",padx=8,pady=6)

    def _pair(self,parent,row,label,var):
        ttk.Label(parent,text=label).grid(row=row,column=0,sticky="w")
        ttk.Entry(parent,textvariable=var,width=13).grid(row=row,column=1,sticky="e")

    def _keys(self):
        self.bind("<Escape>",lambda e:self.cancel())
        self.bind("<Return>",lambda e:self.finish_manual())
        self.bind("<space>",lambda e:self.finish_manual())
        self.bind("<Delete>",lambda e:self.delete())

    def open_image(self):
        p=filedialog.askopenfilename(filetypes=[("Raster / PDF","*.tif *.tiff *.png *.jpg *.jpeg *.bmp *.pdf"),("All files","*.*")])
        if not p:return
        try:
            self.status.set("Loading…");self.update_idletasks()
            self.gray=read_gray(p);h,w=self.gray.shape
            self.project=Project(image_path=p,image_width=w,image_height=h)
            self.scale.set(1500);self.dpi.set(300);self.oe.set(0);self.on.set(0)
            self._preview();self.sk=None;self.refresh();self.status.set(f"Loaded {Path(p).name} — {w} × {h}. Click Prepare.")
        except Exception as e:messagebox.showerror(APP,str(e))

    def do_prepare(self):
        if self.gray is None:return
        try:
            h,w=self.gray.shape;sc=min(1.0,float(self.maxw.get())/w);nw=max(1,int(w*sc));nh=max(1,int(h*sc))
            self.work=cv2.resize(self.gray,(nw,nh),interpolation=cv2.INTER_AREA) if sc<1 else self.gray.copy()
            _,self.sk=prepare(self.work,self.threshold.get(),self.otsu.get())
            self.work_scale=sc;self.status.set(f"Prepared at {nw} × {nh}. Tracing ready.")
        except Exception as e:messagebox.showerror(APP,str(e))

    def _preview(self):
        h,w=self.gray.shape;sc=min(1.0,2600/w);nw=max(1,int(w*sc));nh=max(1,int(h*sc))
        arr=cv2.resize(self.gray,(nw,nh),interpolation=cv2.INTER_AREA) if sc<1 else self.gray
        self.preview=Image.fromarray(arr);self.preview_scale=sc;self.zoom=1;self.redraw()

    def to_orig(self,e):
        x=self.c.canvasx(e.x)/(self.preview_scale*self.zoom);y=self.c.canvasy(e.y)/(self.preview_scale*self.zoom)
        return x,y
    def o2c(self,p):return p[0]*self.preview_scale*self.zoom,p[1]*self.preview_scale*self.zoom
    def o2w(self,p):return p[0]*self.work_scale,p[1]*self.work_scale
    def w2o(self,path):return [(x/self.work_scale,y/self.work_scale) for x,y in path]

    def click(self,e):
        if self.gray is None:return
        p=self.to_orig(e);m=self.mode.get()
        if m=="pan":return
        if m=="spot":return self.add_spot(p)
        if m in {"poly","building","boundary"}:
            self.manual.append(p);self.redraw();return
        if m in {"trace","multi","label"}:
            self.clicks.append(p);self.redraw()
            if len(self.clicks)<2:return
            a,b=self.clicks[:2];self.clicks=[]
            if m=="trace":self.do_trace(a,b)
            elif m=="multi":self.do_multi(a,b)
            else:self.do_label(a,b)

    def do_trace(self,a,b):
        if self.sk is None:return messagebox.showinfo(APP,"Click Prepare first.")
        path=trace_two_clicks(self.sk,self.o2w(a),self.o2w(b),self.gap.get())
        if len(path)<5:return self.status.set("Trace failed. Try two clicks farther apart on the same line.")
        pts=self.w2o(simplify(path,1.25));self.project.features.append(Feature(pts,self.layer.get(),source="autotrace",confidence=.9))
        self.refresh();self.redraw();self.status.set(f"Traced {len(pts)} nodes.")

    def do_multi(self,a,b):
        if self.sk is None:return messagebox.showinfo(APP,"Click Prepare first.")
        hits=cut_hits(self.sk,self.o2w(a),self.o2w(b),spacing=10);added=0
        for h in hits:
            path=trace_seed(self.sk,h,self.gap.get())
            if len(path)<20:continue
            pts=self.w2o(simplify(path,1.25));cx=sum(x for x,y in pts)/len(pts);cy=sum(y for x,y in pts)/len(pts)
            dup=False
            for f in self.project.features:
                if not f.layer.startswith("CONTOUR") or not f.points:continue
                fx=sum(x for x,y in f.points)/len(f.points);fy=sum(y for x,y in f.points)/len(f.points)
                if math.hypot(cx-fx,cy-fy)<20:dup=True;break
            if not dup:self.project.features.append(Feature(pts,self.layer.get(),source="multitrace",confidence=.82));added+=1
        self.refresh();self.redraw();self.status.set(f"Multi Trace added {added} lines.")

    def do_label(self,a,b):
        start=simpledialog.askfloat("Label Contours","Starting elevation:",parent=self)
        if start is None:return
        inc=simpledialog.askfloat("Label Contours","Contour interval (negative allowed):",initialvalue=1.0,parent=self)
        if inc is None:return
        ids=label_contours(self.project.features,a,b,start,inc);self.refresh();self.redraw();self.status.set(f"Labeled {len(ids)} contours.")

    def finish_manual(self):
        if len(self.manual)<2:self.manual=[];self.redraw();return
        m=self.mode.get()
        if m=="building":lay="BUILDING_Z0";closed=True;z=0.0
        elif m=="boundary":lay="PROPERTY_BOUNDARY";closed=True;z=0.0
        else:lay=self.layer.get();closed=False;z=None
        self.project.features.append(Feature(self.manual[:],lay,z,closed,"manual",1.0));self.manual=[];self.refresh();self.redraw()

    def add_spot(self,p):
        z=simpledialog.askfloat("Spot","Elevation:",parent=self)
        if z is None:return
        n=simpledialog.askinteger("Spot","Point number:",initialvalue=1001+len(self.project.spots),parent=self)
        if n is None:return
        d=simpledialog.askstring("Spot","Raw description:",initialvalue="SPOT_ELEV",parent=self) or "SPOT_ELEV"
        self.project.spots.append(Spot(p[0],p[1],z,n,d));self.redraw()

    def cancel(self):self.clicks=[];self.manual=[];self.redraw();self.status.set("Cancelled.")

    def refresh(self):
        self.lst.delete(0,"end")
        for i,f in enumerate(self.project.features):
            z="?" if f.elevation is None else f"{f.elevation:g}"
            self.lst.insert("end",f"{i+1:04d}  {f.layer:18s} Z={z}  {len(f.points)} pts")

    def sel(self,_=None):
        s=self.lst.curselection();self.selected=s[0] if s else None;self.redraw()
    def delete(self):
        if self.selected is None:return
        if 0<=self.selected<len(self.project.features):self.project.features.pop(self.selected)
        self.selected=None;self.refresh();self.redraw()
    def set_z(self):
        if self.selected is None:return
        f=self.project.features[self.selected]
        z=simpledialog.askfloat("Elevation","Feature elevation:",initialvalue=0 if f.elevation is None else f.elevation,parent=self)
        if z is not None:f.elevation=z;self.refresh();self.redraw()
    def change_layer(self):
        if self.selected is None:return
        f=self.project.features[self.selected]
        win=tk.Toplevel(self);win.title("Layer");v=tk.StringVar(value=f.layer)
        ttk.Combobox(win,textvariable=v,values=LAYERS,state="readonly").pack(padx=12,pady=10)
        def ok():f.layer=v.get();win.destroy();self.refresh();self.redraw()
        ttk.Button(win,text="OK",command=ok).pack(pady=(0,10))

    def sync(self):
        self.project.scale=float(self.scale.get());self.project.dpi=float(self.dpi.get());self.project.origin_e=float(self.oe.get());self.project.origin_n=float(self.on.get())

    def save_project(self):
        if not self.project.image_path:return
        p=filedialog.asksaveasfilename(defaultextension=".cdesk.json",filetypes=[("ContourDesk project","*.cdesk.json")])
        if not p:return
        self.sync();Path(p).write_text(self.project.dumps(),encoding="utf-8");self.status.set("Project saved.")

    def load_project(self):
        p=filedialog.askopenfilename(filetypes=[("ContourDesk project","*.cdesk.json"),("JSON","*.json")])
        if not p:return
        try:
            pr=Project.loads(Path(p).read_text(encoding="utf-8"))
            if not Path(pr.image_path).exists():
                img=filedialog.askopenfilename(title="Locate project raster")
                if not img:return
                pr.image_path=img
            self.project=pr;self.gray=read_gray(pr.image_path);self.scale.set(pr.scale);self.dpi.set(pr.dpi);self.oe.set(pr.origin_e);self.on.set(pr.origin_n)
            self._preview();self.sk=None;self.refresh();self.status.set("Project loaded. Click Prepare.")
        except Exception as e:messagebox.showerror(APP,str(e))

    def do_export(self):
        if not self.project.features and not self.project.spots:return messagebox.showinfo(APP,"Nothing to export.")
        p=filedialog.asksaveasfilename(defaultextension=".dxf",filetypes=[("DXF","*.dxf")])
        if not p:return
        try:self.sync();export_dxf(self.project,p);self.status.set(f"DXF exported: {Path(p).name}")
        except Exception as e:messagebox.showerror(APP,str(e))

    def redraw(self):
        self.c.delete("all")
        if self.preview is None:return
        w=max(1,int(self.preview.width*self.zoom));h=max(1,int(self.preview.height*self.zoom))
        im=self.preview.resize((w,h),Image.Resampling.NEAREST if self.zoom>1.4 else Image.Resampling.BILINEAR)
        self.preview_tk=ImageTk.PhotoImage(im);self.c.create_image(0,0,image=self.preview_tk,anchor="nw");self.c.configure(scrollregion=(0,0,w,h))
        for i,f in enumerate(self.project.features):
            if len(f.points)<2:continue
            coords=[]
            pts=f.points+([f.points[0]] if f.closed else [])
            for p in pts:coords.extend(self.o2c(p))
            self.c.create_line(*coords,fill=COL.get(f.layer,"#00e5ff"),width=3 if i==self.selected else 1.5)
            if f.elevation is not None:
                x,y=self.o2c(f.points[len(f.points)//2]);self.c.create_text(x,y,text=f"{f.elevation:g}",fill=COL.get(f.layer,"#00e5ff"),font=("Segoe UI",9,"bold"))
        for s in self.project.spots:
            x,y=self.o2c((s.x,s.y));self.c.create_oval(x-4,y-4,x+4,y+4,fill="#00e5ff",outline="white");self.c.create_text(x+7,y-7,text=f"{s.z:g}",anchor="sw",fill="#00e5ff")
        if self.manual:
            co=[]
            for p in self.manual:co.extend(self.o2c(p))
            if len(co)>=4:self.c.create_line(*co,fill="yellow",width=2,dash=(5,3))
        for p in self.clicks:
            x,y=self.o2c(p);self.c.create_oval(x-5,y-5,x+5,y+5,outline="yellow",width=2)

    def wheel(self,e):
        old=self.zoom;self.zoom=max(.25,min(6.0,self.zoom*(1.15 if e.delta>0 else 1/1.15)))
        if old!=self.zoom:self.redraw()

if __name__=="__main__":
    App().mainloop()
