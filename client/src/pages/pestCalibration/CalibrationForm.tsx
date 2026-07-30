import { useState } from "react";
import { DeviceDetail, TemplateField } from "./types";

export type AnswerValue = {
  value_text?: string | null;
  value_number?: number | null;
  value_boolean?: boolean | null;
  value_date?: string | null;
  value_choices?: string[] | null;
};

export type RepeatingRowState = { rowKey: string; answers: Record<string, AnswerValue> };

type AnswerPayload = {
  template_field_id: string;
  value_text?: string | null;
  value_number?: number | null;
  value_boolean?: boolean | null;
  value_date?: string | null;
  value_choices?: string[] | null;
};

export type CalibrationFormPayload = {
  answers: AnswerPayload[];
  repeating_rows: { task_id: string; answers: AnswerPayload[] }[];
};

function isRowEmpty(answers: Record<string, AnswerValue>): boolean {
  return Object.values(answers).every((a) => {
    const hasText = typeof a.value_text === "string" && a.value_text.trim().length > 0;
    const hasNumber = typeof a.value_number === "number" && Number.isFinite(a.value_number);
    const hasBoolean = typeof a.value_boolean === "boolean";
    const hasDate = typeof a.value_date === "string" && a.value_date.trim().length > 0;
    const hasChoices = Array.isArray(a.value_choices) && a.value_choices.length > 0;
    return !hasText && !hasNumber && !hasBoolean && !hasDate && !hasChoices;
  });
}

let rowKeyCounter = 0;
function nextRowKey() {
  rowKeyCounter += 1;
  return `row-${rowKeyCounter}`;
}

function passFailLabels(field: TemplateField): [string, string] {
  const options = field.choice_options ?? [];
  return [options[0] ?? "Pass", options[1] ?? "Fail"];
}

