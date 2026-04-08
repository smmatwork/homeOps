import { useState, useCallback, useRef } from 'react';
import type { SpeechLang } from '@/hooks/useSarvamSTT';

export interface ChatState {
  input: string;
  lang: SpeechLang;
  sttError: string | null;
  agentAccessToken: string;
  agentHouseholdId: string;
  agentDialogOpen: boolean;
  coverageExperimentOpen: boolean;
  agentBusy: boolean;
  agentError: string | null;
  agentSuccess: string | null;
}

export interface ChatActions {
  setInput: (input: string) => void;
  setLang: (lang: SpeechLang) => void;
  setSttError: (error: string | null) => void;
  setAgentAccessToken: (token: string) => void;
  setAgentHouseholdId: (id: string) => void;
  setAgentDialogOpen: (open: boolean) => void;
  setCoverageExperimentOpen: (open: boolean) => void;
  setAgentBusy: (busy: boolean) => void;
  setAgentError: (error: string | null) => void;
  setAgentSuccess: (success: string | null) => void;
  clearInput: () => void;
  appendToInput: (text: string) => void;
}

export function useChatState(): [ChatState, ChatActions] {
  const [input, setInput] = useState('');
  const [lang, setLang] = useState<SpeechLang>('en-IN');
  const [sttError, setSttError] = useState<string | null>(null);
  const [agentAccessToken, setAgentAccessToken] = useState('');
  const [agentHouseholdId, setAgentHouseholdId] = useState('');
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [coverageExperimentOpen, setCoverageExperimentOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentSuccess, setAgentSuccess] = useState<string | null>(null);

  const clearInput = useCallback(() => setInput(''), []);
  
  const appendToInput = useCallback((text: string) => {
    setInput(prev => prev ? `${prev} ${text}` : text);
  }, []);

  const state: ChatState = {
    input,
    lang,
    sttError,
    agentAccessToken,
    agentHouseholdId,
    agentDialogOpen,
    coverageExperimentOpen,
    agentBusy,
    agentError,
    agentSuccess,
  };

  const actions: ChatActions = {
    setInput,
    setLang,
    setSttError,
    setAgentAccessToken,
    setAgentHouseholdId,
    setAgentDialogOpen,
    setCoverageExperimentOpen,
    setAgentBusy,
    setAgentError,
    setAgentSuccess,
    clearInput,
    appendToInput,
  };

  return [state, actions];
}