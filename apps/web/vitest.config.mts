import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pure view-model modules only (src/lib). Components are checked by typecheck, lint and next build.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