function FieldControl({ field, value, onChange }: { field: TemplateField; value: AnswerValue; onChange: (value: AnswerValue) => void }) {
  const helpText = field.help_text ? <p style={{ margin: "0.1rem 0 0", fontSize: "0.85em", color: "var(--text-muted)" }}>{field.help_text}</p> : null;

  switch (field.field_type) {
    case "checkbox": {
      const options = field.choice_options ?? [];
      const checked = value.value_choices ?? [];
      function toggle(option: string, isChecked: boolean) {
        const next = isChecked ? [...checked, option] : checked.filter((o) => o !== option);
        onChange({ value_choices: next });
      }
      return (
        <div>
          <span style={{ display: "block", marginBottom: "0.25rem" }}>{field.label}{field.is_required ? " *" : ""}</span>
          {options.map((option) => (
            <label key={option} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={checked.includes(option)}
                onChange={(e) => toggle(option, e.target.checked)}
                style={{ width: "auto", marginRight: "0.4rem" }}
              />
              {option}
            </label>
          ))}
          {helpText}
        </div>
      );
    }
    case "short_text":
      return (
        <label>
          {field.label}{field.is_required ? " *" : ""}
          <input
            type="text" value={value.value_text ?? ""} placeholder={field.placeholder ?? undefined}
            onChange={(e) => onChange({ value_text: e.target.value })}
          />
          {helpText}
        </label>
      );
    case "long_text":
      return (
        <label>
          {field.label}{field.is_required ? " *" : ""}
          <textarea
            rows={3} value={value.value_text ?? ""} placeholder={field.placeholder ?? undefined}
            onChange={(e) => onChange({ value_text: e.target.value })}
          />
          {helpText}
        </label>
      );
    case "number":
      return (
        <label>
          {field.label}{field.unit ? ` (${field.unit})` : ""}{field.is_required ? " *" : ""}
          <input
            type="number" inputMode="decimal" step="any"
            value={value.value_number ?? ""} placeholder={field.placeholder ?? undefined}
            onChange={(e) => onChange({ value_number: e.target.value === "" ? null : Number(e.target.value) })}
          />
          {helpText}
        </label>
      );
    case "date":
      return (
        <label>
          {field.label}{field.is_required ? " *" : ""}
          <input type="date" value={value.value_date ?? ""} onChange={(e) => onChange({ value_date: e.target.value })} />
          {helpText}
        </label>
      );
    case "multiple_choice":
      return (
        <label>
          {field.label}{field.is_required ? " *" : ""}
          <select value={value.value_text ?? ""} onChange={(e) => onChange({ value_text: e.target.value })}>
            <option value="">— Select —</option>
            {(field.choice_options ?? []).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
          {helpText}
        </label>
      );
    case "pass_fail": {
      const [passLabel, failLabel] = passFailLabels(field);
      const isPass = value.value_boolean === true;
      const isFail = value.value_boolean === false;
      // .secondary/.danger only render distinctly inside .form-actions (see
      // index.css) — this control sits in a plain .row-actions div, where
      // .secondary has no matching rule at all and .danger is just a faint
      // background tint, so selected vs. unselected looked identical.
      // Explicit inline styling here isn't at the mercy of that scoping.
      return (
        <div>
          <span style={{ display: "block", marginBottom: "0.25rem" }}>{field.label}{field.is_required ? " *" : ""}</span>
          <div className="row-actions">
            <button
              type="button"
              onClick={() => onChange({ value_boolean: true })}
              aria-pressed={isPass}
              style={{
                background: isPass ? "#0c6a56" : "var(--surface)",
                color: isPass ? "#ffffff" : "var(--text)",
                borderColor: isPass ? "#0c6a56" : "var(--border)",
                fontWeight: isPass ? 700 : 400
              }}
            >
              {passLabel}
            </button>
            <button
              type="button"
              onClick={() => onChange({ value_boolean: false })}
              aria-pressed={isFail}
              style={{
                background: isFail ? "#b42318" : "var(--surface)",
                color: isFail ? "#ffffff" : "var(--text)",
                borderColor: isFail ? "#b42318" : "var(--border)",
                fontWeight: isFail ? 700 : 400
              }}
            >
              {failLabel}
            </button>
          </div>
          {helpText}
        </div>
      );
    }
    default:
      return null;
  }
}

function validateField(field: TemplateField, value: AnswerValue | undefined): string | null {
  const v = value ?? {};
  switch (field.field_type) {
    case "checkbox":
      if (field.is_required && !(v.value_choices && v.value_choices.length > 0)) {
        return `"${field.label}" requires at least one checkbox checked.`;
      }
      return null;
    case "pass_fail":
      if (field.is_required && typeof v.value_boolean !== "boolean") return `"${field.label}" is required.`;
      return null;
    case "short_text":
    case "long_text":
      if (field.is_required && !(v.value_text ?? "").trim()) return `"${field.label}" is required.`;
      return null;
    case "multiple_choice":
      if (field.is_required && !(v.value_text ?? "").trim()) return `"${field.label}" is required.`;
      return null;
    case "date":
      if (field.is_required && !(v.value_date ?? "").trim()) return `"${field.label}" is required.`;
      return null;
    case "number": {
      const hasValue = typeof v.value_number === "number" && Number.isFinite(v.value_number);
      if (field.is_required && !hasValue) return `"${field.label}" is required.`;
      if (hasValue) {
        if (field.min_value !== null && (v.value_number as number) < field.min_value) return `"${field.label}" must be at least ${field.min_value}.`;
        if (field.max_value !== null && (v.value_number as number) > field.max_value) return `"${field.label}" must be at most ${field.max_value}.`;
      }
      return null;
    }
    default:
      return null;
  }
}

function toAnswerPayload(fieldId: string, value: AnswerValue | undefined): AnswerPayload {
  return { template_field_id: fieldId, ...(value ?? {}) };
}

type CalibrationFormProps = {
  detail: DeviceDetail;
  onValidSubmit: (payload: CalibrationFormPayload) => void;
  // Disables the submit button while a completion request is in flight —
  // double-tap protection independent of (and in addition to) the server's
  // completion_request_id idempotency key, which only guards against a
  // request actually reaching the network twice, not two rapid taps firing
  // two requests in the first place.
  submitting: boolean;
};

export function CalibrationForm({ detail, onValidSubmit, submitting }: CalibrationFormProps) {
  const [instructionsOpen, setInstructionsOpen] = useState(true);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [rowsByTask, setRowsByTask] = useState<Record<string, RepeatingRowState[]>>({});
  const [error, setError] = useState<string | null>(null);

  const tasks = [...detail.tasks].sort((a, b) => a.sort_order - b.sort_order);
  const fieldsByTask = new Map<string, TemplateField[]>();
  for (const task of tasks) {
    fieldsByTask.set(task.id, detail.fields.filter((f) => f.task_id === task.id).sort((a, b) => a.sort_order - b.sort_order));
  }

  function addRow(taskId: string) {
    setRowsByTask((current) => ({
      ...current,
      [taskId]: [...(current[taskId] ?? []), { rowKey: nextRowKey(), answers: {} }]
    }));
  }

  function removeRow(taskId: string, rowKey: string) {
    setRowsByTask((current) => ({
      ...current,
      [taskId]: (current[taskId] ?? []).filter((r) => r.rowKey !== rowKey)
    }));
  }

  function updateRowAnswer(taskId: string, rowKey: string, fieldId: string, value: AnswerValue) {
    setRowsByTask((current) => ({
      ...current,
      [taskId]: (current[taskId] ?? []).map((r) =>
        r.rowKey === rowKey ? { ...r, answers: { ...r.answers, [fieldId]: value } } : r
      )
    }));
  }

  function handleSubmit() {
    setError(null);

    for (const task of tasks) {
      if (task.is_repeating) continue;
      for (const field of fieldsByTask.get(task.id) ?? []) {
        const message = validateField(field, answers[field.id]);
        if (message) return setError(message);
      }
    }

    for (const task of tasks) {
      if (!task.is_repeating) continue;
      const fields = fieldsByTask.get(task.id) ?? [];
      const rows = (rowsByTask[task.id] ?? []).filter((r) => !isRowEmpty(r.answers));
      if (task.min_rows !== null && rows.length < task.min_rows) {
        return setError(`"${task.name}" requires at least ${task.min_rows} row(s).`);
      }
      if (task.max_rows !== null && rows.length > task.max_rows) {
        return setError(`"${task.name}" allows at most ${task.max_rows} row(s).`);
      }
      for (const row of rows) {
        for (const field of fields) {
          const message = validateField(field, row.answers[field.id]);
          if (message) return setError(message);
        }
      }
    }

    const payload: CalibrationFormPayload = {
      answers: tasks
        .filter((t) => !t.is_repeating)
        .flatMap((task) => (fieldsByTask.get(task.id) ?? []).map((field) => toAnswerPayload(field.id, answers[field.id]))),
      repeating_rows: tasks
        .filter((t) => t.is_repeating)
        .flatMap((task) => {
          const fields = fieldsByTask.get(task.id) ?? [];
          const rows = (rowsByTask[task.id] ?? []).filter((r) => !isRowEmpty(r.answers));
          return rows.map((row) => ({
            task_id: task.id,
            answers: fields.map((field) => toAnswerPayload(field.id, row.answers[field.id]))
          }));
        })
    };

    onValidSubmit(payload);
  }

  return (
    <div>
      {detail.device.instructions ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem", marginBottom: "0.75rem" }}>
          <button
            type="button"
            className="secondary"
            onClick={() => setInstructionsOpen((v) => !v)}
            style={{ marginBottom: instructionsOpen ? "0.5rem" : 0 }}
          >
            {instructionsOpen ? "Hide" : "Show"} Instructions
          </button>
          {instructionsOpen ? <p>{detail.device.instructions}</p> : null}
        </div>
      ) : null}

      <form className="varieties-form" onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        {tasks.map((task) => {
          const fields = fieldsByTask.get(task.id) ?? [];

          if (!task.is_repeating) {
            return (
              <div key={task.id} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem" }}>
                <strong>{task.name}</strong>
                <div style={{ marginTop: "0.5rem" }}>
                  {fields.map((field) => (
                    <FieldControl
                      key={field.id}
                      field={field}
                      value={answers[field.id] ?? {}}
                      onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}
                    />
                  ))}
                </div>
              </div>
            );
          }

          const rows = rowsByTask[task.id] ?? [];
          const atMax = task.max_rows !== null && rows.length >= task.max_rows;
          return (
            <div key={task.id} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem" }}>
              <strong>{task.name}</strong>
              {rows.map((row, rowIndex) => (
                <div key={row.rowKey} style={{ borderTop: "1px solid var(--border)", marginTop: "0.5rem", paddingTop: "0.5rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                    <strong style={{ fontSize: "0.9em" }}>Row {rowIndex + 1}</strong>
                    <button type="button" className="danger" onClick={() => removeRow(task.id, row.rowKey)}>Remove Row</button>
                  </div>
                  {fields.map((field) => (
                    <FieldControl
                      key={field.id}
                      field={field}
                      value={row.answers[field.id] ?? {}}
                      onChange={(value) => updateRowAnswer(task.id, row.rowKey, field.id, value)}
                    />
                  ))}
                </div>
              ))}
              <div className="varieties-toolbar">
                <button type="button" onClick={() => addRow(task.id)} disabled={atMax}>+ Add Row</button>
              </div>
            </div>
          );
        })}

        {error ? <p className="form-error">{error}</p> : null}

        <div className="form-actions" style={{ position: "sticky", bottom: 0, background: "var(--surface)", paddingTop: "0.5rem" }}>
          <button type="submit" className="primary-action-button" disabled={submitting}>
            {submitting ? "Saving..." : "Complete Calibration"}
          </button>
        </div>
      </form>
    </div>
  );
}
