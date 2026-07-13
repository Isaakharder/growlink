import type { FoodSafetyDepartment } from "../../lib/foodSafety/types";
import { createEmptyField, type FoodSafetyFieldType, type FoodSafetyFormSection } from "../../lib/foodSafety/formSchema";
import { FieldEditor } from "./FieldEditor";
import { FieldTypePicker } from "./FieldTypePicker";
import { useState } from "react";

type Props = {
  section: FoodSafetyFormSection;
  departments: FoodSafetyDepartment[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (section: FoodSafetyFormSection) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

export function SectionEditor({ section, departments, canMoveUp, canMoveDown, onChange, onRemove, onMoveUp, onMoveDown }: Props) {
  const [newFieldType, setNewFieldType] = useState<FoodSafetyFieldType>("short_text");

  function addField() {
    const field = createEmptyField(newFieldType, section.fields.length);
    onChange({ ...section, fields: [...section.fields, field] });
  }

  function updateField(index: number, next: import("../../lib/foodSafety/formSchema").FoodSafetyFormField) {
    onChange({ ...section, fields: section.fields.map((f, i) => (i === index ? next : f)) });
  }

  function removeField(index: number) {
    onChange({ ...section, fields: section.fields.filter((_, i) => i !== index) });
  }

  function moveField(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= section.fields.length) return;
    const fields = [...section.fields];
    [fields[index], fields[target]] = [fields[target], fields[index]];
    onChange({ ...section, fields: fields.map((f, i) => ({ ...f, sortOrder: i })) });
  }

  return (
    <div className="coming-soon-card" style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "0.5rem" }}>
        <label style={{ flex: "1 1 260px" }}>
          Section title
          <input type="text" value={section.title} onChange={(event) => onChange({ ...section, title: event.target.value })} />
        </label>
        <div className="row-actions">
          <button type="button" onClick={onMoveUp} disabled={!canMoveUp}>
            Move up
          </button>
          <button type="button" onClick={onMoveDown} disabled={!canMoveDown}>
            Move down
          </button>
          <button type="button" className="danger" onClick={onRemove}>
            Remove section
          </button>
        </div>
      </div>

      <label style={{ display: "block", marginBottom: "0.6rem" }}>
        Section description
        <input
          type="text"
          value={section.description ?? ""}
          onChange={(event) => onChange({ ...section, description: event.target.value })}
        />
      </label>

      {section.fields.length === 0 ? <p>No fields in this section yet.</p> : null}

      {section.fields.map((field, index) => (
        <FieldEditor
          key={field.id}
          field={field}
          departments={departments}
          canMoveUp={index > 0}
          canMoveDown={index < section.fields.length - 1}
          onChange={(next) => updateField(index, next)}
          onRemove={() => removeField(index)}
          onMoveUp={() => moveField(index, -1)}
          onMoveDown={() => moveField(index, 1)}
        />
      ))}

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
        <FieldTypePicker value={newFieldType} onChange={setNewFieldType} />
        <button type="button" onClick={addField}>
          + Add Field
        </button>
      </div>
    </div>
  );
}
