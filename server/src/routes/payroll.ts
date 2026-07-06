import { Router } from "express";
import { supabase } from "../config/supabase";
import { sendSafeError } from "../utils/safeError";
import { requirePermission, requireAnyPermission } from "../middleware/requirePermission";
import {
  ROUNDING_MODES,
  RoundingMode,
  computeShift,
} from "../utils/payrollRounding";

// ── types ─────────────────────────────────────────────────────────────────────

type PayrollSettings = {
  id: string;
  organization_id: string;
  work_day_start: string;
  start_rounding_mode: RoundingMode;
  start_rounding_interval_minutes: number;
  end_rounding_mode: RoundingMode;
  end_rounding_interval_minutes: number;
  snap_early_clock_in_to_start: boolean;
  break_deduction_minutes: number;
  timezone: string;
};

type EmployeeRow = {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
};

type TimeLogRow = {
  id: string;
  employee_id: string;
  clocked_in_at: string;
  clocked_out_at: string | null;
  edited_at: string | null;
  edited_by: string | null;
  edit_note: string | null;
};

// ── settings defaults ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  work_day_start: "07:00",
  start_rounding_mode: "up",
  start_rounding_interval_minutes: 15,
  end_rounding_mode: "down",
  end_rounding_interval_minutes: 15,
  snap_early_clock_in_to_start: true,
  break_deduction_minutes: 0,
  timezone: "America/Toronto",
} as const;

