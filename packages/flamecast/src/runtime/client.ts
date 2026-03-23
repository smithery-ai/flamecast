import type {
  FilePreview,
  FileSystemSnapshot,
} from "../shared/session.js";

export interface RuntimeClient {
  startSession(opts: {
    agentName: string;
    spawn: import("../shared/session.js").AgentSpawn;
    cwd: string;
    runtime: import("../shared/session.js").AgentTemplateRuntime;
    startedAt: string;
  }): Promise<{ sessionId: string }>;

  terminateSession(sessionId: string): Promise<void>;

  getFileSystemSnapshot(
    sessionId: string,
    opts?: { showAllFiles?: boolean },
  ): Promise<FileSystemSnapshot | null>;

  getFilePreview(sessionId: string, path: string): Promise<FilePreview>;

  hasSession(sessionId: string): boolean;
  listSessionIds(): string[];
}
