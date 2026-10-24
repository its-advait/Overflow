import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript source; let Next compile them.
  transpilePackages: [
    "@overflow/schemas",
    "@overflow/oracle",
    "@overflow/fusion",
    "@overflow/payment-client",
    "@overflow/recourse-crypto",
    "@overflow/database",
  ],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
