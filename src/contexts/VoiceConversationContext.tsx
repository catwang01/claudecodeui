import { MicVAD } from '@ricky0123/vad-web';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTTS } from './TTSContext';
import { float32ToWav } from '../utils/wav';
import { authenticatedFetch } from '../utils/api.js';
import { logger } from '../utils/logger';

export type VoiceStatus = 'idle' | 'listening' | 'processing' | 'speaking';
export type VoiceLang = 'zh-CN' | 'en-US' | 'auto';

const VOICE_LANG_KEY = 'voice-lang';
const PARTIAL_INTERVAL_MS = 3000;

// VAD speech probability thresholds
const THRESHOLD_LISTENING = 0.7;  // normal sensitivity when waiting for user
const THRESHOLD_SPEAKING  = 0.92; // strict threshold during TTS to suppress echo

type VoiceConversationContextValue = {
  supported: boolean;
  isActive: boolean;
  status: VoiceStatus;
  transcript: string;
  voiceLang: VoiceLang;
  setVoiceLang: (lang: VoiceLang) => void;
  toggle: () => void;
  registerSubmitCallback: (fn: (text: string) => void) => void;
  notifyLoadingChange: (loading: boolean) => void;
};

const VoiceConversationContext = createContext<VoiceConversationContextValue | null>(null);

async function transcribeWav(wav: Blob, lang: VoiceLang): Promise<string> {
  const form = new FormData();
  form.append('file', wav, 'audio.wav');
  if (lang !== 'auto') {
    form.append('language', lang === 'zh-CN' ? 'zh' : 'en');
  }
  try {
    const res = await authenticatedFetch('/api/stt/transcribe', { method: 'POST', body: form });
    if (!res.ok) return '';
    const data = await res.json();
    return (data.text ?? '').trim();
  } catch {
    return '';
  }
}

