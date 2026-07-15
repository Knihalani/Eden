import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl plugin wires `src/i18n/request.ts` into the build so the
// message bundle is loaded server-side for every render. Without
// this, `useTranslations()` returns empty strings in production
// builds because the bundler tree-shakes the JSON imports.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// We intentionally do NOT set `turbopack.root` OR `outputFileTracingRoot`.
// Setting either creates a path mismatch with Vercel's auto-injected
// `outputFileTracingRoot=/vercel/path0`, which surfaces as:
//
//   ENOENT: no such file or directory, lstat
//   '/vercel/path0/.next/routes-manifest-deterministic.json'
//
// AND silently drops routes from the build output (e.g. /docs, /tools,
// /prompts) — Next.js prints the route table for static analysis but
// the lambdas Vercel ships are missing them. The earlier fix on
// 2026-07-06 (commit 175e3b7c) only removed `outputFileTracingRoot`
// but kept `turbopack.root: portalRoot`, which still mismatches
// Vercel's auto-injected value at deploy time. Removing both lets
// Vercel's default `outputFileTracingRoot` win and keeps the route
// table complete. Local dev and CI builds work the same without an
// override.
//
// See https://github.com/vercel/vercel/issues/12415 — Vercel's build
// worker expects the routes-manifest-deterministic.json to be written
// at the unshifted `<cwd>/.next/...` path, but pinning
// `outputFileTracingRoot` to a directory outside that path causes the
// traces to land in a different `.next` and the manifest lookup misses.

const nextConfig: NextConfig = {
  /* config options here */
  async redirects() {
    return [
      // Dead /jobs and /eval-harnesses surfaces → dashboard.
      {
        source: "/jobs",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/jobs/:path*",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/eval-harnesses",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/eval-harnesses/:path*",
        destination: "/dashboard",
        permanent: false,
      },
      // Stripped env-gen surfaces → dashboard.
      {
        source: "/builder",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/builder/:path*",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/marketplace",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/marketplace/:path*",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/multi-agent",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/multi-agent/:path*",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/agents/:id/sim-runs",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/agents/:id/sim-runs/:path*",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/agents/:id/test-runs",
        destination: "/dashboard",
        permanent: false,
      },
      {
        source: "/agents/:id/test-runs/:path*",
        destination: "/dashboard",
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
      // Legacy portal /docs stub removed — canonical docs live on the
      // Docusaurus site at docs.edenobservability.com.
      {
        source: "/docs",
        destination: "https://docs.edenobservability.com",
        permanent: true,
      },
      {
        source: "/docs/:path*",
        destination: "https://docs.edenobservability.com/:path*",
        permanent: true,
      },
      // Phase 1E bloat cut — stub/low-traffic surfaces redirect to parent.
      {
        source: "/observability/apm",
        destination: "/observability",
        permanent: false,
      },
      {
        source: "/observability/apm/:path*",
        destination: "/observability",
        permanent: false,
      },
      {
        source: "/billing",
        destination: "/settings?tab=billing",
        permanent: false,
      },
      {
        source: "/onboarding/autonomous",
        destination: "/onboarding/connect",
        permanent: false,
      },
      {
        source: "/onboarding/autonomous/:path*",
        destination: "/onboarding/connect",
        permanent: false,
      },
      // N23 — PR suggester inbox migrated to improvement plans.
      {
        source: "/pr-suggestions",
        destination: "/improve/plans",
        permanent: false,
      },
      {
        source: "/pr-suggestions/:id",
        destination: "/improve/plans/:id",
        permanent: false,
      },
      {
        source: "/closed-loop",
        destination: "/improve",
        permanent: false,
      },
      {
        source: "/closed-loop/:path*",
        destination: "/improve",
        permanent: false,
      },
      {
        source: "/autonomous",
        destination: "/improve",
        permanent: false,
      },
      {
        source: "/autonomous/:path*",
        destination: "/improve",
        permanent: false,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
