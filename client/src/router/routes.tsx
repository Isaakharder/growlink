import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "../components/layout/AppLayout";
import { MobileLayout } from "../components/layout/MobileLayout";
import { PagePlaceholder } from "../components/layout/PagePlaceholder";
import { RequireAuth } from "../components/auth/RequireAuth";
import { DashboardPage } from "../pages/DashboardPage";
import { GreenhouseSetupPage } from "../pages/GreenhouseSetupPage";
import { IrrigationPage } from "../pages/IrrigationPage";
import { IrrigationSetupPage } from "../pages/IrrigationSetupPage";
import { MobileDailyYieldPage } from "../pages/MobileDailyYieldPage";
import { MobileHomePage } from "../pages/MobileHomePage";
import { MobileIrrigationLogPage } from "../pages/MobileIrrigationLogPage";
import { MobilePestLogPage } from "../pages/MobilePestLogPage";
import { YieldAnalyticsPage } from "../pages/YieldAnalyticsPage";
import { YieldDataEntryPage } from "../pages/YieldDataEntryPage";
import { PestControlSetupPage } from "../pages/PestControlSetupPage";
import { PestInventoryPage } from "../pages/PestInventoryPage";
import { PestPlannerPage } from "../pages/PestPlannerPage";
import { QualityCheckPage } from "../pages/QualityCheckPage";
import { MobileQualityCheckPage } from "../pages/MobileQualityCheckPage";
import { VarietiesSetupPage } from "../pages/VarietiesSetupPage";
import { AdminOrganizationsPage } from "../pages/AdminOrganizationsPage";
import { LoginPage } from "../pages/LoginPage";
import { SetPasswordPage } from "../pages/SetPasswordPage";

export const appRouter = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />
  },
  {
    path: "/set-password",
    element: <SetPasswordPage />
  },
  {
    path: "/",
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          {
            index: true,
            element: <DashboardPage />
          },
          {
            path: "yield/data-entry",
            element: <YieldDataEntryPage />
          },
          {
            path: "yield/analytics",
            element: <YieldAnalyticsPage />
          },
          {
            path: "yield",
            element: <Navigate to="/yield/data-entry" replace />
          },
          {
            path: "irrigation",
            element: <IrrigationPage />
          },
          {
            path: "pest-control/planner",
            element: <PestPlannerPage />
          },
          {
            path: "pest-control/operate",
            element: <Navigate to="/pest-control/planner" replace />
          },
          {
            path: "pest-control/inventory",
            element: <PestInventoryPage />
          },
          {
            path: "pest-control/records",
            element: (
              <PagePlaceholder
                title="Pest Control Records"
                description="Historical pest control records and compliance-ready logs will be organized in this area."
              />
            )
          },
          {
            path: "pest-control",
            element: <Navigate to="/pest-control/planner" replace />
          },
          {
            path: "daily-yield",
            element: (
              <PagePlaceholder
                title="Daily Yield"
                description="Day-by-day yield summaries and routine harvest snapshots will be available in this page."
              />
            )
          },
          {
            path: "quality-check",
            element: <QualityCheckPage />
          },
          {
            path: "setup/pest-control",
            element: <PestControlSetupPage />
          },
          {
            path: "setup/greenhouse",
            element: <GreenhouseSetupPage />
          },
          {
            path: "setup/irrigation",
            element: <IrrigationSetupPage />
          },
          {
            path: "setup/varieties",
            element: <VarietiesSetupPage />
          },
          {
            path: "setup/settings",
            element: (
              <PagePlaceholder
                title="Settings"
                description="Platform-level settings and global application preferences will be organized here."
              />
            )
          },
          {
            path: "setup",
            element: <Navigate to="/setup/pest-control" replace />
          },
          {
            path: "admin/organizations",
            element: <AdminOrganizationsPage />
          }
        ]
      }
    ]
  },
  {
    path: "/mobile",
    element: <RequireAuth />,
    children: [
      {
        element: <MobileLayout />,
        children: [
          {
            index: true,
            element: <MobileHomePage />
          },
          {
            path: "daily-yield",
            element: <MobileDailyYieldPage />
          },
          {
            path: "irrigation-log",
            element: <MobileIrrigationLogPage />
          },
          {
            path: "pest-log",
            element: <MobilePestLogPage />
          },
          {
            path: "quality-check",
            element: <MobileQualityCheckPage />
          }
        ]
      }
    ]
  }
]);
