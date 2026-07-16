import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listDepartments, listEmployees, listRecords, listTemplates } from "../../lib/foodSafety/api";
import type {
  FoodSafetyDepartment,
  FoodSafetyEmployee,
  FoodSafetyFormTemplateListItem,
  FoodSafetyRecord,
  FoodSafetyRecordStatus
} from "../../lib/foodSafety/types";
import { RecordStatusBadge } from "../../components/food-safety/record/RecordStatusBadge";

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

export function FoodSafetyRecordsPage() {
  const [records, setRecords] = useState<FoodSafetyRecord[]>([]);
  const [templates, setTemplates] = useState<FoodSafetyFormTemplateListItem[]>([]);
  const [departments, setDepartments] = useState<FoodSafetyDepartment[]>([]);
  const [employees, setEmployees] = useState<FoodSafetyEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<FoodSafetyRecordStatus | "">("");
  const [templateId, setTemplateId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const templateNameById = useMemo(() => new Map(templates.map((t) => [t.id, t.name])), [templates]);
  const departmentNameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  const employeeNameById = useMemo(() => new Map(employees.map((e) => [e.id, e.display_name])), [employees]);

  useEffect(() => {
    void Promise.all([listTemplates(), listDepartments(), listEmployees()]).then(
      ([templateRows, departmentRows, employeeRows]) => {
        setTemplates(templateRows);
        setDepartments(departmentRows);
        setEmployees(employeeRows);
      }
    );
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const rows = await listRecords({
        status: status || undefined,
        template_id: templateId || undefined,
        department_id: departmentId || undefined,
        employee_id: employeeId || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined
      });
      setRecords(rows);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load records.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, templateId, departmentId, employeeId, dateFrom, dateTo]);

  return (
    <section className="page-shell">
      <header>
        <h1>Food Safety — Records</h1>
        <p>Submitted, verified, and rejected Food Safety records.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        <div className="varieties-toolbar" style={{ flexWrap: "wrap" }}>
          <select value={status} onChange={(event) => setStatus(event.target.value as FoodSafetyRecordStatus | "")}>
            <option value="">All statuses</option>
            <option value="submitted">Awaiting Verification</option>
            <option value="verified">Verified</option>
            <option value="rejected">Rejected</option>
            <option value="amended">Amended</option>
          </select>
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <option value="">All forms</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
          <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">All employees</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.display_name}
              </option>
            ))}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
            From
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
            To
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
        </div>

        {loading ? <p>Loading...</p> : null}
        {!loading && records.length === 0 ? <p>No records match the current filters.</p> : null}

        {!loading && records.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Form</th>
                  <th>Record Date</th>
                  <th>Completed By</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Verified/Rejected</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>{templateNameById.get(record.template_id) ?? "-"}</td>
                    <td>{record.record_date}</td>
                    <td>
                      {record.completed_by_employee_id ? employeeNameById.get(record.completed_by_employee_id) ?? "-" : "-"}
                    </td>
                    <td>
                      <RecordStatusBadge status={record.status} />
                    </td>
                    <td>{formatDateTime(record.submitted_at)}</td>
                    <td>
                      {record.status === "verified"
                        ? `Verified ${formatDateTime(record.verified_at)}`
                        : record.status === "rejected"
                          ? `Rejected: ${record.rejection_reason ?? ""}`
                          : "-"}
                    </td>
                    <td>
                      <Link to={`/food-safety/records/${record.id}`}>View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
