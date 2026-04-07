import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useSessionFileSystem(
  sessionId: string,
  opts?: { enabled?: boolean; showAllFiles?: boolean; path?: string },
) {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["session-filesystem", sessionId, opts?.showAllFiles, opts?.path],
    queryFn: () =>
      client.fetchSessionFileSystem(sessionId, {
        showAllFiles: opts?.showAllFiles,
        path: opts?.path,
      }),
    enabled: opts?.enabled ?? true,
    refetchInterval: 30_000,
  });
}
