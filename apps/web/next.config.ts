import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  serverExternalPackages: ["bun:sqlite", "@eden/control"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  devIndicators: false,
};

export default nextConfig;
