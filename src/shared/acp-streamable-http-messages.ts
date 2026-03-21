import type * as acp from "@agentclientprotocol/sdk";

export type JsonRpcId = string | number | null;

type JsonRpcObject = Record<string, unknown>;

export function parseAcpMessage(value: unknown): acp.AnyMessage | null {
  if (!isJsonRpcObject(value) || value.jsonrpc !== "2.0") {
    return null;
  }

  if (typeof value.method === "string") {
    if ("id" in value) {
      if (!isJsonRpcId(value.id)) {
        return null;
      }
      return value.params === undefined
        ? {
            jsonrpc: "2.0",
            id: value.id,
            method: value.method,
          }
        : {
            jsonrpc: "2.0",
            id: value.id,
            method: value.method,
            params: value.params,
          };
    }
    return value.params === undefined
      ? {
          jsonrpc: "2.0",
          method: value.method,
        }
      : {
          jsonrpc: "2.0",
          method: value.method,
          params: value.params,
        };
  }

  if (!("id" in value) || !isJsonRpcId(value.id)) {
    return null;
  }

  if ("result" in value) {
    return {
      jsonrpc: "2.0",
      id: value.id,
      result: value.result,
    };
  }

  if (
    "error" in value &&
    isJsonRpcObject(value.error) &&
    typeof value.error.code === "number" &&
    typeof value.error.message === "string"
  ) {
    return value.error.data === undefined
      ? {
          jsonrpc: "2.0",
          id: value.id,
          error: {
            code: value.error.code,
            message: value.error.message,
          },
        }
      : {
          jsonrpc: "2.0",
          id: value.id,
          error: {
            code: value.error.code,
            message: value.error.message,
            data: value.error.data,
          },
        };
  }

  return null;
}

export function parseAcpMessages(value: unknown): acp.AnyMessage[] | null {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return null;
  }

  const messages = values.map(parseAcpMessage);
  return messages.every((message) => message !== null) ? messages : null;
}

export function isRequestMessage(
  message: acp.AnyMessage,
): message is Extract<acp.AnyMessage, { method: string; id: JsonRpcId }> {
  return "method" in message && "id" in message;
}

export function isResponseMessage(
  message: acp.AnyMessage,
): message is Extract<acp.AnyMessage, { id: JsonRpcId }> {
  return "id" in message && !("method" in message);
}

export function isInitializeRequest(message: acp.AnyMessage): boolean {
  return isRequestMessage(message) && message.method === "initialize";
}

function isJsonRpcObject(value: unknown): value is JsonRpcObject {
  return typeof value === "object" && value !== null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}
