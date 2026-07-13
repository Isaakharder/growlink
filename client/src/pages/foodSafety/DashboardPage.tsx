import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/usePermissions";
import { listDepartments, listLocations, listTemplates } from "../../lib/foodSafety/api";

type LoadState = "loading" | "loaded" | "error";

export function FoodSafetyDashboardPage() {
  const { canAny } = usePermissions();
  const canSeeDepartments = canAny(["food_safety:view", "food_safety:manage_departments"]);
  const canSeeLocations = canAny(["food_safety:view", "food_safety:manage_locations"]);
  const canSeeTemplates = canAny(["food_safety:view", "food_safety:manage_templates"]);

  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [activeDepartments, setActiveDepartments] = useState(0);
  const [activeLocations, setActiveLocations] = useState(0);
  const [templateCount, setTemplateCount] = useState(0);
  const [draftCount, setDraftCount] = useState(0);

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
        canSeeTemplates ? listTemplates() : Promise.resolve(null)
      ]);
      if (cancelled) return;

      const [departmentsResult, locationsResult, templatesResult] = results;

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
  }, [canSeeDepartments, canSeeLocations, canSeeTemplates]);

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
          </div>
        )}
      </div>

      <div className="coming-soon-card">
        <h2>Manage</h2>
        <div className="varieties-toolbar">
          {canSeeDepartments ? <Link to="/food-safety/departments">Departments</Link> : null}
          {canSeeLocations ? <Link to="/food-safety/locations">Locations &amp; Assets</Link> : null}
          {canSeeTemplates ? <Link to="/food-safety/templates">Form Templates</Link> : null}
        </div>
      </div>

      <div className="coming-soon-card">
        <h2>Coming soon</h2>
        <p>
          Task scheduling, QR code check-ins, form submissions, corrective actions, training records,
          and Audit Mode are planned for later phases of the Food Safety module. This dashboard
          currently covers departments, locations/assets, and versioned form templates only.
        </p>
      </div>
    </section>
  );
}
