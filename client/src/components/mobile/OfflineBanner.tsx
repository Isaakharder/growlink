import { useOnlineStatus } from "../../hooks/useOnlineStatus";

export function OfflineBanner() {
  const { isOnline } = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="offline-banner" role="alert" aria-live="assertive">
      No internet connection. Changes cannot be saved until connectivity returns.
    </div>
  );
}
