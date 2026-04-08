import { createBrowserRouter } from "react-router";
import { lazy, Suspense } from "react";
import { MainLayout } from "./components/layouts/MainLayout";
import { RequireAuth } from "./auth/RequireAuth";

// Lazy load components for code splitting
const Dashboard = lazy(() => import("./components/dashboard/Dashboard").then(m => ({ default: m.Dashboard })));
const Chores = lazy(() => import("./components/chores/Chores").then(m => ({ default: m.Chores })));
const Recipes = lazy(() => import("./components/recipes/Recipes").then(m => ({ default: m.Recipes })));
const Helpers = lazy(() => import("./components/helpers/Helpers").then(m => ({ default: m.Helpers })));
const Alerts = lazy(() => import("./components/alerts/Alerts").then(m => ({ default: m.Alerts })));
const AdminConfig = lazy(() => import("./components/admin/AdminConfig").then(m => ({ default: m.AdminConfig })));
const ChatInterface = lazy(() => import("./components/chat/ChatInterface").then(m => ({ default: m.ChatInterface })));
const Automations = lazy(() => import("./components/automations/Automations").then(m => ({ default: m.Automations })));
const TaskStatus = lazy(() => import("./components/tasks/TaskStatus").then(m => ({ default: m.TaskStatus })));
const OwnerAnalytics = lazy(() => import("./components/owner/OwnerAnalytics").then(m => ({ default: m.OwnerAnalytics })));
const SupportPanel = lazy(() => import("./components/support/SupportPanel").then(m => ({ default: m.SupportPanel })));
const AcceptInvite = lazy(() => import("./components/invites/AcceptInvite").then(m => ({ default: m.AcceptInvite })));
const Signals = lazy(() => import("./components/signals/Signals").then(m => ({ default: m.Signals })));
const TestsDashboard = lazy(() => import("./components/tests/TestsDashboard").then(m => ({ default: m.TestsDashboard })));

// Auth components - keep these eagerly loaded as they're needed immediately
import { Login } from "./components/auth/Login";
import { Signup } from "./components/auth/Signup";
import { NotFound } from "./components/NotFound";

// Loading component for suspense fallback
const PageLoader = () => (
  <div style={{
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '200px',
    fontSize: '16px',
    color: '#666'
  }}>
    Loading...
  </div>
);

// Wrapper component for lazy-loaded routes
const LazyWrapper = ({ children }: { children: React.ReactNode }) => (
  <Suspense fallback={<PageLoader />}>
    {children}
  </Suspense>
);

export const router = createBrowserRouter([
  {
    path: "/tests",
    Component: () => (
      <LazyWrapper>
        <TestsDashboard />
      </LazyWrapper>
    ),
  },
  {
    path: "/",
    Component: () => (
      <RequireAuth>
        <MainLayout />
      </RequireAuth>
    ),
    children: [
      {
        index: true,
        Component: () => (
          <LazyWrapper>
            <Dashboard />
          </LazyWrapper>
        )
      },
      {
        path: "chores",
        Component: () => (
          <LazyWrapper>
            <Chores />
          </LazyWrapper>
        )
      },
      {
        path: "recipes",
        Component: () => (
          <LazyWrapper>
            <Recipes />
          </LazyWrapper>
        )
      },
      {
        path: "helpers",
        Component: () => (
          <LazyWrapper>
            <Helpers />
          </LazyWrapper>
        )
      },
      {
        path: "alerts",
        Component: () => (
          <LazyWrapper>
            <Alerts />
          </LazyWrapper>
        )
      },
      {
        path: "automations",
        Component: () => (
          <LazyWrapper>
            <Automations />
          </LazyWrapper>
        )
      },
      {
        path: "signals",
        Component: () => (
          <LazyWrapper>
            <Signals />
          </LazyWrapper>
        )
      },
      {
        path: "admin",
        Component: () => (
          <LazyWrapper>
            <AdminConfig />
          </LazyWrapper>
        )
      },
      {
        path: "invite",
        Component: () => (
          <LazyWrapper>
            <AcceptInvite />
          </LazyWrapper>
        )
      },
      {
        path: "chat",
        Component: () => (
          <LazyWrapper>
            <ChatInterface />
          </LazyWrapper>
        )
      },
      {
        path: "status",
        Component: () => (
          <LazyWrapper>
            <TaskStatus />
          </LazyWrapper>
        )
      },
      {
        path: "analytics",
        Component: () => (
          <LazyWrapper>
            <OwnerAnalytics />
          </LazyWrapper>
        )
      },
      {
        path: "support",
        Component: () => (
          <LazyWrapper>
            <SupportPanel />
          </LazyWrapper>
        )
      },
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
