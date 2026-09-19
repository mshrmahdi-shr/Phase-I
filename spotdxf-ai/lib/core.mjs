export function parseElevationText(raw) {
  const text = String(raw || '').replaceAll(',', '.');
  const matches = [...text.matchAll(/(?<!\d)(\d{2,3})\.(\d{2})(?!\d)/g)];
  return matches.map((m) => {
    const value = Number(`${m[1]}.${m[2]}`);
    return {
      raw: m[0],
      value,
      validRange: m[1].length === 3 && value >= 100 && value <= 299,
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

export function buildCsv(points, opts) {
  const selected = points.filter((p) => p.include && Number.isFinite(p.value));
  let csv = 'Point,Elevation,X,Y,PixelX,PixelY,Status,RawText\n';
  selected.forEach((p, i) => {
    const w = toWorld(p, opts.imageHeight, opts.scale, opts.dpi, opts.originX, opts.originY);
    const raw = String(p.rawFull || p.raw || '').replaceAll('"', '""');
    csv += `${i + 1},${p.value.toFixed(2)},${w.x.toFixed(4)},${w.y.toFixed(4)},${p.x.toFixed(1)},${p.y.toFixed(1)},${p.status || 'REVIEW'},"${raw}"\n`;
  });
  return csv;
}

export function buildDxf(points, opts) {
  const selected = points.filter((p) => p.include && Number.isFinite(p.value));
  let dxf = '0\nSECTION\n2\nENTITIES\n';
  for (const p of selected) {
    const w = toWorld(p, opts.imageHeight, opts.scale, opts.dpi, opts.originX, opts.originY);
    dxf += `0\nPOINT\n8\nSPOT_ELEVATIONS\n10\n${w.x.toFixed(4)}\n20\n${w.y.toFixed(4)}\n30\n${w.z.toFixed(3)}\n`;
    dxf += `0\nTEXT\n8\nSPOT_LABELS\n10\n${(w.x + 0.5).toFixed(4)}\n20\n${(w.y + 0.5).toFixed(4)}\n30\n${w.z.toFixed(3)}\n40\n0.9\n1\n${w.z.toFixed(2)}\n`;
  }
  return `${dxf}0\nENDSEC\n0\nEOF\n`;
}
