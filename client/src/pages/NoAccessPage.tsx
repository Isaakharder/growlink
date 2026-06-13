import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export function NoAccessPage() {
  const navigate = useNavigate();

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div className="login-shell">
      <section className="login-card" aria-label="No access">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            GL
          </span>
          <div>
            <h1>No access</h1>
            <p>GrowLink — Farm Data Platform</p>
          </div>
        </div>

        <p style={{ marginBottom: "1rem" }}>
          Your account doesn't have access to any features yet. Contact your
          organization admin to request access.
        </p>

        <button
          type="button"
          className="login-secondary-action"
          onClick={() => void handleSignOut()}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}
