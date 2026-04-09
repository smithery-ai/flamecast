import { useBackendHealth } from "@/hooks/use-backend-health";
import { LoaderCircleIcon, WifiOffIcon } from "lucide-react";

/**
 * Full-screen overlay that blocks the SPA when the backend is unreachable.
 * Renders nothing when the connection is healthy.
 */
export function ConnectionOverlay() {
  const { isConnected, isChecking } = useBackendHealth();

  if (isConnected) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/80 backdrop-blur-sm">
      {isChecking ? (
        <>
          <LoaderCircleIcon className="size-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Connecting to backend...</p>
        </>
      ) : (
        <>
          <WifiOffIcon className="size-8 text-destructive" />
          <div className="flex flex-col items-center gap-1">
            <p className="text-sm font-medium">Unable to connect to backend</p>
            <p className="text-xs text-muted-foreground">Retrying automatically...</p>
          </div>
        </>
      )}
    </div>
  );
}
