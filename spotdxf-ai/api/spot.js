const BASE = process.env.PADDLE_GRADIO_BASE ||
  'https://paddlepaddle-paddleocr-vl-1-6-online-demo.hf.space/gradio_api';

function decodeDataUrl(value = '') {
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!match) throw new Error('Invalid image payload');
  const mime = match[1];
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 3_500_000) throw new Error('Tile payload is too large');
  return { mime, bytes };
}

function parseSseComplete(text) {
  const match = text.match(/event:\s*complete\s*\ndata:\s*(\[[\s\S]*\])\s*$/m);
  if (!match) {
    if (/event:\s*error/.test(text)) throw new Error('PaddleOCR queue returned an error');
    throw new Error('PaddleOCR did not return a complete result');
  }
  return JSON.parse(match[1]);
}

async function uploadTile(bytes, mime) {
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const form = new FormData();
  form.append('files', new Blob([bytes], { type: mime }), `tile.${ext}`);
  const response = await fetch(`${BASE}/upload`, { method: 'POST', body: form });
  const body = await response.text();
  if (!response.ok) throw new Error(`Paddle upload failed (${response.status})`);
  const paths = JSON.parse(body);
  if (!paths?.[0]) throw new Error('Paddle upload returned no path');
  return { path: paths[0], ext };
}

async function runSpotting(path, ext, mime) {
  const file = {
    path,
    orig_name: `tile.${ext}`,
    mime_type: mime,
    meta: { _type: 'gradio.FileData' }
  };

  const submit = await fetch(`${BASE}/call/run_spotting_wrapper`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: [file, null] })
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`Paddle submit failed (${submit.status})`);
  const eventId = JSON.parse(submitText)?.event_id;
  if (!eventId) throw new Error('Paddle returned no event id');

  const result = await fetch(`${BASE}/call/run_spotting_wrapper/${eventId}`);
  const resultText = await result.text();
  if (!result.ok) throw new Error(`Paddle result failed (${result.status})`);
  const payload = parseSseComplete(resultText);
  if (!payload?.[1]) throw new Error('Unexpected Paddle spotting payload');
  const spotting = JSON.parse(payload[1]);
  return {
    rec_texts: Array.isArray(spotting.rec_texts) ? spotting.rec_texts : [],
    rec_polys: Array.isArray(spotting.rec_polys) ? spotting.rec_polys : []
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const { imageDataUrl } = req.body || {};
    if (!imageDataUrl) return res.status(400).json({ ok: false, error: 'imageDataUrl is required' });
    const { mime, bytes } = decodeDataUrl(imageDataUrl);
    const { path, ext } = await uploadTile(bytes, mime);
    const result = await runSpotting(path, ext, mime);
    return res.status(200).json({ ok: true, ...result, engine: 'PaddleOCR-VL 1.6 Spotting' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
}
