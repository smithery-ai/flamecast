import * as acp from "@agentclientprotocol/sdk";
import { AgentAcpClient } from "@/client/lib/agent-acp";
import { useEffect, useEffectEvent, useRef } from "react";
import type { PermissionResponseBody } from "@/shared/session";

type UseAgentOptions = {
  agentId: string;
  sessionId: string;
  cwd?: string | null;
  onPermissionRequested?: (params: acp.RequestPermissionRequest) => void | Promise<void>;
  onSessionUpdate?: (params: acp.SessionNotification) => void | Promise<void>;
};

export function useAgent({
  agentId,
  sessionId,
  cwd,
  onPermissionRequested,
  onSessionUpdate,
}: UseAgentOptions) {
  const clientRef = useRef<AgentAcpClient | null>(null);
  const handleSessionUpdate = useEffectEvent(async (params: acp.SessionNotification) => {
    await onSessionUpdate?.(params);
  });
  const handlePermissionRequested = useEffectEvent(
    async (params: acp.RequestPermissionRequest) => {
      await onPermissionRequested?.(params);
    },
  );

  useEffect(() => {
    if (!cwd) {
      return;
    }

    const client = new AgentAcpClient(agentId, {
      onSessionUpdate: handleSessionUpdate,
      onPermissionRequested: handlePermissionRequested,
    });
    clientRef.current = client;
    let cancelled = false;

    void (async () => {
      try {
        await client.connect();
        if (cancelled) {
          return;
        }
        await client.loadSession(sessionId, cwd);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to attach ACP session", error);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      void client.close();
    };
  }, [agentId, cwd, handlePermissionRequested, handleSessionUpdate, sessionId]);

  const getClient = () => {
    const client = clientRef.current;
    if (!client) {
      throw new Error("ACP client is not ready");
    }
    return client;
  };

  return {
    prompt: (text: string) => getClient().prompt(sessionId, text),
    respondToPermission: (body: PermissionResponseBody) =>
      getClient().respondToPermission(sessionId, body),
  };
}
