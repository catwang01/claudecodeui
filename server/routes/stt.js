import express from 'express';
import multer from 'multer';
import FormData from 'form-data';
import fetch from 'node-fetch';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const SILICONFLOW_API_KEY = () => process.env.SILICONFLOW_API_KEY;
const SILICONFLOW_STT_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const STT_MODEL = 'FunAudioLLM/SenseVoiceSmall';

// GET /api/stt/health
router.get('/health', (_req, res) => {
  res.json({ supported: Boolean(process.env.SILICONFLOW_API_KEY) });
});

// POST /api/stt/transcribe
// multipart/form-data: file (audio/wav), language? (zh|en)
router.post('/transcribe', upload.single('file'), async (req, res) => {
  const apiKey = SILICONFLOW_API_KEY();
  if (!apiKey) return res.status(503).json({ error: 'SILICONFLOW_API_KEY not configured' });
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  const { language } = req.body;
  const ALLOWED_LANGS = new Set(['zh', 'en']);
  if (language && !ALLOWED_LANGS.has(language)) {
    return res.status(400).json({ error: 'Invalid language' });
  }

  const form = new FormData();
  form.append('file', req.file.buffer, {
    filename: 'audio.wav',
    contentType: 'audio/wav',
  });
  form.append('model', STT_MODEL);
  form.append('response_format', 'json');
  if (language && language !== 'auto') {
    form.append('language', language);
  }

  try {
    const response = await fetch(SILICONFLOW_STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
      body: form,
    });
    if (!response.ok) {
      const body = await response.text();
      console.error('[STT] SiliconFlow error', response.status, body);
      return res.status(502).json({ error: 'STT upstream error' });
    }
    const result = await response.json();
    res.json({ text: (result.text ?? '').trim() });
  } catch (err) {
    console.error('[STT] fetch error', err);
    res.status(500).json({ error: 'STT request failed' });
  }
});

export default router;
