import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { detectOnboardingState } from "../services/onboardingState";

/**
 * Checks if the current user's household setup is complete.
 *
 * If `onboarding_completed_at` is NOT set → redirect to /onboarding (welcome flow).
 * If `onboarding_completed_at` IS set but critical steps are missing
 * (no home profile, no chores) → redirect to /chat?onboarding=true (resume).
 *
 * Skips redirect if already on /onboarding, /chat, /login, /signup, or /h/ pages.
 */
export function useOnboardingGate() {
  const { user, householdId } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!user?.id || checkedRef.current) {
      setLoading(false);
      return;
    }

    // Don't redirect if already on exempt pages
    const path = location.pathname;
    const search = location.search ?? "";
    if (
      path.startsWith("/onboarding") ||
      (path.startsWith("/chat") && search.includes("onboarding=true")) ||
      path.startsWith("/login") ||
      path.startsWith("/signup") ||
      path.startsWith("/h/")
    ) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const timeout = setTimeout(() => {
      if (!cancelled) {
        checkedRef.current = true;
        setLoading(false);
      }
    }, 5000);

    (async () => {
      try {
        const hid = typeof householdId === "string" ? householdId.trim() : "";
        const state = await detectOnboardingState(hid, user.id);
        if (cancelled) return;

        checkedRef.current = true;

        if (!state.isComplete) {
          // Never completed onboarding at all → full welcome flow
          navigate("/onboarding", { replace: true });
        } else {
          // Check if all setup steps are actually complete
          const setupComplete = state.homeProfileExists && state.roomCount > 0
            && state.hasFeatures && state.choreCount > 0 && state.helperCount > 0;
          if (!setupComplete) {
            navigate("/chat?onboarding=true", { replace: true });
          }
        }
      } catch {
        // If queries fail, don't block
      } finally {
        if (!cancelled) {
          setLoading(false);
          clearTimeout(timeout);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [user?.id, householdId, navigate, location.pathname]);

  return { loading };
}
