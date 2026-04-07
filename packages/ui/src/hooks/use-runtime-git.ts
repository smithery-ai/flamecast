import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useRuntimeGitBranches(
  instanceName: string,
  opts?: { enabled?: boolean; path?: string },
) {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["runtime-git-branches", instanceName, opts?.path],
    queryFn: () => client.fetchRuntimeGitBranches(instanceName, { path: opts?.path }),
    enabled: opts?.enabled ?? true,
  });
}

export function useRuntimeGitWorktrees(
  instanceName: string,
  opts?: { enabled?: boolean; path?: string },
) {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["runtime-git-worktrees", instanceName, opts?.path],
    queryFn: () => client.fetchRuntimeGitWorktrees(instanceName, { path: opts?.path }),
    enabled: opts?.enabled ?? true,
  });
}

export function useCreateRuntimeGitWorktree(
  instanceName: string,
  opts?: { onSuccess?: () => void },
) {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      path?: string;
      branch?: string;
      newBranch?: boolean;
      startPoint?: string;
    }) => client.createRuntimeGitWorktree(instanceName, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["runtime-git-worktrees", instanceName],
      });
      opts?.onSuccess?.();
    },
  });
}
