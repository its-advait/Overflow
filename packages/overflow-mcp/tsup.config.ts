import { defineConfig } from "tsup";

/**
 * One ESM file at dist/server.js so an MCP client can launch it with a bare `node <abs path>`:
 * no pnpm (its run banner would corrupt the stdio JSON-RPC stream), no tsx. Workspace packages
 * export TypeScript source, so they are bundled in; third-party deps resolve from node_modules.
 */
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  noExternal: [/^@overflow\//],
  banner: { js: "#!/usr/bin/env node" },
});
