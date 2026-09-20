export function parseElevationText(raw) {
  const text = String(raw || '').replaceAll(',', '.');
  const matches = [...text.matchAll(/(?<!\d)(\d{2,3})\.(\d{2})(?!\d)/g)];
  return matches.map((m) => {
    const value = Number(`${m[1]}.${m[2]}`);
    return {
      raw: m[0],
      value,
      validRange: Number.isFinite(value) && value >= 0 && value <= 999,
      roundHundredth: m[2] === '00'
    };
  });
}

export function dedupePoints(points, radiusPx = 40) {
  const out = [];
  for (const point of points) {
    const near = out.find((p) =>
      Math.hypot(p.x - point.x, p.y - point.y) <= radiusPx &&
      ((Number.isFinite(p.value) && Number.isFinite(point.value) && Math.abs(p.value - point.value) < 0.011) || p.raw === point.raw)
    );
    if (!near) out.push({ ...point });
    else if ((point.confidence || 0) > (near.confidence || 0)) Object.assign(near, point);
  }
  return out;
}

export function metresPerPixel(scale, dpi) {
  const s = Number(scale);
  const d = Number(dpi);
  if (!Number.isFinite(s) || !Number.isFinite(d) || s <= 0 || d <= 0) throw new Error('Invalid scale or DPI');
  return (25.4 * s) / (d * 1000);
}

export function toWorld(point, imageHeight, scale, dpi, originX = 0, originY = 0) {
  const k = metresPerPixel(scale, dpi);
  return {
    x: Number(originX) + point.x * k,
    y: Number(originY) + (imageHeight - point.y) * k,
    z: point.value
  };
}

function selectedPoints(points) {
  return points.filter((p) => p.include && Number.isFinite(p.value));
}

function cleanDescription(value) {
  const cleaned = String(value || 'SPOT_ELEV').trim().replace(/[,\r\n]+/g, '_').replace(/\s+/g, '_');
  return cleaned || 'SPOT_ELEV';
}

function pointStart(opts) {
  const n = Math.trunc(Number(opts?.startPoint));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildCsv(points, opts) {
  const selected = selectedPoints(points);
  let csv = 'Point,Elevation,Easting,Northing,PixelX,PixelY,Description,Status,RawText\n';
  const start = pointStart(opts);
  const description = cleanDescription(opts?.description);
  selected.forEach((p, i) => {
    const w = toWorld(p, opts.imageHeight, opts.scale, opts.dpi, opts.originX, opts.originY);
    const raw = String(p.rawFull || p.raw || '').replaceAll('"', '""');
    csv += `${start + i},${p.value.toFixed(2)},${w.x.toFixed(4)},${w.y.toFixed(4)},${p.x.toFixed(1)},${p.y.toFixed(1)},${description},${p.status || 'REVIEW'},"${raw}"\n`;
  });
  return csv;
}

export function buildCivil3dPnezd(points, opts) {
  const selected = selectedPoints(points);
  const start = pointStart(opts);
  const description = cleanDescription(opts?.description);
  let out = '';
  selected.forEach((p, i) => {
    const w = toWorld(p, opts.imageHeight, opts.scale, opts.dpi, opts.originX, opts.originY);
    // Civil 3D PNEZD = Point Number, Northing, Easting, Elevation, Description.
    out += `${start + i},${w.y.toFixed(4)},${w.x.toFixed(4)},${w.z.toFixed(3)},${description}\r\n`;
  });
  return out;
}

export function buildLandXml(points, opts) {
  const selected = selectedPoints(points);
  const start = pointStart(opts);
  const description = cleanDescription(opts?.description);
  const date = opts?.date || new Date().toISOString().slice(0, 10);
  const rows = selected.map((p, i) => {
    const w = toWorld(p, opts.imageHeight, opts.scale, opts.dpi, opts.originX, opts.originY);
    const name = start + i;
    return `    <CgPoint name="${name}" desc="${xmlEscape(description)}" code="${xmlEscape(description)}">${w.y.toFixed(4)} ${w.x.toFixed(4)} ${w.z.toFixed(3)}</CgPoint>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="${xmlEscape(date)}">\n  <Units>\n    <Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars"/>\n  </Units>\n  <CgPoints>\n${rows}\n  </CgPoints>\n</LandXML>\n`;
}

export function buildDxf(points, opts) {
  const selected = selectedPoints(points);
  const description = cleanDescription(opts?.description);
  let dxf = '0\nSECTION\n2\nENTITIES\n';
  for (const p of selected) {
    const w = toWorld(p, opts.imageHeight, opts.scale, opts.dpi, opts.originX, opts.originY);
    dxf += `0\nPOINT\n8\nSPOT_ELEVATIONS\n10\n${w.x.toFixed(4)}\n20\n${w.y.toFixed(4)}\n30\n${w.z.toFixed(3)}\n`;
    dxf += `0\nTEXT\n8\nSPOT_LABELS\n10\n${(w.x + 0.5).toFixed(4)}\n20\n${(w.y + 0.5).toFixed(4)}\n30\n${w.z.toFixed(3)}\n40\n0.9\n1\n${w.z.toFixed(2)} ${description}\n`;
  }
  return `${dxf}0\nENDSEC\n0\nEOF\n`;
}
