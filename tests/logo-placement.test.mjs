import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

function visualBounds({align,scale,containerWidth,imageWidth}){
  const layoutLeft={left:0,center:(containerWidth-imageWidth)/2,right:containerWidth-imageWidth}[align];
  const origin={left:0,center:imageWidth/2,right:imageWidth}[align];
  return [layoutLeft+origin*(1-scale),layoutLeft+origin+(imageWidth-origin)*scale];
}

test('company logo scaling stays inside edge-aligned modal and A3 containers',()=>{
  const dom=new JSDOM(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'));
  const style=dom.window.document.createElement('style');style.textContent=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');dom.window.document.head.append(style);
  const cases=[
    {image:dom.window.document.getElementById('companyLogoPreview'),box:dom.window.document.querySelector('.logo-preview-box'),containerWidth:1,imageWidth:2/3},
    {image:dom.window.document.getElementById('printCompanyLogo'),box:dom.window.document.querySelector('.tb-brand'),containerWidth:18,imageWidth:12}
  ];
  for(const {image,box,containerWidth,imageWidth} of cases){
    for(const align of ['left','center','right']){
      box.dataset.logoAlign=align;
      assert.match(dom.window.getComputedStyle(image).transformOrigin,new RegExp(`^${align}(?: center)?$`),`${image.id} ${align} origin`);
      for(const scale of [.5,1,1.5]){
        image.style.transform=`scale(${scale})`;
        const [left,right]=visualBounds({align,scale,containerWidth,imageWidth});
        assert.ok(left>=-1e-9,`${image.id} ${align} ${scale} left ${left}`);
        assert.ok(right<=containerWidth+1e-9,`${image.id} ${align} ${scale} right ${right}`);
      }
    }
  }
  dom.window.close();
});
