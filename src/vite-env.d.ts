/// <reference types="vite/client" />

declare module "@sanskrit-coders/sanscript" {
  const Sanscript: {
    t: (input: string, from: string, to: string) => string;
  };
  export default Sanscript;
}
/// <reference types="vite-plugin-svgr/client" />

// ── Vite env variables ────────────────────────────────────────────────────────
interface ImportMetaEnv {
  readonly VITE_SARVAM_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// ── Web Speech API (not yet fully typed in TS DOM lib) ────────────────────────
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

declare class SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
