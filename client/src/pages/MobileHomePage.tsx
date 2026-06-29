import { Link } from "react-router-dom";

export function MobileHomePage() {
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

        <Link className="mobile-card-button" to="/mobile/irrigation-log">
          Irrigation Log
        </Link>

        <Link className="mobile-card-button" to="/mobile/pest-log">
          Pest Log
        </Link>

        <Link className="mobile-card-button" to="/mobile/payroll">
          Payroll
        </Link>
      </div>
    </section>
  );
}
