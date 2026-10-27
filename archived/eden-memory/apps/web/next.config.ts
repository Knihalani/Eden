import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVATE_NO_CACHE, PRIVATE_NO_STORE, PUBLIC_ASSET, PUBLIC_HOUR } from "./lib/http-cache";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  serverExternalPackages: ["bun:sqlite", "node:sqlite", "@eden/control"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  devIndicators: false,
  experimental: {
    optimizePackageImports: ["@clerk/nextjs"],
  },
  async headers() {
    const privateStore = [{ key: "Cache-Control", value: PRIVATE_NO_STORE }];
    const privateRevalidate = [{ key: "Cache-Control", value: PRIVATE_NO_CACHE }];
    const asset = [{ key: "Cache-Control", value: PUBLIC_ASSET }];
    return [
      { source: "/", headers: [{ key: "Cache-Control", value: PUBLIC_HOUR }] },
      { source: "/v1/:path*", headers: privateStore },
      { source: "/health", headers: privateStore },
      { source: "/api/:path*", headers: privateRevalidate },
      { source: "/home", headers: privateStore },
      { source: "/live/:path*", headers: privateStore },
      { source: "/request/:path*", headers: privateStore },
      { source: "/setup", headers: privateStore },
      { source: "/tour", headers: privateStore },
      { source: "/workspace", headers: privateStore },
      { source: "/sign-in/:path*", headers: privateStore },
      { source: "/sign-up/:path*", headers: privateStore },
      { source: "/sso-callback", headers: privateStore },
      { source: "/logo.webp", headers: asset },
      { source: "/favicon.ico", headers: asset },
      { source: "/favicon.png", headers: asset },
      { source: "/favicon.webp", headers: asset },
    ];
  },
};

export default nextConfig;
