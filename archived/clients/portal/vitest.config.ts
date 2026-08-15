import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Pre-rebuild wave freezes + EmbeddedSurface-era contracts — archived intent.
    exclude: [
      "**/node_modules/**",
      "**/_archive/**",
      "**/w[0-9]*.test.{ts,tsx}",
      "**/ws[0-9]*.test.{ts,tsx}",
      "**/wE[0-9]*.test.{ts,tsx}",
      "**/handle-logout.test.tsx",
      "**/a1-chrome.done-when.test.ts",
      "**/a2-portal-data.done-when.test.ts",
      "**/u18-portal.test.ts",
    ],
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
