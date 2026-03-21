import * as acp from "@agentclientprotocol/sdk";
import { zInitializeRequest } from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";

export type JsonRpcId = string | number | null;

type JsonRpcNotificationMessage = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcRequestMessage = JsonRpcNotificationMessage & {
  id: JsonRpcId;
};

type JsonRpcErrorResponse = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcSuccessResponseMessage = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcErrorResponseMessage = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorResponse;
};

type JsonRpcResponseMessage = JsonRpcSuccessResponseMessage | JsonRpcErrorResponseMessage;
type JsonRpcMessage = JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage;

const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

const JsonRpcNotificationMessageSchema: z.ZodType<JsonRpcNotificationMessage> = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

const JsonRpcRequestMessageSchema: z.ZodType<JsonRpcRequestMessage> = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});

const JsonRpcErrorSchema: z.ZodType<JsonRpcErrorResponse> = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

const JsonRpcSuccessResponseMessageSchema: z.ZodType<JsonRpcSuccessResponseMessage> = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  result: z.unknown(),
});

const JsonRpcErrorResponseMessageSchema: z.ZodType<JsonRpcErrorResponseMessage> = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  error: JsonRpcErrorSchema,
});

const JsonRpcResponseMessageSchema: z.ZodType<JsonRpcResponseMessage> = z.union([
  JsonRpcSuccessResponseMessageSchema,
  JsonRpcErrorResponseMessageSchema,
]);

const JsonRpcMessageSchema: z.ZodType<JsonRpcMessage> = z.union([
  JsonRpcRequestMessageSchema,
  JsonRpcNotificationMessageSchema,
  JsonRpcResponseMessageSchema,
]);

const InitializeRequestMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  method: z.literal(acp.AGENT_METHODS.initialize),
  params: zInitializeRequest,
});

export function parseServerInboundAcpMessages(value: unknown): acp.AnyMessage[] | null {
  return parseMessageBatch(value);
}

export function parseClientInboundAcpMessage(value: unknown): acp.AnyMessage | null {
  const result = JsonRpcMessageSchema.safeParse(value);
  return result.success ? result.data : null;
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
  return InitializeRequestMessageSchema.safeParse(message).success;
}

function parseMessageBatch(value: unknown): acp.AnyMessage[] | null {
  const batchSchema = z.union([JsonRpcMessageSchema, z.array(JsonRpcMessageSchema).min(1)]);
  const result = batchSchema.safeParse(value);
  if (!result.success) {
    return null;
  }

  return Array.isArray(result.data) ? result.data : [result.data];
}
