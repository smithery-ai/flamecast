import type * as acp from "@agentclientprotocol/sdk";
import type {
  AgentSpawn,
  AgentTemplateRuntime,
  McpServer,
  QueuedPromptResponse,
} from "../shared/session.js";

export interface RuntimeClient {
  startSession(opts: {
    agentName: string;
    spawn: AgentSpawn;
    cwd: string;
    runtime: AgentTemplateRuntime;
    startedAt: string;
    mcpServers?: McpServer[];
  }): Promise<{ sessionId: string }>;

  promptSession(
    sessionId: string,
    text: string,
  ): Promise<acp.PromptResponse | QueuedPromptResponse>;

  terminateSession(sessionId: string): Promise<void>;

  hasSession(sessionId: string): boolean;
  listSessionIds(): string[];
}
