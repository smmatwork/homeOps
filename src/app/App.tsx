import { RouterProvider } from "react-router";
import { useEffect } from "react";
import { router } from "./routes";
import { AuthProvider } from "./auth/AuthProvider";
import { UiLanguageProvider } from "./i18n";
import { initializePerformanceMonitoring } from "@/utils/performance";

export default function App() {
  useEffect(() => {
    // Initialize performance monitoring
    initializePerformanceMonitoring();
  }, []);

  return (
    <AuthProvider>
      <UiLanguageProvider>
        <RouterProvider router={router} />
      </UiLanguageProvider>
    </AuthProvider>
  );
}