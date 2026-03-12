/**
 * useSarvamSTT
 * Records audio via MediaRecorder and sends it to Sarvam Saaras v3 STT.
 * Falls back to the Web Speech API when no API key is set.
 */
import { useState, useRef, useCallback } from "react";
import { transcribeAudio } from "../services/sarvamApi";

export type SpeechLang = "en-IN" | "hi-IN" | "kn-IN";

// ─── Web Speech API fallback ──────────────────────────────────────────────────

type WebSR = typeof SpeechRecognition;

function getWebSR(): WebSR | null {
  if (typeof window === "undefined") return null;
  return (
    (window as Window & { SpeechRecognition?: WebSR }).SpeechRecognition ||
    (window as Window & { webkitSpeechRecognition?: WebSR })
      .webkitSpeechRecognition ||
    null
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseSarvamSTTReturn {
  isListening: boolean;
  isTranscribing: boolean;
  toggle: () => void;
  supported: boolean;
  sttMode: "sarvam" | "browser";
}

export function useSarvamSTT(
  lang: SpeechLang,
  onTranscript: (text: string) => void,
  onError?: (msg: string) => void,
): UseSarvamSTTReturn {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const webSRRef = useRef<SpeechRecognition | null>(null);

  // Determine mode: prefer Sarvam if API key present
  const hasKey =
    !!import.meta.env.VITE_SARVAM_API_KEY &&
    import.meta.env.VITE_SARVAM_API_KEY !== "your_sarvam_api_key_here";
  const hasMediaRecorder =
    typeof window !== "undefined" && !!window.MediaRecorder;
  const hasBrowserSR = !!getWebSR();

  const sttMode: "sarvam" | "browser" =
    hasKey && hasMediaRecorder ? "sarvam" : "browser";
  const supported = sttMode === "sarvam" ? hasMediaRecorder : hasBrowserSR;

  // ── Sarvam path ──────────────────────────────────────────────────────────────

  const startSarvam = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/ogg")
        ? "audio/ogg"
        : MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop all tracks to release the mic
        stream.getTracks().forEach((t) => t.stop());
        setIsListening(false);

        const uploadMimeType = mimeType.split(";")[0] ?? mimeType;
        const blob = new Blob(chunksRef.current, { type: uploadMimeType });
        if (blob.size < 1000) {
          onError?.("I couldn't hear anything. Please try again and speak for 2–3 seconds.");
          return;
        }

        setIsTranscribing(true);
        try {
          const transcript = await transcribeAudio(blob, lang);
          if (transcript) onTranscript(transcript);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "STT error";
          onError?.(msg);
        } finally {
          setIsTranscribing(false);
        }
      };

      // Use a timeslice so we reliably receive chunks before stop()
      recorder.start(250);
      setIsListening(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Microphone access denied";
      onError?.(msg);
    }
  }, [lang, onTranscript, onError]);

  const stopSarvam = useCallback(() => {
    const r = mediaRecorderRef.current;
    if (!r) return;
    try {
      // Flush any buffered audio before stopping
      if (typeof r.requestData === "function") r.requestData();
    } catch {
      // ignore
    }
    r.stop();
  }, []);

  // ── Browser Web Speech API path ───────────────────────────────────────────────

  const startBrowser = useCallback(() => {
    const SR = getWebSR();
    if (!SR) return;
    const r = new SR();
    r.lang = lang;
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e: SpeechRecognitionEvent) => {
      const t = Array.from(e.results)
        .map((res) => res[0].transcript)
        .join("");
      onTranscript(t);
    };
    r.onend = () => setIsListening(false);
    r.onerror = () => setIsListening(false);
    r.start();
    webSRRef.current = r;
    setIsListening(true);
  }, [lang, onTranscript]);

  const stopBrowser = useCallback(() => {
    webSRRef.current?.stop();
    setIsListening(false);
  }, []);

  // ── Toggle ────────────────────────────────────────────────────────────────────

  const toggle = useCallback(() => {
    if (isListening) {
      if (sttMode === "sarvam") stopSarvam();
      else stopBrowser();
    } else {
      if (sttMode === "sarvam") startSarvam();
      else startBrowser();
    }
  }, [isListening, sttMode, startSarvam, stopSarvam, startBrowser, stopBrowser]);

  return { isListening, isTranscribing, toggle, supported, sttMode };
}
