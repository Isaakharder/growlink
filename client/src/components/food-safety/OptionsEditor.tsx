import type { SelectOption } from "../../lib/foodSafety/formSchema";
import { generateLocalId } from "../../lib/foodSafety/formSchema";

type Props = {
  options: SelectOption[];
  onChange: (options: SelectOption[]) => void;
  disabled?: boolean;
};

export function OptionsEditor({ options, onChange, disabled }: Props) {
  function updateOption(index: number, patch: Partial<SelectOption>) {
    onChange(options.map((option, i) => (i === index ? { ...option, ...patch } : option)));
  }

  function addOption() {
    const n = options.length + 1;
    onChange([...options, { value: generateLocalId("option"), label: `Option ${n}` }]);
  }

  function removeOption(index: number) {
    onChange(options.filter((_, i) => i !== index));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div>
      <span style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.3rem" }}>Options</span>
      {options.length === 0 ? <p style={{ margin: "0.3rem 0", fontSize: "0.85rem" }}>No options yet.</p> : null}
      {options.map((option, index) => (
        <div
          key={index}
          style={{ display: "flex", gap: "0.4rem", alignItems: "center", margin: "0.3rem 0" }}
        >
          <input
            type="text"
            placeholder="Value"
            value={option.value}
            disabled={disabled}
            onChange={(event) => updateOption(index, { value: event.target.value })}
            style={{ maxWidth: 140 }}
          />
          <input
            type="text"
            placeholder="Label"
            value={option.label}
            disabled={disabled}
            onChange={(event) => updateOption(index, { label: event.target.value })}
          />
          {!disabled ? (
            <div className="row-actions">
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0}>
                Up
              </button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === options.length - 1}>
                Down
              </button>
              <button type="button" className="danger" onClick={() => removeOption(index)}>
                Remove
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {!disabled ? (
        <button type="button" onClick={addOption}>
          + Add Option
        </button>
      ) : null}
    </div>
  );
}
