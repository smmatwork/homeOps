import { useState, useCallback, useMemo } from 'react';
import type { ToolCall } from '../../../services/agentActions';

export interface ToolCallState {
  toolBusy: boolean;
  toolError: string | null;
  toolSuccess: string | null;
  pendingToolCalls: ToolCall[];
  approvedToolCallKeys: Record<string, boolean>;
  toolCallOverridesByKey: Record<string, ToolCall>;
  autoExecutedToolCallIds: Record<string, boolean>;
  ambiguousIntents: string[]; // Multiple possible intents detected
  rejectedIntents: Record<string, string>; // Key=intent, value=reason
}

export interface ToolCallActions {
  setToolBusy: (busy: boolean) => void;
  setToolError: (error: string | null) => void;
  setToolSuccess: (success: string | null) => void;
  setPendingToolCalls: (calls: ToolCall[]) => void;
  addPendingToolCall: (call: ToolCall) => void;
  removePendingToolCall: (callId: string) => void;
  approveToolCall: (key: string) => void;
  setToolCallOverride: (key: string, call: ToolCall) => void;
  markAutoExecuted: (callId: string) => void;
  clearToolState: () => void;
  setAmbiguousIntents: (intents: string[]) => void;
  setRejectedIntents: (intents: Record<string, string>) => void;
}

export function useToolCalls(): [ToolCallState, ToolCallActions] {
  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolSuccess, setToolSuccess] = useState<string | null>(null);
  const [pendingToolCalls, setPendingToolCalls] = useState<ToolCall[]>([]);
  const [approvedToolCallKeys, setApprovedToolCallKeys] = useState<Record<string, boolean>>({});
  const [toolCallOverridesByKey, setToolCallOverridesByKey] = useState<Record<string, ToolCall>>({});
  const [autoExecutedToolCallIds, setAutoExecutedToolCallIds] = useState<Record<string, boolean>>({});
  const [ambiguousIntents, setAmbiguousIntents] = useState<string[]>([]);
  const [rejectedIntents, setRejectedIntents] = useState<Record<string, string>>({});

  const addPendingToolCall = useCallback((call: ToolCall) => {
    setPendingToolCalls(prev => [...prev, call]);
  }, []);

  const removePendingToolCall = useCallback((callId: string) => {
    setPendingToolCalls(prev => prev.filter(call => call.id !== callId));
  }, []);

  const approveToolCall = useCallback((key: string) => {
    setApprovedToolCallKeys(prev => ({ ...prev, [key]: true }));
  }, []);

  const setToolCallOverride = useCallback((key: string, call: ToolCall) => {
    setToolCallOverridesByKey(prev => ({ ...prev, [key]: call }));
  }, []);

  const markAutoExecuted = useCallback((callId: string) => {
    setAutoExecutedToolCallIds(prev => ({ ...prev, [callId]: true }));
  }, []);

  const clearToolState = useCallback(() => {
    setToolBusy(false);
    setToolError(null);
    setToolSuccess(null);
    setPendingToolCalls([]);
    setApprovedToolCallKeys({});
    setToolCallOverridesByKey({});
    setAutoExecutedToolCallIds({});
  }, []);

  const state: ToolCallState = useMemo(() => ({
    toolBusy,
    toolError,
    toolSuccess,
    pendingToolCalls,
    approvedToolCallKeys,
    toolCallOverridesByKey,
    autoExecutedToolCallIds,
    ambiguousIntents,
    rejectedIntents,
  }), [
    toolBusy,
    toolError,
    toolSuccess,
    pendingToolCalls,
    approvedToolCallKeys,
    toolCallOverridesByKey,
    autoExecutedToolCallIds,
    ambiguousIntents,
    rejectedIntents,
  ]);

  const actions: ToolCallActions = useMemo(() => ({
    setToolBusy,
    setToolError,
    setToolSuccess,
    setPendingToolCalls,
    addPendingToolCall,
    removePendingToolCall,
    approveToolCall,
    setToolCallOverride,
    markAutoExecuted,
    clearToolState,
    setAmbiguousIntents,
    setRejectedIntents,
  }), [
    addPendingToolCall,
    removePendingToolCall,
    approveToolCall,
    setToolCallOverride,
    markAutoExecuted,
    clearToolState,
  ]);

  return [state, actions];
}