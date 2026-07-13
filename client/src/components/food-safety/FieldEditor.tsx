import type { FoodSafetyDepartment, FoodSafetyLocationType } from "../../lib/foodSafety/types";
import type { FoodSafetyFieldConfig, FoodSafetyFieldType, FoodSafetyFormField } from "../../lib/foodSafety/formSchema";
import { FieldTypePicker } from "./FieldTypePicker";
import { OptionsEditor } from "./OptionsEditor";

type Props = {
  field: FoodSafetyFormField;
  departments: FoodSafetyDepartment[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (field: FoodSafetyFormField) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

function updateConfig(field: FoodSafetyFormField, patch: Partial<FoodSafetyFieldConfig>): FoodSafetyFormField {
  return { ...field, config: { ...field.config, ...patch } };
}

export function FieldEditor({ field, departments, canMoveUp, canMoveDown, onChange, onRemove, onMoveUp, onMoveDown }: Props) {
  const config = field.config ?? {};

  function handleTypeChange(type: FoodSafetyFieldType) {
    // Switching type discards config from the previous type — mixed config
    // from an unrelated field type is exactly what the server validator
    // rejects, so the builder never produces it in the first place.
    const next: FoodSafetyFormField = { ...field, type, config: undefined };
    onChange(type === "select" || type === "multi_select" ? updateConfig(next, { options: [{ value: "option_1", label: "Option 1" }] }) : next);
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "0.7rem", margin: "0.5rem 0" }}>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "0.5rem" }}>
        <label style={{ flex: "1 1 220px" }}>
          Label
          <input
            type="text"
            value={field.label}
            onChange={(event) => onChange({ ...field, label: event.target.value })}
          />
        </label>

        <label>
          Type
          <FieldTypePicker value={field.type} onChange={handleTypeChange} />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={field.required}
            disabled={field.type === "information"}
            onChange={(event) => onChange({ ...field, required: event.target.checked })}
          />
          Required
        </label>

        <div className="row-actions">
          <button type="button" onClick={onMoveUp} disabled={!canMoveUp}>
            Move up
          </button>
          <button type="button" onClick={onMoveDown} disabled={!canMoveDown}>
            Move down
          </button>
          <button type="button" className="danger" onClick={onRemove}>
            Remove field
          </button>
        </div>
      </div>

      <label>
        Help text
        <input
          type="text"
          value={field.helpText ?? ""}
          onChange={(event) => onChange({ ...field, helpText: event.target.value })}
        />
      </label>

      {(field.type === "short_text" || field.type === "long_text") && (
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          <label>
            Placeholder
            <input
              type="text"
              value={config.placeholder ?? ""}
              onChange={(event) => onChange(updateConfig(field, { placeholder: event.target.value }))}
            />
          </label>
          <label>
            Min length
            <input
              type="number"
              min={0}
              value={config.minLength ?? ""}
              onChange={(event) =>
                onChange(updateConfig(field, { minLength: event.target.value === "" ? undefined : Number(event.target.value) }))
              }
            />
          </label>
          <label>
            Max length
            <input
              type="number"
              min={0}
              value={config.maxLength ?? ""}
              onChange={(event) =>
                onChange(updateConfig(field, { maxLength: event.target.value === "" ? undefined : Number(event.target.value) }))
              }
            />
          </label>
        </div>
      )}

      {field.type === "number" && (
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          <label>
            Min
            <input
              type="number"
              value={config.min ?? ""}
              onChange={(event) => onChange(updateConfig(field, { min: event.target.value === "" ? undefined : Number(event.target.value) }))}
            />
          </label>
          <label>
            Max
            <input
              type="number"
              value={config.max ?? ""}
              onChange={(event) => onChange(updateConfig(field, { max: event.target.value === "" ? undefined : Number(event.target.value) }))}
            />
          </label>
          <label>
            Decimal precision
            <input
              type="number"
              min={0}
              max={10}
              value={config.precision ?? ""}
              onChange={(event) =>
                onChange(updateConfig(field, { precision: event.target.value === "" ? undefined : Number(event.target.value) }))
              }
            />
          </label>
          <label>
            Unit label
            <input
              type="text"
              value={config.unitLabel ?? ""}
              onChange={(event) => onChange(updateConfig(field, { unitLabel: event.target.value }))}
            />
          </label>
        </div>
      )}

      {(field.type === "date" || field.type === "time") && (
        <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginTop: "0.5rem", fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={config.allowDefaultToCurrentValue ?? false}
            onChange={(event) => onChange(updateConfig(field, { allowDefaultToCurrentValue: event.target.checked }))}
          />
          May default to the current {field.type === "date" ? "date" : "time"} in a future submission
        </label>
      )}

      {(field.type === "select" || field.type === "multi_select") && (
        <div style={{ marginTop: "0.5rem" }}>
          <OptionsEditor
            options={config.options ?? []}
            onChange={(options) => onChange(updateConfig(field, { options }))}
          />
        </div>
      )}

      {field.type === "employee_selector" && (
        <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginTop: "0.5rem", fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={config.activeEmployeesOnly ?? false}
            onChange={(event) => onChange(updateConfig(field, { activeEmployeesOnly: event.target.checked }))}
          />
          Active employees only
        </label>
      )}

      {field.type === "location_asset_selector" && (
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          <label>
            Filter by department
            <select
              value={config.filterDepartmentId ?? ""}
              onChange={(event) => onChange(updateConfig(field, { filterDepartmentId: event.target.value || null }))}
            >
              <option value="">Any department</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Filter by type
            <select
              value={config.filterLocationType ?? ""}
              onChange={(event) =>
                onChange(updateConfig(field, { filterLocationType: (event.target.value || null) as FoodSafetyLocationType | null }))
              }
            >
              <option value="">Location or asset</option>
              <option value="location">Location only</option>
              <option value="asset">Asset only</option>
            </select>
          </label>
        </div>
      )}

      {field.type === "information" && (
        <label style={{ display: "block", marginTop: "0.5rem" }}>
          Information body
          <textarea
            rows={3}
            value={config.informationBody ?? ""}
            onChange={(event) => onChange(updateConfig(field, { informationBody: event.target.value }))}
          />
        </label>
      )}
    </div>
  );
}
