import { WebSocket } from "ws";

export async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

export async function startSession(baseUrl: string, sessionId: string) {
  return readJson<{
    acpSessionId: string;
    hostUrl: string;
    websocketUrl: string;
  }>(
    await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "agentjs",
        args: [],
        workspace: process.cwd(),
      }),
    }),
  );
}

export async function terminateSession(baseUrl: string, sessionId: string) {
  const response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/terminate`, {
    method: "POST",
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(await response.text());
  }
}

export async function openSessionSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Session WebSocket timed out")), 10_000);
    const finish = (callback: () => void) => {
      clearTimeout(timeout);
      ws.off("error", onError);
      callback();
    };
    const onError = (error: Error) => finish(() => reject(error));

    ws.once("open", () => finish(resolve));
    ws.once("error", onError);
  });

  return ws;
}

export async function closeSessionSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 1_000);

    ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.close();
  });
}

export async function promptSession(ws: WebSocket, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let completedResult: unknown;
    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`Timed out waiting for prompt completion: ${text}`));
    }, 20_000);

    const cleanupListeners = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    const onError = (error: Error) => {
      cleanupListeners();
      reject(error);
    };

    const onClose = () => {
      cleanupListeners();
      reject(new Error("Session WebSocket closed before prompt completed"));
    };

    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data));

      if (message.type === "error") {
        cleanupListeners();
        reject(new Error(message.message));
        return;
      }

      if (message.type !== "event" || message.event?.type !== "rpc") {
        return;
      }

      const rpc = message.event.data;
      const update = rpc?.payload?.update;
      if (
        update &&
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
        update.status === "completed"
      ) {
        completedResult = update.rawOutput?.result;
      }

      if (rpc?.method === "session/prompt" && rpc.phase === "response") {
        cleanupListeners();
        resolve(completedResult);
      }
    };

    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
    ws.send(JSON.stringify({ action: "prompt", text }));
  });
}
