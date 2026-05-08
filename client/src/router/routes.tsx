import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "../components/layout/AppLayout";
import { MobileLayout } from "../components/layout/MobileLayout";
import { PagePlaceholder } from "../components/layout/PagePlaceholder";
import { DashboardPage } from "../pages/DashboardPage";
import { GreenhouseSetupPage } from "../pages/GreenhouseSetupPage";
import { IrrigationSetupPage } from "../pages/IrrigationSetupPage";
import { MobileDailyYieldPage } from "../pages/MobileDailyYieldPage";
import { MobileHomePage } from "../pages/MobileHomePage";
import { YieldAnalyticsPage } from "../pages/YieldAnalyticsPage";
import { YieldDataEntryPage } from "../pages/YieldDataEntryPage";
import { VarietiesSetupPage } from "../pages/VarietiesSetupPage";

export const appRouter = createBrowserRouter([
  {
    path: "/",
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
        element: (
          <PagePlaceholder
            title="Irrigation"
            description="Irrigation logs, schedules, and monitoring workflows will be managed here."
          />
        )
      },
      {
        path: "pest-control/operate",
        element: (
          <PagePlaceholder
            title="Pest Control Operate"
            description="Daily pest control operational actions and execution workflows will appear here."
          />
        )
      },
      {
        path: "pest-control/inventory",
        element: (
          <PagePlaceholder
            title="Pest Control Inventory"
            description="Inventory counts, usage records, and replenishment tracking for pest control materials belong here."
          />
        )
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
        element: <Navigate to="/pest-control/operate" replace />
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
        element: (
          <PagePlaceholder
            title="Quality Check"
            description="Quality inspection checkpoints, review notes, and pass/fail statuses will be captured here."
          />
        )
      },
      {
        path: "setup/pest-control",
        element: (
          <PagePlaceholder
            title="Pest Control Setup"
            description="Configuration for pest control categories, defaults, and setup metadata will be managed here."
          />
        )
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
      }
    ]
  },
  {
    path: "/mobile",
    element: <MobileLayout />,
    children: [
      {
        index: true,
        element: <MobileHomePage />
      },
      {
        path: "daily-yield",
        element: <MobileDailyYieldPage />
      }
    ]
  }
]);
