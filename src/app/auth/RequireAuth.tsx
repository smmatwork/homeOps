import { Navigate, useLocation } from "react-router";
import { useAuth } from "./AuthProvider";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const location = useLocation();

  const bypass = String(import.meta.env.VITE_E2E_BYPASS_AUTH ?? "").trim();
  if (bypass === "1" || bypass.toLowerCase() === "true") {
    return <>{children}</>;
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
