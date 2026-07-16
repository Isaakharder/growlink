// Desktop permission keys — any one of these means the user has web/dashboard access.
const DESKTOP_PERMISSIONS = [
  "yield:view",
  "yield:edit",
  "irrigation:view",
  "irrigation:edit",
  "pest:view",
  "pest:edit",
  "quality:view",
  "quality:edit",
  "greenhouse_setup:view",
  "greenhouse_setup:edit",
  "cases:view",
  "cases:edit",
  "payroll:view",
  "payroll:edit",
  "food_safety:view",
  "food_safety:manage_departments",
  "food_safety:manage_locations",
  "food_safety:manage_templates",
  "food_safety:complete",
  "food_safety:verify",
];

// Mobile permission keys — any one of these means the user has mobile access.
// mobile:access is the master gate enforced by MobileLayout.
const MOBILE_PERMISSIONS = [
  "mobile:access",
  "mobile:daily_yield",
  "mobile:irrigation",
  "mobile:pest",
  "mobile:quality",
  "mobile:payroll",
  "mobile:food_safety",
];

/**
 * Returns the correct landing route for a user based on their role and permissions.
 *
 * Rules:
 *   owner | admin           → "/"         (full access, no permission check needed)
 *   member with any desktop → "/"         (desktop wins even if mobile is also present)
 *   member with only mobile → "/mobile"
 *   member with nothing     → "/no-access"
 */
export function getDefaultRoute(
  role: string | null,
  permissions: Record<string, boolean>
): string {
  // Owners and admins bypass all permission checks; always send to dashboard.
  if (role === "owner" || role === "admin") return "/";

  // Any desktop permission → dashboard.
  if (DESKTOP_PERMISSIONS.some((k) => permissions[k] === true)) return "/";

  // Only mobile permissions left → mobile landing.
  if (MOBILE_PERMISSIONS.some((k) => permissions[k] === true)) return "/mobile";

  return "/no-access";
}
