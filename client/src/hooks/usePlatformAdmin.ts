import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type State =
  | { loading: true; isPlatformAdmin: false }
  | { loading: false; isPlatformAdmin: boolean };

export function usePlatformAdmin(): State {
  const [state, setState] = useState<State>({ loading: true, isPlatformAdmin: false });

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/admin/check")
      .then(res => {
        if (!cancelled) setState({ loading: false, isPlatformAdmin: res.ok });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, isPlatformAdmin: false });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
