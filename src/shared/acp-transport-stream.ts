import type * as acp from "@agentclientprotocol/sdk";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Bridges an MCP callback-style transport into the ACP SDK's stream interface.
 *
 * ACP connections speak in terms of `ReadableStream`/`WritableStream<AnyMessage>`,
 * while the MCP Streamable HTTP SDK exposes a `Transport` with `onmessage` callbacks.
 * Until ACP ships its own Streamable HTTP transport, this is the narrow adapter layer.
 */
export function createAcpTransportStream(transport: McpTransport): acp.Stream {
  let controller: ReadableStreamDefaultController<acp.AnyMessage> | null = null;

  const readable = new ReadableStream<acp.AnyMessage>({
    start(nextController) {
      controller = nextController;
      transport.onmessage = (message) => {
        nextController.enqueue(toAcpMessage(message));
      };
      transport.onerror = (error) => {
        if (controller) {
          controller.error(error);
          controller = null;
        }
      };
      transport.onclose = () => {
        if (controller) {
          controller.close();
          controller = null;
        }
      };
    },
    cancel() {
      controller = null;
      return transport.close();
    },
  });

  const writable = new WritableStream<acp.AnyMessage>({
    write(message) {
      return transport.send(toJsonRpcMessage(message));
    },
    close() {
      return transport.close();
    },
    abort() {
      return transport.close();
    },
  });

  return { readable, writable };
}

function toAcpMessage(message: JSONRPCMessage): acp.AnyMessage {
  if ("method" in message && "id" in message) {
    const next: JSONRPCRequest = {
      jsonrpc: message.jsonrpc,
      id: message.id,
      method: message.method,
    };
    if (message.params !== undefined) {
      next.params = message.params;
    }
    return next;
  }

  if ("method" in message) {
    const next: JSONRPCNotification = {
      jsonrpc: message.jsonrpc,
      method: message.method,
    };
    if (message.params !== undefined) {
      next.params = message.params;
    }
    return next;
  }

  if ("result" in message) {
    const next: JSONRPCResultResponse = {
      jsonrpc: message.jsonrpc,
      id: message.id,
      result: message.result,
    };
    return next;
  }

  const next: JSONRPCErrorResponse = {
    jsonrpc: message.jsonrpc,
    error: message.error,
  };
  if (message.id !== undefined) {
    next.id = message.id;
  }
  return next;
}

function toJsonRpcMessage(message: acp.AnyMessage): JSONRPCMessage {
  if ("method" in message && "id" in message) {
    const next: JSONRPCRequest = {
      jsonrpc: message.jsonrpc,
      id: message.id,
      method: message.method,
    };
    if (message.params !== undefined) {
      next.params = message.params;
    }
    return next;
  }

  if ("method" in message) {
    const next: JSONRPCNotification = {
      jsonrpc: message.jsonrpc,
      method: message.method,
    };
    if (message.params !== undefined) {
      next.params = message.params;
    }
    return next;
  }

  if ("result" in message) {
    const next: JSONRPCResultResponse = {
      jsonrpc: message.jsonrpc,
      id: message.id,
      result: message.result,
    };
    return next;
  }

  const next: JSONRPCErrorResponse = {
    jsonrpc: message.jsonrpc,
    error: message.error,
  };
  if (message.id !== undefined && message.id !== null) {
    next.id = message.id;
  }
  return next;
}
