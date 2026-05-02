# VAD Voice Conversation Design

**Date:** 2026-05-02
**Status:** Approved
**Branch:** fix/websocket-reconnect-session-state

---

## Problem

Current voice conversation implementation uses a 3-second polling approach:
- MediaRecorder accumulates audio and sends chunks every 3s via WebSocket
- Silence detection is simulated by comparing consecutive STT results
- End-of-speech detection takes 6s+ (3s interval × 2 silence chunks)
- Barge-in is unreliable (2s grace period + character-count heuristics)

## Goal

Replace the polling approach with browser-side VAD (Voice Activity Detection) to:
- Detect end-of-speech in ~100ms instead of 6s+
- Send exactly one complete utterance per STT request
- Make barge-in reliable via `onSpeechStart` event

---

## Architecture

### Before

```
MediaRecorder (3s chunks, cumulative blobs)
  → WebSocket → stt-ws.js
  → SiliconFlow HTTP POST (batch transcription)
  → silence detection (seq numbers, buffer, 2x same result)
  → submit text to Claude
```

### After

```
@ricky0123/vad-web (browser, silero-vad ONNX model)
  onSpeechEnd(Float32Array) → convert to WAV
    → HTTP POST /api/stt/transcribe
    → SiliconFlow → { text }
    → submit text to Claude

  onSpeechStart (during TTS) → ttsStop() [barge-in]
```

---

## Components

### 1. `@ricky0123/vad-web` (new dependency)

- Browser library running silero-vad ONNX model via WebAssembly
- Provides React hook: `useMicVAD({ onSpeechStart, onSpeechEnd, ... })`
- `onSpeechEnd(audio: Float32Array)` — 16kHz mono PCM of the detected utterance
- Requires ONNX/WASM model files served from `public/` (vite config change)

### 2. `VoiceConversationContext.tsx` (rewrite core logic)

**Remove:**
- `MediaRecorder` and chunk recording logic
- 3s/1.2s interval timers (`chunkTimerRef`, `chunkTimerRef`)
- Sequence numbers (`seqRef`, `bargeInStartSeqRef`)
- Cumulative blob accumulation (`listenBlobsRef`)
- Silence counting (`silenceCountRef`, `prevResultRef`, `SILENCE_CHUNKS`)
- WebSocket (`wsRef`, `openWS`, `ensureWS`, `closeWS`)
- `sendChunk`, `startChunk`, `stopRecording` functions
- `BARGE_IN_GRACE_MS`, `BARGE_IN_INTERVAL_MS`, `CHUNK_INTERVAL_MS` constants

**Add:**
- `useMicVAD` hook with handlers:
  - `onSpeechStart`: if status is `speaking` → call `ttsStop()` (barge-in)
  - `onSpeechEnd(audio)`: if status is `listening` → convert to WAV → POST to STT → on result → submit
- `float32ToWav(audio: Float32Array, sampleRate: number): Blob` — WAV encoder utility
- STT via `authenticatedFetch('/api/stt/transcribe', { method: 'POST', body: wavBlob })`

**Simplified status machine:**
```
idle → toggle() → listening
listening → onSpeechEnd → processing (STT in flight)
processing → LLM done (notifyLoadingChange false) → listening
processing → TTS starts (isSpeaking=true) → speaking
speaking → TTS ends (isSpeaking=false) → listening
speaking → onSpeechStart → ttsStop() → listening
```

### 3. `server/routes/stt.js` (add transcribe endpoint)

Add `POST /api/stt/transcribe`:
- Receives `multipart/form-data` with `file` (WAV audio) and optional `language`
- Forwards to SiliconFlow STT API (`FunAudioLLM/SenseVoiceSmall`)
- Returns `{ text: string }`

### 4. `vite.config.js` (add WASM copy)

Copy `@ricky0123/vad-web` ONNX model files to `public/` at build time so the browser can load them. Use `vite-plugin-static-copy` or manual `assetsInclude` config.

### 5. `server/stt-ws.js` (remove)

WebSocket STT server is no longer needed. Remove the file and its registration in `server/index.js`.

---

## Data Flow: Speech End

```
VAD onSpeechEnd(audio: Float32Array, sampleRate=16000)
  → float32ToWav(audio, 16000) → Blob (audio/wav)
  → setStatus('processing')
  → POST /api/stt/transcribe  (multipart, file=wav, language=zh|en|undefined)
  → { text: "你好，帮我..." }
  → submitCallback(text)
  → setTranscript('')
```

## Data Flow: Barge-in

```
TTS playing → status = 'speaking'
User starts speaking
  → VAD onSpeechStart fires (~100ms from speech onset)
  → ttsStop()
  → status = 'listening'
  → next onSpeechEnd will capture the full utterance
```

---

## Error Handling

- STT request fails → log error, stay in `listening` (don't crash)
- VAD fails to load WASM → `supported = false`, hide voice button
- Mic permission denied → set `isActive = false`, `status = 'idle'`

---

## Files Changed

| File | Change |
|------|--------|
| `src/contexts/VoiceConversationContext.tsx` | Rewrite: remove WS/polling, add VAD hook |
| `server/routes/stt.js` | Add `POST /api/stt/transcribe` |
| `vite.config.js` | Add WASM model file copy |
| `package.json` | Add `@ricky0123/vad-web` |
| `server/stt-ws.js` | Delete |
| `server/index.js` | Remove WS STT registration |

---

## Out of Scope

- Streaming STT (Deepgram) — future improvement
- Streaming TTS — future improvement
- Changing TTS provider — no change
- Changing LLM provider — no change
