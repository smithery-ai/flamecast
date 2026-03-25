import { WebSocket } from "ws";

function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((value) => new Uint8Array(value));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new TextEncoder().encode(String(data));
}

export async function openWorkerAcpTransport(url, init = {}) {
  const ws = new WebSocket(url, init);

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      ws.off("open", onOpen);
      reject(error);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
  });

  const output = new ReadableStream({
    start(controller) {
      ws.on("message", (data) => {
        void Promise.resolve(toUint8Array(data)).then((value) => controller.enqueue(value));
      });
      ws.once("close", () => controller.close());
      ws.once("error", (error) => controller.error(error));
    },
    cancel() {
      ws.close();
    },
  });

  const input = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        ws.send(Buffer.from(chunk), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    close() {
      ws.close(1000, "ACP transport closed");
    },
    abort() {
      ws.close(1011, "ACP transport aborted");
    },
  });

  return {
    input,
    output,
    dispose: async () => {
      if (ws.readyState === WebSocket.CLOSED) {
        return;
      }

      await new Promise((resolve) => {
        ws.once("close", () => resolve());
        ws.close(1000, "ACP transport disposed");
      });
    },
  };
}

export function createCloudflareWorkerRuntimeProvider({ baseUrl, websocketUrl, headers } = {}) {
  const resolvedUrl =
    websocketUrl ??
    (() => {
      if (!baseUrl) {
        throw new Error("Provide either websocketUrl or baseUrl");
      }
      const url = new URL("/acp", baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    })();

  return {
    async start() {
      const transport = await openWorkerAcpTransport(resolvedUrl, headers ? { headers } : {});
      return {
        transport,
        terminate: async () => {
          await transport.dispose?.();
        },
      };
    },
  };
}
