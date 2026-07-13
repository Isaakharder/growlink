import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "../components/layout/AppLayout";
import { MobileLayout } from "../components/layout/MobileLayout";
import { PagePlaceholder } from "../components/layout/PagePlaceholder";
import { RequireAuth } from "../components/auth/RequireAuth";
import { RequirePermission } from "../components/auth/RequirePermission";
import { RequireAnyPermission } from "../components/auth/RequireAnyPermission";
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
import { PestControlRecordsPage } from "../pages/PestControlRecordsPage";
import { PestPlannerPage } from "../pages/PestPlannerPage";
import { QualityCheckPage } from "../pages/QualityCheckPage";
import { MobileQualityCheckPage } from "../pages/MobileQualityCheckPage";
import { VarietiesSetupPage } from "../pages/VarietiesSetupPage";
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
import { FoodSafetyDashboardPage } from "../pages/foodSafety/DashboardPage";
import { FoodSafetyDepartmentsPage } from "../pages/foodSafety/DepartmentsPage";
import { FoodSafetyLocationsPage } from "../pages/foodSafety/LocationsPage";
import { FoodSafetyTemplatesPage } from "../pages/foodSafety/TemplatesPage";
import { FoodSafetyTemplateEditorPage } from "../pages/foodSafety/TemplateEditorPage";
import { FoodSafetyTemplateVersionHistoryPage } from "../pages/foodSafety/TemplateVersionHistoryPage";

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
            path: "pest-control",
            element: <Navigate to="/pest-control/planner" replace />
          },

          // Daily Yield placeholder — no permission guard (internal placeholder)
          {
            path: "daily-yield",
            element: (
              <PagePlaceholder
                title="Daily Yield"
                description="Day-by-day yield summaries and routine harvest snapshots will be available in this page."
              />
            )
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

          // Food Safety — dashboard is reachable with any Food Safety
          // permission (including the narrower manage_* keys, which each
          // include their own read access on the backend).
          {
            path: "food-safety",
            element: (
              <RequireAnyPermission
                permissions={[
                  "food_safety:view",
                  "food_safety:manage_departments",
                  "food_safety:manage_locations",
                  "food_safety:manage_templates"
                ]}
              >
                <FoodSafetyDashboardPage />
              </RequireAnyPermission>
            )
          },
          {
            path: "food-safety/departments",
            element: (
              <RequireAnyPermission permissions={["food_safety:view", "food_safety:manage_departments"]}>
                <FoodSafetyDepartmentsPage />
              </RequireAnyPermission>
            )
          },
          {
            path: "food-safety/locations",
            element: (
              <RequireAnyPermission permissions={["food_safety:view", "food_safety:manage_locations"]}>
                <FoodSafetyLocationsPage />
              </RequireAnyPermission>
            )
          },
          {
            path: "food-safety/templates",
            element: (
              <RequireAnyPermission permissions={["food_safety:view", "food_safety:manage_templates"]}>
                <FoodSafetyTemplatesPage />
              </RequireAnyPermission>
            )
          },
          {
            path: "food-safety/templates/:templateId/edit",
            element: (
              <RequireAnyPermission permissions={["food_safety:view", "food_safety:manage_templates"]}>
                <FoodSafetyTemplateEditorPage />
              </RequireAnyPermission>
            )
          },
          {
            path: "food-safety/templates/:templateId/versions",
            element: (
              <RequireAnyPermission permissions={["food_safety:view", "food_safety:manage_templates"]}>
                <FoodSafetyTemplateVersionHistoryPage />
              </RequireAnyPermission>
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
              <RequirePermission permission="mobile:irrigation">
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
          }
        ]
      }
    ]
  }
]);
