import type { WsChannelEventMessage } from "@flamecast/protocol/ws/channels";

// ---------------------------------------------------------------------------
// Channel event — the internal representation flowing through the adapter
// ---------------------------------------------------------------------------

export interface ChannelEvent {
  sessionId: string;
  agentId: string;
  seq: number;
  event: {
    type: string;
    data: Record<string, unknown>;
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// agentId resolution — centralized so only this function changes when
// multi-session-per-agent lands
// ---------------------------------------------------------------------------

/**
 * Resolve the agentId for a given sessionId.
 * In the current 1:1 model, agentId === sessionId.
 */
export function resolveAgentId(sessionId: string): string {
  return sessionId;
}

// ---------------------------------------------------------------------------
// Event type → channel classification (explicit allowlists)
// ---------------------------------------------------------------------------

const TERMINAL_EVENT_TYPES = new Set([
  "terminal.create",
  "terminal.output",
  "terminal.release",
  "terminal.wait_for_exit",
  "terminal.kill",
]);

const QUEUE_EVENT_TYPES = new Set(["queue.updated", "queue.paused", "queue.resumed"]);

const FS_EVENT_TYPES = new Set(["filesystem.changed", "filesystem.snapshot", "file.preview"]);

function isTerminalEvent(event: ChannelEvent): boolean {
  // Direct terminal events
  if (TERMINAL_EVENT_TYPES.has(event.event.type)) return true;
  // RPC events wrapping terminal methods
  if (event.event.type === "rpc") {
    const method = event.event.data.method;
    if (typeof method === "string" && TERMINAL_EVENT_TYPES.has(method)) return true;
  }
  return false;
}

function isQueueEvent(event: ChannelEvent): boolean {
  if (QUEUE_EVENT_TYPES.has(event.event.type)) return true;
  if (event.event.type === "rpc") {
    const method = event.event.data.method;
    if (typeof method === "string" && QUEUE_EVENT_TYPES.has(method)) return true;
  }
  return false;
}

function isFsEvent(event: ChannelEvent): boolean {
  if (FS_EVENT_TYPES.has(event.event.type)) return true;
  if (event.event.type === "rpc") {
    const method = event.event.data.method;
    if (typeof method === "string" && FS_EVENT_TYPES.has(method)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// eventToChannels — returns channels in specificity order (most specific first)
// ---------------------------------------------------------------------------

/**
 * Map an event to all channel strings it belongs to.
 * Returns channels in **specificity order** (most specific first):
 *   sub-channel with ID > sub-channel > session > agent > global
 *
 * Used by the WS adapter for routing + deduplication: for each client,
 * the first channel from the ordered list that the client is subscribed to
 * is used as the event's `channel` tag.
 */
export function eventToChannels(event: ChannelEvent): string[] {
  const channels: string[] = [];
  const { sessionId, agentId } = event;

  // --- Most specific: sub-channels with IDs ---
  if (isTerminalEvent(event)) {
    const terminalId = event.event.data.terminalId;
    if (typeof terminalId === "string") {
      channels.push(`session:${sessionId}:terminal:${terminalId}`);
    }
    channels.push(`session:${sessionId}:terminal`);
  }

  if (isQueueEvent(event)) {
    channels.push(`session:${sessionId}:queue`);
  }

  if (isFsEvent(event)) {
    channels.push(`session:${sessionId}:fs`);
    channels.push(`agent:${agentId}:fs`);
  }

  // --- Session level ---
  channels.push(`session:${sessionId}`);

  // --- Agent level ---
  channels.push(`agent:${agentId}`);

  // --- Global ---
  channels.push("agents");

  return channels;
}

// ---------------------------------------------------------------------------
// Helpers for history replay filtering
// ---------------------------------------------------------------------------

export function isTerminalChannelEvent(event: ChannelEvent): boolean {
  return isTerminalEvent(event);
}

export function isQueueChannelEvent(event: ChannelEvent): boolean {
  return isQueueEvent(event);
}

export function isFsChannelEvent(event: ChannelEvent): boolean {
  return isFsEvent(event);
}

/**
 * Convert a ChannelEvent to the server→client WS message format.
 */
export function toWsChannelEvent(event: ChannelEvent, channel: string): WsChannelEventMessage {
  return {
    type: "event",
    channel,
    sessionId: event.sessionId,
    agentId: event.agentId,
    seq: event.seq,
    event: event.event,
  };
}
