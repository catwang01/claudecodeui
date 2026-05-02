# Implementation Plan: VAD Voice Conversation

**Spec:** `2026-05-02-vad-voice-conversation-design.md`
**Date:** 2026-05-02

---

## Step 1 — Install dependency

```bash
npm install @ricky0123/vad-web
```

Verify it's in `package.json` dependencies.

---

## Step 2 — Configure Vite to serve WASM model files

Edit `vite.config.js`:
- Copy `node_modules/@ricky0123/vad-web/dist/*.onnx` and `*.wasm` files to `public/`
- Use `vite-plugin-static-copy` OR manually add to `publicDir` / copy script

The library loads these at runtime from the root URL. Without this step VAD will fail to initialize.

Check what files the library needs:
```bash
ls node_modules/@ricky0123/vad-web/dist/
```

---

## Step 3 — Add WAV encoder utility

Add a pure function `float32ToWav(samples: Float32Array, sampleRate: number): Blob` to a new file `src/utils/wav.ts`.

WAV format:
- 44-byte header (RIFF/WAVE/fmt/data chunks)
- 16-bit PCM samples (float32 → int16 conversion)
- Mono, 16kHz

---

## Step 4 — Add `POST /api/stt/transcribe` to server

Edit `server/routes/stt.js`:
- Add `multer` or use raw `express` body parsing for `multipart/form-data`
- Extract `file` (audio/wav) and optional `language` field
- Forward to SiliconFlow API (same as existing `stt-ws.js` logic)
- Return `{ text: string }`

---

## Step 5 — Rewrite `VoiceConversationContext.tsx`

Replace the entire recording/WebSocket/silence-detection logic with `useMicVAD`:

```tsx
const vad = useMicVAD({
  startOnLoad: false,
  onSpeechStart: () => {
    if (statusRef.current === 'speaking') {
      ttsStopRef.current?.();
      setStatus('listening');
    }
  },
  onSpeechEnd: async (audio: Float32Array) => {
    if (statusRef.current !== 'listening') return;
    setStatus('processing');
    const wav = float32ToWav(audio, 16000);
    const text = await transcribe(wav, voiceLangRef.current);
    if (text) submitCallbackRef.current?.(text);
    else setStatus('listening');
  },
});
```

Keep: `toggle()`, `registerSubmitCallback()`, `notifyLoadingChange()`, status types, lang selection.
Remove: everything WS/MediaRecorder/timer related.

---

## Step 6 — Remove WebSocket STT server

- Delete `server/stt-ws.js`
- Edit `server/index.js`: remove WS `/stt` route registration

---

## Step 7 — Manual test

Test scenarios:
1. Basic: click voice button → speak → pause → text appears in input → submits
2. Barge-in: Claude is speaking TTS → you speak → TTS stops → your speech is captured
3. Language switch: toggle between zh-CN / en-US
4. Error: kill server mid-request → stays in listening, doesn't crash

---

## Step 8 — Cleanup

- Remove unused constants from `VoiceConversationContext.tsx`
- Verify `package.json` has no unused deps from old WS approach
