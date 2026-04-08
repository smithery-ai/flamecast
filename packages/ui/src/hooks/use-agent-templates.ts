/**
 * useAgentTemplates — list available agent templates from the conductor.
 *
 * Fetches from GET /api/v1/agent-templates which reads agents.toml.
 */

import { useEffect, useState } from "react";
import { useEndpoints } from "../provider.js";

interface AgentTemplate {
  name: string;
  port: number;
  agent?: string;
  command?: string[];
}

export function useAgentTemplates() {
  const endpoints = useEndpoints();
  const [data, setData] = useState<AgentTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const resp = await fetch(`${endpoints.apiUrl}/api/v1/agent-templates`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const templates: AgentTemplate[] = await resp.json();
        if (!cancelled) {
          setData(templates);
          setIsLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setIsLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [endpoints.apiUrl]);

  return { data, isLoading, error };
}
