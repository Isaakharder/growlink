// MOBILE_BASE is the path prefix under which the mobile app's routes are
// mounted. The web/PWA build mounts them at "/mobile" (sharing one bundle
// with the desktop app, see router/routes.ts); the native iOS build (see
// main.native.tsx / router/nativeRoutes.ts) mounts the identical route
// tree at "/" instead, since the native shell only ever contains the
// mobile app. Every mobile-internal absolute link is built from this
// constant, rather than hardcoding "/mobile", so the same page components
// render correctly under both routers unchanged.
//
// VITE_APP_TARGET is set to "native" only by vite.ios.config.ts — the
// regular web build (dev, Railway) never sets it, so MOBILE_BASE there is
// always "/mobile".
export const MOBILE_BASE = import.meta.env.VITE_APP_TARGET === "native" ? "" : "/mobile";

// The mobile app's own home/index route under the current build's router.
export const MOBILE_HOME = MOBILE_BASE || "/";

// Builds an absolute link to a mobile route from a path relative to the
// mobile app's root, e.g. mobilePath("/daily-yield") -> "/mobile/daily-yield"
// on web, "/daily-yield" natively.
export function mobilePath(subpath: string): string {
  const normalized = subpath.startsWith("/") ? subpath : `/${subpath}`;
  return `${MOBILE_BASE}${normalized}`;
}

export function isNativeBuild(): boolean {
  return MOBILE_BASE === "";
}
