import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import { createRecord, listAwaitingVerification, listDepartments, listMobileForms, listMobileRecent } from "../../lib/foodSafety/api";
import type { FoodSafetyDepartment, FoodSafetyRecord, MobileFormListItem } from "../../lib/foodSafety/types";
import { RecordStatusBadge } from "../../components/food-safety/record/RecordStatusBadge";

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
}

export function MobileFoodSafetyPage() {
  const navigate = useNavigate();
  const { can, canAny } = usePermissions();
  const canComplete = can("food_safety:complete");
  const canVerify = can("food_safety:verify");

  const [forms, setForms] = useState<MobileFormListItem[]>([]);
  const [departments, setDepartments] = useState<FoodSafetyDepartment[]>([]);
  const [recent, setRecent] = useState<FoodSafetyRecord[]>([]);
  const [awaiting, setAwaiting] = useState<FoodSafetyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const tasks: Promise<void>[] = [];
      if (canComplete) {
        tasks.push(
          Promise.all([listMobileForms(), listDepartments(), listMobileRecent()]).then(([formRows, departmentRows, recentRows]) => {
            setForms(formRows);
            setDepartments(departmentRows);
            setRecent(recentRows);
          })
        );
      }
      if (canVerify) {
        tasks.push(listAwaitingVerification().then(setAwaiting));
      }
      await Promise.all(tasks);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load Food Safety.");
    } finally {
      setLoading(false);
    }
  }

  const filteredForms = useMemo(() => {
    return forms.filter((form) => {
      if (departmentFilter && form.departmentId !== departmentFilter) return false;
      if (!search.trim()) return true;
      return form.name.toLowerCase().includes(search.trim().toLowerCase());
    });
  }, [forms, search, departmentFilter]);

  const drafts = useMemo(() => recent.filter((record) => record.status === "draft"), [recent]);
  const completedRecent = useMemo(() => recent.filter((record) => record.status !== "draft").slice(0, 10), [recent]);

  async function startForm(templateId: string) {
    if (starting) return; // guards against a double-tap creating two records
    setStarting(templateId);
    setError(null);
    try {
      const record = await createRecord({ template_id: templateId });
      navigate(`/mobile/food-safety/records/${record.id}`);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start form.");
      setStarting(null);
    }
  }

  if (!canAny(["food_safety:complete", "food_safety:verify"])) {
    return (
      <section className="mobile-page">
        <h2>Food Safety</h2>
        <p>You do not have access to Food Safety on mobile.</p>
      </section>
    );
  }

  return (
    <section className="mobile-page">
      <h2>Food Safety</h2>
      {error ? <p className="form-error">{error}</p> : null}
      {loading ? <p>Loading...</p> : null}

      {canVerify && awaiting.length > 0 ? (
        <div className="coming-soon-card">
          <h3>Awaiting Verification ({awaiting.length})</h3>
          {awaiting.slice(0, 10).map((record) => (
            <Link key={record.id} className="mobile-card-button" to={`/mobile/food-safety/records/${record.id}`}>
              <RecordStatusBadge status={record.status} /> {formatDate(record.record_date)}
            </Link>
          ))}
        </div>
      ) : null}

      {canComplete ? (
        <>
          {drafts.length > 0 ? (
            <div className="coming-soon-card">
              <h3>My Drafts ({drafts.length})</h3>
              {drafts.map((record) => (
                <Link key={record.id} className="mobile-card-button" to={`/mobile/food-safety/records/${record.id}`}>
                  {formatDate(record.record_date)} — Draft
                </Link>
              ))}
            </div>
          ) : null}

          <div className="coming-soon-card">
            <h3>Available Forms</h3>
            <div className="varieties-toolbar" style={{ flexWrap: "wrap" }}>
              <input type="text" placeholder="Search forms..." value={search} onChange={(event) => setSearch(event.target.value)} />
              <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}>
                <option value="">All departments</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </div>
            {filteredForms.length === 0 ? <p>No forms available.</p> : null}
            <div className="mobile-card-grid">
              {filteredForms.map((form) => (
                <div key={form.id} className="coming-soon-card">
                  <p style={{ fontWeight: 600, margin: "0 0 0.2rem" }}>{form.name}</p>
                  {form.departmentName ? <p style={{ margin: "0 0 0.2rem", fontSize: "0.85rem" }}>{form.departmentName}</p> : null}
                  {form.description ? <p style={{ margin: "0 0 0.4rem", fontSize: "0.85rem" }}>{form.description}</p> : null}
                  {form.hasInstructions ? <p style={{ margin: "0 0 0.4rem", fontSize: "0.78rem" }}>Includes instructions</p> : null}
                  <button type="button" onClick={() => void startForm(form.id)} disabled={starting === form.id}>
                    {starting === form.id ? "Starting..." : "Start"}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="coming-soon-card">
            <h3>My Recent Records</h3>
            {completedRecent.length === 0 ? <p>No recent records yet.</p> : null}
            {completedRecent.map((record) => (
              <Link key={record.id} className="mobile-card-button" to={`/mobile/food-safety/records/${record.id}`}>
                <RecordStatusBadge status={record.status} /> {formatDate(record.record_date)}
                {record.status === "rejected" ? <span> — Correct &amp; Resubmit</span> : null}
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
