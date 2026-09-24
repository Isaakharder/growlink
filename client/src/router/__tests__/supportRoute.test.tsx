import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useRoutes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A signed-OUT browser: no session, no user, no membership. The real RequireAuth / route config runs
// against this, so these tests prove /support really is public and the auth gate still works.
const getSession = vi.fn();
const getUser = vi.fn();
const signInWithPassword = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
      getUser: () => getUser(),
      signInWithPassword: (...a: unknown[]) => signInWithPassword(...a),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } })
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) })
  }
}));

import { appRouteConfig } from "../routes";

// Renders the REAL route config through MemoryRouter + useRoutes (rather than a data router, whose
// redirects hit a jsdom/undici AbortSignal incompatibility) — same config, same RequireAuth.
let currentPath = "";
function Routed() {
  currentPath = useLocation().pathname;
  return useRoutes(appRouteConfig);
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routed />
    </MemoryRouter>
  );
}

describe("/support route — signed out", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    getUser.mockResolvedValue({ data: { user: null }, error: null });
  });
  afterEach(() => vi.clearAllMocks());

  it("renders the support page without signing in, and does not redirect to /login", async () => {
    renderAt("/support");
    expect(await screen.findByRole("heading", { level: 1, name: "GrowLink Mobile Support" })).toBeInTheDocument();
    expect(currentPath).toBe("/support");
    expect(screen.getByRole("link", { name: /isaakiya26@live\.com/ })).toHaveAttribute("href", "mailto:isaakiya26@live.com");
    expect(screen.getByRole("link", { name: /\+1 519-990-3015/ })).toHaveAttribute("href", "tel:+15199903015");
  });

  it("never touches the auth session (the page is fully public)", async () => {
    renderAt("/support");
    await screen.findByRole("heading", { level: 1, name: "GrowLink Mobile Support" });
    expect(getSession).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("control: the auth gate still works — a protected route bounces a signed-out visitor to /login", async () => {
    renderAt("/");
    await waitFor(() => expect(currentPath).toBe("/login"));
    expect(screen.queryByRole("heading", { name: "GrowLink Mobile Support" })).not.toBeInTheDocument();
  });

  it("control: the mobile app routes are still auth-protected", async () => {
    renderAt("/mobile");
    await waitFor(() => expect(currentPath).toBe("/login"));
  });

  it("is a top-level route outside the RequireAuth tree, exactly like /login", () => {
    const support = appRouteConfig.find((r) => r.path === "/support");
    expect(support).toBeDefined();
    expect(support?.children).toBeUndefined();
    const guarded = appRouteConfig.filter((r) => r.children);
    for (const r of guarded) {
      const paths = JSON.stringify((r.children ?? []).map((c) => c.path));
      expect(paths).not.toContain("support");
    }
  });
});
