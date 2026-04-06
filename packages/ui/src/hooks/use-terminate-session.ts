import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useTerminateSession(options?: {
  onSuccess?: (id: string) => void;
  onError?: (err: Error) => void;
}) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.terminateSession(id),
    onSuccess: (_, id) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      options?.onSuccess?.(id);
    },
    onError: options?.onError,
  });
}
