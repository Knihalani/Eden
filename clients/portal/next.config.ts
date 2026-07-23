import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** Soft-land leftover stubs on product unavailable page. */
const STUB_LAND = "/unavailable";

function softLand(prefixes: string[]) {
  return prefixes.flatMap((source) => [
    { source, destination: STUB_LAND, permanent: false as const },
    { source: `${source}/:path*`, destination: STUB_LAND, permanent: false as const },
  ]);
}

const nextConfig: NextConfig = {
  // Playwright golden paths hit 127.0.0.1; allow dev HMR from that host.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Monorepo: trace deps from the portal package, not a parent lockfile.
  outputFileTracingRoot: import.meta.dirname,
  // Turbopack duplicates recharts (~412KB) per async island. Webpack + a
  // shared cacheGroup keeps one copy and maxSize splits it under the
  // 400KB/chunk budget gate (`bun run check:bundle`).
  webpack: (config, { isServer }) => {
    if (isServer) return config;
    const split = config.optimization?.splitChunks;
    if (!split || typeof split !== "object") return config;
    config.optimization = {
      ...config.optimization,
      splitChunks: {
        ...split,
        chunks: "all",
        maxSize: 350 * 1024,
        cacheGroups: {
          ...(split.cacheGroups ?? {}),
          recharts: {
            test: /[\\/]node_modules[\\/](recharts|victory-vendor|d3-[^\\/]+)[\\/]/,
            name: "recharts-vendor",
            chunks: "all",
            priority: 40,
            reuseExistingChunk: true,
            enforce: true,
            maxSize: 350 * 1024,
          },
        },
      },
    };
    return config;
  },
  experimental: {
    // P34: include cmdk / radix / clerk; drop unused @xyflow (K9).
    optimizePackageImports: [
      "recharts",
      "lucide-react",
      "framer-motion",
      "cmdk",
      "@clerk/nextjs",
      "@radix-ui/react-avatar",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
      "@tanstack/react-query",
      "@tanstack/react-virtual",
    ],
  },
  images: {
    // P13–P14: Clerk CDN + same-origin avatars. Arbitrary transcript
    // URLs use next/image with ``unoptimized`` at the call site.
    remotePatterns: [
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "images.clerk.dev" },
      { protocol: "https", hostname: "edenobservability.com" },
      { protocol: "http", hostname: "localhost" },
      { protocol: "http", hostname: "127.0.0.1" },
    ],
  },
  async redirects() {
    return [
      // Lab → product cutover (preserve bookmarks)
      { source: "/lab", destination: "/home", permanent: false },
      { source: "/lab/home", destination: "/home", permanent: false },
      { source: "/lab/shell", destination: "/shell", permanent: false },
      { source: "/lab/agents", destination: "/agents", permanent: false },
      { source: "/lab/traces", destination: "/traces", permanent: false },
      { source: "/lab/sessions", destination: "/traces?view=sessions", permanent: false },
      { source: "/lab/issues", destination: "/issues", permanent: false },
      { source: "/lab/signals", destination: "/signals", permanent: false },
      { source: "/lab/alerts", destination: "/alerts", permanent: false },
      { source: "/lab/evals", destination: "/evals", permanent: false },
      { source: "/lab/improve", destination: "/improve", permanent: false },
      { source: "/lab/cost", destination: "/cost", permanent: false },
      { source: "/lab/agent", destination: "/agent", permanent: false },
      { source: "/lab/debugger", destination: "/debugger", permanent: false },
      { source: "/lab/debugger/:id", destination: "/debugger/:id", permanent: false },
      { source: "/lab/compare", destination: "/compare", permanent: false },
      { source: "/lab/settings", destination: "/settings", permanent: false },
      { source: "/dashboard", destination: "/home", permanent: false },
      { source: "/dashboard/:path*", destination: "/home", permanent: false },

      // Auth cutover to Clerk — keep
      { source: "/login", destination: "/sign-in", permanent: false },
      { source: "/login/:path*", destination: "/sign-in/:path*", permanent: false },
      { source: "/signup", destination: "/sign-up", permanent: false },
      { source: "/signup/:path*", destination: "/sign-up/:path*", permanent: false },
      // Docs — keep external
      { source: "/docs", destination: "https://docs.edenobservability.com", permanent: true },
      { source: "/docs/:path*", destination: "https://docs.edenobservability.com/:path*", permanent: true },
      { source: "/quickstart", destination: "https://docs.edenobservability.com/quickstart", permanent: true },
      // Public status alias
      { source: "/health", destination: "/status", permanent: false },

      // Phase 2: live Agents routes — not soft-landed
      { source: "/fleet", destination: "/agents?tab=fleet", permanent: false },
      { source: "/fleet/:path*", destination: "/agents?tab=fleet", permanent: false },
      {
        source: "/agents/:id/book",
        destination: "/agents/:id?tab=book",
        permanent: false,
      },
      {
        source: "/agents/:id/drift",
        destination: "/agents/:id?tab=drift",
        permanent: false,
      },
      {
        source: "/agents/:id/sim-runs",
        destination: "/agents/:id",
        permanent: false,
      },
      {
        source: "/agents/:id/sim-runs/:path*",
        destination: "/agents/:id",
        permanent: false,
      },
      {
        source: "/agents/:id/test-runs",
        destination: "/agents/:id",
        permanent: false,
      },
      {
        source: "/agents/:id/test-runs/:path*",
        destination: "/agents/:id",
        permanent: false,
      },

      // Phase 3 Observe — IA redirects (before soft-land catch-alls)
      { source: "/sessions", destination: "/traces?view=sessions", permanent: false },
      {
        source: "/sessions/:sessionId",
        destination: "/traces?view=sessions&sessionId=:sessionId",
        permanent: false,
      },
      { source: "/incidents", destination: "/issues?tab=incidents", permanent: false },
      {
        source: "/incidents/:cluster_id",
        destination: "/issues?tab=incidents&issueId=:cluster_id",
        permanent: false,
      },
      // Signals is the product leaf; /alerts opens the shell modal then home
      { source: "/inspector", destination: "/traces?mode=meta", permanent: false },
      { source: "/observability/mcp", destination: "/traces?facet=mcp", permanent: false },
      {
        source: "/observability/decisions",
        destination: "/traces?facet=decisions",
        permanent: false,
      },
      {
        source: "/observability/memory",
        destination: "/traces?facet=memory",
        permanent: false,
      },
      {
        source: "/observability/retrieval",
        destination: "/traces?facet=retrieval",
        permanent: false,
      },
      {
        source: "/observability/time-travel",
        destination: "/debugger?tab=time-travel",
        permanent: false,
      },
      {
        source: "/observability/eval",
        destination: "/evals?tab=eval",
        permanent: false,
      },
      { source: "/observability/query", destination: "/traces", permanent: false },
      { source: "/observability/cohorts", destination: "/traces", permanent: false },
      { source: "/observability/apm", destination: "/traces", permanent: false },
      { source: "/observability/apm/:path*", destination: "/traces", permanent: false },
      { source: "/observability", destination: "/traces", permanent: false },
      { source: "/observability/:path*", destination: "/traces", permanent: false },
      { source: "/apm", destination: "/traces", permanent: false },
      { source: "/apm/:path*", destination: "/traces", permanent: false },

      // Phase 4 Evaluate — IA redirects (before soft-land catch-alls)
      { source: "/datasets", destination: "/evals?tab=datasets", permanent: false },
      {
        source: "/datasets/:id",
        destination: "/evals/datasets/:id",
        permanent: false,
      },
      {
        source: "/playgrounds",
        destination: "/evals?tab=playgrounds",
        permanent: false,
      },
      {
        source: "/experiments",
        destination: "/evals?tab=experiments",
        permanent: false,
      },
      { source: "/labeling", destination: "/evals?tab=labeling", permanent: false },
      {
        source: "/labeling/queues/:id",
        destination: "/evals?tab=labeling&queueId=:id",
        permanent: false,
      },
      { source: "/studio", destination: "/evals?tab=studio", permanent: false },
      {
        source: "/synthetic",
        destination: "/evals?tab=synthetic",
        permanent: false,
      },

      // Phase 5 Improve / Cost / Guardrails — IA §7.3 + §7.5 (before soft-land)
      { source: "/artifacts", destination: "/improve?tab=artifacts", permanent: false },
      {
        source: "/artifacts/:path*",
        destination: "/improve?tab=artifacts",
        permanent: false,
      },
      { source: "/ledger", destination: "/improve?tab=ledger", permanent: false },
      {
        source: "/ledger/:path*",
        destination: "/improve?tab=ledger",
        permanent: false,
      },
      {
        source: "/promotions",
        destination: "/improve?tab=promotions",
        permanent: false,
      },
      {
        source: "/promotions/:path*",
        destination: "/improve?tab=promotions",
        permanent: false,
      },
      { source: "/improve/plans", destination: "/improve?tab=plans", permanent: false },
      { source: "/improve/runs", destination: "/improve?tab=history", permanent: false },
      {
        source: "/improve/runs/:path*",
        destination: "/improve?tab=history",
        permanent: false,
      },
      {
        source: "/improve/scorecard",
        destination: "/improve?tab=history",
        permanent: false,
      },
      {
        source: "/improve/scorecard/:path*",
        destination: "/improve?tab=history",
        permanent: false,
      },
      {
        source: "/improve/online-scoring",
        destination: "/improve",
        permanent: false,
      },
      {
        source: "/improve/online-scoring/:path*",
        destination: "/improve",
        permanent: false,
      },
      {
        source: "/improve/change-impact",
        destination: "/improve",
        permanent: false,
      },
      {
        source: "/improve/change-impact/:path*",
        destination: "/improve",
        permanent: false,
      },
      {
        source: "/pr-suggestions",
        destination: "/improve?tab=plans",
        permanent: false,
      },
      {
        source: "/pr-suggestions/:path*",
        destination: "/improve?tab=plans",
        permanent: false,
      },
      {
        source: "/agents/eden/inbox",
        destination: "/improve?tab=plans",
        permanent: false,
      },
      { source: "/closed-loop", destination: "/improve", permanent: false },
      {
        source: "/closed-loop/:path*",
        destination: "/improve",
        permanent: false,
      },
      { source: "/autonomous", destination: "/improve", permanent: false },
      {
        source: "/autonomous/:path*",
        destination: "/improve",
        permanent: false,
      },
      {
        source: "/optimization/budget",
        destination: "/cost?tab=budget",
        permanent: false,
      },
      {
        source: "/optimization/outcomes",
        destination: "/cost?tab=outcomes",
        permanent: false,
      },
      {
        source: "/optimization/predict",
        destination: "/cost?tab=forecast",
        permanent: false,
      },
      {
        source: "/optimization/model-advisor",
        destination: "/cost?tab=advisor",
        permanent: false,
      },
      { source: "/optimization", destination: "/cost", permanent: false },
      {
        source: "/optimization/:path*",
        destination: "/cost",
        permanent: false,
      },
      { source: "/llmops", destination: "/cost", permanent: false },
      { source: "/llmops/:path*", destination: "/cost", permanent: false },
      {
        source: "/redteam",
        destination: "/guardrails?tab=policies",
        permanent: false,
      },
      {
        source: "/redteam/:path*",
        destination: "/guardrails?tab=policies",
        permanent: false,
      },

      // Phase 6 — debugger-sessions + replay legacy redirects (before soft-land catch-alls)
      {
        source: "/debugger-sessions",
        destination: "/debugger",
        permanent: false,
      },
      {
        source: "/debugger-sessions/:id",
        destination: "/debugger/:id",
        permanent: false,
      },
      {
        source: "/replay",
        destination: "/debugger?tab=replay",
        permanent: false,
      },
      {
        source: "/replay/:path*",
        destination: "/debugger?tab=replay",
        permanent: false,
      },

      // Phase 7 — Settings + Audit aliases (before soft-land catch-alls)
      { source: "/audit", destination: "/settings?mode=audit", permanent: false },
      { source: "/audit/:path*", destination: "/settings?mode=audit", permanent: false },
      { source: "/audit-trail", destination: "/settings?mode=audit", permanent: false },
      { source: "/audit-trail/:path*", destination: "/settings?mode=audit", permanent: false },
      { source: "/profile", destination: "/settings?tab=account", permanent: false },
      { source: "/profile/:path*", destination: "/settings?tab=account", permanent: false },
      { source: "/billing", destination: "/settings?tab=billing", permanent: false },
      { source: "/billing/:path*", destination: "/settings?tab=billing", permanent: false },
      { source: "/finops", destination: "/settings?tab=finops", permanent: false },
      { source: "/finops/:path*", destination: "/settings?tab=finops", permanent: false },

      // Later (post-P7) — Prompts + Analytics product hubs (not core leaves)
      { source: "/users", destination: "/analytics?tab=users", permanent: false },
      { source: "/users/:path*", destination: "/analytics?tab=users", permanent: false },
      { source: "/tools", destination: "/analytics?tab=tools", permanent: false },
      { source: "/tools/:path*", destination: "/analytics?tab=tools", permanent: false },
      { source: "/insights/topics", destination: "/analytics?tab=topics", permanent: false },
      { source: "/insights", destination: "/analytics?tab=insights", permanent: false },
      { source: "/insights/:path*", destination: "/analytics?tab=insights", permanent: false },

      // Teardown Mode A: remaining former product trees → stub dashboard
      // Observe + Evaluate + Improve + Workspace live; Prompts + Analytics live above.
      // First-run: soft-landed routes stay unavailable; onboarding opens home tour.
      {
        source: "/onboarding",
        destination: "/home?onboarding=1",
        permanent: false,
      },
      {
        source: "/onboarding/:path*",
        destination: "/home?onboarding=1",
        permanent: false,
      },
      ...softLand([
        "/runs",
        "/jobs",
        "/eval-harnesses",
        "/builder",
        "/marketplace",
        "/multi-agent",
        "/sandbox",
      ]),
    ];
  },
};

export default withNextIntl(nextConfig);
