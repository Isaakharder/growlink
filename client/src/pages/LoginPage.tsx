import { FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getDefaultRoute } from "../utils/getDefaultRoute";

type View = "login" | "forgot";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    typeof (location.state as { from?: unknown } | null)?.from === "string"
      ? ((location.state as { from: string }).from)
      : undefined;
  const [view, setView] = useState<View>("login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotSent, setForgotSent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { data: authData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        return;
      }

      // Preserve deep-link: if the user was bounced here from a protected route,
      // send them back there instead of applying the default routing logic.
      if (from) {
        navigate(from, { replace: true });
        return;
      }

      // Determine the correct landing page from the user's membership permissions.
      let route = "/";
      try {
        const userId = authData.user?.id;
        if (userId) {
          const { data: row } = await supabase
            .from("memberships")
            .select("role, permissions")
            .eq("user_id", userId)
            .maybeSingle();
          if (row) {
            const rawPerms = (row as { role: string; permissions?: unknown }).permissions;
            const perms: Record<string, boolean> =
              rawPerms !== null && typeof rawPerms === "object" && !Array.isArray(rawPerms)
                ? (rawPerms as Record<string, boolean>)
                : {};
            route = getDefaultRoute((row as { role: string }).role, perms);
          }
        }
      } catch {
        // Membership fetch failed — fall back to dashboard.
      }

      navigate(route, { replace: true });
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Unable to log in right now."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgotSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setForgotSubmitting(true);
    setForgotError(null);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(forgotEmail, {
        redirectTo: window.location.origin + "/set-password"
      });
      if (resetError) {
        setForgotError(resetError.message);
        return;
      }
      setForgotSent(true);
    } catch (submitError) {
      setForgotError(
        submitError instanceof Error ? submitError.message : "Unable to send reset email right now."
      );
    } finally {
      setForgotSubmitting(false);
    }
  }

  function switchToForgot() {
    setForgotEmail(email);
    setForgotError(null);
    setForgotSent(false);
    setView("forgot");
  }

  function switchToLogin() {
    setError(null);
    setView("login");
  }

  return (
    <div className="login-shell">
      <section className="login-card" aria-label="GrowLink login">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            GL
          </span>
          <div>
            <h1>GrowLink</h1>
            <p>Farm Data Platform</p>
          </div>
        </div>

        {view === "login" && (
          <form className="login-form" onSubmit={handleSubmit}>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            {error && (
              <p className="login-error" role="alert" aria-live="polite">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting}>
              {submitting ? "Logging in..." : "Log in"}
            </button>

            <button type="button" className="login-secondary-action" onClick={switchToForgot}>
              Forgot password?
            </button>
          </form>
        )}

        {view === "forgot" && !forgotSent && (
          <form className="login-form" onSubmit={handleForgotSubmit}>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={forgotEmail}
                onChange={(event) => setForgotEmail(event.target.value)}
                required
              />
            </label>

            {forgotError && (
              <p className="login-error" role="alert" aria-live="polite">
                {forgotError}
              </p>
            )}

            <button type="submit" disabled={forgotSubmitting}>
              {forgotSubmitting ? "Sending..." : "Send reset link"}
            </button>

            <button type="button" className="login-secondary-action" onClick={switchToLogin}>
              Back to login
            </button>
          </form>
        )}

        {view === "forgot" && forgotSent && (
          <>
            <p role="status" aria-live="polite">
              Check your email for a reset link.
            </p>
            <button type="button" className="login-secondary-action" onClick={switchToLogin}>
              Back to login
            </button>
          </>
        )}
      </section>
    </div>
  );
}
