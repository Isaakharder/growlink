import type { FoodSafetyFormSection } from "../../../lib/foodSafety/formSchema";
import type { FoodSafetyEmployee, FoodSafetyLocation } from "../../../lib/foodSafety/types";
import { RecordFieldInput } from "./RecordFieldInput";

type Props = {
  section: FoodSafetyFormSection;
  answers: Record<string, unknown>;
  onFieldChange: (fieldId: string, value: unknown) => void;
  employees: FoodSafetyEmployee[];
  locations: FoodSafetyLocation[];
  readOnly?: boolean;
  errors?: Record<string, string>;
};

export function RecordSection({ section, answers, onFieldChange, employees, locations, readOnly, errors }: Props) {
  const sortedFields = [...section.fields].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="coming-soon-card" style={{ marginBottom: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>{section.title}</h3>
      {section.description ? <p>{section.description}</p> : null}
      {sortedFields.map((field) => (
        <RecordFieldInput
          key={field.id}
          field={field}
          value={answers[field.id]}
          onChange={(value) => onFieldChange(field.id, value)}
          employees={employees}
          locations={locations}
          readOnly={readOnly}
          error={errors?.[field.id]}
        />
      ))}
    </div>
  );
}
