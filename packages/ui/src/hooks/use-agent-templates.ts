import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "../provider.js";

export function useAgentTemplates() {
  const client = useFlamecastClient();
  return useQuery({
    queryKey: ["agent-templates"],
    queryFn: client.fetchAgentTemplates,
  });
}
