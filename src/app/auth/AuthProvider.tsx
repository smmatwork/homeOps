import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../services/supabaseClient";

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  accessToken: string;
  householdId: string;
  lastError: string;
  refreshHouseholdId: () => Promise<void>;
  bootstrapHousehold: (params?: { fullName?: string; householdName?: string }) => Promise<{ ok: true; householdId: string } | { ok: false; error: string }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function setLocalStorageSafe(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function getLocalStorageSafe(key: string): string {
  try {
    return (localStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [householdId, setHouseholdId] = useState<string>(() => getLocalStorageSafe("homeops.agent.household_id"));
  const [lastError, setLastError] = useState<string>("");

  const autoBootstrapAttemptRef = useRef<string>("");

  const accessToken = session?.access_token ?? "";
  const user = session?.user ?? null;

  const refreshHouseholdId = useCallback(async () => {
    if (!user) return;

    const { data, error } = await supabase
      .from("household_members")
      .select("household_id")
      .eq("user_id", user.id)
      .limit(1);

    if (error) {
      const msg = error?.message ? String(error.message) : "";
      setLastError(
        `We couldn't load your home details right now. Please try again.${msg ? ` (${msg})` : ""}`,
      );
      return;
    }
    const next = data?.[0]?.household_id ? String(data[0].household_id) : "";
    if (next) {
      setHouseholdId(next);
      setLocalStorageSafe("homeops.agent.household_id", next);
      setLastError("");
      return;
    }

    setHouseholdId("");
    try {
      localStorage.removeItem("homeops.agent.household_id");
    } catch {
      // ignore
    }
    setLastError("Your account is logged in, but your home is not set up yet. Click 'Set up my home' to create/link your household.");
  }, [user]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    setHouseholdId("");
    try {
      localStorage.removeItem("homeops.agent.access_token");
      localStorage.removeItem("homeops.agent.household_id");
    } catch {
      // ignore
    }
  }, []);

  const bootstrapHousehold = useCallback(
    async (params?: { fullName?: string; householdName?: string }) => {
      const token = accessToken.trim();
      if (!token) return { ok: false as const, error: "Please log in to continue." };

      const baseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim().replace(/\/$/, "");
      if (!baseUrl) return { ok: false as const, error: "App setup is incomplete (missing server URL)." };

      const fullName = typeof params?.fullName === "string" ? params.fullName.trim() : "";
      const householdName = typeof params?.householdName === "string" ? params.householdName.trim() : "";

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/functions/v1/server/auth/bootstrap`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            full_name: fullName,
            household_name: householdName,
          }),
        });
      } catch (e) {
        const msg = "We couldn't reach the server. Please check your internet / local server and try again.";
        setLastError(msg);
        return { ok: false as const, error: msg };
      }

      const text = await res.text().catch(() => "");
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!res.ok) {
        const msg =
          json && typeof json === "object" && (json as { error?: unknown }).error
            ? String((json as { error?: unknown }).error)
            : text || res.statusText;

        if (res.status === 401) {
          const friendly =
            "We couldn't verify your login with the server (401). This usually happens when the app is pointing to a different Supabase project/keys than the server. Please check your .env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) and supabase/functions/.env (SB_URL / SB_SERVICE_ROLE_KEY), then try again.";
          setLastError(friendly);
          return { ok: false as const, error: msg || friendly };
        }

        setLastError("We couldn't set up your home. Please try again.");
        return { ok: false as const, error: msg || "Failed to set up your home" };
      }

      const nextHouseholdId =
        json && typeof json === "object" && typeof (json as { household_id?: unknown }).household_id === "string"
          ? String((json as { household_id?: unknown }).household_id).trim()
          : "";

      if (!nextHouseholdId) {
        const msg = "Setup completed, but we couldn't confirm your home ID. Please try again.";
        setLastError(msg);
        return { ok: false as const, error: msg };
      }

      setHouseholdId(nextHouseholdId);
      setLocalStorageSafe("homeops.agent.household_id", nextHouseholdId);
      setLastError("");
      return { ok: true as const, householdId: nextHouseholdId };
    },
    [accessToken, signOut],
  );

  useEffect(() => {
    let isMounted = true;

    (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!isMounted) return;
      if (error) {
        setLastError(`auth.getSession failed: ${error.message}`);
      }
      setSession(data.session ?? null);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) setLastError("");
    });

    return () => {
      isMounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    setLocalStorageSafe("homeops.agent.access_token", accessToken);
  }, [accessToken]);

  useEffect(() => {
    if (!user) return;
    void refreshHouseholdId();
  }, [user, refreshHouseholdId]);

  useEffect(() => {
    if (!user) {
      autoBootstrapAttemptRef.current = "";
      return;
    }

    if (!accessToken.trim()) return;
    if (householdId.trim()) return;

    const key = user.id;
    if (autoBootstrapAttemptRef.current === key) return;

    autoBootstrapAttemptRef.current = key;

    (async () => {
      try {
        await refreshHouseholdId();
      } catch {
        // ignore
      }

      if (getLocalStorageSafe("homeops.agent.household_id")) return;
      if (householdId.trim()) return;

      const fullName = typeof (user.user_metadata as any)?.full_name === "string" ? String((user.user_metadata as any).full_name) : "";
      const householdName = fullName.trim() ? `${fullName.trim()}'s Home` : "My Home";
      await bootstrapHousehold({ fullName, householdName });
    })();
  }, [user, accessToken, householdId, refreshHouseholdId, bootstrapHousehold]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      accessToken,
      householdId,
      lastError,
      refreshHouseholdId,
      bootstrapHousehold,
      signOut,
    }),
    [session, user, accessToken, householdId, lastError, refreshHouseholdId, bootstrapHousehold, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
