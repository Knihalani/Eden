import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import path from "node:path";

// next-intl plugin wires `src/i18n/request.ts` into the build so the
// message bundle is loaded server-side for every render. Without
// this, `useTranslations()` returns empty strings in production
// builds because the bundler tree-shakes the JSON imports.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Pin Turbopack's workspace root to this package directory.
//
// Next.js 16 walks upward from CWD looking for lockfiles. When it
// finds multiple (e.g. a stray `pnpm-lock.yaml` in the user's home
// directory or another package's `bun.lock` higher up the tree) it
// picks one and emits a "multiple lockfiles detected" warning —
// and on the build server can pick the wrong one, causing
// `bun install --frozen-lockfile` to fail with `LOCKFILE_DRIFT`.
//
// Locking the root to the absolute path of this config's directory
// eliminates both the warning and the failure mode. See:
// https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory
const portalRoot = path.resolve(process.cwd());

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {
    root: portalRoot,
  },
  // Also pin output-file tracing to this directory so Vercel's build
  // step doesn't walk above the portal root while collecting files.
  outputFileTracingRoot: portalRoot,
  async redirects() {
    return [
      // Legacy /jobs URL renamed to /eval-harnesses.
      // When the eval-pipeline feature flag is off, /eval-harnesses will
      // 404 (handled by the new page guard); the redirect itself still
      // happens, which is the desired behavior: old links always land
      // users on the new canonical URL first.
      {
        source: "/jobs",
        destination: "/eval-harnesses",
        permanent: false,
      },
      {
        source: "/jobs/:path*",
        destination: "/eval-harnesses/:path*",
        permanent: false,
      },
      // Auth cutover to Clerk (June 17, 2026). The old /login and
      // /signup still render the same Clerk chrome, but Clerk's own
      // portal-style flows use /sign-in and /sign-up — sending old
      // links straight there avoids a stale "Sign up" cross-link
      // that points back to the legacy path.
      {
        source: "/login",
        destination: "/sign-in",
        permanent: false,
      },
      {
        source: "/login/:path*",
        destination: "/sign-in/:path*",
        permanent: false,
      },
      {
        source: "/signup",
        destination: "/sign-up",
        permanent: false,
      },
      {
        source: "/signup/:path*",
        destination: "/sign-up/:path*",
        permanent: false,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
