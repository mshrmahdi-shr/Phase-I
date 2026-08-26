export function figureDefaults(){
  return {
    A:{title:'SITE LOCATION MAP',extentMeters:500,status:'Not Started'},
    B:{title:'CURRENT AERIAL / SITE PLAN',extentMeters:250,status:'Not Started'},
    C:{title:'TOPOGRAPHICAL MAP',extentMeters:1000,status:'Not Started'},
    D:{title:'SURFICIAL GEOLOGY',extentMeters:2000,status:'Not Started'},
    E:{title:'BEDROCK GEOLOGY',extentMeters:20000,status:'Not Started'}
  };
}

export function createProject({name='',projectNo='',address='',date='',company=''}={}){
  return {
    id: (globalThis.crypto?.randomUUID?.() || `p-${Date.now()}`),
    name, projectNo, address, date, company,
    location:null,
    siteBoundary:[], buildingBoundary:[], historical:[],
    geology:{surficial:null,bedrock:null},
    dpi:300,
    figures:figureDefaults(),
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
  };
}

export function closeRing(points){
  if(!points?.length) return [];
  const out=points.map(p=>[Number(p[0]),Number(p[1])]);
  const a=out[0], b=out[out.length-1];
  if(a[0]!==b[0] || a[1]!==b[1]) out.push([...a]);
  return out;
}

export function pointInPolygon(point, polygon){
  const [x,y]=point; let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [xi,yi]=polygon[i], [xj,yj]=polygon[j];
    const intersects=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||Number.EPSILON)+xi);
    if(intersects) inside=!inside;
  }
  return inside;
}

function dxfPolyline(layer, points){
  if(!points?.length) return '';
  const ring=closeRing(points);
  let s=`0\nLWPOLYLINE\n8\n${layer}\n90\n${ring.length}\n70\n1\n`;
  for(const [x,y] of ring) s+=`10\n${x}\n20\n${y}\n`;
  return s;
}

export function buildDxf({siteBoundary=[],buildingBoundary=[]}={}){
  return `0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${dxfPolyline('SITE_BOUNDARY',siteBoundary)}${dxfPolyline('BUILDING_BOUNDARY',buildingBoundary)}0\nENDSEC\n0\nEOF\n`;
}
