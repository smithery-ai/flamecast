import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage/api-server",
      include: ["src/flamecast/**/*.ts", "src/server/**/*.ts"],
      exclude: [
        "src/flamecast/state-managers/psql/drizzle.config.ts",
        "src/flamecast/state-managers/psql/types.ts",
      ],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "alchemy/test/vitest": path.resolve(__dirname, "./node_modules/alchemy/lib/test/vitest.js"),
    },
  },
});
