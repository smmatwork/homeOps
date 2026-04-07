import { RouterProvider } from "react-router";
import { router } from "./routes";
import { AuthProvider } from "./auth/AuthProvider";
import { UiLanguageProvider } from "./i18n";

export default function App() {
  return (
    <AuthProvider>
      <UiLanguageProvider>
        <RouterProvider router={router} />
      </UiLanguageProvider>
    </AuthProvider>
  );
}