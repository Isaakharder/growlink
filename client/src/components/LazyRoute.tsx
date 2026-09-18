import { Component, ReactNode, Suspense } from "react";

type BoundaryProps = { children: ReactNode };
type BoundaryState = { failed: boolean };

// React error boundaries can only be class components (no hook equivalent
// exists yet) — this exists specifically to catch a failed dynamic
// import() from React.lazy (e.g. a stale deploy where the chunk hash
// changed, or a network blip), which Suspense's fallback alone does NOT
// handle: Suspense covers the *loading* state, not a *rejected* load.
// Without this, a failed chunk load would render a blank page.
class LazyLoadErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Failed to load a page chunk:", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="lazy-route-state lazy-route-error">
          <p>This page couldn't be loaded.</p>
          <p>Check your connection and try again.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function LazyRouteFallback() {
  return (
    <div className="lazy-route-state lazy-route-loading" role="status" aria-live="polite">
      <span className="lazy-route-spinner" aria-hidden="true" />
      <p>Loading…</p>
    </div>
  );
}

// Wraps a React.lazy()-loaded route element with a GrowLink-styled loading
// state and a fallback for a failed chunk load, so route-level code
// splitting never regresses to a blank screen.
export function LazyRoute({ children }: { children: ReactNode }) {
  return (
    <LazyLoadErrorBoundary>
      <Suspense fallback={<LazyRouteFallback />}>{children}</Suspense>
    </LazyLoadErrorBoundary>
  );
}
