import { defineConfig } from "vitest/config";

// Lets `pnpm --filter @overflow/service test` run; without a project config vitest falls back to the root
// `projects` list resolved relative to apps/service and fails at startup. The root run picks this up as the
// project config.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
