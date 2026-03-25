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
        "src/flamecast/storage.ts",
        "src/flamecast/runtime.ts",
        "src/flamecast/runtimes/node.ts",
        "src/flamecast/session-service.ts",
        "src/flamecast/agent.ts",
        "src/flamecast/client.ts",
      ],
      thresholds: {
        branches: 55,
        functions: 60,
        lines: 60,
        statements: 60,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@flamecast/storage-psql": path.resolve(__dirname, "../flamecast-psql/src/index.ts"),
    },
  },
});
