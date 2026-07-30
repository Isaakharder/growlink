import { FIELD_TYPE_OPTIONS, FieldType, Task, TemplateField } from "./types";
import { StringListEditor } from "../../components/StringListEditor";

// A top-level Calibration Task always contains one or more Response
// Fields — a genuine two-level structure (Task -> Fields), not a single
// flat list wearing two hats. "Repeating" is a per-task boolean, not a
// separate field type: a plain task ("Nozzle 1", several fields, answered
// once) and a repeating task ("Nozzle Measurements", the employee adds
// rows) are the same shape underneath, just is_repeating flipped.
//
// Deliberately two separate, non-recursive components (TaskListEditor for
// the task-card list, FieldRowList for a task's own field list) rather than
// the old single recursive component — there is no nesting beyond one
// level, so recursion was solving a problem that doesn't exist anymore.

export type EditableField = {
  _key: string; // real field id if loaded from server, else "new-N"
  _isNew: boolean;
  field_type: FieldType;
  label: string;
  help_text: string;
  is_required: boolean;
  placeholder: string;
  unit: string;
  min_value: string;
  max_value: string;
  decimal_precision: string;
  choice_options: string[];
};

export type EditableTask = {
  _key: string; // real task id if loaded from server, else "new-N"
  _isNew: boolean;
  name: string;
  is_repeating: boolean;
  min_rows: string;
  max_rows: string;
  fields: EditableField[];
};

const DEFAULT_PASS_FAIL_LABELS = ["Pass", "Fail"];

let newKeyCounter = 0;
export function nextNewKey(): string {
  newKeyCounter += 1;
  return `new-${newKeyCounter}`;
}
export function isNewKey(key: string): boolean {
  return key.startsWith("new-");
}

export function blankField(): EditableField {
  return {
    _key: nextNewKey(), _isNew: true,
    field_type: "short_text", label: "", help_text: "", is_required: false, placeholder: "", unit: "",
    min_value: "", max_value: "", decimal_precision: "", choice_options: []
  };
}

// A new task is never left empty — one blank field is seeded immediately
// so a simple single-field task ("Scale calibrated correctly") is exactly
// as easy to create as a multi-field one.
export function blankTask(): EditableTask {
  return {
    _key: nextNewKey(), _isNew: true, name: "", is_repeating: false, min_rows: "", max_rows: "",
    fields: [blankField()]
  };
}

