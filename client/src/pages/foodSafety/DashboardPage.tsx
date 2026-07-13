import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listDepartments, listLocations } from "../../lib/foodSafety/api";

type LoadState = "loading" | "loaded" | "error";

export function FoodSafetyDashboardPage() {
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [activeDepartments, setActiveDepartments] = useState(0);
  const [activeLocations, setActiveLocations] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState("loading");
      setError(null);
      try {
        const [departments, locations] = await Promise.all([listDepartments(), listLocations()]);
        if (cancelled) return;
        setActiveDepartments(departments.filter((department) => department.active).length);
        setActiveLocations(locations.filter((location) => location.active).length);
        setState("loaded");
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load Food Safety dashboard.");
        setState("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

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
            <p style={{ margin: 0 }}>
              <strong>{activeDepartments}</strong> active department{activeDepartments === 1 ? "" : "s"}
            </p>
            <p style={{ margin: 0 }}>
              <strong>{activeLocations}</strong> active location/asset{activeLocations === 1 ? "" : "s"}
            </p>
          </div>
        )}
      </div>

      <div className="coming-soon-card">
        <h2>Manage</h2>
        <div className="varieties-toolbar">
          <Link to="/food-safety/departments">Departments</Link>
          <Link to="/food-safety/locations">Locations &amp; Assets</Link>
        </div>
      </div>

      <div className="coming-soon-card">
        <h2>Coming soon</h2>
        <p>
          Digital forms, scheduled tasks, QR code check-ins, corrective actions, training records,
          and Audit Mode are planned for later phases of the Food Safety module. This dashboard
          currently covers departments and locations/assets only.
        </p>
      </div>
    </section>
  );
}
