import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import { listAwaitingVerification, listDepartments, listLocations, listRecords, listTemplates } from "../../lib/foodSafety/api";

type LoadState = "loading" | "loaded" | "error";

export function FoodSafetyDashboardPage() {
  const { canAny } = usePermissions();
  const canSeeDepartments = canAny(["food_safety:view", "food_safety:manage_departments"]);
  const canSeeLocations = canAny(["food_safety:view", "food_safety:manage_locations"]);
  const canSeeTemplates = canAny(["food_safety:view", "food_safety:manage_templates"]);
  const canSeeRecords = canAny(["food_safety:view", "food_safety:complete", "food_safety:verify"]);
  const canSeeAwaitingVerification = canAny(["food_safety:verify"]);

  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [activeDepartments, setActiveDepartments] = useState(0);
  const [activeLocations, setActiveLocations] = useState(0);
  const [templateCount, setTemplateCount] = useState(0);
  const [draftCount, setDraftCount] = useState(0);
  const [recordCount, setRecordCount] = useState(0);
  const [awaitingVerificationCount, setAwaitingVerificationCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Each section is fetched only if the user holds the permission that
    // section's route requires, and a failure in one section never blanks
    // out the others — a user with, say, only food_safety:manage_departments
    // (no food_safety:view, no manage_locations/manage_templates) can still
    // see their department count even though they can't see locations or
    // templates at all.
    async function load() {
      setState("loading");
      setError(null);

      const results = await Promise.allSettled([
        canSeeDepartments ? listDepartments() : Promise.resolve(null),
        canSeeLocations ? listLocations() : Promise.resolve(null),
        canSeeTemplates ? listTemplates() : Promise.resolve(null),
        canSeeRecords ? listRecords() : Promise.resolve(null),
        canSeeAwaitingVerification ? listAwaitingVerification() : Promise.resolve(null)
      ]);
      if (cancelled) return;

      const [departmentsResult, locationsResult, templatesResult, recordsResult, awaitingResult] = results;

      if (departmentsResult.status === "fulfilled" && departmentsResult.value) {
        setActiveDepartments(departmentsResult.value.filter((department) => department.active).length);
      }
      if (locationsResult.status === "fulfilled" && locationsResult.value) {
        setActiveLocations(locationsResult.value.filter((location) => location.active).length);
      }
      if (templatesResult.status === "fulfilled" && templatesResult.value) {
        setTemplateCount(templatesResult.value.length);
        setDraftCount(templatesResult.value.filter((template) => template.has_draft).length);
      }
      if (recordsResult.status === "fulfilled" && recordsResult.value) {
        setRecordCount(recordsResult.value.length);
      }
      if (awaitingResult.status === "fulfilled" && awaitingResult.value) {
        setAwaitingVerificationCount(awaitingResult.value.length);
      }

      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        const message = failures[0].reason instanceof Error ? failures[0].reason.message : "Failed to load part of the Food Safety dashboard.";
        setError(message);
      }

      setState("loaded");
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [canSeeDepartments, canSeeLocations, canSeeTemplates, canSeeRecords, canSeeAwaitingVerification]);

  return (
    <section className="page-shell">
      <header>
        <h1>Food Safety</h1>
        <p>Program areas, locations, and assets for GrowLink&rsquo;s Food Safety module.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="coming-soon-card">
        <h2>Overview</h2>
        {state === "loading" ? (
          <p>Loading...</p>
        ) : (
          <div className="varieties-toolbar">
            {canSeeDepartments ? (
              <p style={{ margin: 0 }}>
                <strong>{activeDepartments}</strong> active department{activeDepartments === 1 ? "" : "s"}
              </p>
            ) : null}
            {canSeeLocations ? (
              <p style={{ margin: 0 }}>
                <strong>{activeLocations}</strong> active location/asset{activeLocations === 1 ? "" : "s"}
              </p>
            ) : null}
            {canSeeTemplates ? (
              <>
                <p style={{ margin: 0 }}>
                  <strong>{templateCount}</strong> form template{templateCount === 1 ? "" : "s"}
                </p>
                <p style={{ margin: 0 }}>
                  <strong>{draftCount}</strong> draft{draftCount === 1 ? "" : "s"} in progress
                </p>
              </>
            ) : null}
            {canSeeRecords ? (
              <p style={{ margin: 0 }}>
                <strong>{recordCount}</strong> submitted record{recordCount === 1 ? "" : "s"}
              </p>
            ) : null}
            {canSeeAwaitingVerification ? (
              <p style={{ margin: 0 }}>
                <strong>{awaitingVerificationCount}</strong> awaiting verification
              </p>
            ) : null}
          </div>
        )}
      </div>

      <div className="coming-soon-card">
        <h2>Manage</h2>
        <div className="varieties-toolbar">
          {canSeeDepartments ? <Link to="/food-safety/departments">Departments</Link> : null}
          {canSeeLocations ? <Link to="/food-safety/locations">Locations &amp; Assets</Link> : null}
          {canSeeTemplates ? <Link to="/food-safety/templates">Form Templates</Link> : null}
          {canSeeRecords ? <Link to="/food-safety/records">Records</Link> : null}
        </div>
      </div>

      <div className="coming-soon-card">
        <h2>Coming soon</h2>
        <p>
          Recurring schedules, automatically generated due tasks, QR code check-ins, corrective actions,
          training records, and Audit Mode are planned for later phases of the Food Safety module.
        </p>
      </div>
    </section>
  );
}
