/**
 * useSessions — list all connections from the durable stream.
 *
 * Replaces the old REST polling with reactive StreamDB collections.
 */

import { useCollections } from "../provider.js";

export function useSessions() {
  const collections = useCollections();
  return {
    data: [...collections.connections.toArray],
    isLoading: false,
    error: null,
  };
}
