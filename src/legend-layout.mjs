const CONTINUED_TITLE='LEGEND — CONTINUED';
const EPSILON=.000001;

function invalid(message){throw new Error(message);}

function validateEntries(entries){
  if(!Array.isArray(entries)) invalid('Legend entries must be an array.');
  for(const entry of entries){
    if(!entry||typeof entry!=='object'||entry.code==null||!String(entry.code).trim()){
      invalid('Legend entries must each have a code.');
    }
  }
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
    columnCounts:[...new Set(columnCounts)].sort((a,b)=>a-b),
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
      const entry=entries[index],entryHeight=measuredHeight(measure,entry,fontSize,width);
      if(used+entryHeight>height+EPSILON) break;
      column.push(entry);
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
    // The PDF legend producer sets `symbol` for SITE and boundary rows. Codes remain opaque.
    if(typeof entries[i].symbol==='string'&&entries[i].symbol.trim()) index=i;
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
 * field marks a required SITE/boundary row; the caller supplies it explicitly.
 */
export function planLegend({entries,measure,box,fontSizes=[7.5,7,6.5,6,5.5],columnCounts=[1,2]}={}){
  validateEntries(entries);
  if(typeof measure!=='function') invalid('Legend measure must be a function.');
  const normalizedBox=normalizeBox(box),options=normalizeOptions(fontSizes,columnCounts);
  const allCandidates=candidates(options.fontSizes,options.columnCounts);
  const minimumFont=options.fontSizes.at(-1),fullWidth=dimensions(normalizedBox,1);

  for(const entry of entries){
    if(measuredHeight(measure,entry,minimumFont,fullWidth.width)>fullWidth.height+EPSILON){
      throw new Error(`Legend entry ${entry.code} exceeds the supported text length.`);
    }
  }

  for(const candidate of allCandidates){
    const fit=fitPrefix(entries,measure,normalizedBox,candidate.fontSize,candidate.columnCount);
    if(fit.count===entries.length) return {map:pagePlan(fit,candidate),continuations:[]};
  }

  const requiredThrough=fixedEntryIndex(entries)+1;
  let bestMap=null;
  for(const candidate of allCandidates){
    const fit=fitPrefix(entries,measure,normalizedBox,candidate.fontSize,candidate.columnCount);
    if(fit.count<requiredThrough) continue;
    if(!bestMap||fit.count>bestMap.fit.count) bestMap={candidate,fit};
  }
  if(!bestMap) invalid('Required legend symbols do not fit on the map page.');

  const remaining=entries.slice(bestMap.fit.count);
  let bestContinuation=null;
  for(const candidate of allCandidates){
    const pages=paginate(remaining,measure,normalizedBox,candidate);
    if(!pages) continue;
    if(!bestContinuation||pages.length<bestContinuation.pages.length){
      bestContinuation={candidate,pages};
    }
  }
  if(!bestContinuation) invalid('Legend entries do not fit on continuation pages.');

  return {map:pagePlan(bestMap.fit,bestMap.candidate),continuations:bestContinuation.pages};
}
