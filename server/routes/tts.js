import express from 'express';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

const router = express.Router();

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const SYNTHESIS_TIMEOUT_MS = 30_000;

// POST /api/tts/synthesize
// Body: { text: string, voice?: string }
// Returns: audio/mpeg stream
router.post('/synthesize', async (req, res) => {
  const { text, voice = DEFAULT_VOICE } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }

  const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

  const py = spawn('python3', [
    '-c',
    `
import edge_tts
import asyncio

async def run():
    tts = edge_tts.Communicate(${JSON.stringify(text.trim())}, ${JSON.stringify(voice)})
    await tts.save(${JSON.stringify(tmpFile)})

asyncio.run(run())
`
  ]);

  // Kill the process and clean up if it hangs
  const killTimer = setTimeout(() => {
    py.kill();
    fs.unlink(tmpFile, () => {});
    if (!res.headersSent) {
      res.status(504).json({ error: 'TTS synthesis timed out' });
    }
  }, SYNTHESIS_TIMEOUT_MS);

  py.on('close', (code) => {
    clearTimeout(killTimer);
    if (code !== 0) {
      fs.unlink(tmpFile, () => {});
      if (!res.headersSent) {
        res.status(500).json({ error: 'TTS synthesis failed' });
      }
      return;
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(tmpFile, () => {}));
    stream.on('error', (err) => {
      console.error('[TTS] stream error', err);
      fs.unlink(tmpFile, () => {});
      // Headers already sent — destroy the socket to signal an error to the client
      res.destroy();
    });
  });

  py.stderr.on('data', (data) => {
    console.error('[TTS]', data.toString());
  });
});

// GET /api/tts/health
// Returns 200 if edge_tts is importable, 503 otherwise
router.get('/health', (req, res) => {
  const py = spawn('python3', ['-c', 'import edge_tts; print("ok")']);
  py.on('close', (code) => {
    if (code === 0) {
      res.json({ supported: true });
    } else {
      res.status(503).json({ supported: false });
    }
  });
});

// GET /api/tts/voices
// Returns list of available voices
router.get('/voices', async (req, res) => {
  const py = spawn('python3', [
    '-c',
    `
import edge_tts
import asyncio
import json

async def run():
    voices = await edge_tts.list_voices()
    print(json.dumps(voices))

asyncio.run(run())
`
  ]);

  let output = '';
  py.stdout.on('data', (d) => { output += d.toString(); });
  py.on('close', (code) => {
    if (code !== 0) return res.status(500).json({ error: 'Failed to list voices' });
    try {
      res.json(JSON.parse(output));
    } catch {
      res.status(500).json({ error: 'Invalid voice list response' });
    }
  });
});

export default router;
