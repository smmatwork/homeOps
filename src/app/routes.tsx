import { createBrowserRouter } from "react-router";
import { MainLayout } from "./components/layouts/MainLayout";
import { Login } from "./components/auth/Login";
import { Signup } from "./components/auth/Signup";
import { RequireAuth } from "./auth/RequireAuth";
import { Dashboard } from "./components/dashboard/Dashboard";
import { Chores } from "./components/chores/Chores";
import { Recipes } from "./components/recipes/Recipes";
import { Helpers } from "./components/helpers/Helpers";
import { Alerts } from "./components/alerts/Alerts";
import { AdminConfig } from "./components/admin/AdminConfig";
import { ChatInterface } from "./components/chat/ChatInterface";
import { TaskStatus } from "./components/tasks/TaskStatus";
import { OwnerAnalytics } from "./components/owner/OwnerAnalytics";
import { SupportPanel } from "./components/support/SupportPanel";
import { NotFound } from "./components/NotFound";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: () => (
      <RequireAuth>
        <MainLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, Component: Dashboard },
      { path: "chores", Component: Chores },
      { path: "recipes", Component: Recipes },
      { path: "helpers", Component: Helpers },
      { path: "alerts", Component: Alerts },
      { path: "admin", Component: AdminConfig },
      { path: "chat", Component: ChatInterface },
      { path: "status", Component: TaskStatus },
      { path: "analytics", Component: OwnerAnalytics },
      { path: "support", Component: SupportPanel },
    ],
  },
  {
    path: "/login",
    Component: Login,
  },
  {
    path: "/signup",
    Component: Signup,
  },
  {
    path: "*",
    Component: NotFound,
  },
]);
