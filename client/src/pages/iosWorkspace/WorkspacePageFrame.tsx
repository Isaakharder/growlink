import type { ReactNode } from "react";
import type { WorkspaceResource } from "./workspaceData";

// The frame of a compact workspace page: its title, when the data was
// loaded, a Refresh button, and the loading / refreshing / stale / error /
// no-access states, so every page reports them the same way.

const formatTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function WorkspacePageFrame<T>({
  title,
  subtitle,
  state,
  onRefresh,
  loadingText,
  errorText,
  forbiddenText,
  children
}: {
  title: string;
  subtitle?: string;
  state: WorkspaceResource<T>;
  onRefresh: () => void;
  loadingText: string;
  errorText: string;
  forbiddenText: string;
  children: (data: T) => ReactNode;
}) {
  const busy = state.status === "loading" || (state.status === "ready" && state.refreshing);
  const hasData = state.status === "ready" || state.status === "stale";

  return (
    <section className="iosws-page" aria-labelledby="iosws-page-title" aria-busy={busy}>
      <header className="iosws-page-header">
        <div className="iosws-page-heading">
          <h2 id="iosws-page-title" className="iosws-page-title">
            {title}
          </h2>
          {subtitle ? <p className="iosws-page-note">{subtitle}</p> : null}
        </div>
        <button
          type="button"
          className="iosws-refresh"
          onClick={onRefresh}
          disabled={busy}
          aria-label={`Refresh ${title}`}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v3.8h-3.8" />
          </svg>
          <span aria-hidden="true">{state.status === "loading" ? "Loading…" : busy ? "Refreshing…" : "Refresh"}</span>
        </button>
      </header>

      <p className="iosws-status" role="status" aria-live="polite">
        {state.status === "loading"
          ? loadingText
          : state.status === "ready"
            ? state.refreshing
              ? `Refreshing… Showing data from ${formatTime(state.loadedAt)}.`
              : `Updated ${formatTime(state.loadedAt)}`
            : ""}
      </p>

      {state.status === "stale" ? (
        <p className="iosws-notice iosws-notice-stale" role="alert">
          {state.forbidden
            ? `${forbiddenText} Showing data from ${formatTime(state.loadedAt)}.`
            : `Couldn't refresh. Showing data from ${formatTime(state.loadedAt)}.`}
        </p>
      ) : null}

      {state.status === "error" ? (
        <div className={`iosws-notice ${state.forbidden ? "iosws-notice-forbidden" : "iosws-notice-error"}`} role="alert">
          <p>{state.forbidden ? forbiddenText : errorText}</p>
          {state.forbidden ? null : (
            <button type="button" className="iosws-retry" onClick={onRefresh}>
              Try again
            </button>
          )}
        </div>
      ) : null}

      {hasData ? <div className={state.status === "stale" ? "iosws-body iosws-body-stale" : "iosws-body"}>{children(state.data)}</div> : null}
    </section>
  );
}
