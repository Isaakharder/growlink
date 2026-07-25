import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, apiUrl } from "../lib/api";

type LocationFrequency = "daily" | "weekly" | "monthly" | "annually";

type LocationCard = {
  id: string;
  name: string;
  area: string;
  frequency: LocationFrequency | null;
  isComplete: boolean;
  completedByInitials: string | null;
  // Most recent FINALIZED report for this location (never the in-progress
  // checklist) -- distinct from completedByInitials above, which only
  // reflects the current cycle. Powers the "Last: Jul 22, 3:41 PM" footer.
  lastCompletedAt: string | null;
  lastCompletedByInitials: string | null;
  items: { isComplete: boolean; isRequired: boolean }[];
};

const API_BASE = apiUrl("/api/food-safety/mobile/cleaning-checklist");

// GrowLink's single organization timezone (see
// server/src/config/orgTimezone.ts) -- report timestamps are always
// formatted in this zone, never the viewer's device timezone, so "Last
// completed" reads the same regardless of where the phone thinks it is.
const ORG_TIMEZONE = "America/Toronto";

function orgTzYear(date: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: ORG_TIMEZONE, year: "numeric" }).format(date));
}

function orgTzPart(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ORG_TIMEZONE, ...options }).format(date);
}

// "Jul 22, 3:41 PM", or "Dec 18, 2025, 3:41 PM" when the completion fell in
// a year other than the current one (org timezone on both sides).
function formatLastCompletedShort(iso: string): string {
  const date = new Date(iso);
  const month = orgTzPart(date, { month: "short" });
  const day = orgTzPart(date, { day: "numeric" });
  const time = orgTzPart(date, { hour: "numeric", minute: "2-digit" });

  if (orgTzYear(date) !== orgTzYear(new Date())) {
    const year = orgTzPart(date, { year: "numeric" });
    return `${month} ${day}, ${year}, ${time}`;
  }
  return `${month} ${day}, ${time}`;
}

// "July 22, 2026 at 3:41 PM" -- the accessible label always includes the
// year, regardless of the short visual format's same-year abbreviation.
function formatLastCompletedLong(iso: string): string {
  const date = new Date(iso);
  const month = orgTzPart(date, { month: "long" });
  const day = orgTzPart(date, { day: "numeric" });
  const year = orgTzPart(date, { year: "numeric" });
  const time = orgTzPart(date, { hour: "numeric", minute: "2-digit" });
  return `${month} ${day}, ${year} at ${time}`;
}

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
                <div className="cleaning-checklist-card-name-row">
                  <div className="cleaning-checklist-card-name">{location.name}</div>
                  {location.frequency ? (
                    <span className="cleaning-checklist-frequency-badge">{location.frequency.toUpperCase()}</span>
                  ) : null}
                </div>
                <div className="cleaning-checklist-card-area">{location.area}</div>
                <div className="cleaning-checklist-card-progress">
                  {completedCount} of {total} complete
                </div>
                <div className="cleaning-checklist-card-footer">
                  <div className={`cleaning-checklist-status-badge status-${status.key}`}>{status.label}</div>
                  <span
                    className="cleaning-checklist-last-completed"
                    aria-label={
                      location.lastCompletedAt
                        ? `Last completed ${formatLastCompletedLong(location.lastCompletedAt)}`
                        : "This location has never been completed"
                    }
                  >
                    {location.lastCompletedAt
                      ? `Last: ${formatLastCompletedShort(location.lastCompletedAt)}${
                          location.lastCompletedByInitials ? ` · ${location.lastCompletedByInitials}` : ""
                        }`
                      : "Never completed"}
                  </span>
                </div>
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
