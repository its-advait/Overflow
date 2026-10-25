import path from "node:path";
import { defineConfig } from "vitest/config";

/** Pure logic only (tree math, the SIMULATED treasury): no DOM, no Next runtime. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
});
