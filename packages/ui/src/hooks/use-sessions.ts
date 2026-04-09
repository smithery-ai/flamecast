import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useSessions() {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["sessions"],
    queryFn: client.fetchSessions,
    refetchInterval: 5_000,
  });
}
