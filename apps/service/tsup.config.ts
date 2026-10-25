import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Workspace packages export TypeScript source, so bundle them in.
  noExternal: [/^@overflow\//],
  // The bundled @overflow/database can no longer find ../drizzle next to its
  // source, so ship the migrations with the bundle. `pnpm start` points
  // OVERFLOW_MIGRATIONS_DIR at this copy.
  onSuccess: async () => {
    cpSync("../../packages/database/drizzle", "dist/drizzle", { recursive: true });
    console.log("copied packages/database/drizzle -> dist/drizzle");
  },
});
