import type { FoodSafetyFormSchema } from "../../lib/foodSafety/formSchema";
import { FieldPreview } from "./FieldPreview";

type Props = {
  schema: FoodSafetyFormSchema;
};

// Renders the form exactly as an employee would see it — read-only, no
// submission behavior. Used by the editor's live preview panel and by the
// version history's "Preview" action.
export function FormPreview({ schema }: Props) {
  const sortedSections = [...schema.sections].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div>
      <h2 style={{ marginBottom: "0.2rem" }}>{schema.title || "Untitled form"}</h2>
      {schema.description ? <p style={{ marginTop: 0 }}>{schema.description}</p> : null}
      {schema.instructions ? (
        <div className="coming-soon-card" style={{ marginBottom: "1rem" }}>
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{schema.instructions}</p>
        </div>
      ) : null}

      {sortedSections.length === 0 ? <p>This form has no sections yet.</p> : null}

      {sortedSections.map((section) => (
        <div key={section.id} className="coming-soon-card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>{section.title}</h3>
          {section.description ? <p>{section.description}</p> : null}
          {[...section.fields]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((field) => (
              <FieldPreview key={field.id} field={field} />
            ))}
        </div>
      ))}
    </div>
  );
}
