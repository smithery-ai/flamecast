import { useQuery } from "@tanstack/react-query";
import { useFlamecastClient } from "@flamecast/ui";

/**
 * Polls the backend /health endpoint to determine connectivity.
 * Returns `isConnected: false` when the backend is unreachable.
 */
export function useBackendHealth() {
  const client = useFlamecastClient();

  const query = useQuery({
    queryKey: ["backend-health"],
    queryFn: async () => {
      // fetchRuntimes is a lightweight GET that hits the server.
      // If it throws (network error, 5xx, etc.), React Query marks it as an error.
      await client.fetchRuntimes();
      return { ok: true as const };
    },
    refetchInterval: 10_000,
    retry: 1,
    retryDelay: 2_000,
  });

  // Connected once the first successful response arrives.
  // Disconnected if the query is in error state (network failure / server down).
  const isConnected = query.isSuccess;
  const isChecking = query.isLoading;

  return { isConnected, isChecking, error: query.error };
}
