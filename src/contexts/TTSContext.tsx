import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { authenticatedFetch } from '../utils/api.js';

const TTS_ENABLED_KEY = 'tts-enabled';
const VOICE_LANG_KEY = 'voice-lang';

function voiceLangToEdgeVoice(lang: string | null): string {
  if (lang === 'en-US') return 'en-US-AriaNeural';
  return 'zh-CN-XiaoxiaoNeural'; // default for zh-CN and auto
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`[^`]*`/g, '')        // inline code
    .replace(/!\[.*?\]\(.*?\)/g, '') // images
    .replace(/\[([^\]]*)\]\(.*?\)/g, '$1') // links → label only
    .replace(/#{1,6}\s+/g, '')      // headings
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/^\s*[-*+]\s+/gm, '')  // list bullets
    .replace(/^\s*\d+\.\s+/gm, '')  // numbered lists
    .replace(/>\s+/g, '')           // blockquotes
    .replace(/\n{2,}/g, '. ')       // paragraph breaks → pause
    .replace(/\n/g, ' ')
    .trim();
}

type TTSContextValue = {
  supported: boolean;
  enabled: boolean;
  isSpeaking: boolean;
  speakingText: string;
  speak: (text: string) => void;
  stop: () => void;
  toggle: () => void;
};

const TTSContext = createContext<TTSContextValue | null>(null);

export function TTSProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TTS_ENABLED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [supported, setSupported] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakingText, setSpeakingText] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);

  // Check backend availability once on mount
  useEffect(() => {
    authenticatedFetch('/api/tts/health')
      .then((res) => res.ok && res.json())
      .then((data) => {
        if (data && data.supported) setSupported(true);
      })
      .catch(() => {/* backend unavailable */});
  }, []);

  // Persist preference
  useEffect(() => {
    try {
      localStorage.setItem(TTS_ENABLED_KEY, String(enabled));
    } catch {
      // ignore
    }
  }, [enabled]);

  // Unlock audio on first user gesture — create & resume AudioContext within the gesture
  // so iOS Safari allows subsequent auto-play via Web Audio API.
  useEffect(() => {
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          ctx.resume();
          audioContextRef.current = ctx;
        }
      } catch { /* ignore */ }
      document.removeEventListener('click', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
    document.addEventListener('click', unlock, true);
    document.addEventListener('touchstart', unlock, true);
    document.addEventListener('keydown', unlock, true);
    return () => {
      document.removeEventListener('click', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
  }, []);

  const stop = useCallback(() => {
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch { /* ignore */ }
      sourceNodeRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setIsSpeaking(false);
    setSpeakingText('');
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!enabled || !text.trim()) return;

      // Stop any ongoing speech
      if (sourceNodeRef.current) {
        try { sourceNodeRef.current.stop(); } catch { /* ignore */ }
        sourceNodeRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }

      const clean = stripMarkdown(text);
      if (!clean) return;

      setSpeakingText(clean);
      try {
        const res = await authenticatedFetch('/api/tts/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean, voice: voiceLangToEdgeVoice(localStorage.getItem(VOICE_LANG_KEY)) }),
        });

        if (!res.ok) { setSpeakingText(''); return; }

        const arrayBuffer = await res.arrayBuffer();
        const ctx = audioContextRef.current;

        if (ctx && ctx.state !== 'closed') {
          // Web Audio API path — works on iOS Safari after AudioContext is unlocked
          const decoded = await ctx.decodeAudioData(arrayBuffer);
          const source = ctx.createBufferSource();
          source.buffer = decoded;
          source.connect(ctx.destination);
          sourceNodeRef.current = source;
          source.onended = () => {
            sourceNodeRef.current = null;
            setIsSpeaking(false);
            setSpeakingText('');
          };
          await ctx.resume(); // resume if suspended (e.g. iOS after page background)
          source.start(0);
          setIsSpeaking(true);
        } else {
          // Fallback: HTML Audio element (desktop browsers)
          const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => {
            URL.revokeObjectURL(url);
            setIsSpeaking(false);
            setSpeakingText('');
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            setIsSpeaking(false);
            setSpeakingText('');
          };
          await audio.play();
          setIsSpeaking(true);
        }
      } catch {
        setIsSpeaking(false);
        setSpeakingText('');
      }
    },
    [enabled],
  );

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) stop();
      return !prev;
    });
  }, [stop]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (sourceNodeRef.current) {
        try { sourceNodeRef.current.stop(); } catch { /* ignore */ }
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  return (
    <TTSContext.Provider value={{ supported, enabled, isSpeaking, speakingText, speak, stop, toggle }}>
      {children}
    </TTSContext.Provider>
  );
}

export function useTTS() {
  const ctx = useContext(TTSContext);
  if (!ctx) throw new Error('useTTS must be used within TTSProvider');
  return ctx;
}
