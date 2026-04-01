import type { WsChannelEventMessage } from "@flamecast/protocol/ws/channels";
import type { SessionLog } from "../../shared/session.js";

/**
 * Convert multiplexed WS channel events to the SessionLog shape that
 * `sessionLogsToSegments()` expects. Thin mapper — no data transformation.
 */
export function channelEventsToLogs(events: WsChannelEventMessage[]): SessionLog[] {
  return events.map((msg) => ({
    type: msg.event.type,
    timestamp: msg.event.timestamp,
    data: msg.event.data,
  }));
}
