/**
 * useAgentTemplates — list available agent templates.
 *
 * TODO: Wire to a REST endpoint that reads agents.toml from the conductor.
 * For now returns an empty list (no throw).
 */

export function useAgentTemplates() {
  return { data: [], isLoading: false, error: null };
}
