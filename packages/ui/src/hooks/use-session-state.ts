/**
 * useSessionState — derives session UI state from durable stream collections + ACP session.
 *
 * Returns structured session data backed by:
 * - durable-session (SSE collections) for state observation
 * - ACP client (prompt/cancel) for commands
 */

import { useMemo } from "react";
import { useCollections, useAcpSession, type SessionState } from "../provider.js";

export type MarkdownSegment =
  | { kind: "assistant"; text: string }
  | { kind: "user"; text: string }
  | { kind: "tool"; toolCallId: string; title: string; status: string };

export function useSessionState(sessionId: string) {
  const collections = useCollections();
  const acpSession: SessionState = useAcpSession();

  return useMemo(() => {
    const allChunks = [...collections.chunks.toArray];
    const allTurns = [...collections.promptTurns.toArray];
    const allPermissions = [...collections.permissions.toArray];

    const chunks = allChunks
      .filter((c) => c.logicalConnectionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
    const turns = allTurns.filter((t) => t.logicalConnectionId === sessionId);
    const permissions = allPermissions.filter((p) => p.logicalConnectionId === sessionId);

    const activeTurn = turns.find((t) => t.state === "active");
    const pendingPermissions = permissions.filter((p) => p.state === "pending");
    const isProcessing = activeTurn !== undefined;

    // Build markdown segments from chunks + turns
    const segments: MarkdownSegment[] = [];
    let currentTurnIdx = 0;

    for (const chunk of chunks) {
      // Insert user prompt before first chunk of each turn
      const turn = turns.find((t) => t.promptTurnId === chunk.promptTurnId);
      if (turn && turn.text && turns.indexOf(turn) >= currentTurnIdx) {
        segments.push({ kind: "user", text: turn.text });
        currentTurnIdx = turns.indexOf(turn) + 1;
      }

      if (chunk.type === "text") {
        const last = segments.at(-1);
        if (last?.kind === "assistant") {
          last.text += chunk.content;
        } else {
          segments.push({ kind: "assistant", text: chunk.content });
        }
      } else if (chunk.type === "tool_call") {
        try {
          const data = JSON.parse(chunk.content);
          segments.push({
            kind: "tool",
            toolCallId: data.toolCallId ?? "",
            title: data.title ?? data.name ?? "Tool",
            status: data.status ?? "running",
          });
        } catch {
          // skip malformed
        }
      }
    }

    return {
      // Session data
      session: null,
      isLoading: false,

      // Connection
      connectionState: acpSession.isReady ? ("connected" as const) : ("connecting" as const),
      isConnected: acpSession.isReady,

      // Data
      chunks,
      turns,
      markdownSegments: segments,
      isProcessing,

      // Permissions
      pendingPermissions,

      // Actions (from ACP client)
      prompt: acpSession.prompt,
      cancel: acpSession.cancel,
      terminate: acpSession.disconnect,
    };
  }, [collections, sessionId, acpSession]);
}
