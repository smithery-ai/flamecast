import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentTemplate } from "@flamecast/sdk/session";
import { useFlamecastClient } from "../provider.js";

export function useRegisterAgentTemplate(options?: {
  onSuccess?: (template: AgentTemplate) => void;
  onError?: (err: Error) => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      command: string;
      args: string[];
      provider?: string;
      setup?: string;
      env?: Record<string, string>;
    }) =>
      client.registerAgentTemplate({
        name: body.name,
        spawn: { command: body.command, args: body.args },
        runtime: {
          provider: body.provider ?? "default",
          ...(body.setup ? { setup: body.setup } : {}),
        },
        ...(body.env && Object.keys(body.env).length > 0 ? { env: body.env } : {}),
      }),
    onSuccess: (template) => {
      void queryClient.invalidateQueries({ queryKey: ["agent-templates"] });
      options?.onSuccess?.(template);
    },
    onError: options?.onError,
  });
}
