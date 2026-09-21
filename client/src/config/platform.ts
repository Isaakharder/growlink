// MOBILE_BASE is the path prefix under which the mobile app's routes are
// mounted. Both the web/PWA build (sharing one bundle with the desktop
// app, see router/routes.ts) and the native iOS build (see
// main.native.tsx / router/nativeRoutes.tsx) mount the identical
// mobileRouteChildren tree at "/mobile" — there is no longer a
// native-vs-web split here. An earlier version made this conditional on
// VITE_APP_TARGET so native could mount at "/" instead; that meant every
// mobile page had to route its absolute links through mobilePath() below
// rather than a literal string, and a few pages (EquipmentTab's
// equipment-detail navigation, MobilePestCalibrationPage,
// MobileFoodSafetyPage) never got converted, so their links 404'd under
// the native router while looking identical to the ones that worked.
// Mounting both builds at the same path removes that whole class of bug
// — a literal "/mobile/..." string is now correct under either router,
// same as it always was on web — rather than requiring every call site
// to be found and converted.
export const MOBILE_BASE = "/mobile";

// The mobile app's own home/index route.
export const MOBILE_HOME = MOBILE_BASE;

// Builds an absolute link to a mobile route from a path relative to the
// mobile app's root, e.g. mobilePath("/daily-yield") -> "/mobile/daily-yield".
// Existing callers keep working unchanged; new mobile-internal links can
// use this OR a literal "/mobile/..." string equally correctly now.
export function mobilePath(subpath: string): string {
  const normalized = subpath.startsWith("/") ? subpath : `/${subpath}`;
  return `${MOBILE_BASE}${normalized}`;
}
