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
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!enabled || !text.trim()) return;

      // Stop any ongoing speech
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }

      const clean = stripMarkdown(text);
      if (!clean) return;

      try {
        setIsSpeaking(true);
        const res = await authenticatedFetch('/api/tts/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean, voice: voiceLangToEdgeVoice(localStorage.getItem(VOICE_LANG_KEY)) }),
        });

        if (!res.ok) {
          setIsSpeaking(false);
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;

        audio.onended = () => {
          URL.revokeObjectURL(url);
          setIsSpeaking(false);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setIsSpeaking(false);
        };

        await audio.play();
      } catch {
        setIsSpeaking(false);
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
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
    };
  }, []);

  return (
    <TTSContext.Provider value={{ supported, enabled, isSpeaking, speak, stop, toggle }}>
      {children}
    </TTSContext.Provider>
  );
}

export function useTTS() {
  const ctx = useContext(TTSContext);
  if (!ctx) throw new Error('useTTS must be used within TTSProvider');
  return ctx;
}
