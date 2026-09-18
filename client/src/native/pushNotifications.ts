import { Capacitor } from "@capacitor/core";

// Push notifications — foundation only (Stage 1/2 of the iOS rollout).
// Nothing here requests permission or talks to the server yet; it exists
// so the plugin, its listeners, and the exact points Stage 3 needs to fill
// in are all in one place instead of invented later under time pressure.
//
// The full flow, once Stage 3 adds the server side:
//   1. A UI action the user chose on purpose (e.g. a Settings toggle),
//      having already explained why ("get notified when a work order is
//      assigned to you") — never on app launch — calls
//      requestPushPermissionAndRegister().
//   2. If granted, PushNotifications.register() triggers the "registration"
//      listener below with the APNs device token. Stage 3 POSTs that token,
//      plus the signed-in organization_id/user_id and a device identifier,
//      to a new server endpoint (e.g. POST /api/mobile/push-tokens) so a
//      notification can be addressed to this device. APNs credentials
//      (the .p8 key) live only on the server — never in this client.
//   3. Apple can replace a device's token at any time; the same
//      "registration" listener fires again with the new value, so the
//      server route in step 2 must upsert (organization_id, user_id,
//      device_id) -> token, not insert-only, or a rotated token would
//      leave a stale row a notification could still be (wrongly) sent to.
//   4. unregisterPushNotifications() (below) runs on logout, clearing this
//      device's local listeners; Stage 3 also has it call a
//      DELETE /api/mobile/push-tokens/:deviceId (or similar) so a signed-out
//      device stops receiving notifications addressed to the account that
//      just logged out.
//   5. pushNotificationActionPerformed (a tap on a delivered notification)
//      hands its payload to deepLinks.ts's extractInAppPath()/router
//      .navigate() — the same mechanism a universal link uses — so a tap
//      lands on the correct authorized mobile screen rather than just
//      opening the app to Mobile Home.

export async function registerPushListeners(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const { PushNotifications } = await import("@capacitor/push-notifications");

  PushNotifications.addListener("registration", (token) => {
    // Stage 3: POST token.value to the server, associated with this
    // device/user/organization. Logged for now so registration can be
    // verified end-to-end during Stage 2 device testing.
    console.info("[push] APNs device token received", token.value);
  });

  PushNotifications.addListener("registrationError", (error) => {
    console.warn("[push] APNs registration failed", error);
  });

  PushNotifications.addListener("pushNotificationReceived", (notification) => {
    console.info("[push] notification received in foreground", notification);
  });

  PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    // Stage 3: route action.notification.data.path (server-supplied) through
    // deepLinks.ts's extractInAppPath()/router.navigate().
    console.info("[push] notification tapped", action.notification);
  });
}

export async function requestPushPermissionAndRegister(): Promise<"granted" | "denied" | "unavailable"> {
  if (!Capacitor.isNativePlatform()) return "unavailable";

  const { PushNotifications } = await import("@capacitor/push-notifications");
  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return "denied";

  await PushNotifications.register();
  return "granted";
}

export async function unregisterPushNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const { PushNotifications } = await import("@capacitor/push-notifications");
  await PushNotifications.removeAllListeners();
  // Stage 3: also call the server to delete this device's stored token.
}
