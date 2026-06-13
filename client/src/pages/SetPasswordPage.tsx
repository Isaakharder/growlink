import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getDefaultRoute } from "../utils/getDefaultRoute";

type SessionBootstrapState = "loading" | "ready" | "invalid";

export function SetPasswordPage() {
  const navigate = useNavigate();
  const redirectTimerRef = useRef<number | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [bootstrapState, setBootstrapState] = useState<SessionBootstrapState>("loading");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [resolvedRoute, setResolvedRoute] = useState("/");

  // TODO: In the Supabase dashboard (Authentication → URL Configuration), set the
  // invite redirect URL to <your-origin>/set-password so Supabase delivers the
  // ?code= param here directly instead of auto-exchanging it on the app root.

  useEffect(() => {
    async function prepareInviteSession() {
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

        const code = searchParams.get("code");
        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) {
            setBootstrapState("invalid");
            setError(exchangeError.message);
            return;
          }
        } else {
          const accessToken = hashParams.get("access_token");
          const refreshToken = hashParams.get("refresh_token");

          if (accessToken && refreshToken) {
            const { error: setSessionError } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken
            });

            if (setSessionError) {
              setBootstrapState("invalid");
              setError(setSessionError.message);
              return;
            }
          }
        }

        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !data.session) {
          setBootstrapState("invalid");
          setError(sessionError?.message ?? "Invite link is invalid or expired.");
          return;
        }

        // Remove one-time auth tokens from the URL after bootstrap.
        if (window.location.search || window.location.hash) {
          window.history.replaceState({}, document.title, "/set-password");
        }

        setBootstrapState("ready");
      } catch (bootstrapError) {
        setBootstrapState("invalid");
        setError(
          bootstrapError instanceof Error
            ? bootstrapError.message
            : "Unable to initialize invite session."
        );
      }
    }

    void prepareInviteSession();

    return () => {
      if (redirectTimerRef.current !== null) {
        window.clearTimeout(redirectTimerRef.current);
      }
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });

      if (updateError) {
        setError(updateError.message);
        return;
      }

      // Clear the flag so RequireAuth won't redirect this user again.
      await supabase.auth.updateUser({ data: { mustSetPassword: false } });

      // Determine the correct landing page from the user's membership permissions.
      let route = "/";
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user?.id) {
          const { data: row } = await supabase
            .from("memberships")
            .select("role, permissions")
            .eq("user_id", user.id)
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

      setResolvedRoute(route);
      setSuccess(true);
      redirectTimerRef.current = window.setTimeout(() => {
        navigate(route, { replace: true });
      }, 1200);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Unable to set password right now."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <section className="login-card" aria-label="Set GrowLink password">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            GL
          </span>
          <div>
            <h1>Set your password</h1>
            <p>Create or reset your GrowLink password.</p>
          </div>
        </div>

        {bootstrapState === "loading" && (
          <p role="status" aria-live="polite">
            Validating link...
          </p>
        )}

        {bootstrapState === "invalid" && (
          <>
            <p className="login-error" role="alert" aria-live="polite">
              {error ?? "This link is invalid or has expired. Request a new one from the login page."}
            </p>
            <button
              type="button"
              className="login-secondary-action"
              onClick={() => navigate("/login", { replace: true })}
            >
              Back to login
            </button>
          </>
        )}

        {bootstrapState === "ready" && !success && (
          <form className="login-form" onSubmit={handleSubmit}>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
              />
            </label>

            <label>
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                minLength={8}
              />
            </label>

            {error && (
              <p className="login-error" role="alert" aria-live="polite">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting}>
              {submitting ? "Saving..." : "Set password"}
            </button>
          </form>
        )}

        {success && (
          <>
            <p role="status" aria-live="polite">
              Password set successfully. Redirecting...
            </p>
            <button
              type="button"
              className="login-secondary-action"
              onClick={() => navigate(resolvedRoute, { replace: true })}
            >
              Continue now
            </button>
          </>
        )}
      </section>
    </div>
  );
}
