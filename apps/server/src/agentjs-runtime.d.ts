export class AgentJsRuntime {
  constructor(options?: {
    baseUrl?: string;
    websocketUrl?: string;
    headers?: Record<string, string>;
  });
  fetchSession(sessionId: string, request: Request): Promise<Response>;
  dispose(): Promise<void>;
}
