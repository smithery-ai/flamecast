import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import path from "path";

const alchemyEntryUrl = new URL(import.meta.resolve("alchemy"));
const alchemyTestVitestPath = fileURLToPath(new URL("./test/vitest.js", alchemyEntryUrl));

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
        "src/flamecast/runtime.ts", // type-only module, no runtime logic to test
        "src/flamecast/runtimes/node.ts", // tested via integration tests, not unit tests
        "src/flamecast/session-service.ts", // tested via integration tests, not unit tests
        "src/flamecast/agent.ts", // example agent — tested via session-host integration
        "src/flamecast/client.ts", // example client — tested via session-host integration
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
      "alchemy/test/vitest": alchemyTestVitestPath,
      "@flamecast/storage-psql": path.resolve(__dirname, "../flamecast-psql/src/index.ts"),
    },
  },
});
