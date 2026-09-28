// Which browser origins may call the API (see app.ts). Browsers send Origin
// as scheme://host[:port] with no path or trailing slash, so each allowlist
// entry is normalised to exactly that before comparing. An entry copied
// from the address bar ("https://growlink.lltech.io/", with a path, in
// quotes or in capitals) then still matches, instead of silently never
// matching and blocking every request from that site.

// Always allowed, in every environment: local dev servers, and the native
// iOS app, which loads its bundle from capacitor://localhost (see
// client/capacitor.config.ts); WKWebView sends that as a real Origin.
export const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "capacitor://localhost",
];

/** scheme://host[:port], lower-cased; null for anything that isn't an origin (including "*" and "null"). */
export function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!url.host) return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * DEV_ORIGINS plus every comma-separated CORS_ORIGINS entry, normalised.
 * Entries that aren't origins are returned in `invalid` (and never allowed).
 */
export function parseAllowedOrigins(env: string | undefined): { origins: Set<string>; invalid: string[] } {
  const origins = new Set(DEV_ORIGINS);
  const invalid: string[] = [];
  for (const raw of (env ?? "").split(",")) {
    if (!raw.trim()) continue;
    const origin = normalizeOrigin(raw);
    if (origin) origins.add(origin);
    else invalid.push(raw.trim());
  }
  return { origins, invalid };
}

export function isAllowedOrigin(origins: Set<string>, requestOrigin: string): boolean {
  const origin = normalizeOrigin(requestOrigin);
  return origin !== null && origins.has(origin);
}
