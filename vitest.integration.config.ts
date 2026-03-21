import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "alchemy/test/vitest": path.resolve(__dirname, "./node_modules/alchemy/lib/test/vitest.js"),
    },
  },
});
