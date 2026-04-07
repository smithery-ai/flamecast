import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useRuntimeFileSystem(
  instanceName: string,
  opts?: { enabled?: boolean; showAllFiles?: boolean; path?: string },
) {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["runtime-filesystem", instanceName, opts?.showAllFiles, opts?.path],
    queryFn: () =>
      client.fetchRuntimeFileSystem(instanceName, {
        showAllFiles: opts?.showAllFiles,
        path: opts?.path,
      }),
    enabled: opts?.enabled ?? true,
  });
}