export function VoiceConversationProvider({ children }: { children: ReactNode }) {
  const { isSpeaking, stop: ttsStop } = useTTS();

  const [isActive, setIsActive]        = useState(false);
  const [status, setStatus]            = useState<VoiceStatus>('idle');
  const [transcript, setTranscript]    = useState('');
  const [voiceLang, setVoiceLangState] = useState<VoiceLang>(() => {
    try {
      const saved = localStorage.getItem(VOICE_LANG_KEY);
      if (saved === 'zh-CN' || saved === 'en-US' || saved === 'auto') return saved;
    } catch { /* ignore */ }
    return 'zh-CN';
  });

  const supported = typeof window !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof navigator?.mediaDevices?.getUserMedia === 'function';

  const submitCallbackRef = useRef<((text: string) => void) | null>(null);
  const statusRef         = useRef<VoiceStatus>('idle');
  const isActiveRef       = useRef(false);
  const voiceLangRef      = useRef(voiceLang);
  const isSpeakingRef     = useRef(isSpeaking);
  const ttsStopRef        = useRef(ttsStop);
  const prevLoadingRef    = useRef(false);
  const vadRef            = useRef<MicVAD | null>(null);
  const speechFramesRef   = useRef<Float32Array[]>([]);
  const speechStartedRef  = useRef(false);
  const partialTimerRef   = useRef<number | null>(null);

  // Sync update in render body so VAD callbacks always see current values.
  ttsStopRef.current = ttsStop;

  useEffect(() => { statusRef.current = status; },     [status]);
  useEffect(() => { voiceLangRef.current = voiceLang; }, [voiceLang]);

  const setVoiceLang = useCallback((lang: VoiceLang) => {
    setVoiceLangState(lang);
    voiceLangRef.current = lang;
    try { localStorage.setItem(VOICE_LANG_KEY, lang); } catch { /* ignore */ }
  }, []);

  // ── Partial STT (preview while speaking) ─────────────────────────────────

  const sendPartialNow = useCallback(async () => {
    const frames = speechFramesRef.current;
    if (frames.length < 80) return;

    speechFramesRef.current = [];
    const total = frames.reduce((sum, f) => sum + f.length, 0);
    const combined = new Float32Array(total);
    let offset = 0;
    for (const f of frames) { combined.set(f, offset); offset += f.length; }

    const wav = float32ToWav(combined, 16000);
    const text = await transcribeWav(wav, voiceLangRef.current);
    if (text && speechStartedRef.current) {
      setTranscript(text);
    }
  }, []);

  const schedulePartial = useCallback(() => {
    partialTimerRef.current = window.setTimeout(async () => {
      if (!speechStartedRef.current) return;
      await sendPartialNow();
      if (speechStartedRef.current) schedulePartial();
    }, PARTIAL_INTERVAL_MS);
  }, [sendPartialNow]);

  const cancelPartialTimer = useCallback(() => {
    if (partialTimerRef.current !== null) {
      clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }
  }, []);

  // ── VAD lifecycle ─────────────────────────────────────────────────────────

  const startVAD = useCallback(async () => {
    if (vadRef.current) return;

    try {
      const vad = await MicVAD.new({
        baseAssetPath: '/',
        onnxWASMBasePath: '/',
        // AEC removes speaker output from mic signal before VAD sees it.
        // Combined with dynamic threshold below, this suppresses echo on mobile.
        getStream: () => navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          },
        }),
        positiveSpeechThreshold: THRESHOLD_LISTENING,
        negativeSpeechThreshold: THRESHOLD_LISTENING - 0.15,
        redemptionMs: 2000,
        minSpeechMs: 600,
        onSpeechStart: () => {
          if (!isActiveRef.current) return;
          cancelPartialTimer();
          speechStartedRef.current = true;
          speechFramesRef.current = [];
          schedulePartial();
          // Barge-in: user speaks while TTS is playing → stop TTS, start listening
          if (statusRef.current === 'speaking') {
            logger.log('[Voice] barge-in');
            ttsStopRef.current();
            setStatus('listening');
            statusRef.current = 'listening';
          }
        },
        onFrameProcessed: (_probs: any, frame: Float32Array) => {
          if (speechStartedRef.current) {
            speechFramesRef.current.push(new Float32Array(frame));
          }
        },
        onSpeechEnd: async (audio: Float32Array) => {
          if (!isActiveRef.current) return;
          if (statusRef.current !== 'listening') return;

          cancelPartialTimer();
          speechStartedRef.current = false;
          speechFramesRef.current = [];

          logger.log(`[Voice] speech end, samples=${audio.length}`);
          setStatus('processing');
          statusRef.current = 'processing';
          setTranscript('');

          const wav = float32ToWav(audio, 16000);
          const text = await transcribeWav(wav, voiceLangRef.current);
          logger.log(`[Voice] STT result: "${text}"`);

          if (!isActiveRef.current) return;

          if (text) {
            submitCallbackRef.current?.(text);
          } else {
            setStatus('listening');
            statusRef.current = 'listening';
          }
        },
        onVADMisfire: () => {
          cancelPartialTimer();
          speechStartedRef.current = false;
          speechFramesRef.current = [];
          logger.log('[Voice] VAD misfire');
        },
      });

      vadRef.current = vad;
      await vad.start();
      logger.log('[Voice] VAD started');
    } catch (err) {
      logger.error('[Voice] VAD init failed', err);
      setIsActive(false);
      isActiveRef.current = false;
      setStatus('idle');
      statusRef.current = 'idle';
    }
  }, [cancelPartialTimer, schedulePartial]);

  const stopVAD = useCallback(async () => {
    const vad = vadRef.current;
    vadRef.current = null;
    if (vad) {
      try { await vad.destroy(); } catch { /* ignore */ }
      logger.log('[Voice] VAD destroyed');
    }
  }, []);

  // ── TTS interlock ─────────────────────────────────────────────────────────
  // During TTS playback: raise threshold to 0.92 so TTS echo can't trigger
  // barge-in. Real intentional speech (user speaking loudly) still exceeds 0.92.
  // When TTS ends: restore normal threshold.

  useEffect(() => {
    const prevSpeaking = isSpeakingRef.current;
    isSpeakingRef.current = isSpeaking;
    if (!isActiveRef.current) return;

    if (isSpeaking && !prevSpeaking) {
      logger.log('[Voice] TTS started → speaking');
      setStatus('speaking');
      statusRef.current = 'speaking';
      vadRef.current?.setOptions({ positiveSpeechThreshold: THRESHOLD_SPEAKING });
    } else if (!isSpeaking && prevSpeaking) {
      logger.log('[Voice] TTS ended → listening');
      if (statusRef.current === 'speaking') {
        setStatus('listening');
        statusRef.current = 'listening';
        vadRef.current?.setOptions({ positiveSpeechThreshold: THRESHOLD_LISTENING });
      }
    }
  }, [isSpeaking]);

  // ── toggle ────────────────────────────────────────────────────────────────

  const toggle = useCallback(() => {
    if (isActiveRef.current) {
      isActiveRef.current = false;
      speechStartedRef.current = false;
      speechFramesRef.current = [];
      cancelPartialTimer();
      setIsActive(false);
      setStatus('idle');
      statusRef.current = 'idle';
      setTranscript('');
      stopVAD();
    } else {
      isActiveRef.current = true;
      setIsActive(true);
      setStatus('listening');
      statusRef.current = 'listening';
      startVAD();
    }
  }, [startVAD, stopVAD, cancelPartialTimer]);

  const registerSubmitCallback = useCallback((fn: (text: string) => void) => {
    submitCallbackRef.current = fn;
  }, []);

  const notifyLoadingChange = useCallback((loading: boolean) => {
    const prev = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (!loading && prev && isActiveRef.current && statusRef.current === 'processing') {
      setTimeout(() => {
        if (isActiveRef.current && statusRef.current === 'processing') {
          setStatus('listening');
          statusRef.current = 'listening';
        }
      }, 300);
    }
  }, []);

  useEffect(() => {
    return () => { cancelPartialTimer(); stopVAD(); };
  }, [cancelPartialTimer, stopVAD]);

  return (
    <VoiceConversationContext.Provider
      value={{ supported, isActive, status, transcript, voiceLang, setVoiceLang, toggle, registerSubmitCallback, notifyLoadingChange }}
    >
      {children}
    </VoiceConversationContext.Provider>
  );
}

export function useVoiceConversation() {
  const ctx = useContext(VoiceConversationContext);
  if (!ctx) throw new Error('useVoiceConversation must be used within VoiceConversationProvider');
  return ctx;
}
