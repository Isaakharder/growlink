// Generic "list of small text rows, add/remove" widget, structurally and
// visually identical to Food Safety's checkbox action-label editor
// (FoodSafetyLocationsPage.tsx: cleaning-task-checkboxes /
// cleaning-task-checkboxes-header / cleaning-task-checkbox-row /
// cleaning-tasks-empty) — same header row (label left, "+ Add" button
// right, on one line), same indented/left-bordered row list below, same
// empty-state message. Reuses those exact CSS classes rather than
// approximating them, so this widget reads as the same control wherever
// it appears (Calibration's checkboxes, pass/fail-style option lists,
// multiple_choice options).

type StringListEditorProps = {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addButtonLabel?: string;
  emptyMessage?: string;
};

export function StringListEditor({
  label, items, onChange, placeholder, addButtonLabel = "+ Add", emptyMessage = "Nothing added yet."
}: StringListEditorProps) {
  return (
    <div className="cleaning-task-checkboxes">
      <div className="cleaning-task-checkboxes-header">
        <span>{label}</span>
        <button type="button" onClick={() => onChange([...items, ""])}>
          {addButtonLabel}
        </button>
      </div>

      {items.length === 0 ? <p className="cleaning-tasks-empty">{emptyMessage}</p> : null}

      {items.map((item, index) => (
        <div className="cleaning-task-checkbox-row" key={index}>
          <input
            type="text"
            value={item}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((v, i) => (i === index ? e.target.value : v)))}
          />
          <button type="button" className="danger" onClick={() => onChange(items.filter((_, i) => i !== index))}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
