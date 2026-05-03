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

        <button type="button" className="mobile-card-button" disabled>
          Quality Check
          <span>Coming soon</span>
        </button>

        <button type="button" className="mobile-card-button" disabled>
          Irrigation Log
          <span>Coming soon</span>
        </button>

        <button type="button" className="mobile-card-button" disabled>
          Pest Log
          <span>Coming soon</span>
        </button>
      </div>
    </section>
  );
}
