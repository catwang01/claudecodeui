import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTTS } from './TTSContext';

export type VoiceStatus = 'idle' | 'listening' | 'processing' | 'speaking';
export type VoiceLang = 'zh-CN' | 'en-US' | 'auto';

const VOICE_LANG_KEY = 'voice-lang';
const SILENCE_MS = 2000;

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

// Minimal SpeechRecognition interfaces (not always present in all TS DOM lib versions)
interface ISpeechRecognitionResult {
  readonly isFinal: boolean;
  [index: number]: { transcript: string };
}
interface ISpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: ISpeechRecognitionResult[];
}
interface ISpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: ISpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

function getSpeechRecognitionClass(): (new () => ISpeechRecognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w['SpeechRecognition'] ?? w['webkitSpeechRecognition'] ?? null) as (new () => ISpeechRecognition) | null;
}

export function VoiceConversationProvider({ children }: { children: ReactNode }) {
  const { isSpeaking } = useTTS();
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [voiceLang, setVoiceLangState] = useState<VoiceLang>(() => {
    try {
      const saved = localStorage.getItem(VOICE_LANG_KEY);
      if (saved === 'zh-CN' || saved === 'en-US' || saved === 'auto') return saved;
    } catch { /* ignore */ }
    return 'zh-CN';
  });

  const submitCallbackRef = useRef<((text: string) => void) | null>(null);
  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const finalTranscriptRef = useRef('');
  const isActiveRef = useRef(false);
  const statusRef = useRef<VoiceStatus>('idle');
  const prevLoadingRef = useRef(false);
  const isSpeakingRef = useRef(isSpeaking);
  const voiceLangRef = useRef(voiceLang);
  const silenceTimerRef = useRef<number | null>(null);

  const supported = Boolean(getSpeechRecognitionClass());

  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { voiceLangRef.current = voiceLang; }, [voiceLang]);

  const setVoiceLang = useCallback((lang: VoiceLang) => {
    setVoiceLangState(lang);
    voiceLangRef.current = lang;
    try { localStorage.setItem(VOICE_LANG_KEY, lang); } catch { /* ignore */ }
  }, []);

  const startListening = useCallback(() => {
    const SR = getSpeechRecognitionClass();
    if (!SR || !isActiveRef.current) return;

    recognitionRef.current?.abort();
    recognitionRef.current = null;

    const recognition = new SR();
    recognition.lang = voiceLangRef.current === 'auto' ? '' : voiceLangRef.current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    finalTranscriptRef.current = '';

    recognition.onresult = (event) => {
      // Reset silence timer on every new result
      if (silenceTimerRef.current !== null) {
        window.clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }

      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (final) {
        finalTranscriptRef.current += final;
      }
      setTranscript(finalTranscriptRef.current + interim);

      // Start silence timer once we have confirmed speech
      if (finalTranscriptRef.current.trim()) {
        silenceTimerRef.current = window.setTimeout(() => {
          silenceTimerRef.current = null;
          recognitionRef.current?.stop();
        }, SILENCE_MS);
      }
    };

    recognition.onend = () => {
      if (silenceTimerRef.current !== null) {
        window.clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }

      if (!isActiveRef.current) return;

      const text = finalTranscriptRef.current.trim();
      if (text && submitCallbackRef.current) {
        submitCallbackRef.current(text);
        setTranscript('');
        setStatus('processing');
        statusRef.current = 'processing';
      } else {
        // No speech detected — restart listening
        setTranscript('');
        if (statusRef.current === 'listening') {
          startListening();
        }
      }
    };

    recognition.onerror = (event) => {
      if (!isActiveRef.current) return;
      if (event.error === 'aborted') return;
      // Restart on any transient error
      setTimeout(() => {
        if (isActiveRef.current && statusRef.current === 'listening') {
          startListening();
        }
      }, 500);
    };

    setStatus('listening');
    statusRef.current = 'listening';
    recognitionRef.current = recognition;
    recognition.start();
  }, []);

  // TTS state transitions
  useEffect(() => {
    const prevSpeaking = isSpeakingRef.current;
    isSpeakingRef.current = isSpeaking;

    if (!isActiveRef.current) return;

    if (isSpeaking && !prevSpeaking) {
      // TTS just started — stop recognition and enter speaking state
      if (statusRef.current !== 'speaking') {
        recognitionRef.current?.abort();
        recognitionRef.current = null;
        setStatus('speaking');
        statusRef.current = 'speaking';
      }
    } else if (!isSpeaking && prevSpeaking) {
      // TTS just finished — go back to listening
      if (statusRef.current === 'speaking') {
        startListening();
      }
    }
  }, [isSpeaking, startListening]);

  const toggle = useCallback(() => {
    if (isActiveRef.current) {
      isActiveRef.current = false;
      setIsActive(false);
      setStatus('idle');
      statusRef.current = 'idle';
      setTranscript('');
      if (silenceTimerRef.current !== null) {
        window.clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    } else {
      isActiveRef.current = true;
      setIsActive(true);
      startListening();
    }
  }, [startListening]);

  const registerSubmitCallback = useCallback((fn: (text: string) => void) => {
    submitCallbackRef.current = fn;
  }, []);

  // When loading finishes and TTS doesn't start, fall back to listening
  const notifyLoadingChange = useCallback(
    (loading: boolean) => {
      const prevLoading = prevLoadingRef.current;
      prevLoadingRef.current = loading;

      if (!loading && prevLoading && isActiveRef.current && statusRef.current === 'processing') {
        // Give TTS 700ms to start; if it doesn't, resume listening
        setTimeout(() => {
          if (isActiveRef.current && statusRef.current === 'processing') {
            startListening();
          }
        }, 700);
      }
    },
    [startListening],
  );

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (silenceTimerRef.current !== null) {
        window.clearTimeout(silenceTimerRef.current);
      }
    };
  }, []);

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
