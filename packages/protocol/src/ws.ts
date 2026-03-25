// ---------------------------------------------------------------------------
// Server → Client messages (WebSocket only — real-time events)
// ---------------------------------------------------------------------------

export interface WsEventMessage {
  type: "event";
  timestamp: string;
  event: { type: string; data: Record<string, unknown>; timestamp: string };
}

export interface WsConnectedMessage {
  type: "connected";
  sessionId: string;
}

export interface WsErrorMessage {
  type: "error";
  message: string;
}

export type WsServerMessage = WsEventMessage | WsConnectedMessage | WsErrorMessage;

// ---------------------------------------------------------------------------
// Client → Server messages (WebSocket only — commands)
// ---------------------------------------------------------------------------

export interface WsPromptAction {
  action: "prompt";
  text: string;
}

export interface WsPermissionRespondAction {
  action: "permission.respond";
  requestId: string;
  body: { optionId: string } | { outcome: "cancelled" };
}

export interface WsCancelAction {
  action: "cancel";
  queueId?: string;
}

export interface WsTerminateAction {
  action: "terminate";
}

export interface WsPingAction {
  action: "ping";
}

export type WsControlMessage =
  | WsPromptAction
  | WsPermissionRespondAction
  | WsCancelAction
  | WsTerminateAction
  | WsPingAction;
