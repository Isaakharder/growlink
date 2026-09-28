import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePermissions } from "../hooks/usePermissions";
import { MAINTENANCE_ACCESS_PERMISSIONS } from "./maintenance/access";
import { mobilePath } from "../config/platform";

const IRRIGATION_PERMISSIONS = ["mobile:irrigation", "irrigation:view", "irrigation:edit"];

type TaskTone = "yield" | "quality" | "irrigation" | "pest" | "food-safety" | "calibration" | "maintenance";

// Line icons on a 24×24 grid; drawn in the card's tone colour.
const ICONS: Record<TaskTone, ReactNode> = {
  yield: (
    <>
      <path d="M12 7.5c-3.9 0-6.5 2.6-6.5 6.2 0 3.4 2.9 5.8 6.5 5.8s6.5-2.4 6.5-5.8c0-3.6-2.6-6.2-6.5-6.2Z" />
      <path d="M9.5 7.9 12 9.6l2.5-1.7M12 7.5c0-1.9 1-3.2 2.7-3.6" />
    </>
  ),
  quality: (
    <>
      <rect x="5.5" y="4.5" width="13" height="16" rx="2" />
      <path d="M9 4.5V3.5h6v1M9 13l2.2 2.2L15.5 11" />
    </>
  ),
  irrigation: <path d="M12 3.8s-5.5 6.1-5.5 10.2a5.5 5.5 0 0 0 11 0c0-4.1-5.5-10.2-5.5-10.2ZM9.6 14.6a2.6 2.6 0 0 0 2.4 2.3" />,
  pest: (
    <>
      <path d="M12 8.5c-2.5 0-4 2-4 5s1.6 5.5 4 5.5 4-2.5 4-5.5-1.5-5-4-5ZM12 8.5V19" />
      <path d="M10 8.9 8.6 6.5M14 8.9l1.4-2.4M8 12H5M8 15.5l-2.6 1.4M16 12h3M16 15.5l2.6 1.4" />
    </>
  ),
  "food-safety": (
    <>
      <path d="M12 3.8 5.5 6.3v5.3c0 4.2 2.8 7.2 6.5 8.6 3.7-1.4 6.5-4.4 6.5-8.6V6.3L12 3.8Z" />
      <path d="m9.2 12.2 2 2 3.8-3.9" />
    </>
  ),
  calibration: (
    <>
      <path d="M4.5 15.5a7.5 7.5 0 1 1 15 0" />
      <path d="M12 15.5 15.2 10M4.5 15.5h2M17.5 15.5h2M12 8V9.5M7.2 10.2l1 1M16.8 10.2l-1 1" />
      <circle cx="12" cy="15.5" r="1.2" />
    </>
  ),
  maintenance: <path d="M14.7 5.3a4 4 0 0 0-5 5.1l-5 5a1.8 1.8 0 0 0 2.6 2.6l5-5a4 4 0 0 0 5.1-5l-2.4 2.4-2.1-.6-.6-2.1 2.4-2.4Z" />
};

function TaskCard({ to, tone, label }: { to: string; tone: TaskTone; label: string }) {
  return (
    <li>
      <Link className={`mobile-home-task mobile-home-task--${tone}`} to={to}>
        <span className="mobile-home-task-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            {ICONS[tone]}
          </svg>
        </span>
        <span className="mobile-home-task-label">{label}</span>
        <svg className="mobile-home-task-chevron" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m8 5 5 5-5 5" />
        </svg>
      </Link>
    </li>
  );
}

export function MobileHomePage() {
  // canAny is optimistically true while membership is loading (see
  // usePermissions.ts) so this card doesn't flash-appear/disappear for the
  // common (authorized) case -- it's simply present from first render.
  const { canAny } = usePermissions();
  const canUseIrrigation = canAny(IRRIGATION_PERMISSIONS);
  const canUseMaintenance = canAny(MAINTENANCE_ACCESS_PERMISSIONS);

  return (
    <nav className="mobile-page mobile-home" aria-label="Tasks">
      {/* role="list": Safari drops list semantics from a list-style: none list. */}
      <ul className="mobile-home-tasks" role="list">
        <TaskCard to={mobilePath("/daily-yield")} tone="yield" label="Daily Yield" />
        <TaskCard to={mobilePath("/quality-check")} tone="quality" label="Quality Check" />
        {canUseIrrigation ? <TaskCard to={mobilePath("/irrigation-log")} tone="irrigation" label="Irrigation Log" /> : null}
        <TaskCard to={mobilePath("/pest-log")} tone="pest" label="Pest Log" />
        <TaskCard to={mobilePath("/food-safety")} tone="food-safety" label="Food Safety" />
        <TaskCard to={mobilePath("/calibration")} tone="calibration" label="Calibration" />
        {canUseMaintenance ? <TaskCard to={mobilePath("/maintenance")} tone="maintenance" label="Maintenance" /> : null}
      </ul>
    </nav>
  );
}
