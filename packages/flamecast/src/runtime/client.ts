import type * as acp from "@agentclientprotocol/sdk";
import type {
  AgentSpawn,
  AgentTemplateRuntime,
  FilePreview,
  FileSystemSnapshot,
  PermissionResponseBody,
  SessionLog,
} from "../shared/session.js";

export interface RuntimeClient {
  startSession(opts: {
    agentName: string;
    spawn: AgentSpawn;
    cwd: string;
    runtime: AgentTemplateRuntime;
    startedAt: string;
  }): Promise<{ sessionId: string }>;

  promptSession(sessionId: string, text: string): Promise<acp.PromptResponse>;

  resolvePermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponseBody,
  ): Promise<void>;

  terminateSession(sessionId: string): Promise<void>;

  getFileSystemSnapshot(
    sessionId: string,
    opts?: { showAllFiles?: boolean },
  ): Promise<FileSystemSnapshot | null>;

  getFilePreview(sessionId: string, path: string): Promise<FilePreview>;

  subscribe(sessionId: string, callback: (event: SessionLog) => void): () => void;

  hasSession(sessionId: string): boolean;
  listSessionIds(): string[];
}
