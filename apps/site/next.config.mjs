import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bunSqliteStub = path.join(__dirname, "src/bun-sqlite-stub.js");
const SQLITE_STUB =
  '({Database:class Database{constructor(){throw new Error("bun:sqlite unavailable")}}})';

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@eden/core"],
  // Hosted persistence is Neon (`DATABASE_URL`). bun:sqlite is stubbed in the bundle.
  serverExternalPackages: ["@neondatabase/serverless"],
  outputFileTracingRoot: path.join(__dirname, "../../"),
  outputFileTracingIncludes: {
    "/[[...path]]": ["./public/logo.webp", "./public/favicon.png", "./public/apple-touch-icon.png"],
  },
  // Next typechecks workspace packages this app does not own (Know sqlite,
  // compile corpus). Repo gate is `bun run typecheck`. Do not skip that.
  typescript: { ignoreBuildErrors: true },
  webpack: (config, { webpack }) => {
    config.resolve.alias = { ...config.resolve.alias, "bun:sqlite": bunSqliteStub };
    config.plugins.push({
      apply(compiler) {
        compiler.hooks.compilation.tap("EdenSqliteStub", (compilation) => {
          compilation.hooks.processAssets.tap(
            {
              name: "EdenSqliteStub",
              stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE,
            },
            () => {
              for (const name of Object.keys(compilation.assets)) {
                const src = compilation.assets[name].source();
                if (typeof src !== "string" || !src.includes("bun:sqlite")) continue;
                compilation.updateAsset(
                  name,
                  new webpack.sources.RawSource(
                    src
                      .replaceAll('require("bun:sqlite")', SQLITE_STUB)
                      .replaceAll("require('bun:sqlite')", SQLITE_STUB),
                  ),
                );
              }
            },
          );
        });
      },
    });
    return config;
  },
  turbopack: {
    resolveAlias: { "bun:sqlite": bunSqliteStub },
  },
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
