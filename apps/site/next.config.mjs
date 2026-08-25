import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@eden/core"],
  serverExternalPackages: ["bun:sqlite", "@neondatabase/serverless"],
  outputFileTracingRoot: path.join(__dirname, "../../"),
  async headers() {
    return [
      {
        // Hardening for every route. frame-ancestors denies clickjacking on
        // the approve UI; nosniff stops a mislabeled trace body executing.
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
