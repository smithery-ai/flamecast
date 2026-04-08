/**
 * useSessionState — derives session UI state from durable stream collections.
 */

import { useMemo } from "react";
import { useCollections } from "../provider.js";

export function useSessionState(sessionId: string) {
  const collections = useCollections();

  return useMemo(() => {
    const allChunks = [...collections.chunks.toArray];
    const allTurns = [...collections.promptTurns.toArray];
    const allPermissions = [...collections.permissions.toArray];

    const chunks = allChunks.filter((c) => c.logicalConnectionId === sessionId);
    const turns = allTurns.filter((t) => t.logicalConnectionId === sessionId);
    const permissions = allPermissions.filter((p) => p.logicalConnectionId === sessionId);

    const activeTurn = turns.find((t) => t.state === "active");
    const pendingPermissions = permissions.filter((p) => p.state === "pending");
    const isLoading = activeTurn !== undefined;

    return {
      chunks,
      turns,
      permissions,
      activeTurn,
      pendingPermissions,
      isLoading,
    };
  }, [collections, sessionId]);
}