export function tasksFromServer(tasks: Task[], fields: TemplateField[]): EditableTask[] {
  return tasks
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((task) => ({
      _key: task.id,
      _isNew: false,
      name: task.name,
      is_repeating: task.is_repeating,
      min_rows: task.min_rows !== null ? String(task.min_rows) : "",
      max_rows: task.max_rows !== null ? String(task.max_rows) : "",
      fields: fields
        .filter((f) => f.task_id === task.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((f) => ({
          _key: f.id,
          _isNew: false,
          field_type: f.field_type,
          label: f.label,
          help_text: f.help_text ?? "",
          is_required: f.is_required,
          placeholder: f.placeholder ?? "",
          unit: f.unit ?? "",
          min_value: f.min_value !== null ? String(f.min_value) : "",
          max_value: f.max_value !== null ? String(f.max_value) : "",
          decimal_precision: f.decimal_precision !== null ? String(f.decimal_precision) : "",
          choice_options: f.choice_options ?? []
        }))
    }));
}

function moveInArray<T>(items: T[], index: number, direction: "up" | "down"): T[] {
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= items.length) return items;
  const next = [...items];
  [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  return next;
}

function changeFieldTypeDefaults(nextType: FieldType): Partial<EditableField> {
  if (nextType === "pass_fail") return { field_type: nextType, choice_options: [...DEFAULT_PASS_FAIL_LABELS] };
  if (nextType === "checkbox" || nextType === "multiple_choice") return { field_type: nextType, choice_options: [] };
  return { field_type: nextType };
}

function FieldRowList({ fields, onChange }: { fields: EditableField[]; onChange: (fields: EditableField[]) => void }) {
  function updateField(key: string, patch: Partial<EditableField>) {
    onChange(fields.map((f) => (f._key === key ? { ...f, ...patch } : f)));
  }
  function removeField(key: string) {
    onChange(fields.filter((f) => f._key !== key));
  }
  function addField() {
    onChange([...fields, blankField()]);
  }

  return (
    <div style={{ marginTop: "0.5rem", marginLeft: "1rem" }}>
      <div className="cleaning-tasks-header">
        <span>Response Fields</span>
        <button type="button" onClick={addField}>+ Add Response Field</button>
      </div>

      {fields.length === 0 ? <p className="cleaning-tasks-empty">No response fields yet. Add at least one.</p> : null}

      {fields.map((field, index) => {
        const fieldLabel = field.label.trim() || `field ${index + 1}`;
        return (
          <div className="cleaning-task-row" key={field._key}>
            <div className="cleaning-task-row-main">
              <input
                type="text"
                value={field.label}
                onChange={(e) => updateField(field._key, { label: e.target.value })}
                placeholder="Field label, e.g. Volume collected"
                aria-label={`Field ${index + 1} label`}
              />
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="button" onClick={() => onChange(moveInArray(fields, index, "up"))} aria-label={`Move ${fieldLabel} up`}>↑</button>
                <button type="button" onClick={() => onChange(moveInArray(fields, index, "down"))} aria-label={`Move ${fieldLabel} down`}>↓</button>
                <button type="button" className="danger" onClick={() => removeField(field._key)} aria-label={`Remove ${fieldLabel}`}>
                  Remove Field
                </button>
              </div>
            </div>

            <div className="cleaning-task-row-options">
              <select
                value={field.field_type}
                onChange={(e) => updateField(field._key, changeFieldTypeDefaults(e.target.value as FieldType))}
                disabled={!field._isNew}
                aria-label={`Response type for ${fieldLabel}`}
              >
                {FIELD_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {!field._isNew ? (
                <span style={{ fontSize: "0.8em", color: "var(--text-muted)", marginLeft: "0.5rem" }}>
                  Type can't be changed after creation — remove and re-add to change it.
                </span>
              ) : null}
              <label style={{ marginLeft: "0.75rem" }}>
                <input
                  type="checkbox"
                  checked={field.is_required}
                  onChange={(e) => updateField(field._key, { is_required: e.target.checked })}
                  style={{ width: "auto", marginRight: "0.3rem" }}
                />
                Required
              </label>
            </div>

            {field.field_type === "checkbox" ? (
              <StringListEditor
                label="Checkboxes"
                items={field.choice_options}
                onChange={(items) => updateField(field._key, { choice_options: items })}
                placeholder="Checkbox label, e.g. Clean"
                addButtonLabel="+ Add Checkbox"
                emptyMessage="No checkboxes yet. Add at least one."
              />
            ) : null}

            {field.field_type === "pass_fail" ? (
              <div className="cleaning-task-checkboxes">
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <label style={{ flex: 1 }}>
                    Pass label
                    <input
                      type="text"
                      value={field.choice_options[0] ?? "Pass"}
                      onChange={(e) => updateField(field._key, { choice_options: [e.target.value, field.choice_options[1] ?? "Fail"] })}
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    Fail label
                    <input
                      type="text"
                      value={field.choice_options[1] ?? "Fail"}
                      onChange={(e) => updateField(field._key, { choice_options: [field.choice_options[0] ?? "Pass", e.target.value] })}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {field.field_type === "multiple_choice" ? (
              <StringListEditor
                label="Options"
                items={field.choice_options}
                onChange={(items) => updateField(field._key, { choice_options: items })}
                placeholder="Option label"
                addButtonLabel="+ Add Option"
                emptyMessage="No options yet. Add at least one."
              />
            ) : null}

            {field.field_type === "short_text" || field.field_type === "long_text" ? (
              <div className="cleaning-task-checkboxes">
                <label>
                  Placeholder text
                  <input
                    type="text"
                    value={field.placeholder}
                    onChange={(e) => updateField(field._key, { placeholder: e.target.value })}
                    placeholder="e.g. Enter displayed weight..."
                  />
                </label>
              </div>
            ) : null}

            {field.field_type === "number" ? (
              <div className="cleaning-task-checkboxes">
                <label>
                  Placeholder text
                  <input
                    type="text"
                    value={field.placeholder}
                    onChange={(e) => updateField(field._key, { placeholder: e.target.value })}
                    placeholder="e.g. Enter measured weight"
                  />
                </label>
                <label>Unit<input type="text" value={field.unit} onChange={(e) => updateField(field._key, { unit: e.target.value })} placeholder="e.g. kg, psi, mL" /></label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <label style={{ flex: 1 }}>Min value<input type="number" value={field.min_value} onChange={(e) => updateField(field._key, { min_value: e.target.value })} /></label>
                  <label style={{ flex: 1 }}>Max value<input type="number" value={field.max_value} onChange={(e) => updateField(field._key, { max_value: e.target.value })} /></label>
                  <label style={{ flex: 1 }}>Decimal precision<input type="number" min="0" value={field.decimal_precision} onChange={(e) => updateField(field._key, { decimal_precision: e.target.value })} /></label>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type TaskListEditorProps = {
  tasks: EditableTask[];
  onChange: (tasks: EditableTask[]) => void;
};

export function TaskListEditor({ tasks, onChange }: TaskListEditorProps) {
  function updateTask(key: string, patch: Partial<EditableTask>) {
    onChange(tasks.map((t) => (t._key === key ? { ...t, ...patch } : t)));
  }
  function removeTask(key: string) {
    onChange(tasks.filter((t) => t._key !== key));
  }
  function addTask() {
    onChange([...tasks, blankTask()]);
  }

  return (
    <div className="cleaning-tasks-section">
      <div className="cleaning-tasks-header">
        <span>Tasks</span>
        <button type="button" onClick={addTask}>+ Add Task</button>
      </div>

      {tasks.length === 0 ? <p className="cleaning-tasks-empty">No tasks yet. Add at least one.</p> : null}

      {tasks.map((task, index) => {
        const taskLabel = task.name.trim() || `task ${index + 1}`;
        return (
          <div className="cleaning-task-row" key={task._key}>
            <div className="cleaning-task-row-main">
              <input
                type="text"
                value={task.name}
                onChange={(e) => updateTask(task._key, { name: e.target.value })}
                placeholder="Task name — the card the employee sees, e.g. Nozzle 1"
                aria-label={`Task ${index + 1} name`}
              />
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="button" onClick={() => onChange(moveInArray(tasks, index, "up"))} aria-label={`Move ${taskLabel} up`}>↑</button>
                <button type="button" onClick={() => onChange(moveInArray(tasks, index, "down"))} aria-label={`Move ${taskLabel} down`}>↓</button>
                <button type="button" className="danger" onClick={() => removeTask(task._key)} aria-label={`Remove ${taskLabel}`}>
                  Remove Task
                </button>
              </div>
            </div>

            <div className="cleaning-task-row-options">
              <label>
                <input
                  type="checkbox"
                  checked={task.is_repeating}
                  onChange={(e) => updateTask(task._key, { is_repeating: e.target.checked })}
                  style={{ width: "auto", marginRight: "0.3rem" }}
                />
                Repeating (employee can add/remove rows)
              </label>
              {task.is_repeating ? (
                <>
                  <label style={{ marginLeft: "0.75rem" }}>Min rows<input type="number" min="0" value={task.min_rows} onChange={(e) => updateTask(task._key, { min_rows: e.target.value })} /></label>
                  <label style={{ marginLeft: "0.5rem" }}>Max rows<input type="number" min="0" value={task.max_rows} onChange={(e) => updateTask(task._key, { max_rows: e.target.value })} /></label>
                </>
              ) : null}
            </div>

            <FieldRowList fields={task.fields} onChange={(fields) => updateTask(task._key, { fields })} />
          </div>
        );
      })}
    </div>
  );
}
