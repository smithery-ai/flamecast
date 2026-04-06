import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useSession(id: string, opts?: { showAllFiles?: boolean }) {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["session", id, opts?.showAllFiles],
    queryFn: () =>
      client.fetchSession(id, { includeFileSystem: true, showAllFiles: opts?.showAllFiles }),
    staleTime: Infinity,
  });
}
