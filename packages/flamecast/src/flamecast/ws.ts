import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { StreamManager } from "./stream-manager.js";
import type { SessionManager } from "./sessions/session-manager.js";

const SESSION_STREAM_RE = /^\/sessions\/(fc_[0-9a-f]+)\/stream$/;

export interface WebSocketServerOptions {
  validateToken?: (token: string) => boolean;
}

export function attachWebSocketServer(
  httpServer: Server,
  streamManager: StreamManager,
  sessions: SessionManager,
  options?: WebSocketServerOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    const match = url.pathname.match(SESSION_STREAM_RE);

    if (!match) {
      socket.destroy();
      return;
    }

    if (options?.validateToken) {
      const token = url.searchParams.get("token");
      if (!token || !options.validateToken(token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const sessionId = match[1];

    // Verify session exists before upgrading
    sessions
      .get({ sessionId })
      .then((result) => {
        if (result.status !== "running") {
          socket.write(`HTTP/1.1 409 Conflict\r\n\r\n`);
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);

          streamManager.addClient(sessionId, ws).catch((err) => {
            console.error(`WS setup error for ${sessionId}:`, err);
            ws.close(1011, "failed to attach stream");
          });

          ws.on("message", (data: Buffer | string) => {
            streamManager.handleMessage(sessionId, data).catch((err) => {
              console.error(`WS message error for ${sessionId}:`, err);
            });
          });
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
      });
  });

  return wss;
}
