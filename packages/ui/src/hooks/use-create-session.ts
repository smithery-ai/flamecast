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
    mutationFn: ({
      agentTemplateId,
      runtimeInstance,
    }: {
      agentTemplateId: string;
      runtimeInstance?: string;
    }) => client.createSession({ agentTemplateId, cwd: undefined, runtimeInstance }),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      options?.onSuccess?.(session);
    },
    onError: options?.onError,
  });
}
