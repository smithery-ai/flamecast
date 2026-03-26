import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/session-host/test/**/*.test.ts"],
  },
});
