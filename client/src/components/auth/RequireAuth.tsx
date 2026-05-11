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
      // Invited users have no last_sign_in_at on their very first authentication.
      // Redirect them to /set-password before they can access the app.
      if (event === "SIGNED_IN" && nextSession?.user && !nextSession.user.last_sign_in_at) {
        setNeedsPasswordSetup(true);
      }
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
