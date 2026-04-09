import { app } from "./app.js";
import { handleEmail } from "./lib/email-handler.js";
import type { Env } from "./types.js";

export default {
  fetch: app.fetch,

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
};
