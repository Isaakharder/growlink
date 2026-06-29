import { FormEvent, CSSProperties, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

// ── types ─────────────────────────────────────────────────────────────────────

type Employee = {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
  activeShiftId: string | null;
};

type TimeLog = {
  id: string;
  employeeId: string;
  employeeName: string;
  clockedInAt: string;
  clockedOutAt: string | null;
  roundedIn: string;
  roundedOut: string | null;
  rawHours: number | null;
  breakDeductionMinutes: number;
  totalHours: number | null;
  status: "in_progress" | "completed";
  editedAt: string | null;
  editNote: string | null;
};

type PayrollSettings = {
  work_day_start: string;
  rounding_interval_minutes: number;
  break_deduction_minutes: number;
  timezone: string;
};

// ── module-level helpers ──────────────────────────────────────────────────────

function fmtDateTime(iso: string | null, timezone?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

function fmtHours(h: number | null): string {
  if (h === null) return "—";
  return `${h.toFixed(2)} h`;
}

function getResponseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const msg = (body as { message?: unknown }).message;
  return typeof msg === "string" && msg.trim().length > 0 ? msg : fallback;
}

// Returns today in YYYY-MM-DD using the browser's local calendar.
function todayLocalStr(): string {
  return new Date().toLocaleDateString("en-CA");
}

// Returns the Monday of the current week in YYYY-MM-DD (browser local time).
function mondayLocalStr(): string {
  const d = new Date();
  const day = d.getDay(); // 0 = Sun
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.toLocaleDateString("en-CA");
}

// Converts a UTC ISO timestamp to { date: "YYYY-MM-DD", time: "HH:MM" } in a
// given IANA timezone. Used to pre-populate the edit modal's local date+time inputs.
function utcToLocalParts(iso: string, timezone: string): { date: string; time: string } {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });
  const parts = fmt.formatToParts(d);
  const year   = parts.find((p) => p.type === "year")?.value   ?? "";
  const month  = parts.find((p) => p.type === "month")?.value  ?? "";
  const day    = parts.find((p) => p.type === "day")?.value    ?? "";
  const hour   = String(Number(parts.find((p) => p.type === "hour")?.value   ?? 0) % 24).padStart(2, "0");
  const minute = String(Number(parts.find((p) => p.type === "minute")?.value ?? 0)).padStart(2, "0");
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

// Converts a local YYYY-MM-DD date + HH:MM time in a given IANA timezone back
// to a UTC ISO string. Uses the same iterative Intl probe as the server so DST
// and UTC+13/+14 offsets are handled correctly.
function localDateTimeToUTC(localDate: string, localTime: string, timezone: string): string {
  const [h, min] = localTime.split(":").map(Number);
  const targetMins = (h ?? 0) * 60 + (min ?? 0);
  const [y, m, d] = localDate.split("-").map(Number);
  if (!y || !m || !d) return new Date().toISOString();

  const fmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });

  let probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = fmt.formatToParts(probe);
    const localDay = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
    const pHour = Number(parts.find((p) => p.type === "hour")?.value   ?? 0) % 24;
    const pMin  = Number(parts.find((p) => p.type === "minute")?.value ?? 0);

    if (localDay === localDate) {
      const midnightUTC = new Date(probe.getTime() - (pHour * 60 + pMin) * 60_000);
      return new Date(midnightUTC.getTime() + targetMins * 60_000).toISOString();
    }
    probe = new Date(probe.getTime() + (localDay > localDate ? -1 : 1) * 24 * 3_600_000);
  }

  // Fallback: interpret as UTC (should never be reached for valid inputs).
  return `${localDate}T${localTime}:00.000Z`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function csvQuote(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Returns the local calendar date (YYYY-MM-DD) of a UTC ISO timestamp in a
// given IANA timezone — used to assign each shift to the correct payroll day.
function getLocalDateKey(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: timezone });
}

// Returns every YYYY-MM-DD string from start to end inclusive.
function generateDays(start: string, end: string): string[] {
  if (!start || !end) return [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (!sy || !sm || !sd || !ey || !em || !ed) return [];
  const days: string[] = [];
  let cur = new Date(Date.UTC(sy, sm - 1, sd));
  const last = new Date(Date.UTC(ey, em - 1, ed));
  while (cur <= last) {
    days.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 24 * 3_600_000);
  }
  return days;
}

