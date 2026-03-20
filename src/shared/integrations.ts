import { z } from "zod";

export const IntegrationProviderSchema = z.enum(["slack", "linear"]);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;

export const ConversationSourcePlatformSchema = z.enum([
  "slack",
  "linear_comment",
  "linear_agent_session",
]);
export type ConversationSourcePlatform = z.infer<typeof ConversationSourcePlatformSchema>;

export const IntegrationInstallSchema = z.object({
  id: z.string(),
  provider: IntegrationProviderSchema,
  externalId: z.string(),
  label: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  hasCredential: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IntegrationInstall = z.infer<typeof IntegrationInstallSchema>;

export const ConversationSourceSchema = z.object({
  platform: ConversationSourcePlatformSchema,
  threadId: z.string(),
  installId: z.string().nullable(),
  externalWorkspaceId: z.string().nullable(),
  externalThreadLabel: z.string().nullable(),
});
export type ConversationSource = z.infer<typeof ConversationSourceSchema>;

export const ConversationBindingSchema = z.object({
  id: z.string(),
  source: ConversationSourceSchema,
  connectionId: z.string().nullable(),
  sessionId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConversationBinding = z.infer<typeof ConversationBindingSchema>;

export const TranscriptEventSchema = z.object({
  id: z.string(),
  bindingId: z.string(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

export const BrokerTokenScopeSchema = z.object({
  installId: z.string().nullable(),
  services: z.array(IntegrationProviderSchema).min(1),
  methods: z.array(z.string().min(1)).default(["GET", "POST"]),
  pathPrefixes: z.array(z.string().min(1)).default([]),
  expiresAt: z.string(),
});
export type BrokerTokenScope = z.infer<typeof BrokerTokenScopeSchema>;
