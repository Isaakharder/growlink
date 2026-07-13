import { FOOD_SAFETY_FIELD_TYPES, FIELD_TYPE_LABELS, type FoodSafetyFieldType } from "../../lib/foodSafety/formSchema";

type Props = {
  value: FoodSafetyFieldType;
  onChange: (type: FoodSafetyFieldType) => void;
  disabled?: boolean;
};

export function FieldTypePicker({ value, onChange, disabled }: Props) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as FoodSafetyFieldType)}
    >
      {FOOD_SAFETY_FIELD_TYPES.map((type) => (
        <option key={type} value={type}>
          {FIELD_TYPE_LABELS[type]}
        </option>
      ))}
    </select>
  );
}
