import type { FoodSafetyEmployee } from "../../../lib/foodSafety/types";

type Props = {
  employees: FoodSafetyEmployee[];
  selectedEmployeeId: string | null;
  onSelectEmployee: (employeeId: string | null) => void;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  disabled?: boolean;
};

// Phase 3's "signature" is an explicit digital confirmation action, not a
// drawn signature — this component is where employee identity is captured
// alongside that confirmation, immediately before Submit.
export function EmployeeConfirmation({
  employees,
  selectedEmployeeId,
  onSelectEmployee,
  confirmed,
  onConfirmedChange,
  disabled
}: Props) {
  return (
    <div className="coming-soon-card">
      <h3 style={{ marginTop: 0 }}>Confirm &amp; Submit</h3>

      <label style={{ display: "block", marginBottom: "0.6rem" }}>
        Completed by
        <select
          value={selectedEmployeeId ?? ""}
          disabled={disabled}
          onChange={(event) => onSelectEmployee(event.target.value || null)}
        >
          <option value="">Select employee...</option>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.display_name}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(event) => onConfirmedChange(event.target.checked)}
        />
        <span>I confirm that the information entered is complete and accurate.</span>
      </label>
    </div>
  );
}
