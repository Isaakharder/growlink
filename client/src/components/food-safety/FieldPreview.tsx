import type { FoodSafetyFormField } from "../../lib/foodSafety/formSchema";

type Props = {
  field: FoodSafetyFormField;
};

// Read-only rendering of a single field "as an employee would see it".
// There is no submission behavior yet — every control is disabled and
// nothing here collects or stores a value.
export function FieldPreview({ field }: Props) {
  const config = field.config ?? {};

  if (field.type === "information") {
    return (
      <div style={{ background: "var(--brand-soft)", border: "1px solid var(--brand)", borderRadius: 8, padding: "0.7rem", margin: "0.5rem 0" }}>
        <p style={{ margin: "0 0 0.3rem", fontWeight: 600 }}>{field.label}</p>
        {config.informationBody ? <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{config.informationBody}</p> : null}
      </div>
    );
  }

  return (
    <div style={{ margin: "0.6rem 0" }}>
      <label style={{ display: "block", fontWeight: 600 }}>
        {field.label}
        {field.required ? <span style={{ color: "#c0392b" }}> *</span> : null}
      </label>
      {field.helpText ? <p style={{ margin: "0.1rem 0 0.3rem", fontSize: "0.82rem" }}>{field.helpText}</p> : null}

      {(field.type === "short_text" || field.type === "employee_selector" || field.type === "location_asset_selector") && (
        <input type="text" placeholder={config.placeholder} disabled />
      )}

      {field.type === "long_text" && <textarea rows={3} placeholder={config.placeholder} disabled />}

      {field.type === "number" && (
        <input type="number" disabled placeholder={config.unitLabel ? `Value (${config.unitLabel})` : "Value"} />
      )}

      {field.type === "date" && <input type="date" disabled />}
      {field.type === "time" && <input type="time" disabled />}

      {field.type === "checkbox" && (
        <label style={{ fontWeight: 400 }}>
          <input type="checkbox" disabled /> Yes
        </label>
      )}

      {field.type === "yes_no" && (
        <div className="row-actions">
          <button type="button" disabled>
            Yes
          </button>
          <button type="button" disabled>
            No
          </button>
        </div>
      )}

      {field.type === "pass_fail" && (
        <div className="row-actions">
          <button type="button" disabled>
            Pass
          </button>
          <button type="button" disabled>
            Fail
          </button>
        </div>
      )}

      {field.type === "select" && (
        <select disabled>
          <option>Select...</option>
          {(config.options ?? []).map((option) => (
            <option key={option.value}>{option.label}</option>
          ))}
        </select>
      )}

      {field.type === "multi_select" && (
        <div>
          {(config.options ?? []).map((option) => (
            <label key={option.value} style={{ display: "block", fontWeight: 400 }}>
              <input type="checkbox" disabled /> {option.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
