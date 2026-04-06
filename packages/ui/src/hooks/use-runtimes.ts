import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useRuntimes() {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["runtimes"],
    queryFn: client.fetchRuntimes,
    refetchInterval: 30_000,
  });
}
