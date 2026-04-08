/**
 * useTerminal — terminal state from durable stream + kill via REST.
 */

import { useCallback, useMemo } from "react";
import { useCollections, useEndpoints } from "../provider.js";

export interface TerminalSession {
  terminalId: string;
  command?: string;
  state: "open" | "exited" | "released" | "broken";
}

export function useTerminal(sessionId: string) {
  const collections = useCollections();
  const endpoints = useEndpoints();

  const terminals: TerminalSession[] = useMemo(
    () =>
      [...collections.terminals.toArray]
        .filter((t) => t.logicalConnectionId === sessionId)
        .map((t) => ({
          terminalId: t.terminalId,
          command: t.command,
          state: t.state,
        })),
    [collections, sessionId],
  );

  const killTerminal = useCallback(
    async (terminalId: string) => {
      await fetch(
        `${endpoints.apiUrl}/api/v1/connections/${sessionId}/terminals/${terminalId}`,
        { method: "DELETE" },
      );
    },
    [endpoints.apiUrl, sessionId],
  );

  return { terminals, killTerminal };
}
