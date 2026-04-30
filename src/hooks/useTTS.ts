import { useCallback, useEffect, useRef, useState } from 'react';

const TTS_ENABLED_KEY = 'tts-enabled';

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

export function useTTS() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TTS_ENABLED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [supported] = useState(() => typeof window !== 'undefined' && 'speechSynthesis' in window);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Persist preference
  useEffect(() => {
    try {
      localStorage.setItem(TTS_ENABLED_KEY, String(enabled));
    } catch {
      // ignore
    }
  }, [enabled]);

  const stop = useCallback(() => {
    if (supported) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      if (!supported || !enabled || !text.trim()) return;

      // Cancel any ongoing speech first
      window.speechSynthesis.cancel();

      const clean = stripMarkdown(text);
      if (!clean) return;

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.1;
      utterance.pitch = 1.0;

      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);

      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [supported, enabled],
  );

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) {
        // Turning off — cancel in-flight speech
        window.speechSynthesis?.cancel();
        setIsSpeaking(false);
      }
      return !prev;
    });
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, []);

  return { supported, enabled, isSpeaking, speak, stop, toggle };
}