// Formats a YYYY-MM-DD date string as "Mon Jun 22" using UTC so the label
// matches the calendar date exactly, regardless of the viewer's browser timezone.
function fmtDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const date = new Date(Date.UTC(y, m - 1, d));
  const fmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("month")} ${get("day")}`;
}

type PrintParams = {
  logs: TimeLog[];
  settings: PayrollSettings;
  startDate: string;
  endDate: string;
};

function buildPrintHTML({ logs, settings, startDate, endDate }: PrintParams): string {
  const tz = settings.timezone;
  const days = generateDays(startDate, endDate);
  const isWide = days.length > 7;

  // Index payroll hours by employee × local calendar day.
  const empNames = new Map<string, string>(); // empId → name
  const empDayHours = new Map<string, Map<string, number>>(); // empId → dayKey → payroll h

  for (const log of logs) {
    if (log.totalHours === null) continue; // in-progress: no payroll hours yet
    empNames.set(log.employeeId, log.employeeName);
    // Use clockedInAt in org timezone to determine which local day the shift belongs to.
    const dayKey = getLocalDateKey(log.clockedInAt, tz);
    if (!empDayHours.has(log.employeeId)) empDayHours.set(log.employeeId, new Map());
    const m = empDayHours.get(log.employeeId)!;
    m.set(dayKey, (m.get(dayKey) ?? 0) + log.totalHours);
  }

  // Employees sorted alphabetically.
  const sortedEmps = [...empNames.entries()].sort((a, b) => a[1].localeCompare(b[1]));

  // Column totals (all employees for each day).
  const dayTotals = new Map<string, number>();
  for (const dayMap of empDayHours.values()) {
    for (const [day, h] of dayMap) {
      dayTotals.set(day, (dayTotals.get(day) ?? 0) + h);
    }
  }
  const grandTotal = [...dayTotals.values()].reduce((s, h) => s + h, 0);

  const headerCells = days.map((d) => `<th>${escapeHtml(fmtDayLabel(d))}</th>`).join("");

  const bodyRows = sortedEmps
    .map(([empId, empName]) => {
      const dayMap = empDayHours.get(empId) ?? new Map<string, number>();
      let rowTotal = 0;
      const cells = days.map((day) => {
        const h = dayMap.get(day) ?? 0;
        rowTotal += h;
        return `<td class="num">${h > 0 ? h.toFixed(2) : ""}</td>`;
      });
      return `<tr>
      <td class="name">${escapeHtml(empName)}</td>
      ${cells.join("")}
      <td class="num total-cell">${rowTotal > 0 ? rowTotal.toFixed(2) : ""}</td>
    </tr>`;
    })
    .join("");

  const totalCells = days
    .map((day) => {
      const h = dayTotals.get(day) ?? 0;
      return `<td class="num">${h > 0 ? h.toFixed(2) : ""}</td>`;
    })
    .join("");

  const fontSize = isWide ? "10px" : "12px";
  const thFontSize = isWide ? "9px" : "11px";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Payroll Summary</title>
<style>
  @page { size: ${isWide ? "landscape" : "portrait"}; margin: 1.5cm; }
  body { font-family: Arial, sans-serif; font-size: ${fontSize}; color: #111; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 3px; }
  .meta { color: #555; font-size: 10px; margin-bottom: 14px; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: center;
    border-bottom: 2px solid #222;
    padding: 5px 6px;
    font-size: ${thFontSize};
    white-space: nowrap;
    background: #f4f4f4;
  }
  th.name-col { text-align: left; }
  th.total-th { border-left: 2px solid #999; }
  td { border-bottom: 1px solid #e0e0e0; padding: 4px 6px; vertical-align: middle; }
  td.name { white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.total-cell { font-weight: 600; border-left: 2px solid #999; }
  tr.totals-row td {
    border-top: 2px solid #222;
    border-bottom: none;
    font-weight: bold;
    padding-top: 6px;
    background: #f9f9f9;
  }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>Payroll Time Summary</h1>
<div class="meta">
  <div>Date range: ${escapeHtml(startDate)} — ${escapeHtml(endDate)}</div>
  <div>Timezone: ${escapeHtml(tz)}</div>
  <div>Printed: ${escapeHtml(new Date().toLocaleString(undefined, { timeZone: tz }))}</div>
</div>
<table>
  <thead>
    <tr>
      <th class="name-col">Employee</th>
      ${headerCells}
      <th class="total-th">Total</th>
    </tr>
  </thead>
  <tbody>
    ${bodyRows}
    <tr class="totals-row">
      <td>Total</td>
      ${totalCells}
      <td class="num total-cell">${grandTotal > 0 ? grandTotal.toFixed(2) : ""}</td>
    </tr>
  </tbody>
</table>
</body>
</html>`;
}

// ── component ─────────────────────────────────────────────────────────────────

