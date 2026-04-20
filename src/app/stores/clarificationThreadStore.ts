import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type ClarificationAnswerState = {
  // Backward compat (older builds may have persisted this)
  space?: string;
  spaces?: string[];
  due_at?: string;
};

export type ClarificationThreadSlice = {
  dismissedClarificationKey: string | null;
  answers: ClarificationAnswerState;
  homeProfileVersion: string;
  approvedToolCallKeys: Record<string, boolean>;
};

export type ClarificationStoreState = {
  threads: Record<string, ClarificationThreadSlice>;

  getThread: (threadKey: string) => ClarificationThreadSlice;
  setDismissedClarificationKey: (threadKey: string, key: string | null) => void;
  setAnswer: (threadKey: string, patch: Partial<ClarificationAnswerState>) => void;
  clearAnswers: (threadKey: string) => void;

  setToolCallApproved: (threadKey: string, toolCallKey: string) => void;
  clearApprovedToolCalls: (threadKey: string) => void;
  setHomeProfileVersion: (threadKey: string, version: string) => void;
  resetThread: (threadKey: string) => void;
};

export function buildThreadKey(params: { householdId: string; conversationId: string }): string {
  const hid = params.householdId.trim();
  const cid = params.conversationId.trim();
  return hid && cid ? `${hid}:${cid}` : "";
}

const EMPTY_ANSWERS: ClarificationAnswerState = {};
const EMPTY_SLICE: ClarificationThreadSlice = {
  dismissedClarificationKey: null,
  answers: EMPTY_ANSWERS,
  homeProfileVersion: "",
  approvedToolCallKeys: {},
};

function emptySlice(): ClarificationThreadSlice {
  return EMPTY_SLICE;
}

export const useClarificationStore = create<ClarificationStoreState>()(
  persist(
    (set, get) => ({
      threads: {},

      getThread: (threadKey: string) => {
        const k = threadKey.trim();
        if (!k) return emptySlice();
        return get().threads[k] ?? emptySlice();
      },

      setDismissedClarificationKey: (threadKey: string, key: string | null) => {
        const tk = threadKey.trim();
        if (!tk) return;
        set((prev) => ({
          ...prev,
          threads: {
            ...prev.threads,
            [tk]: {
              ...(prev.threads[tk] ?? emptySlice()),
              dismissedClarificationKey: key && key.trim() ? key.trim() : null,
            },
          },
        }));
      },

      setAnswer: (threadKey: string, patch: Partial<ClarificationAnswerState>) => {
        const tk = threadKey.trim();
        if (!tk) return;
        set((prev) => ({
          ...prev,
          threads: {
            ...prev.threads,
            [tk]: {
              ...(prev.threads[tk] ?? emptySlice()),
              answers: { ...((prev.threads[tk] ?? emptySlice()).answers ?? {}), ...patch },
            },
          },
        }));
      },

      clearAnswers: (threadKey: string) => {
        const tk = threadKey.trim();
        if (!tk) return;
        set((prev) => ({
          ...prev,
          threads: {
            ...prev.threads,
            [tk]: { ...(prev.threads[tk] ?? emptySlice()), answers: {} },
          },
        }));
      },

      setToolCallApproved: (threadKey: string, toolCallKey: string) => {
        const tk = threadKey.trim();
        const k = toolCallKey.trim();
        if (!tk || !k) return;
        set((prev) => ({
          ...prev,
          threads: {
            ...prev.threads,
            [tk]: {
              ...(prev.threads[tk] ?? emptySlice()),
              approvedToolCallKeys: { ...((prev.threads[tk] ?? emptySlice()).approvedToolCallKeys ?? {}), [k]: true },
            },
          },
        }));
      },

      clearApprovedToolCalls: (threadKey: string) => {
        const tk = threadKey.trim();
        if (!tk) return;
        set((prev) => ({
          ...prev,
          threads: {
            ...prev.threads,
            [tk]: { ...(prev.threads[tk] ?? emptySlice()), approvedToolCallKeys: {} },
          },
        }));
      },

      setHomeProfileVersion: (threadKey: string, version: string) => {
        const tk = threadKey.trim();
        if (!tk) return;
        const next = version.trim();
        set((prev) => {
          const current = (prev.threads[tk] ?? emptySlice()).homeProfileVersion.trim();
          if (!current) {
            return {
              ...prev,
              threads: {
                ...prev.threads,
                [tk]: { ...(prev.threads[tk] ?? emptySlice()), homeProfileVersion: next },
              },
            };
          }
          if (current === next) return prev;
          return {
            ...prev,
            threads: {
              ...prev.threads,
              [tk]: { ...(prev.threads[tk] ?? emptySlice()), homeProfileVersion: next, dismissedClarificationKey: null, answers: {}, approvedToolCallKeys: {} },
            },
          };
        });
      },

      resetThread: (threadKey: string) => {
        const tk = threadKey.trim();
        if (!tk) return;
        set((prev) => {
          const next = { ...prev.threads };
          delete next[tk];
          return { ...prev, threads: next };
        });
      },
    }),
    {
      name: "homeops.chat.clarifications.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ threads: s.threads }),
    },
  ),
);
