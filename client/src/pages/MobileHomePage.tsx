import { Link } from "react-router-dom";
import { usePermissions } from "../hooks/usePermissions";

const IRRIGATION_PERMISSIONS = ["mobile:irrigation", "irrigation:view", "irrigation:edit"];

export function MobileHomePage() {
  // canAny is optimistically true while membership is loading (see
  // usePermissions.ts) so this card doesn't flash-appear/disappear for the
  // common (authorized) case -- it's simply present from first render.
  const { canAny } = usePermissions();
  const canUseIrrigation = canAny(IRRIGATION_PERMISSIONS);

  return (
    <section className="mobile-page">
      <h2>Mobile Logging</h2>
      <p>Choose a task to start quick mobile logging.</p>

      <div className="mobile-card-grid">
        <Link className="mobile-card-button" to="/mobile/daily-yield">
          Daily Yield
        </Link>

        <Link className="mobile-card-button" to="/mobile/quality-check">
          Quality Check
        </Link>

        {canUseIrrigation ? (
          <Link className="mobile-card-button" to="/mobile/irrigation-log">
            Irrigation Log
          </Link>
        ) : null}

        <Link className="mobile-card-button" to="/mobile/pest-log">
          Pest Log
        </Link>

        <Link className="mobile-card-button" to="/mobile/payroll">
          Payroll
        </Link>

        <Link className="mobile-card-button" to="/mobile/food-safety">
          Food Safety
        </Link>

        <Link className="mobile-card-button" to="/mobile/calibration">
          Calibration
        </Link>
      </div>
    </section>
  );
}
