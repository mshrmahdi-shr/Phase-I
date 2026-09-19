export default function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    engine: 'PaddleOCR-VL 1.6 Spotting',
    provider: 'official Hugging Face demo endpoint',
    version: '0.1.0'
  });
}
