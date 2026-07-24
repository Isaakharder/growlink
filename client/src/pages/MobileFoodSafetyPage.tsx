import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, apiUrl } from "../lib/api";

type LocationCard = {
  id: string;
  name: string;
  area: string;
  isComplete: boolean;
  completedByInitials: string | null;
  items: { isComplete: boolean; isRequired: boolean }[];
};

const API_BASE = apiUrl("/api/food-safety/mobile/cleaning-checklist");

// Progress and status only ever consider required tasks — optional tasks can
// still be filled in on the checklist page but never block "In Progress" vs
// "Completed". Completion itself is manual now (the Complete Location
// button), independent of whether every checkbox ended up checked.
function requiredItems(location: LocationCard) {
  return location.items.filter((item) => item.isRequired);
}

function statusFor(location: LocationCard): { key: string; label: string } {
  if (location.isComplete) return { key: "complete", label: "Completed" };
  const completedCount = requiredItems(location).filter((item) => item.isComplete).length;
  if (completedCount === 0) return { key: "not-started", label: "Not Started" };
  return { key: "in-progress", label: "In Progress" };
}

export function MobileFoodSafetyPage() {
  const [locations, setLocations] = useState<LocationCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(API_BASE);
        if (!res.ok) throw new Error("Failed to load cleaning locations");
        const data = (await res.json()) as { locations: LocationCard[] };
        setLocations(data.locations ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load cleaning locations");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  return (
    <section className="mobile-page">
      <h2>Food Safety</h2>

      {error ? <p className="form-error">{error}</p> : null}
      {loading ? <p>Loading…</p> : null}

      {!loading && locations.length === 0 ? <p>No cleaning locations configured yet.</p> : null}

      {!loading && locations.length > 0 ? (
        <div className="cleaning-checklist-list">
          {locations.map((location) => {
            const required = requiredItems(location);
            const total = required.length;
            const completedCount = required.filter((item) => item.isComplete).length;
            const status = statusFor(location);

            return (
              <Link
                key={location.id}
                to={`/mobile/food-safety/${location.id}`}
                className="cleaning-checklist-location-card"
              >
                <div className="cleaning-checklist-card-name">{location.name}</div>
                <div className="cleaning-checklist-card-area">{location.area}</div>
                <div className="cleaning-checklist-card-progress">
                  {completedCount} of {total} complete
                </div>
                <div className={`cleaning-checklist-status-badge status-${status.key}`}>{status.label}</div>
                {location.isComplete && location.completedByInitials ? (
                  <div className="cleaning-checklist-card-initials">Completed by {location.completedByInitials}</div>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
