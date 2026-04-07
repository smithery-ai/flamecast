import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useSession(id: string) {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => client.fetchSession(id),
    staleTime: Infinity,
  });
}
