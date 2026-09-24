import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupportPage } from "../SupportPage";

describe("SupportPage — public App Store support page", () => {
  beforeEach(() => {
    document.title = "GrowLink";
    document.head.querySelectorAll('meta[name="description"]').forEach((m) => m.remove());
    const meta = document.createElement("meta");
    meta.name = "description";
    meta.content = "Greenhouse operations platform";
    document.head.appendChild(meta);
  });

  afterEach(() => {
    document.head.querySelectorAll('meta[name="description"]').forEach((m) => m.remove());
  });

  it("shows the required title and explains what support covers", () => {
    render(<SupportPage />);
    expect(screen.getByRole("heading", { level: 1, name: "GrowLink Mobile Support" })).toBeInTheDocument();
    const intro = screen.getByText(/Contact support for account access, troubleshooting/i);
    expect(intro).toHaveTextContent(/questions about GrowLink Mobile/i);
  });

  it("shows the contact name", () => {
    render(<SupportPage />);
    expect(screen.getByText("Isaak Harder Hiebert")).toBeInTheDocument();
  });

  it("has a clickable email link (mailto:) with the exact address", () => {
    render(<SupportPage />);
    const link = screen.getByRole("link", { name: /isaakiya26@live\.com/ });
    expect(link).toHaveAttribute("href", "mailto:isaakiya26@live.com");
  });

  it("has a clickable phone link (tel:) that displays +1 519-990-3015 and dials the E.164 number", () => {
    render(<SupportPage />);
    const link = screen.getByRole("link", { name: /\+1 519-990-3015/ });
    expect(link).toHaveAttribute("href", "tel:+15199903015");
  });

  it("does not display or reference the Apple reviewer account or any credentials", () => {
    const { container } = render(<SupportPage />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const forbidden of ["apple-review", "apple review", "reviewer", "password", "demo account", "credential"]) {
      expect(text).not.toContain(forbidden);
    }
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["mailto:isaakiya26@live.com", "tel:+15199903015"]);
  });

  it("sets the page title and meta description, and restores the originals on unmount", () => {
    const { unmount } = render(<SupportPage />);
    expect(document.title).toBe("GrowLink Mobile Support");
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    expect(meta?.content).toMatch(/GrowLink Mobile/);
    expect(meta?.content).toMatch(/account access/i);

    unmount();
    expect(document.title).toBe("GrowLink");
    expect(document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content).toBe("Greenhouse operations platform");
  });

  it("creates the description meta if the shell has none, and removes it again on unmount", () => {
    document.head.querySelectorAll('meta[name="description"]').forEach((m) => m.remove());
    const { unmount } = render(<SupportPage />);
    expect(document.querySelector('meta[name="description"]')).not.toBeNull();
    unmount();
    expect(document.querySelector('meta[name="description"]')).toBeNull();
  });
});
