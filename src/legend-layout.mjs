const CONTINUED_TITLE='LEGEND — CONTINUED';

function invalid(message){throw new Error(message);}

function validateEntries(entries){
  if(!Array.isArray(entries)) invalid('Legend entries must be an array.');
  return entries.map(entry=>{
    if(!entry||typeof entry!=='object') invalid('Legend entries must be objects.');
    let symbol=null;
    if(entry.symbol!=null){
      if(typeof entry.symbol!=='string'||!entry.symbol.trim()) invalid('Legend entry symbols must be non-empty strings.');
      symbol=entry.symbol.trim();
    }
    let label;
    if(entry.code==null){
      if(!symbol) invalid('Legend entries must each have a code or symbol.');
      label=symbol;
    }else if(typeof entry.code==='string'&&entry.code.trim()) label=entry.code.trim();
    else if(typeof entry.code==='number'&&Number.isFinite(entry.code)) label=String(entry.code);
    else invalid('Legend entry codes must be non-empty strings or finite numbers.');
    return {entry,label,fixed:!!symbol};
  });
}

function normalizeOptions(fontSizes,columnCounts){
  if(!Array.isArray(fontSizes)||!fontSizes.length||fontSizes.some(size=>!Number.isFinite(size)||size<=0)){
    invalid('Legend font sizes must be a non-empty array of positive finite numbers.');
  }
  if(!Array.isArray(columnCounts)||!columnCounts.length||columnCounts.some(count=>!Number.isInteger(count)||![1,2].includes(count))){
    invalid('Legend column counts must contain only 1 or 2.');
  }
  return {
    fontSizes:[...new Set(fontSizes)].sort((a,b)=>b-a),
    columnCounts:[...new Set(columnCounts)],
  };
}

function normalizeBox(box){
  if(!box||typeof box!=='object'||!Number.isFinite(box.width)||box.width<=0||!Number.isFinite(box.height)||box.height<=0){
    invalid('Legend box width and height must be positive finite numbers.');
  }
  const padding=box.padding??0,gap=box.gap??box.columnGap??0;
  if(!Number.isFinite(padding)||padding<0||!Number.isFinite(gap)||gap<0){
    invalid('Legend box padding and gap must be finite non-negative numbers.');
  }
  return {width:box.width,height:box.height,padding,gap};
}

function dimensions(box,columnCount){
  const height=box.height-box.padding*2;
  const width=(box.width-box.padding*2-box.gap*(columnCount-1))/columnCount;
  if(width<=0||height<=0) invalid('Legend box has no usable layout area.');
  return {width,height};
}

function measuredHeight(measure,entry,fontSize,width){
  const height=measure(entry,{fontSize,width});
  if(!Number.isFinite(height)||height<0) invalid('Legend measure must return a finite non-negative height.');
  return height;
}

function fitPrefix(entries,measure,box,fontSize,columnCount){
  const {width,height}=dimensions(box,columnCount);
  const columns=Array.from({length:columnCount},()=>[]);
  let index=0;
  for(const column of columns){
    let used=0;
    while(index<entries.length){
      const entry=entries[index],entryHeight=measuredHeight(measure,entry.entry,fontSize,width);
      if(used+entryHeight>height) break;
      column.push(entry.entry);
      used+=entryHeight;
      index+=1;
    }
  }
  return {columns,count:index};
}

function candidates(fontSizes,columnCounts){
  return fontSizes.flatMap(fontSize=>columnCounts.map(columnCount=>({fontSize,columnCount})));
}

function fixedEntryIndex(entries){
  let index=-1;
  for(let i=0;i<entries.length;i+=1){
    if(entries[i].fixed) index=i;
  }
  return index;
}

function pagePlan(fit,{fontSize,columnCount}){
  return {fontSize,columnCount,columns:fit.columns};
}

function paginate(entries,measure,box,candidate){
  const pages=[];
  let remaining=entries;
  while(remaining.length){
    const fit=fitPrefix(remaining,measure,box,candidate.fontSize,candidate.columnCount);
    if(!fit.count) return null;
    pages.push({title:CONTINUED_TITLE,...pagePlan(fit,candidate)});
    remaining=remaining.slice(fit.count);
  }
  return pages;
}

/**
 * Plans measured legend rows without altering their contents. A non-empty `symbol`
 * field marks a required SITE/boundary row; it is also that row's stable error label
 * when no code is supplied. Candidates use largest font first, then supplied column
 * order; overflow-map ties retain that priority, as do continuation candidates.
 */
export function planLegend({entries,measure,box,fontSizes=[7.5,7,6.5,6,5.5],columnCounts=[1,2]}={}){
  const normalizedEntries=validateEntries(entries);
  if(typeof measure!=='function') invalid('Legend measure must be a function.');
  const normalizedBox=normalizeBox(box),options=normalizeOptions(fontSizes,columnCounts);
  const allCandidates=candidates(options.fontSizes,options.columnCounts);
  const minimumFont=options.fontSizes.at(-1),fullWidth=dimensions(normalizedBox,1);

  for(const item of normalizedEntries){
    if(measuredHeight(measure,item.entry,minimumFont,fullWidth.width)>fullWidth.height){
      throw new Error(`Legend entry ${item.label} exceeds the supported text length.`);
    }
  }

  for(const candidate of allCandidates){
    const fit=fitPrefix(normalizedEntries,measure,normalizedBox,candidate.fontSize,candidate.columnCount);
    if(fit.count===normalizedEntries.length) return {map:pagePlan(fit,candidate),continuations:[]};
  }

  const requiredThrough=fixedEntryIndex(normalizedEntries)+1;
  let bestMap=null;
  for(const candidate of allCandidates){
    const fit=fitPrefix(normalizedEntries,measure,normalizedBox,candidate.fontSize,candidate.columnCount);
    if(fit.count<requiredThrough) continue;
    if(!bestMap||fit.count>bestMap.fit.count) bestMap={candidate,fit};
  }
  if(!bestMap) invalid('Required legend symbols do not fit on the map page.');

  const remaining=normalizedEntries.slice(bestMap.fit.count);
  for(const candidate of allCandidates){
    const pages=paginate(remaining,measure,normalizedBox,candidate);
    if(pages) return {map:pagePlan(bestMap.fit,bestMap.candidate),continuations:pages};
  }
  invalid('Legend entries do not fit on continuation pages.');
}
