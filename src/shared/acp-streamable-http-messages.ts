import * as acp from "@agentclientprotocol/sdk";
import { zInitializeRequest } from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";

export type JsonRpcId = string | number | null;

const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

const JsonRpcRequestMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const JsonRpcResponseMessageSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .refine((message) => message.result !== undefined || message.error !== undefined, {
    message: "A JSON-RPC response must include result or error",
  });

const JsonRpcMessageSchema = z.union([JsonRpcRequestMessageSchema, JsonRpcResponseMessageSchema]);

const InitializeRequestMessageSchema = JsonRpcRequestMessageSchema.extend({
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
