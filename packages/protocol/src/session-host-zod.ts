import { z } from "zod";
import type { SessionHostStartRequest } from "./session-host.js";

export const SessionHostStartRequestSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  workspace: z.string(),
  setup: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  callbackUrl: z.string().optional(),
}) satisfies z.ZodType<SessionHostStartRequest>;
