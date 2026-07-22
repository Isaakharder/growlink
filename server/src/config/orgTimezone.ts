// Single source of truth for the timezone used to compute calendar-day/week/
// month/year boundaries server-side (e.g. Food Safety cleaning checklist
// periods), so every user sees the same period regardless of device clock
// or timezone. Hardcoded for now, consistent with payroll_settings' default;
// replace with an organization-level setting later without changing call
// sites that import this constant.
export const DEFAULT_ORG_TIMEZONE = "America/Toronto";
