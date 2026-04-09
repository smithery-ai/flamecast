import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@flamecast/sdk/session";
import { useFlamecastClient } from "../provider.js";

export function useCreateSession(options?: {
  onSuccess?: (session: Session) => void;
  onError?: (err: Error) => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      sessionId?: string;
      agentTemplateId: string;
      runtimeInstance?: string;
      cwd?: string;
      /** Display name for optimistic sidebar entry. */
      agentName?: string;
    }) =>
      client.createSession({
        sessionId: vars.sessionId,
        agentTemplateId: vars.agentTemplateId,
        cwd: vars.cwd,
        runtimeInstance: vars.runtimeInstance,
      }),
    onMutate: async (vars) => {
      if (!vars.sessionId) return;
      await queryClient.cancelQueries({ queryKey: ["sessions"] });
      const previous = queryClient.getQueryData<Session[]>(["sessions"]);
      const placeholder: Session = {
        id: vars.sessionId,
        agentName: vars.agentName ?? "Starting...",
        spawn: { command: "", args: [] },
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        status: "active",
        logs: [],
        pendingPermission: null,
        fileSystem: null,
        promptQueue: null,
        runtime: vars.runtimeInstance,
        cwd: vars.cwd,
      };
      queryClient.setQueryData<Session[]>(["sessions"], (old) => [placeholder, ...(old ?? [])]);
      return { previous };
    },
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      options?.onSuccess?.(session);
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["sessions"], context.previous);
      }
      options?.onError?.(err);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}
