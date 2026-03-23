export interface RuntimeClient {
  startSession(opts: {
    agentName: string;
    spawn: import("../shared/session.js").AgentSpawn;
    cwd: string;
    runtime: import("../shared/session.js").AgentTemplateRuntime;
    startedAt: string;
  }): Promise<{ sessionId: string }>;

  terminateSession(sessionId: string): Promise<void>;

  hasSession(sessionId: string): boolean;
  listSessionIds(): string[];
}
