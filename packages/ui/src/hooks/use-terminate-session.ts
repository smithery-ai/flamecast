/**
 * useTerminateSession — disconnect the ACP session.
 *
 * Closing the WebSocket connection terminates the conductor session.
 * The DurableStateProxy updates the connection state to "closed".
 */

import { useCallback } from "react";
import { useAcpSession } from "../provider.js";

export function useTerminateSession() {
  const session = useAcpSession();

  const terminate = useCallback(() => {
    session.disconnect();
  }, [session]);

  return { terminate };
}