export function PayrollPage() {
  // ── settings ────────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<PayrollSettings>({
    work_day_start: "07:00",
    rounding_interval_minutes: 15,
    break_deduction_minutes: 0,
    timezone: "America/Toronto",
  });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // ── employees ────────────────────────────────────────────────────────────────
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [empLoading, setEmpLoading] = useState(true);
  const [empError, setEmpError] = useState<string | null>(null);
  const [newEmpName, setNewEmpName] = useState("");
  const [addingEmp, setAddingEmp] = useState(false);
  const [addEmpError, setAddEmpError] = useState<string | null>(null);

  // ── time logs ────────────────────────────────────────────────────────────────
  const [logs, setLogs] = useState<TimeLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(mondayLocalStr);
  const [endDate, setEndDate] = useState(todayLocalStr);

  // ── edit modal ────────────────────────────────────────────────────────────────
  const [selectedLog, setSelectedLog] = useState<TimeLog | null>(null);
  const [editStartDate, setEditStartDate] = useState("");
  const [editStartTime, setEditStartTime] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editEndTime, setEditEndTime] = useState("");
  const [editNoteInput, setEditNoteInput] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // ── load on mount ─────────────────────────────────────────────────────────────
  useEffect(() => {
    void loadSettings();
    void loadEmployees();
  }, []);

  // Reload logs whenever the date range changes (also fires on initial mount).
  useEffect(() => {
    void loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  async function loadSettings() {
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const res = await apiFetch("/api/payroll/settings");
      const body = (await res.json().catch(() => ({}))) as Partial<PayrollSettings> & { message?: string };
      if (!res.ok) {
        setSettingsError(getResponseMessage(body, "Failed to load settings."));
        return;
      }
      setSettings({
        work_day_start: body.work_day_start ?? "07:00",
        rounding_interval_minutes: body.rounding_interval_minutes ?? 15,
        break_deduction_minutes: body.break_deduction_minutes ?? 0,
        timezone: body.timezone ?? "America/Toronto",
      });
    } catch {
      setSettingsError("Network error while loading settings.");
    } finally {
      setSettingsLoading(false);
    }
  }

  async function loadEmployees() {
    setEmpLoading(true);
    setEmpError(null);
    try {
      const res = await apiFetch("/api/payroll/employees");
      const body = (await res.json().catch(() => ({}))) as { employees?: Employee[]; message?: string };
      if (!res.ok) {
        setEmpError(getResponseMessage(body, "Failed to load employees."));
        return;
      }
      setEmployees(body.employees ?? []);
    } catch {
      setEmpError("Network error while loading employees.");
    } finally {
      setEmpLoading(false);
    }
  }

  async function loadLogs() {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const params = new URLSearchParams();
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      const res = await apiFetch(`/api/payroll/time-logs?${params.toString()}`);
      const body = (await res.json().catch(() => ({}))) as { logs?: TimeLog[]; message?: string };
      if (!res.ok) {
        setLogsError(getResponseMessage(body, "Failed to load time logs."));
        return;
      }
      setLogs(body.logs ?? []);
    } catch {
      setLogsError("Network error while loading time logs.");
    } finally {
      setLogsLoading(false);
    }
  }

  // ── settings save ────────────────────────────────────────────────────────────
  async function handleSettingsSubmit(e: FormEvent) {
    e.preventDefault();
    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const res = await apiFetch("/api/payroll/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<PayrollSettings> & { message?: string };
      if (!res.ok) {
        setSettingsError(getResponseMessage(body, "Failed to save settings."));
        return;
      }
      setSettings({
        work_day_start: body.work_day_start ?? settings.work_day_start,
        rounding_interval_minutes: body.rounding_interval_minutes ?? settings.rounding_interval_minutes,
        break_deduction_minutes: body.break_deduction_minutes ?? settings.break_deduction_minutes,
        timezone: body.timezone ?? settings.timezone,
      });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
      // Re-fetch logs to reflect new rounding settings.
      void loadLogs();
    } catch {
      setSettingsError("Network error. Please try again.");
    } finally {
      setSettingsSaving(false);
    }
  }

  // ── add employee ─────────────────────────────────────────────────────────────
  async function handleAddEmployee(e: FormEvent) {
    e.preventDefault();
    const name = newEmpName.trim();
    if (!name) return;
    setAddingEmp(true);
    setAddEmpError(null);
    try {
      const res = await apiFetch("/api/payroll/employees", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => ({}))) as Employee & { message?: string };
      if (!res.ok) {
        setAddEmpError(getResponseMessage(body, "Failed to add employee."));
        return;
      }
      setEmployees((prev) => [...prev, body as Employee].sort((a, b) => a.name.localeCompare(b.name)));
      setNewEmpName("");
    } catch {
      setAddEmpError("Network error. Please try again.");
    } finally {
      setAddingEmp(false);
    }
  }

  // ── toggle active ────────────────────────────────────────────────────────────
  async function handleToggleActive(emp: Employee) {
    try {
      const res = await apiFetch(`/api/payroll/employees/${emp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !emp.active }),
      });
      if (!res.ok) return;
      setEmployees((prev) =>
        prev.map((e) => (e.id === emp.id ? { ...e, active: !emp.active } : e))
      );
    } catch {
      // Silent — UI stays in previous state
    }
  }

  // ── edit modal handlers ───────────────────────────────────────────────────────
  function openEditModal(log: TimeLog) {
    const tz = settings.timezone;
    const startParts = utcToLocalParts(log.clockedInAt, tz);
    setEditStartDate(startParts.date);
    setEditStartTime(startParts.time);
    if (log.clockedOutAt) {
      const endParts = utcToLocalParts(log.clockedOutAt, tz);
      setEditEndDate(endParts.date);
      setEditEndTime(endParts.time);
    } else {
      setEditEndDate("");
      setEditEndTime("");
    }
    setEditNoteInput(log.editNote ?? "");
    setEditError(null);
    setSelectedLog(log);
  }

  function closeEditModal() {
    setSelectedLog(null);
    setEditError(null);
  }

  async function handleEditSave() {
    if (!selectedLog) return;
    if (!editStartDate || !editStartTime) {
      setEditError("Start date and time are required.");
      return;
    }
    if ((editEndDate && !editEndTime) || (!editEndDate && editEndTime)) {
      setEditError("Please provide both an end date and an end time, or leave both blank.");
      return;
    }

    const tz = settings.timezone;
    const newClockIn = localDateTimeToUTC(editStartDate, editStartTime, tz);
    let newClockOut: string | null = null;
    if (editEndDate && editEndTime) {
      newClockOut = localDateTimeToUTC(editEndDate, editEndTime, tz);
      if (new Date(newClockOut) <= new Date(newClockIn)) {
        setEditError("End time must be after start time.");
        return;
      }
    }

    setEditSaving(true);
    setEditError(null);
    try {
      const res = await apiFetch(`/api/payroll/time-logs/${selectedLog.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          clocked_in_at: newClockIn,
          clocked_out_at: newClockOut,
          edit_note: editNoteInput.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setEditError(getResponseMessage(body, "Failed to save changes."));
        return;
      }
      closeEditModal();
      void loadLogs();
    } catch {
      setEditError("Network error. Please try again.");
    } finally {
      setEditSaving(false);
    }
  }

  // ── totals ───────────────────────────────────────────────────────────────────
  const totals = useMemo(() => {
    const completed = logs.filter((l) => l.status === "completed");
    const totalRaw = completed.reduce((s, l) => s + (l.rawHours ?? 0), 0);
    const totalBreak = completed.reduce((s, l) => s + l.breakDeductionMinutes / 60, 0);
    const totalPayroll = completed.reduce((s, l) => s + (l.totalHours ?? 0), 0);
    return { totalRaw, totalBreak, totalPayroll, completedCount: completed.length };
  }, [logs]);

  // ── export CSV ───────────────────────────────────────────────────────────────
  function handleExportCSV() {
    const tz = settings.timezone;
    const header = [
      "Employee",
      "Raw Start Time",
      "Raw End Time",
      "Rounded Start Time",
      "Rounded End Time",
      "Break Deduction Minutes",
      "Raw Hours",
      "Payroll Hours",
      "Status",
    ].join(",");

    const rows = logs.map((l) =>
      [
        csvQuote(l.employeeName),
        csvQuote(fmtDateTime(l.clockedInAt, tz)),
        csvQuote(fmtDateTime(l.clockedOutAt, tz)),
        csvQuote(fmtDateTime(l.roundedIn, tz)),
        csvQuote(fmtDateTime(l.roundedOut, tz)),
        l.status === "completed" ? String(l.breakDeductionMinutes) : "",
        l.rawHours !== null ? l.rawHours.toFixed(2) : "",
        l.totalHours !== null ? l.totalHours.toFixed(2) : "",
        l.status === "completed" ? "Completed" : "In Progress",
      ].join(",")
    );

    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll_${startDate}_to_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── print ─────────────────────────────────────────────────────────────────────
  function handlePrint() {
    const html = buildPrintHTML({ logs, settings, startDate, endDate });
    const win = window.open("", "_blank", "width=1000,height=700");
    if (!win) {
      alert("Please allow popups to print the payroll report.");
      return;
    }
    win.document.write(html);
    win.document.close();
    // Small delay so the browser finishes laying out the document.
    setTimeout(() => {
      win.print();
      win.close();
    }, 250);
  }

  // ── render ───────────────────────────────────────────────────────────────────
  return (
    <div style={pageStyle}>
      <h1 style={pageTitleStyle}>Payroll</h1>

      {/* ── Settings ──────────────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Payroll Settings</h2>
        <p style={descStyle}>Configure work day start time, rounding, and automatic break deductions.</p>

        {settingsLoading ? (
          <p style={mutedStyle}>Loading settings…</p>
        ) : (
          <form onSubmit={(e) => void handleSettingsSubmit(e)} style={cardStyle}>
            <div style={fieldRowStyle}>
              <label htmlFor="pay-start" style={labelStyle}>
                Work Day Start Time
              </label>
              <input
                id="pay-start"
                type="time"
                required
                value={settings.work_day_start}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, work_day_start: e.target.value }))
                }
                style={{ ...inputStyle, width: "auto" }}
              />
              <p style={hintStyle}>
                Employees who clock in before this time are credited from this time. Late arrivals round up.
              </p>
            </div>

            <div style={fieldRowStyle}>
              <label htmlFor="pay-interval" style={labelStyle}>
                Rounding Interval (minutes)
              </label>
              <select
                id="pay-interval"
                value={settings.rounding_interval_minutes}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    rounding_interval_minutes: Number(e.target.value),
                  }))
                }
                style={{ ...inputStyle, width: "auto" }}
              >
                {[5, 6, 10, 12, 15, 20, 30].map((n) => (
                  <option key={n} value={n}>
                    {n} minutes
                  </option>
                ))}
              </select>
              <p style={hintStyle}>Late clock-ins round up; early clock-outs round down.</p>
            </div>

            <div style={fieldRowStyle}>
              <label htmlFor="pay-break" style={labelStyle}>
                Auto Break Deduction (minutes)
              </label>
              <input
                id="pay-break"
                type="number"
                min="0"
                step="1"
                required
                value={settings.break_deduction_minutes}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    break_deduction_minutes: Math.max(0, Math.round(Number(e.target.value))),
                  }))
                }
                style={{ ...inputStyle, width: "auto" }}
              />
              <p style={hintStyle}>
                Deducted from every completed shift. Set to 0 to disable.
              </p>
            </div>

            <div style={fieldRowStyle}>
              <label htmlFor="pay-tz" style={labelStyle}>
                Timezone
              </label>
              <select
                id="pay-tz"
                value={settings.timezone}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, timezone: e.target.value }))
                }
                style={{ ...inputStyle, width: "auto" }}
              >
                <optgroup label="Canada">
                  <option value="America/Toronto">America/Toronto (Eastern)</option>
                  <option value="America/Winnipeg">America/Winnipeg (Central)</option>
                  <option value="America/Edmonton">America/Edmonton (Mountain)</option>
                  <option value="America/Vancouver">America/Vancouver (Pacific)</option>
                  <option value="America/Halifax">America/Halifax (Atlantic)</option>
                  <option value="America/St_Johns">America/St_Johns (Newfoundland)</option>
                </optgroup>
                <optgroup label="United States">
                  <option value="America/New_York">America/New_York (Eastern)</option>
                  <option value="America/Chicago">America/Chicago (Central)</option>
                  <option value="America/Denver">America/Denver (Mountain)</option>
                  <option value="America/Los_Angeles">America/Los_Angeles (Pacific)</option>
                  <option value="America/Phoenix">America/Phoenix (Arizona)</option>
                  <option value="America/Anchorage">America/Anchorage (Alaska)</option>
                  <option value="Pacific/Honolulu">Pacific/Honolulu (Hawaii)</option>
                </optgroup>
                <optgroup label="Europe">
                  <option value="Europe/Amsterdam">Europe/Amsterdam</option>
                  <option value="Europe/Brussels">Europe/Brussels</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="Europe/Berlin">Europe/Berlin</option>
                  <option value="Europe/Paris">Europe/Paris</option>
                  <option value="Europe/Warsaw">Europe/Warsaw</option>
                  <option value="Europe/Helsinki">Europe/Helsinki</option>
                </optgroup>
                <optgroup label="Australia / NZ">
                  <option value="Australia/Sydney">Australia/Sydney</option>
                  <option value="Australia/Melbourne">Australia/Melbourne</option>
                  <option value="Australia/Brisbane">Australia/Brisbane</option>
                  <option value="Australia/Perth">Australia/Perth</option>
                  <option value="Pacific/Auckland">Pacific/Auckland</option>
                </optgroup>
              </select>
              <p style={hintStyle}>
                Work day start time and displayed timestamps are interpreted in this timezone.
                Timestamps are always stored in UTC.
              </p>
            </div>

            {settingsError && <p style={errorStyle}>{settingsError}</p>}
            {settingsSaved && <p style={successStyle}>Settings saved.</p>}

            <button type="submit" disabled={settingsSaving} style={primaryBtnStyle}>
              {settingsSaving ? "Saving…" : "Save Settings"}
            </button>
          </form>
        )}
      </section>

      {/* ── Employees ─────────────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Employees</h2>
        <p style={descStyle}>
          Add contractor names here. Active employees appear on the mobile clock-in screen.
        </p>

        {empError && <p style={errorStyle}>{empError}</p>}

        <form onSubmit={(e) => void handleAddEmployee(e)} style={addEmpFormStyle}>
          <input
            type="text"
            placeholder="Employee name"
            value={newEmpName}
            onChange={(e) => setNewEmpName(e.target.value)}
            style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
          />
          <button type="submit" disabled={addingEmp || !newEmpName.trim()} style={addBtnStyle}>
            {addingEmp ? "Adding…" : "Add Employee"}
          </button>
        </form>
        {addEmpError && <p style={{ ...errorStyle, marginTop: "0.4rem" }}>{addEmpError}</p>}

        <div style={{ ...cardStyle, marginTop: "0.75rem" }}>
          {empLoading ? (
            <p style={{ margin: 0, ...mutedStyle }}>Loading employees…</p>
          ) : employees.length === 0 ? (
            <p style={{ margin: 0, ...mutedStyle }}>No employees yet. Add one above.</p>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Currently Clocked In</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => (
                  <tr key={emp.id}>
                    <td style={tdStyle}>{emp.name}</td>
                    <td style={tdStyle}>
                      <span style={emp.active ? activeBadgeStyle : inactiveBadgeStyle}>
                        {emp.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {emp.activeShiftId ? (
                        <span style={clockedInBadgeStyle}>Yes</span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <button
                        type="button"
                        onClick={() => void handleToggleActive(emp)}
                        style={smallSecBtnStyle}
                      >
                        {emp.active ? "Set Inactive" : "Set Active"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* ── Time Logs ─────────────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={titleStyle}>Time Logs</h2>
        <p style={descStyle}>
          Rounded times and payroll hours are calculated from your current settings.
          Original timestamps are always preserved in the database.
        </p>

        {/* Filter bar */}
        <div style={filterBarStyle}>
          <div style={filterFieldStyle}>
            <label htmlFor="log-start" style={filterLabelStyle}>
              Start Date
            </label>
            <input
              id="log-start"
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(e) => setStartDate(e.target.value)}
              style={dateInputStyle}
            />
          </div>
          <div style={filterFieldStyle}>
            <label htmlFor="log-end" style={filterLabelStyle}>
              End Date
            </label>
            <input
              id="log-end"
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => setEndDate(e.target.value)}
              style={dateInputStyle}
            />
          </div>
          <div style={filterActionsStyle}>
            <button
              type="button"
              onClick={handleExportCSV}
              disabled={logs.length === 0}
              style={outlineBtnStyle}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={logs.length === 0}
              style={outlineBtnStyle}
            >
              Print
            </button>
          </div>
        </div>

        {logsError && <p style={errorStyle}>{logsError}</p>}

        <div style={{ ...cardStyle, overflowX: "auto", padding: 0 }}>
          {logsLoading ? (
            <p style={{ margin: 0, padding: "0.9rem", ...mutedStyle }}>Loading time logs…</p>
          ) : logs.length === 0 ? (
            <p style={{ margin: 0, padding: "0.9rem", ...mutedStyle }}>
              No time logs for this date range.
            </p>
          ) : (
            <table style={{ ...tableStyle, minWidth: 860 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Employee</th>
                  <th style={thStyle}>Raw Start</th>
                  <th style={thStyle}>Raw End</th>
                  <th style={thStyle}>Rounded Start</th>
                  <th style={thStyle}>Rounded End</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Break Min</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Raw Hrs</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Pay Hrs</th>
                  <th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    onClick={() => openEditModal(log)}
                    style={{ cursor: "pointer" }}
                    title="Click to edit"
                  >
                    <td style={tdStyle}>
                      <span>{log.employeeName}</span>
                      {log.editedAt && (
                        <span
                          style={editedBadgeStyle}
                          title={log.editNote ?? "Edited by manager"}
                        >
                          Edited
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>{fmtDateTime(log.clockedInAt, settings.timezone)}</td>
                    <td style={tdStyle}>{fmtDateTime(log.clockedOutAt, settings.timezone)}</td>
                    <td style={tdStyle}>{fmtDateTime(log.roundedIn, settings.timezone)}</td>
                    <td style={tdStyle}>{fmtDateTime(log.roundedOut, settings.timezone)}</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {log.status === "completed" ? log.breakDeductionMinutes : "—"}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmtHours(log.rawHours)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {log.totalHours === null ? (
                        <span style={inProgressBadgeStyle}>In progress</span>
                      ) : (
                        fmtHours(log.totalHours)
                      )}
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={log.status === "completed" ? completedBadgeStyle : inProgressBadgeStyle}
                      >
                        {log.status === "completed" ? "Completed" : "In Progress"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* Totals */}
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--border)" }}>
                  <td
                    colSpan={5}
                    style={{ ...tdStyle, fontWeight: 600, borderBottom: "none", paddingTop: "0.6rem" }}
                  >
                    Totals — {totals.completedCount} completed shift
                    {totals.completedCount === 1 ? "" : "s"}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", borderBottom: "none", paddingTop: "0.6rem", fontVariantNumeric: "tabular-nums" }}>
                    —
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      fontWeight: 600,
                      borderBottom: "none",
                      paddingTop: "0.6rem",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {totals.totalRaw.toFixed(2)} h
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      fontWeight: 600,
                      borderBottom: "none",
                      paddingTop: "0.6rem",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {totals.totalPayroll.toFixed(2)} h
                  </td>
                  <td style={{ ...tdStyle, borderBottom: "none", paddingTop: "0.6rem" }} />
                </tr>
                <tr>
                  <td
                    colSpan={6}
                    style={{
                      ...tdStyle,
                      color: "var(--text-muted)",
                      fontSize: "0.78rem",
                      borderBottom: "none",
                      paddingTop: "0.25rem",
                    }}
                  >
                    Break deduction total
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      color: "var(--text-muted)",
                      fontSize: "0.78rem",
                      borderBottom: "none",
                      paddingTop: "0.25rem",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {totals.totalBreak.toFixed(2)} h
                  </td>
                  <td colSpan={2} style={{ ...tdStyle, borderBottom: "none" }} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </section>

      {/* ── Edit Modal ────────────────────────────────────────────────────── */}
      {selectedLog && (
        <div style={modalOverlayStyle} onClick={closeEditModal}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <h3 style={modalTitleStyle}>Edit Time Log</h3>
              <button type="button" onClick={closeEditModal} style={modalCloseStyle}>
                ✕
              </button>
            </div>

            <p style={{ ...mutedStyle, marginBottom: "1rem" }}>
              <strong>{selectedLog.employeeName}</strong>
              {selectedLog.editedAt && (
                <span style={{ ...mutedStyle, fontSize: "0.75rem", marginLeft: "0.5rem" }}>
                  (previously edited)
                </span>
              )}
            </p>

            <div style={modalRowStyle}>
              <div style={modalFieldStyle}>
                <label style={labelStyle} htmlFor="edit-start-date">Start Date</label>
                <input
                  id="edit-start-date"
                  type="date"
                  value={editStartDate}
                  onChange={(e) => setEditStartDate(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div style={modalFieldStyle}>
                <label style={labelStyle} htmlFor="edit-start-time">Start Time</label>
                <input
                  id="edit-start-time"
                  type="time"
                  value={editStartTime}
                  onChange={(e) => setEditStartTime(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={modalRowStyle}>
              <div style={modalFieldStyle}>
                <label style={labelStyle} htmlFor="edit-end-date">End Date</label>
                <input
                  id="edit-end-date"
                  type="date"
                  value={editEndDate}
                  onChange={(e) => setEditEndDate(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div style={modalFieldStyle}>
                <label style={labelStyle} htmlFor="edit-end-time">End Time</label>
                <input
                  id="edit-end-time"
                  type="time"
                  value={editEndTime}
                  onChange={(e) => setEditEndTime(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>

            <p style={hintStyle}>
              Times are in <strong>{settings.timezone}</strong>. Leave end date / time blank to mark as in progress.
            </p>

            <div style={{ marginTop: "1rem" }}>
              <label style={labelStyle} htmlFor="edit-note">Edit Note / Reason</label>
              <textarea
                id="edit-note"
                rows={2}
                placeholder="Optional — reason for the change"
                value={editNoteInput}
                onChange={(e) => setEditNoteInput(e.target.value)}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
              />
            </div>

            {editError && <p style={{ ...errorStyle, marginTop: "0.75rem" }}>{editError}</p>}

            <div style={modalFooterStyle}>
              <button type="button" onClick={closeEditModal} style={smallSecBtnStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleEditSave()}
                disabled={editSaving}
                style={primaryBtnStyle}
              >
                {editSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  maxWidth: 1100,
  margin: "0 auto",
  padding: "1.5rem 1rem 2rem",
};

const pageTitleStyle: CSSProperties = {
  fontSize: "1.4rem",
  fontWeight: 700,
  color: "var(--text)",
  marginBottom: "1.5rem",
};

const sectionStyle: CSSProperties = {
  marginBottom: "2rem",
};

const titleStyle: CSSProperties = {
  fontSize: "1.1rem",
  fontWeight: 600,
  color: "var(--text)",
  marginBottom: "0.2rem",
};

const descStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "0.85rem",
  marginBottom: "0.75rem",
  marginTop: 0,
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "0.9rem",
};

const fieldRowStyle: CSSProperties = {
  marginBottom: "1rem",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  fontWeight: 500,
  marginBottom: "0.3rem",
};

const hintStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-muted)",
  margin: "0.25rem 0 0",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.65rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.9rem",
  color: "var(--text)",
  background: "var(--surface-soft)",
  outline: "none",
  boxSizing: "border-box",
};

const primaryBtnStyle: CSSProperties = {
  padding: "0.55rem 1rem",
  background: "var(--brand)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.88rem",
  fontWeight: 600,
};

const addEmpFormStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
};

const addBtnStyle: CSSProperties = {
  padding: "0.45rem 0.9rem",
  background: "var(--brand)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const smallSecBtnStyle: CSSProperties = {
  padding: "0.28rem 0.55rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.78rem",
  fontWeight: 500,
};

const filterBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: "0.75rem",
  flexWrap: "wrap",
  marginBottom: "0.75rem",
};

const filterFieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const filterLabelStyle: CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 500,
  color: "var(--text-muted)",
};

const dateInputStyle: CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.88rem",
  color: "var(--text)",
  background: "var(--surface-soft)",
  outline: "none",
};

const filterActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginLeft: "auto",
};

const outlineBtnStyle: CSSProperties = {
  padding: "0.4rem 0.8rem",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.83rem",
  fontWeight: 500,
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.83rem",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-muted)",
  fontWeight: 600,
  padding: "0.55rem 0.7rem",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  padding: "0.5rem 0.7rem",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
};

const errorStyle: CSSProperties = {
  margin: "0 0 0.6rem",
  padding: "0.5rem 0.65rem",
  background: "#fdf2f2",
  border: "1px solid #f5c6c6",
  borderRadius: 6,
  fontSize: "0.82rem",
  color: "#c0392b",
};

const successStyle: CSSProperties = {
  margin: "0 0 0.6rem",
  padding: "0.5rem 0.65rem",
  background: "#f0faf4",
  border: "1px solid #a3d9b5",
  borderRadius: 6,
  fontSize: "0.82rem",
  color: "#1f7a42",
};

const mutedStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "0.875rem",
};

function badge(bg: string, color: string, border: string): CSSProperties {
  return {
    display: "inline-block",
    borderRadius: 999,
    padding: "0.1rem 0.45rem",
    fontSize: "0.72rem",
    background: bg,
    color,
    border: `1px solid ${border}`,
  };
}

const activeBadgeStyle = badge("#e8f8ef", "#1f7a42", "#bfe9cf");
const inactiveBadgeStyle = badge("var(--surface-soft)", "var(--text-muted)", "var(--border)");
const clockedInBadgeStyle = badge("#fef3c7", "#92400e", "#fde68a");
const inProgressBadgeStyle = badge("#fef3c7", "#92400e", "#fde68a");
const completedBadgeStyle = badge("#e8f8ef", "#1f7a42", "#bfe9cf");
const editedBadgeStyle: CSSProperties = {
  ...badge("#eff6ff", "#1d4ed8", "#bfdbfe"),
  marginLeft: "0.4rem",
  cursor: "help",
};

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "1.5rem",
  width: "min(520px, 95vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
};

const modalHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: "0.75rem",
};

const modalTitleStyle: CSSProperties = {
  fontSize: "1rem",
  fontWeight: 600,
  margin: 0,
  color: "var(--text)",
};

const modalCloseStyle: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: "1rem",
  color: "var(--text-muted)",
  lineHeight: 1,
  padding: "0.1rem 0.3rem",
};

const modalRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.75rem",
  marginBottom: "0.75rem",
};

const modalFieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const modalFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  marginTop: "1.25rem",
};
