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
      exclude: ["src/flamecast/storage.ts"],
      thresholds: {
        branches: 95,
        functions: 97,
        lines: 98,
        statements: 98,
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
