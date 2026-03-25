import type { FileSystemEntry } from "./session-host.js";

// ---------------------------------------------------------------------------
// Server → Client messages
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

export interface WsFilePreviewResponse {
  type: "file.preview";
  path: string;
  content: string;
  truncated: boolean;
  maxChars: number;
}

export interface WsFsSnapshotResponse {
  type: "fs.snapshot";
  root: string;
  entries: FileSystemEntry[];
  truncated: boolean;
  maxEntries: number;
}

export type WsServerMessage =
  | WsEventMessage
  | WsConnectedMessage
  | WsErrorMessage
  | WsFilePreviewResponse
  | WsFsSnapshotResponse;

// ---------------------------------------------------------------------------
// Client → Server messages
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

export interface WsFilePreviewAction {
  action: "file.preview";
  path: string;
}

export interface WsFsSnapshotAction {
  action: "fs.snapshot";
  showAllFiles?: boolean;
}

export type WsControlMessage =
  | WsPromptAction
  | WsPermissionRespondAction
  | WsCancelAction
  | WsTerminateAction
  | WsPingAction
  | WsFilePreviewAction
  | WsFsSnapshotAction;
