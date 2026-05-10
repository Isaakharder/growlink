import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";

export function RequireAuth() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);

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
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
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

  // No session: return null so AppRoot can re-render to LoginPage.
  // AppRoot holds the same onAuthStateChange subscription and will
  // unmount the router, replacing it with LoginPage.
  if (!session) {
    return null;
  }

  return <Outlet />;
}
