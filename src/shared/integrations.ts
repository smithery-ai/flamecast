import { z } from "zod";

export const SlackInstallationSummarySchema = z.object({
  teamId: z.string(),
  teamName: z.string().nullable(),
  botUserId: z.string().nullable(),
  installedAt: z.string(),
  updatedAt: z.string(),
});
export type SlackInstallationSummary = z.infer<typeof SlackInstallationSummarySchema>;

export const SlackConnectionStatusSchema = z.object({
  bound: z.boolean(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  botUserId: z.string().nullable(),
  boundAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type SlackConnectionStatus = z.infer<typeof SlackConnectionStatusSchema>;

export const SlackBindConnectionBodySchema = z.object({
  teamId: z.string().min(1),
});
export type SlackBindConnectionBody = z.infer<typeof SlackBindConnectionBodySchema>;
