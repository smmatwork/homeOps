import { useState, useCallback, useRef } from "react";
import { useAuth } from "../auth/AuthProvider";
import { syncChoreSchedule, type SyncResult } from "../services/choreEngine";
import type { SyncOptions } from "../services/choreEngine";

const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes

export function useSyncSchedule() {
  const { householdId, accessToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSyncRef = useRef<number>(0);

  const sync = useCallback(
    async (options: SyncOptions = { mode: "confirm" }) => {
      if (!householdId || !accessToken) {
        setError("Missing session. Please log in.");
        return null;
      }

      // Debounce: skip if synced recently (unless manual trigger).
      if (options.trigger !== "manual" && Date.now() - lastSyncRef.current < DEBOUNCE_MS) {
        return result;
      }

      setBusy(true);
      setError(null);

      const syncResult = await syncChoreSchedule(householdId, accessToken, options);
      lastSyncRef.current = Date.now();

      setBusy(false);

      if (syncResult.errors.length > 0) {
        setError(syncResult.errors.join("; "));
      }

      setResult(syncResult);
      return syncResult;
    },
    [householdId, accessToken, result],
  );

  const clearResult = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { sync, busy, result, error, clearResult };
}
