import type { FoodSafetyFormField } from "../../../lib/foodSafety/formSchema";
import type { FoodSafetyEmployee, FoodSafetyLocation } from "../../../lib/foodSafety/types";

type Props = {
  field: FoodSafetyFormField;
  value: unknown;
  onChange: (value: unknown) => void;
  employees: FoodSafetyEmployee[];
  locations: FoodSafetyLocation[];
  readOnly?: boolean;
  error?: string;
};

// A real, interactive input for one field — the completion-time counterpart
// to FieldPreview (which is read-only and never collects a value). Answers
// are always addressed by the field's stable id, never its label.
export function RecordFieldInput({ field, value, onChange, employees, locations, readOnly, error }: Props) {
  const config = field.config ?? {};

  if (field.type === "information") {
    return (
      <div
        style={{
          background: "var(--brand-soft)",
          border: "1px solid var(--brand)",
          borderRadius: 8,
          padding: "0.7rem",
          margin: "0.5rem 0"
        }}
      >
        <p style={{ margin: "0 0 0.3rem", fontWeight: 600 }}>{field.label}</p>
        {config.informationBody ? <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{config.informationBody}</p> : null}
      </div>
    );
  }

  const filteredLocations = locations.filter((location) => {
    if (config.filterDepartmentId && location.department_id !== config.filterDepartmentId) return false;
    if (config.filterLocationType && location.location_type !== config.filterLocationType) return false;
    return true;
  });
  const eligibleEmployees = config.activeEmployeesOnly ? employees.filter((employee) => employee.active) : employees;

  return (
    <div style={{ margin: "0.6rem 0" }}>
      <label style={{ display: "block", fontWeight: 600 }}>
        {field.label}
        {field.required ? <span style={{ color: "#c0392b" }}> *</span> : null}
      </label>
      {field.helpText ? <p style={{ margin: "0.1rem 0 0.3rem", fontSize: "0.82rem" }}>{field.helpText}</p> : null}

      {field.type === "short_text" && (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={config.placeholder}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {field.type === "long_text" && (
        <textarea
          rows={3}
          value={typeof value === "string" ? value : ""}
          placeholder={config.placeholder}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {field.type === "number" && (
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          disabled={readOnly}
          placeholder={config.unitLabel ? `Value (${config.unitLabel})` : "Value"}
          onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        />
      )}

      {field.type === "date" && (
        <input
          type="date"
          value={typeof value === "string" ? value : ""}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value || null)}
        />
      )}

      {field.type === "time" && (
        <input
          type="time"
          value={typeof value === "string" ? value : ""}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value || null)}
        />
      )}

      {field.type === "checkbox" && (
        <label style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={value === true} disabled={readOnly} onChange={(event) => onChange(event.target.checked)} /> Yes
        </label>
      )}

      {field.type === "yes_no" && (
        <div className="row-actions">
          <button
            type="button"
            disabled={readOnly}
            className={value === true ? "" : "secondary"}
            onClick={() => onChange(true)}
          >
            Yes
          </button>
          <button
            type="button"
            disabled={readOnly}
            className={value === false ? "" : "secondary"}
            onClick={() => onChange(false)}
          >
            No
          </button>
        </div>
      )}

      {field.type === "pass_fail" && (
        <div className="row-actions">
          <button type="button" disabled={readOnly} className={value === "pass" ? "" : "secondary"} onClick={() => onChange("pass")}>
            Pass
          </button>
          <button type="button" disabled={readOnly} className={value === "fail" ? "" : "secondary"} onClick={() => onChange("fail")}>
            Fail
          </button>
        </div>
      )}

      {field.type === "select" && (
        <select value={typeof value === "string" ? value : ""} disabled={readOnly} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">Select...</option>
          {(config.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}

      {field.type === "multi_select" && (
        <div>
          {(config.options ?? []).map((option) => {
            const selected = Array.isArray(value) && (value as string[]).includes(option.value);
            return (
              <label key={option.value} style={{ display: "block", fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={readOnly}
                  onChange={(event) => {
                    const current = Array.isArray(value) ? [...(value as string[])] : [];
                    if (event.target.checked) {
                      onChange([...current, option.value]);
                    } else {
                      onChange(current.filter((v) => v !== option.value));
                    }
                  }}
                />{" "}
                {option.label}
              </label>
            );
          })}
        </div>
      )}

      {field.type === "employee_selector" && (
        <select value={typeof value === "string" ? value : ""} disabled={readOnly} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">Select employee...</option>
          {eligibleEmployees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.display_name}
            </option>
          ))}
        </select>
      )}

      {field.type === "location_asset_selector" && (
        <select value={typeof value === "string" ? value : ""} disabled={readOnly} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">Select location/asset...</option>
          {filteredLocations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      )}

      {error ? <p className="form-error" style={{ margin: "0.3rem 0 0" }}>{error}</p> : null}
    </div>
  );
}
