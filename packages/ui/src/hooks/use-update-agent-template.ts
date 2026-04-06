import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentTemplate } from "@flamecast/sdk/session";
import { useFlamecastClient } from "../provider.js";

export function useUpdateAgentTemplate(
  templateId: string,
  options?: {
    onSuccess?: (template: AgentTemplate) => void;
    onError?: (err: Error) => void;
  },
) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      command: string;
      args: string[];
      provider: string;
      setup?: string;
      env?: Record<string, string>;
      currentRuntime?: AgentTemplate["runtime"];
    }) =>
      client.updateAgentTemplate(templateId, {
        name: body.name,
        spawn: { command: body.command, args: body.args },
        runtime: {
          ...body.currentRuntime,
          provider: body.provider,
          setup: body.setup,
        },
        env: body.env,
      }),
    onSuccess: (template) => {
      void queryClient.invalidateQueries({ queryKey: ["agent-templates"] });
      options?.onSuccess?.(template);
    },
    onError: options?.onError,
  });
}
