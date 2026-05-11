import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";

export function RequireAuth() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false);
  const location = useLocation();

  useEffect(() => {
    let mounted = true;

    async function loadSession() {
      const { data, error } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(error ? null : data.session);
      setLoading(false);
    }

    void loadSession();

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // Supabase sets last_sign_in_at on invite redemption, so it can't signal
      // first-time users. Instead rely on user_metadata: invited_at is stamped
      // by the invite and password_set is cleared once the user saves a password.
      const isInviteSignIn =
        event === "SIGNED_IN" &&
        !!nextSession?.user?.user_metadata?.invited_at &&
        !nextSession?.user?.user_metadata?.password_set;

      if (isInviteSignIn) setNeedsPasswordSetup(true);
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  if (loading) {
    return (
      <div className="auth-loading-shell" role="status" aria-live="polite">
        Checking session...
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (needsPasswordSetup) {
    return <Navigate to="/set-password" replace />;
  }

  return <Outlet />;
}
