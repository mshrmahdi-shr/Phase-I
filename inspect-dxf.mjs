import {buildDxf} from './src/core.mjs';
const p={siteBoundary:[[-79.385,43.645],[-79.375,43.645],[-79.375,43.655],[-79.385,43.655],[-79.385,43.645]],buildingBoundary:[],name:'Project',projectNo:'AB-12345',location:{lng:-79.38,lat:43.65}};
const c={companyName:'Northline Environmental',address:'100 Queen Street West, Toronto',phone:'416-555-0100',email:'hello@northline.example',website:'https://northline.example',logoAssetId:'logo',logoMime:'image/png',logoWidth:320,logoHeight:160,logoPlacement:{align:'center',scale:1}};
const d=buildDxf(p,{companyProfile:c});console.log('lines',d.split('\\n').length);console.log(d.split('\\n').map((v,i)=>`${i+1}: ${v}`).slice(-80).join('\\n'));
