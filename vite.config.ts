import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // All /api requests are forwarded to the Hono server
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
