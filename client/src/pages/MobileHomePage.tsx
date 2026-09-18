import { Link } from "react-router-dom";
import { usePermissions } from "../hooks/usePermissions";
import { MAINTENANCE_ACCESS_PERMISSIONS } from "./maintenance/access";
import { mobilePath } from "../config/platform";

const IRRIGATION_PERMISSIONS = ["mobile:irrigation", "irrigation:view", "irrigation:edit"];

export function MobileHomePage() {
  // canAny is optimistically true while membership is loading (see
  // usePermissions.ts) so this card doesn't flash-appear/disappear for the
  // common (authorized) case -- it's simply present from first render.
  const { canAny } = usePermissions();
  const canUseIrrigation = canAny(IRRIGATION_PERMISSIONS);
  const canUseMaintenance = canAny(MAINTENANCE_ACCESS_PERMISSIONS);

  return (
    <section className="mobile-page">
      <h2>Mobile Logging</h2>
      <p>Choose a task to start quick mobile logging.</p>

      <div className="mobile-card-grid">
        <Link className="mobile-card-button" to={mobilePath("/daily-yield")}>
          Daily Yield
        </Link>

        <Link className="mobile-card-button" to={mobilePath("/quality-check")}>
          Quality Check
        </Link>

        {canUseIrrigation ? (
          <Link className="mobile-card-button" to={mobilePath("/irrigation-log")}>
            Irrigation Log
          </Link>
        ) : null}

        <Link className="mobile-card-button" to={mobilePath("/pest-log")}>
          Pest Log
        </Link>

        <Link className="mobile-card-button" to={mobilePath("/food-safety")}>
          Food Safety
        </Link>

        <Link className="mobile-card-button" to={mobilePath("/calibration")}>
          Calibration
        </Link>

        {canUseMaintenance ? (
          <Link className="mobile-card-button" to={mobilePath("/maintenance")}>
            Maintenance
          </Link>
        ) : null}
      </div>
    </section>
  );
}
