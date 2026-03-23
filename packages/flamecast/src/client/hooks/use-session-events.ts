import { useMemo } from "react";
import type { SessionLog } from "../../shared/session.js";

/**
 * Filter session events by type(s).
 *
 * @param events - All session events (from useFlamecastSession)
 * @param eventTypes - One or more event type strings to filter by.
 *                     If omitted, returns all events.
 */
export function useSessionEvents(
  events: readonly SessionLog[],
  ...eventTypes: string[]
): readonly SessionLog[] {
  return useMemo(() => {
    if (eventTypes.length === 0) return events;
    const typeSet = new Set(eventTypes);
    return events.filter((e) => typeSet.has(e.type));
  }, [events, ...eventTypes]);
}
