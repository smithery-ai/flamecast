/**
 * useSessionFilesystem — browse agent workspace files via REST API.
 */

import { useCallback, useEffect, useState } from "react";
import { useEndpoints } from "../provider.js";

interface TreeEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export function useSessionFilesystem(sessionId: string) {
  const endpoints = useEndpoints();
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [error, setError] = useState<Error | null>(null);

  const fetchTree = useCallback(
    async (path?: string) => {
      try {
        const params = path ? `?path=${encodeURIComponent(path)}` : "";
        const resp = await fetch(
          `${endpoints.apiUrl}/api/v1/connections/${sessionId}/fs/tree${params}`,
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data: TreeEntry[] = await resp.json();
        setTree(data);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    },
    [endpoints.apiUrl, sessionId],
  );

  const readFile = useCallback(
    async (path: string): Promise<string> => {
      const resp = await fetch(
        `${endpoints.apiUrl}/api/v1/connections/${sessionId}/files?path=${encodeURIComponent(path)}`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.text();
    },
    [endpoints.apiUrl, sessionId],
  );

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  return { tree, fetchTree, readFile, error };
}
