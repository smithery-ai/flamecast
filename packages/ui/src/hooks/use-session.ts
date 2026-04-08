/**
 * useSession — get a single connection from the durable stream.
 */

import { useCollections } from "../provider.js";

export function useSession(id: string) {
  const collections = useCollections();
  const connection = [...collections.connections.toArray].find(
    (c) => c.logicalConnectionId === id,
  );
  return {
    data: connection ?? null,
    isLoading: false,
    error: null,
  };
}
