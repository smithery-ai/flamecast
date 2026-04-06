import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useRuntimeFileSystem(instanceName: string, opts?: { enabled?: boolean; showAllFiles?: boolean }) {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["runtime-filesystem", instanceName, opts?.showAllFiles],
    queryFn: () => client.fetchRuntimeFileSystem(instanceName, { showAllFiles: opts?.showAllFiles }),
    enabled: opts?.enabled ?? true,
    refetchInterval: 30_000,
  });
}
