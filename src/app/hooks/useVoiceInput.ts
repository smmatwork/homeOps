import { useState, useRef, useCallback } from "react";

export type SpeechLang = "en-IN" | "hi-IN" | "kn-IN";

const getSR = (): typeof SpeechRecognition | null => {
  if (typeof window === "undefined") return null;
  return (
    (window as Window & { SpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
    (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition ||
    null
  );
};

export function useVoiceInput(lang: SpeechLang, onTranscript: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const recRef = useRef<SpeechRecognition | null>(null);

  const start = useCallback(() => {
    const SR = getSR();
    if (!SR) return;
    const r = new SR();
    r.lang = lang;
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = Array.from(e.results)
        .map((res) => res[0].transcript)
        .join("");
      onTranscript(transcript);
    };
    r.onend = () => setIsListening(false);
    r.onerror = () => setIsListening(false);
    r.start();
    recRef.current = r;
    setIsListening(true);
  }, [lang, onTranscript]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setIsListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (isListening) stop();
    else start();
  }, [isListening, start, stop]);

  return { isListening, toggle, supported: !!getSR() };
}
