import { create } from "zustand";

export interface ChoreProposal {
  choreId: string;
  helperId: string;
  helperName: string;
  ruleIds: string[];
  proposedAt: number;
}

interface ProposalsStoreState {
  byChoreId: Record<string, ChoreProposal>;
  setProposal: (p: ChoreProposal) => void;
  clearProposal: (choreId: string) => void;
  getProposal: (choreId: string) => ChoreProposal | undefined;
  clearAll: () => void;
}

/**
 * Ephemeral client-side store of one_tap assignment proposals. Populated by
 * autoAssignIfSilent when a (predicate, helper) pair is in one_tap mode.
 * The chore card reads this to render a "Proposed: {helper}" chip with
 * Confirm/Change actions. Cleared when the user acts on the proposal or
 * the page reloads.
 */
export const useProposalsStore = create<ProposalsStoreState>((set, get) => ({
  byChoreId: {},
  setProposal: (p) => {
    set((state) => ({
      byChoreId: { ...state.byChoreId, [p.choreId]: p },
    }));
  },
  clearProposal: (choreId) => {
    set((state) => {
      const next = { ...state.byChoreId };
      delete next[choreId];
      return { byChoreId: next };
    });
  },
  getProposal: (choreId) => get().byChoreId[choreId],
  clearAll: () => set({ byChoreId: {} }),
}));
