export { Flamecast } from "./flamecast/index.js";
export type { AppType } from "./flamecast/index.js";
export { FlamecastClient } from "./flamecast/client.js";
export { SessionManager, SessionError } from "./flamecast/sessions/session-manager.js";
export { createMcpServer, createMcpHandler } from "./flamecast/mcp.js";
export type {
  Session,
  SessionStatus,
  CreateParams,
  CreateResult,
  ExecParams,
  ExecResult,
  ExecAsyncParams,
  ExecAsyncResult,
  InputParams,
  InputResult,
  GetParams,
  GetResult,
  ListResult,
  CloseParams,
  CloseResult,
} from "./flamecast/sessions/types.js";
