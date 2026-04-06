import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileSystemEntry, SessionLog } from "@flamecast/sdk/session";
import { PendingPermissionSchema } from "@flamecast/sdk/session";
import type { PermissionRequestEvent } from "@flamecast/protocol/session-host";
import { useSession } from "./use-session.js";
import { useFlamecastSession } from "./use-flamecast-session.js";
import { sessionLogsToSegments } from "../lib/logs-markdown.js";

export function useSessionState(sessionId: string, opts?: { showAllFiles?: boolean }) {
  const [showAllFiles, setShowAllFiles] = useState(opts?.showAllFiles ?? false);

  const sessionQuery = useSession(sessionId, { showAllFiles });
  const session = sessionQuery.data;

  const {
    events: wsEvents,
    connectionState,
    isConnected,
    prompt: wsPrompt,
    respondToPermission: wsRespondToPermission,
    requestFilePreview,
    requestFsSnapshot,
    cancel,
    terminate,
  } = useFlamecastSession(sessionId, session?.websocketUrl);

  // Merge: use WS events if available, fall back to REST logs
  const logs: SessionLog[] = useMemo(() => {
    if (wsEvents.length > 0) return [...wsEvents];
    return session?.logs ?? [];
  }, [wsEvents, session?.logs]);

  // Derive all pending permissions from WS events
  const pendingPermissions = useMemo(() => {
    const resolvedIds = new Set<string>();
    for (const event of wsEvents) {
      if (
        event.type === "permission_approved" ||
        event.type === "permission_rejected" ||
        event.type === "permission_cancelled" ||
        event.type === "permission_responded"
      ) {
        const rid = event.data.requestId;
        if (typeof rid === "string") resolvedIds.add(rid);
      }
    }
    const pending: PermissionRequestEvent[] = [];
    for (const event of wsEvents) {
      if (event.type === "permission_request") {
        const parsed = PendingPermissionSchema.safeParse(event.data);
        if (parsed.success && !resolvedIds.has(parsed.data.requestId)) {
          pending.push(parsed.data);
        }
      }
    }
    if (pending.length === 0 && session?.pendingPermission) {
      return [session.pendingPermission];
    }
    return pending;
  }, [wsEvents, session?.pendingPermission]);

  // Filesystem state
  const [fileEntries, setFileEntries] = useState<FileSystemEntry[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.fileSystem) return;
    setFileEntries(session.fileSystem.entries);
    setWorkspaceRoot(session.fileSystem.root);
  }, [session?.fileSystem]);

  const fsChangeCount = useMemo(
    () => wsEvents.filter((e) => e.type === "filesystem.changed").length,
    [wsEvents],
  );

  useEffect(() => {
    if (!session) return;
    requestFsSnapshot({ showAllFiles })
      .then((snapshot) => {
        setFileEntries(snapshot.entries);
        setWorkspaceRoot(snapshot.root);
      })
      .catch(() => {});
  }, [fsChangeCount, requestFsSnapshot, session, showAllFiles]);

  // Markdown segments
  const markdownSegments = useMemo(() => sessionLogsToSegments(logs), [logs]);

  // Derive isProcessing from event stream
  const isProcessing = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      if (log.type === "rpc") {
        const d = log.data;
        if (d.method === "session/prompt") {
          // RPC response = prompt finished
          if (d.direction === "agent_to_client" && d.phase === "response") return false;
          // RPC request = prompt started
          if (d.direction === "client_to_agent" && d.phase === "request") return true;
        }
      }
    }
    return false;
  }, [logs]);

  // Permission handler
  const respondToPermission = useCallback(
    (requestId: string, body: { optionId: string } | { outcome: "cancelled" }) => {
      wsRespondToPermission(requestId, body);
    },
    [wsRespondToPermission],
  );

  return {
    // Session data
    session,
    isLoading: sessionQuery.isLoading,

    // Connection
    connectionState,
    isConnected,

    // Logs & segments
    logs,
    markdownSegments,
    isProcessing,

    // Permissions
    pendingPermissions,
    respondToPermission,

    // Filesystem
    fileEntries,
    workspaceRoot,
    showAllFiles,
    setShowAllFiles,

    // Actions
    prompt: wsPrompt,
    cancel,
    terminate,
    requestFilePreview,
  };
}
