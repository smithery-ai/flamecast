import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@flamecast/sdk": resolve(import.meta.dirname, "../flamecast/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
