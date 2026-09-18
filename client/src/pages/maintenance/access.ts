// Single source of truth for "can this user reach the Maintenance module."
// Both the Mobile Home card (MobileHomePage.tsx) and the /mobile/maintenance
// route guards (router/routes.tsx) import this exact array rather than each
// writing out their own literal — so a future edit to who gets Maintenance
// access can't accidentally update one and not the other, and the two can
// never disagree about who's authorized.
export const MAINTENANCE_ACCESS_PERMISSIONS: string[] = ["mobile:maintenance", "maintenance:view", "maintenance:edit"];