// Converts a local YYYY-MM-DD date string to UTC start/end boundaries in the
// given IANA timezone. Uses an iterative probe so it is correct for all
// offsets including UTC+13/+14 (Auckland DST).
function localDateToUTCRange(
  dateStr: string,
  timezone: string
): { gte: string; lte: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Invalid date: ${dateStr}`);

  const fmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });

  // Probe at UTC noon; for most timezones this is safely within the target
  // local calendar date. If not, shift ±24 h and retry (max 2 corrections).
  let probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = fmt.formatToParts(probe);
    const localDate = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
    const pHour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    const pMin  = Number(parts.find((p) => p.type === "minute")?.value ?? 0);

    if (localDate === dateStr) {
      // Probe is on the correct local day. Back up to local midnight.
      const localMidnightUTC = new Date(probe.getTime() - (pHour * 60 + pMin) * 60_000);
      const endOfDayUTC      = new Date(localMidnightUTC.getTime() + 24 * 3_600_000 - 1);
      return { gte: localMidnightUTC.toISOString(), lte: endOfDayUTC.toISOString() };
    }

    // Wrong local day: shift probe toward the target date.
    probe = new Date(probe.getTime() + (localDate > dateStr ? -1 : 1) * 24 * 3_600_000);
  }

  throw new Error(`Could not resolve local date bounds for ${dateStr} in ${timezone}`);
}

// ── router ────────────────────────────────────────────────────────────────────

export const payrollRouter = Router();

// GET /api/payroll/settings
payrollRouter.get(
  "/payroll/settings",
  requirePermission("payroll:view"),
  async (req, res) => {
    const { organizationId } = req;

    const { data, error } = await supabase
      .from("payroll_settings")
      .select("*")
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (error) {
      return sendSafeError(res, 500, "Failed to load payroll settings.", "payroll settings GET:", error);
    }

    return res.json(data ?? { ...DEFAULT_SETTINGS, organization_id: organizationId });
  }
);

// PUT /api/payroll/settings
payrollRouter.put(
  "/payroll/settings",
  requirePermission("payroll:edit"),
  async (req, res) => {
    const { organizationId } = req;
    const body = req.body as Record<string, unknown>;

    const workDayStart = typeof body.work_day_start === "string" ? body.work_day_start.trim() : "";
    if (!/^\d{2}:\d{2}$/.test(workDayStart)) {
      return res.status(400).json({ message: "work_day_start must be HH:MM (e.g. 07:00)." });
    }

    const startRoundingMode = body.start_rounding_mode as RoundingMode;
    if (!ROUNDING_MODES.includes(startRoundingMode)) {
      return res.status(400).json({ message: `start_rounding_mode must be one of: ${ROUNDING_MODES.join(", ")}.` });
    }

    const startRoundingInterval = Number(body.start_rounding_interval_minutes);
    if (!Number.isInteger(startRoundingInterval) || startRoundingInterval < 1) {
      return res.status(400).json({ message: "start_rounding_interval_minutes must be a positive integer." });
    }

    const endRoundingMode = body.end_rounding_mode as RoundingMode;
    if (!ROUNDING_MODES.includes(endRoundingMode)) {
      return res.status(400).json({ message: `end_rounding_mode must be one of: ${ROUNDING_MODES.join(", ")}.` });
    }

    const endRoundingInterval = Number(body.end_rounding_interval_minutes);
    if (!Number.isInteger(endRoundingInterval) || endRoundingInterval < 1) {
      return res.status(400).json({ message: "end_rounding_interval_minutes must be a positive integer." });
    }

    if (typeof body.snap_early_clock_in_to_start !== "boolean") {
      return res.status(400).json({ message: "snap_early_clock_in_to_start must be true or false." });
    }
    const snapEarlyClockInToStart = body.snap_early_clock_in_to_start;

    const breakDeduction = Number(body.break_deduction_minutes);
    if (!Number.isInteger(breakDeduction) || breakDeduction < 0) {
      return res.status(400).json({ message: "break_deduction_minutes must be 0 or greater." });
    }

    const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
    if (!timezone) {
      return res.status(400).json({ message: "timezone is required." });
    }
    // Validate that the timezone is a recognised IANA name by attempting to use it.
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return res.status(400).json({ message: `"${timezone}" is not a valid IANA timezone name.` });
    }

    const { data, error } = await supabase
      .from("payroll_settings")
      .upsert(
        {
          organization_id: organizationId,
          work_day_start: workDayStart,
          start_rounding_mode: startRoundingMode,
          start_rounding_interval_minutes: startRoundingInterval,
          end_rounding_mode: endRoundingMode,
          end_rounding_interval_minutes: endRoundingInterval,
          snap_early_clock_in_to_start: snapEarlyClockInToStart,
          break_deduction_minutes: breakDeduction,
          timezone,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id" }
      )
      .select("*")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to save payroll settings.", "payroll settings PUT:", error);
    }

    return res.json(data);
  }
);

// GET /api/payroll/employees
// Returns employees with activeShiftId so the mobile page knows who is clocked in.
payrollRouter.get(
  "/payroll/employees",
  requireAnyPermission(["payroll:view", "mobile:payroll"]),
  async (req, res) => {
    const { organizationId } = req;

    const [empResult, activeResult] = await Promise.all([
      supabase
        .from("payroll_employees")
        .select("id, name, active, created_at")
        .eq("organization_id", organizationId)
        .order("name", { ascending: true }),
      supabase
        .from("payroll_time_logs")
        .select("id, employee_id")
        .eq("organization_id", organizationId)
        .is("clocked_out_at", null),
    ]);

    if (empResult.error) {
      return sendSafeError(res, 500, "Failed to load employees.", "payroll employees GET:", empResult.error);
    }
    if (activeResult.error) {
      return sendSafeError(res, 500, "Failed to load active shifts.", "payroll active shifts GET:", activeResult.error);
    }

    const activeShiftMap = new Map(
      (activeResult.data ?? []).map((s: { id: string; employee_id: string }) => [s.employee_id, s.id])
    );

    const employees = (empResult.data ?? []).map((emp: EmployeeRow) => ({
      ...emp,
      activeShiftId: activeShiftMap.get(emp.id) ?? null,
    }));

    return res.json({ employees });
  }
);

// POST /api/payroll/employees
payrollRouter.post(
  "/payroll/employees",
  requirePermission("payroll:edit"),
  async (req, res) => {
    const { organizationId } = req;
    const body = req.body as Record<string, unknown>;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ message: "name is required." });
    }

    const { data, error } = await supabase
      .from("payroll_employees")
      .insert({ organization_id: organizationId, name })
      .select("id, name, active, created_at")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to create employee.", "payroll employee POST:", error);
    }

    return res.status(201).json({ ...(data as EmployeeRow), activeShiftId: null });
  }
);

// PATCH /api/payroll/employees/:id
payrollRouter.patch(
  "/payroll/employees/:id",
  requirePermission("payroll:edit"),
  async (req, res) => {
    const { organizationId } = req;
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return res.status(400).json({ message: "name cannot be empty." });
      updates.name = name;
    }

    if (typeof body.active === "boolean") {
      updates.active = body.active;
    }

    const { data, error } = await supabase
      .from("payroll_employees")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("id, name, active, created_at")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to update employee.", "payroll employee PATCH:", error);
    }

    return res.json(data);
  }
);

// GET /api/payroll/time-logs?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
// Returns logs with rounding applied. start_date/end_date are converted to UTC
// using the org's configured timezone so the filter respects the local calendar day.
payrollRouter.get(
  "/payroll/time-logs",
  requirePermission("payroll:view"),
  async (req, res) => {
    const { organizationId } = req;
    const { start_date, end_date } = req.query;

    // Fetch settings first — we need the timezone before building the date filter.
    const settingsResult = await supabase
      .from("payroll_settings")
      .select("*")
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (settingsResult.error) {
      return sendSafeError(res, 500, "Failed to load settings.", "payroll time-logs settings:", settingsResult.error);
    }

    const settings: PayrollSettings = (settingsResult.data as PayrollSettings | null) ?? {
      id: "",
      organization_id: organizationId,
      ...DEFAULT_SETTINGS,
    };

    // Build the logs query with optional date range filtering.
    let logsQuery = supabase
      .from("payroll_time_logs")
      .select("id, employee_id, clocked_in_at, clocked_out_at, edited_at, edited_by, edit_note")
      .eq("organization_id", organizationId);

    if (typeof start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      try {
        const { gte } = localDateToUTCRange(start_date, settings.timezone);
        logsQuery = logsQuery.gte("clocked_in_at", gte);
      } catch {
        return res.status(400).json({ message: `Invalid start_date: ${start_date}` });
      }
    }

    if (typeof end_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      try {
        const { lte } = localDateToUTCRange(end_date, settings.timezone);
        logsQuery = logsQuery.lte("clocked_in_at", lte);
      } catch {
        return res.status(400).json({ message: `Invalid end_date: ${end_date}` });
      }
    }

    logsQuery = logsQuery.order("clocked_in_at", { ascending: false });

    const [logsResult, empResult] = await Promise.all([
      logsQuery,
      supabase
        .from("payroll_employees")
        .select("id, name")
        .eq("organization_id", organizationId),
    ]);

    if (logsResult.error) {
      return sendSafeError(res, 500, "Failed to load time logs.", "payroll time-logs GET:", logsResult.error);
    }
    if (empResult.error) {
      return sendSafeError(res, 500, "Failed to load employees.", "payroll time-logs emp GET:", empResult.error);
    }

    const empMap = new Map(
      (empResult.data ?? []).map((e: { id: string; name: string }) => [e.id, e.name])
    );

    const logs = (logsResult.data ?? []).map((log: TimeLogRow) => {
      const clockIn = new Date(log.clocked_in_at);
      const clockOut = log.clocked_out_at ? new Date(log.clocked_out_at) : null;
      const computed = computeShift(clockIn, clockOut, settings);
      return {
        id: log.id,
        employeeId: log.employee_id,
        employeeName: empMap.get(log.employee_id) ?? "Unknown",
        clockedInAt: log.clocked_in_at,
        clockedOutAt: log.clocked_out_at,
        roundedIn: computed.roundedIn,
        roundedOut: computed.roundedOut,
        rawHours: computed.rawHours,
        breakDeductionMinutes: computed.breakDeductionMinutes,
        grossMinutes: computed.grossMinutes,
        payableMinutes: computed.payableMinutes,
        totalHours: computed.totalHours,
        status: computed.status,
        editedAt: log.edited_at ?? null,
        editNote: log.edit_note ?? null,
      };
    });

    return res.json({ logs });
  }
);

// PATCH /api/payroll/time-logs/:id
// Manager edits the raw clock-in/out timestamps and optionally adds a note.
// Rounding is re-computed from the saved timestamps on each GET — not stored.
payrollRouter.patch(
  "/payroll/time-logs/:id",
  requirePermission("payroll:edit"),
  async (req, res) => {
    const { organizationId, userId } = req;
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;

    const rawIn = typeof body.clocked_in_at === "string" ? body.clocked_in_at.trim() : "";
    if (!rawIn || Number.isNaN(new Date(rawIn).getTime())) {
      return res.status(400).json({ message: "clocked_in_at is required and must be a valid timestamp." });
    }
    const clockedInAt = new Date(rawIn).toISOString();

    let clockedOutAt: string | null = null;
    if (body.clocked_out_at !== null && body.clocked_out_at !== undefined && body.clocked_out_at !== "") {
      if (typeof body.clocked_out_at !== "string" || Number.isNaN(new Date(body.clocked_out_at).getTime())) {
        return res.status(400).json({ message: "clocked_out_at must be a valid timestamp or null." });
      }
      const rawOut = body.clocked_out_at.trim();
      if (new Date(rawOut) <= new Date(clockedInAt)) {
        return res.status(400).json({ message: "clocked_out_at must be after clocked_in_at." });
      }
      clockedOutAt = new Date(rawOut).toISOString();
    }

    const editNote =
      typeof body.edit_note === "string" && body.edit_note.trim().length > 0
        ? body.edit_note.trim()
        : null;

    // Verify the log belongs to this org before touching it.
    const { data: existing, error: findError } = await supabase
      .from("payroll_time_logs")
      .select("id")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (findError) {
      return sendSafeError(res, 500, "Failed to find time log.", "payroll time-log PATCH find:", findError);
    }
    if (!existing) {
      return res.status(404).json({ message: "Time log not found." });
    }

    const { data, error } = await supabase
      .from("payroll_time_logs")
      .update({
        clocked_in_at: clockedInAt,
        clocked_out_at: clockedOutAt,
        edited_at: new Date().toISOString(),
        edited_by: userId,
        edit_note: editNote,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .select("id")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to update time log.", "payroll time-log PATCH update:", error);
    }

    return res.json(data);
  }
);

// DELETE /api/payroll/time-logs/:id
// Manager deletes a time log entry (e.g. an accidental duplicate clock-in).
payrollRouter.delete(
  "/payroll/time-logs/:id",
  requirePermission("payroll:edit"),
  async (req, res) => {
    const { organizationId } = req;
    const { id } = req.params;

    const { data: existing, error: findError } = await supabase
      .from("payroll_time_logs")
      .select("id")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (findError) {
      return sendSafeError(res, 500, "Failed to find time log.", "payroll time-log DELETE find:", findError);
    }
    if (!existing) {
      return res.status(404).json({ message: "Time log not found." });
    }

    const { error } = await supabase
      .from("payroll_time_logs")
      .delete()
      .eq("id", id)
      .eq("organization_id", organizationId);

    if (error) {
      return sendSafeError(res, 500, "Failed to delete time log.", "payroll time-log DELETE:", error);
    }

    return res.status(204).send();
  }
);

// POST /api/payroll/clock-in
// Mobile: tap "Start Work" for an employee.
payrollRouter.post(
  "/payroll/clock-in",
  requirePermission("mobile:payroll"),
  async (req, res) => {
    const { organizationId } = req;
    const body = req.body as Record<string, unknown>;

    const employeeId = typeof body.employee_id === "string" ? body.employee_id.trim() : "";
    if (!employeeId) {
      return res.status(400).json({ message: "employee_id is required." });
    }

    // Verify employee belongs to this org
    const { data: emp, error: empError } = await supabase
      .from("payroll_employees")
      .select("id")
      .eq("id", employeeId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (empError) {
      return sendSafeError(res, 500, "Failed to verify employee.", "payroll clock-in emp:", empError);
    }
    if (!emp) {
      return res.status(404).json({ message: "Employee not found." });
    }

    // Prevent double clock-in
    const { data: existing, error: checkError } = await supabase
      .from("payroll_time_logs")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("employee_id", employeeId)
      .is("clocked_out_at", null)
      .maybeSingle();

    if (checkError) {
      return sendSafeError(res, 500, "Failed to check active shift.", "payroll clock-in check:", checkError);
    }
    if (existing) {
      return res.status(409).json({ message: "Employee is already clocked in." });
    }

    const { data, error } = await supabase
      .from("payroll_time_logs")
      .insert({
        organization_id: organizationId,
        employee_id: employeeId,
        clocked_in_at: new Date().toISOString(),
      })
      .select("id, employee_id, clocked_in_at, clocked_out_at")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to clock in.", "payroll clock-in insert:", error);
    }

    return res.status(201).json(data);
  }
);

// POST /api/payroll/clock-out
// Mobile: tap "End Work" for an employee.
payrollRouter.post(
  "/payroll/clock-out",
  requirePermission("mobile:payroll"),
  async (req, res) => {
    const { organizationId } = req;
    const body = req.body as Record<string, unknown>;

    const employeeId = typeof body.employee_id === "string" ? body.employee_id.trim() : "";
    if (!employeeId) {
      return res.status(400).json({ message: "employee_id is required." });
    }

    const { data: shift, error: findError } = await supabase
      .from("payroll_time_logs")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("employee_id", employeeId)
      .is("clocked_out_at", null)
      .maybeSingle();

    if (findError) {
      return sendSafeError(res, 500, "Failed to find active shift.", "payroll clock-out find:", findError);
    }
    if (!shift) {
      return res.status(404).json({ message: "No active shift found for this employee." });
    }

    const { data, error } = await supabase
      .from("payroll_time_logs")
      .update({
        clocked_out_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", (shift as { id: string }).id)
      .eq("organization_id", organizationId)
      .select("id, employee_id, clocked_in_at, clocked_out_at")
      .single();

    if (error) {
      return sendSafeError(res, 500, "Failed to clock out.", "payroll clock-out update:", error);
    }

    return res.json(data);
  }
);
