// ---------------------------------------------------------------------------
// Multi-session WebSocket adapter — channel-based protocol (SMI-1704)
//
// These types define the multiplexed WS endpoint at ws://host/ws.
// The existing per-session types in ws.ts remain unchanged for backward compat.
// ---------------------------------------------------------------------------

/** A channel identifier, e.g. "session:abc", "agent:xyz:fs", "agents". */
export type Channel = string;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export interface WsChannelConnectedMessage {
  type: "connected";
  connectionId: string;
}

export interface WsSubscribedMessage {
  type: "subscribed";
  channel: Channel;
}

export interface WsUnsubscribedMessage {
  type: "unsubscribed";
  channel: Channel;
}

export interface WsChannelEventMessage {
  type: "event";
  channel: Channel;
  sessionId: string;
  agentId?: string;
  seq: number;
  event: {
    type: string;
    data: Record<string, unknown>;
    timestamp: string;
  };
}

export interface WsSessionCreatedMessage {
  type: "session.created";
  sessionId: string;
  agentId: string;
}

export interface WsSessionTerminatedMessage {
  type: "session.terminated";
  sessionId: string;
  agentId: string;
}

export interface WsChannelErrorMessage {
  type: "error";
  message: string;
  channel?: Channel;
}

export type WsChannelServerMessage =
  | WsChannelConnectedMessage
  | WsSubscribedMessage
  | WsUnsubscribedMessage
  | WsChannelEventMessage
  | WsSessionCreatedMessage
  | WsSessionTerminatedMessage
  | WsChannelErrorMessage;

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export interface WsSubscribeAction {
  action: "subscribe";
  channel: Channel;
  /** Optional sequence number — replay only events with seq > since. */
  since?: number;
}

export interface WsUnsubscribeAction {
  action: "unsubscribe";
  channel: Channel;
}

export interface WsChannelPromptAction {
  action: "prompt";
  sessionId: string;
  text: string;
}

export interface WsChannelPermissionRespondAction {
  action: "permission.respond";
  sessionId: string;
  requestId: string;
  body: { optionId: string } | { outcome: "cancelled" };
}

export interface WsChannelCancelAction {
  action: "cancel";
  sessionId: string;
  queueId?: string;
}

export interface WsChannelTerminateAction {
  action: "terminate";
  sessionId: string;
}

export interface WsChannelQueueReorderAction {
  action: "queue.reorder";
  sessionId: string;
  order: string[];
}

export interface WsChannelQueueClearAction {
  action: "queue.clear";
  sessionId: string;
}

export interface WsChannelQueuePauseAction {
  action: "queue.pause";
  sessionId: string;
}

export interface WsChannelQueueResumeAction {
  action: "queue.resume";
  sessionId: string;
}

export interface WsChannelPingAction {
  action: "ping";
}

export type WsChannelControlMessage =
  | WsSubscribeAction
  | WsUnsubscribeAction
  | WsChannelPromptAction
  | WsChannelPermissionRespondAction
  | WsChannelCancelAction
  | WsChannelTerminateAction
  | WsChannelQueueReorderAction
  | WsChannelQueueClearAction
  | WsChannelQueuePauseAction
  | WsChannelQueueResumeAction
  | WsChannelPingAction;
