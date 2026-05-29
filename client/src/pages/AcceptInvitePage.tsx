import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiUrl } from "../lib/api";

type PageState = "loading" | "ready" | "invalid" | "already-accepted" | "accepted";

type InviteInfo = {
  email: string;
  position: string | null;
  organizationName: string | null;
};

type ValidateResponse = {
  email?: string;
  position?: string | null;
  organizationName?: string | null;
  message?: string;
};

type AcceptResponse = {
  message?: string;
};

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [pageState, setPageState] = useState<PageState>("loading");
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [position, setPosition] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadError("No invite token found in the URL.");
      setPageState("invalid");
      return;
    }

    async function validateInvite() {
      try {
        const response = await fetch(
          apiUrl(`/api/invites/validate?token=${encodeURIComponent(token)}`)
        );
        const data = (await response.json()) as ValidateResponse;

        if (!response.ok) {
          if (response.status === 409) {
            setPageState("already-accepted");
          } else {
            setLoadError(data.message ?? "This invite link is invalid or has expired.");
            setPageState("invalid");
          }
          return;
        }

        const info: InviteInfo = {
          email: data.email ?? "",
          position: data.position ?? null,
          organizationName: data.organizationName ?? null,
        };
        setInviteInfo(info);
        setPosition(data.position ?? "");
        setPageState("ready");
      } catch {
        setLoadError("Unable to validate invite link. Check your connection and try again.");
        setPageState("invalid");
      }
    }

    void validateInvite();
  }, [token]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setSubmitError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const body: Record<string, string> = { token, password };
      const trimmedName = name.trim();
      const trimmedPosition = position.trim();
      if (trimmedName) body.name = trimmedName;
      if (trimmedPosition) body.position = trimmedPosition;

      const response = await fetch(apiUrl("/api/invites/accept"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as AcceptResponse;

      if (!response.ok) {
        setSubmitError(data.message ?? "Something went wrong. Please try again.");
        return;
      }

      setPageState("accepted");
    } catch {
      setSubmitError("Unable to complete registration. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const subtitle = inviteInfo?.organizationName
    ? `You've been invited to join ${inviteInfo.organizationName} on GrowLink.`
    : "You've been invited to GrowLink.";

  return (
    <div className="login-shell">
      <section className="login-card" aria-label="Accept GrowLink invite">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            GL
          </span>
          <div>
            <h1>Create your account</h1>
            <p>{pageState === "ready" ? subtitle : "GrowLink — Farm Data Platform"}</p>
          </div>
        </div>

        {pageState === "loading" && (
          <p role="status" aria-live="polite">
            Validating invite link...
          </p>
        )}

        {pageState === "invalid" && (
          <>
            <p className="login-error" role="alert" aria-live="polite">
              {loadError ?? "This invite link is invalid or has expired."}
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

        {pageState === "already-accepted" && (
          <>
            <p role="status" aria-live="polite">
              This invite has already been accepted. Sign in with the account that was created.
            </p>
            <button
              type="button"
              className="login-secondary-action"
              onClick={() => navigate("/login", { replace: true })}
            >
              Go to login
            </button>
          </>
        )}

        {pageState === "ready" && inviteInfo && (
          <form className="login-form" onSubmit={handleSubmit}>
            <label>
              Email
              <input
                type="email"
                value={inviteInfo.email}
                disabled
                aria-label="Email address from invite"
              />
            </label>

            <label>
              Full name
              <input
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your full name"
              />
            </label>

            <label>
              Position
              <input
                type="text"
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                placeholder="Your role or title"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
              />
            </label>

            {submitError && (
              <p className="login-error" role="alert" aria-live="polite">
                {submitError}
              </p>
            )}

            <button type="submit" disabled={submitting}>
              {submitting ? "Creating account..." : "Create account"}
            </button>

            <button
              type="button"
              className="login-secondary-action"
              onClick={() => navigate("/login")}
            >
              Already have an account? Log in
            </button>
          </form>
        )}

        {pageState === "accepted" && (
          <>
            <p role="status" aria-live="polite">
              Account created successfully. Sign in with your email and password to get started.
            </p>
            <button
              type="button"
              className="login-secondary-action"
              onClick={() => navigate("/login", { replace: true })}
            >
              Go to login
            </button>
          </>
        )}
      </section>
    </div>
  );
}
