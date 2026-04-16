import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { fetchUserProfile } from "../services/profileService";

/**
 * Checks if the current user has completed onboarding.
 * If not, redirects to /onboarding.
 * Returns `{ loading: true }` while checking, `{ loading: false }` when done.
 */
export function useOnboardingGate() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!user?.id || checkedRef.current) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    // Safety timeout: never block the app for more than 5 seconds.
    const timeout = setTimeout(() => {
      if (!cancelled) {
        checkedRef.current = true;
        setLoading(false);
      }
    }, 5000);

    (async () => {
      try {
        const { data } = await fetchUserProfile(user.id);
        if (cancelled) return;

        checkedRef.current = true;

        if (!data?.onboarding_completed_at) {
          navigate("/onboarding", { replace: true });
        }
      } catch {
        // If the profile query fails, don't block — let the user through.
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
  }, [user?.id, navigate]);

  return { loading };
}
