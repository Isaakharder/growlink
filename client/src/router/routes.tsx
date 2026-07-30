import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "../components/layout/AppLayout";
import { MobileLayout } from "../components/layout/MobileLayout";
import { RequireAuth } from "../components/auth/RequireAuth";
import { RequirePermission } from "../components/auth/RequirePermission";
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
import { DailyYieldSamplesPage } from "../pages/DailyYieldSamplesPage";
import { PestControlSetupPage } from "../pages/PestControlSetupPage";
import { PestInventoryPage } from "../pages/PestInventoryPage";
import { PestControlRecordsPage } from "../pages/PestControlRecordsPage";
import { PestControlCalibrationPage } from "../pages/PestControlCalibrationPage";
import { PestPlannerPage } from "../pages/PestPlannerPage";
import { QualityCheckPage } from "../pages/QualityCheckPage";
import { MobileQualityCheckPage } from "../pages/MobileQualityCheckPage";
import { VarietiesSetupPage } from "../pages/VarietiesSetupPage";
import { FoodSafetySetupPage } from "../pages/FoodSafetySetupPage";
import { AdminDocklinkIntegrationsPage } from "../pages/AdminDocklinkIntegrationsPage";
import { AdminGrowlinkAgentPage } from "../pages/AdminGrowlinkAgentPage";
import { AdminIntegrationsPage } from "../pages/AdminIntegrationsPage";
import { ImportTemplateMappingPage } from "../pages/ImportTemplateMappingPage";
import { AdminOrganizationsPage } from "../pages/AdminOrganizationsPage";
import { PlatformCustomersPage } from "../pages/PlatformCustomersPage";
import { AcceptInvitePage } from "../pages/AcceptInvitePage";
import { NoAccessPage } from "../pages/NoAccessPage";
import { SettingsPage } from "../pages/SettingsPage";
import { LoginPage } from "../pages/LoginPage";
import { SetPasswordPage } from "../pages/SetPasswordPage";
import { PayrollPage } from "../pages/PayrollPage";
import { MobilePayrollPage } from "../pages/MobilePayrollPage";
import { FoodSafetyPage } from "../pages/FoodSafetyPage";
import { FoodSafetyLocationsPage } from "../pages/FoodSafetyLocationsPage";
import { FoodSafetyReportsPage } from "../pages/FoodSafetyReportsPage";
import { FoodSafetyLocationReportPage } from "../pages/foodSafetyReports/FoodSafetyLocationReportPage";
import { MobileFoodSafetyPage } from "../pages/MobileFoodSafetyPage";
import { MobileFoodSafetyLocationPage } from "../pages/MobileFoodSafetyLocationPage";
import { MobilePestCalibrationPage } from "../pages/MobilePestCalibrationPage";
import { MobilePestCalibrationDeviceCompletePage } from "../pages/MobilePestCalibrationDeviceCompletePage";

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
    path: "/invite/accept",
    element: <AcceptInvitePage />
  },
  {
    path: "/",
    element: <RequireAuth />,
    children: [
      // No-access page: auth-protected but rendered without any layout shell.
      {
        path: "no-access",
        element: <NoAccessPage />
      },
      {
        element: <AppLayout />,
        children: [
          // Dashboard — accessible to all authenticated org members
          {
            index: true,
            element: <DashboardPage />
          },

          // Yield — requires yield:view
          {
            path: "yield/data-entry",
            element: (
              <RequirePermission permission="yield:view">
                <YieldDataEntryPage />
              </RequirePermission>
            )
          },
          {
            path: "yield/analytics",
            element: (
              <RequirePermission permission="yield:view">
                <YieldAnalyticsPage />
              </RequirePermission>
            )
          },
          {
            path: "yield/daily-yield-samples",
            element: (
              <RequirePermission permission="yield:view">
                <DailyYieldSamplesPage />
              </RequirePermission>
            )
          },
          {
            path: "yield",
            element: <Navigate to="/yield/data-entry" replace />
          },

          // Irrigation — requires irrigation:view
          {
            path: "irrigation",
            element: (
              <RequirePermission permission="irrigation:view">
                <IrrigationPage />
              </RequirePermission>
            )
          },

          // Pest Control — requires pest:view
          {
            path: "pest-control/planner",
            element: (
              <RequirePermission permission="pest:view">
                <PestPlannerPage />
              </RequirePermission>
            )
          },
          {
            path: "pest-control/operate",
            element: <Navigate to="/pest-control/planner" replace />
          },
          {
            path: "pest-control/inventory",
            element: (
              <RequirePermission permission="pest:view">
                <PestInventoryPage />
              </RequirePermission>
            )
          },
          {
            path: "pest-control/records",
            element: (
              <RequirePermission permission="pest:view">
                <PestControlRecordsPage />
              </RequirePermission>
            )
          },
          {
            path: "pest-control/calibration",
            element: (
              <RequirePermission permission="calibration:view">
                <PestControlCalibrationPage />
              </RequirePermission>
            )
          },
          {
            path: "pest-control",
            element: <Navigate to="/pest-control/planner" replace />
          },

          // Quality Check — requires quality:view
          {
            path: "quality-check",
            element: (
              <RequirePermission permission="quality:view">
                <QualityCheckPage />
              </RequirePermission>
            )
          },

          // Setup — each sub-route has its own permission requirement
          {
            path: "setup/pest-control",
            element: (
              <RequirePermission permission="pest:view">
                <PestControlSetupPage />
              </RequirePermission>
            )
          },
          {
            path: "setup/greenhouse",
            element: (
              <RequirePermission permission="greenhouse_setup:view">
                <GreenhouseSetupPage />
              </RequirePermission>
            )
          },
          {
            path: "setup/irrigation",
            element: (
              <RequirePermission permission="irrigation:view">
                <IrrigationSetupPage />
              </RequirePermission>
            )
          },
          {
            path: "setup/varieties",
            element: (
              <RequirePermission permission="greenhouse_setup:view">
                <VarietiesSetupPage />
              </RequirePermission>
            )
          },
          {
            path: "setup/food-safety",
            element: (
              <RequirePermission permission="food_safety:view">
                <FoodSafetySetupPage />
              </RequirePermission>
            )
          },
          // Settings — visible to all org members; invite section self-guards via API
          {
            path: "setup/settings",
            element: <SettingsPage />
          },
          {
            path: "setup",
            element: <Navigate to="/setup/pest-control" replace />
          },

          // Admin — backend enforces admin-only; routes stay accessible for the links to work
          {
            path: "admin/organizations",
            element: <AdminOrganizationsPage />
          },
          {
            path: "admin/customers",
            element: <PlatformCustomersPage />
          },
          {
            path: "admin/docklink",
            element: <AdminDocklinkIntegrationsPage />
          },
          {
            path: "admin/growlink-agent",
            element: <AdminGrowlinkAgentPage />
          },
          {
            path: "admin/integrations",
            element: <AdminIntegrationsPage />
          },
          {
            path: "admin/import-templates/:uploadKeyId",
            element: <ImportTemplateMappingPage />
          },

          // Payroll — requires payroll:view
          {
            path: "payroll",
            element: (
              <RequirePermission permission="payroll:view">
                <PayrollPage />
              </RequirePermission>
            )
          },

          // Food Safety — requires food_safety:view
          {
            path: "food-safety",
            element: (
              <RequirePermission permission="food_safety:view">
                <FoodSafetyPage />
              </RequirePermission>
            )
          },
          {
            path: "food-safety/locations",
            element: (
              <RequirePermission permission="food_safety:view">
                <FoodSafetyLocationsPage />
              </RequirePermission>
            )
          },
          {
            path: "food-safety/reports",
            element: (
              <RequirePermission permission="food_safety:view">
                <FoodSafetyReportsPage />
              </RequirePermission>
            )
          },
          {
            path: "food-safety/reports/:locationId",
            element: (
              <RequirePermission permission="food_safety:view">
                <FoodSafetyLocationReportPage />
              </RequirePermission>
            )
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
        // MobileLayout provides MembershipProvider and guards mobile:access
        // for every child route. Individual pages add finer-grained guards.
        element: <MobileLayout />,
        children: [
          {
            index: true,
            element: <MobileHomePage />
          },
          {
            path: "food-safety",
            element: (
              <RequirePermission permission="mobile:food_safety">
                <MobileFoodSafetyPage />
              </RequirePermission>
            )
          },
          {
            path: "food-safety/:locationId",
            element: (
              <RequirePermission permission="mobile:food_safety">
                <MobileFoodSafetyLocationPage />
              </RequirePermission>
            )
          },
          {
            path: "daily-yield",
            element: (
              <RequirePermission permission="mobile:daily_yield">
                <MobileDailyYieldPage />
              </RequirePermission>
            )
          },
          {
            path: "irrigation-log",
            element: (
              <RequirePermission permission={["mobile:irrigation", "irrigation:view", "irrigation:edit"]}>
                <MobileIrrigationLogPage />
              </RequirePermission>
            )
          },
          {
            path: "pest-log",
            element: (
              <RequirePermission permission="mobile:pest">
                <MobilePestLogPage />
              </RequirePermission>
            )
          },
          {
            path: "quality-check",
            element: (
              <RequirePermission permission="mobile:quality">
                <MobileQualityCheckPage />
              </RequirePermission>
            )
          },
          {
            path: "payroll",
            element: (
              <RequirePermission permission="mobile:payroll">
                <MobilePayrollPage />
              </RequirePermission>
            )
          },
          {
            path: "calibration",
            element: (
              <RequirePermission permission="mobile:calibration">
                <MobilePestCalibrationPage />
              </RequirePermission>
            )
          },
          {
            path: "calibration/:deviceId",
            element: (
              <RequirePermission permission="mobile:calibration">
                <MobilePestCalibrationDeviceCompletePage />
              </RequirePermission>
            )
          }
        ]
      }
    ]
  }
]);
