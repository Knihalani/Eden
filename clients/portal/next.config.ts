import type { NextConfig } from "next";

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
      { source: "/lab/shell", destination: "/home", permanent: false },
      { source: "/lab/agents", destination: "/agents", permanent: false },
      { source: "/lab/traces", destination: "/traces", permanent: false },
      { source: "/lab/sessions", destination: "/traces?view=sessions", permanent: false },
      { source: "/lab/issues", destination: "/issues", permanent: false },
      { source: "/lab/signals", destination: "/signals", permanent: false },
      // Legacy /lab/alerts → soft-land /alerts (bell Inbox guidance)
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
      // /shell is a retired lab/dev surface — soft-land on /unavailable
      // (also listed in STUB_PORTAL_PATH_PREFIXES for hub rewrite).
      ...(process.env.NODE_ENV === "development"
        ? []
        : [
            {
              source: "/shell",
              destination: "/unavailable",
              permanent: false as const,
            },
            {
              source: "/shell/:path*",
              destination: "/unavailable",
              permanent: false as const,
            },
          ]),

      // Auth cutover to Clerk — keep
      // Unhyphenated spellings are what users type and what external
      // links guess at; without these they hit the global 404.
      { source: "/signin", destination: "/sign-in", permanent: false },
      { source: "/log-in", destination: "/sign-in", permanent: false },
      { source: "/register", destination: "/sign-up", permanent: false },
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
      { source: "/fleet", destination: "/agents", permanent: false },
      { source: "/fleet/:path*", destination: "/agents", permanent: false },
      {
        // Book / drift leaves never shipped as agent modes — land on agent detail.
        source: "/agents/:id/book",
        destination: "/agents?id=:id",
        permanent: false,
      },
      {
        // Agent cross-links → dedicated Improve surfaces (FEAT-6/7/89).
        source: "/agents/:id/ledger",
        destination: "/ledger?agent=:id",
        permanent: false,
      },
      {
        source: "/agents/:id/drift",
        destination: "/drift?agent=:id",
        permanent: false,
      },
      {
        source: "/agents/:id/sim-runs",
        destination: "/agents?id=:id",
        permanent: false,
      },
      {
        source: "/agents/:id/sim-runs/:path*",
        destination: "/agents?id=:id",
        permanent: false,
      },
      {
        source: "/agents/:id/test-runs",
        destination: "/agents?id=:id",
        permanent: false,
      },
      {
        source: "/agents/:id/test-runs/:path*",
        destination: "/agents?id=:id",
        permanent: false,
      },

      // Phase 3 Observe — IA redirects (before soft-land catch-alls)
      { source: "/sessions", destination: "/traces?view=sessions", permanent: false },
      {
        source: "/sessions/:sessionId",
        destination: "/traces?view=sessions&session=:sessionId",
        permanent: false,
      },
      { source: "/incidents", destination: "/issues", permanent: false },
      {
        // issues-client selects off ``?id=``; ``issueId`` was never read,
        // so this rule used to drop the cluster id on the floor.
        source: "/incidents/:cluster_id",
        destination: "/issues?id=:cluster_id",
        permanent: false,
      },
      // Issue detail is a selection inside /issues (it reads ?id= and
      // ?tab=), not its own route — without these, every in-product link
      // of the form /issues/<id> hit the global 404.
      { source: "/issues/:id", destination: "/issues?id=:id", permanent: false },
      {
        // W29 retired the live /fix page; the fix/handoff surface is the
        // Fix tab of the issue detail pane.
        source: "/issues/:id/fix",
        destination: "/issues?id=:id&tab=fix",
        permanent: false,
      },
      // Signals is the product leaf; /alerts soft-lands with Inbox guidance
      // (page.tsx) rather than dumping on Detectors.
      { source: "/inspector", destination: "/traces", permanent: false },
      {
        source: "/observability/mcp",
        destination: "/traces?q=mcp",
        permanent: false,
      },
      {
        source: "/observability/decisions",
        destination: "/traces?q=decision",
        permanent: false,
      },
      {
        source: "/observability/memory",
        destination: "/traces?q=memory",
        permanent: false,
      },
      {
        source: "/observability/retrieval",
        destination: "/traces?q=retrieval",
        permanent: false,
      },
      {
        source: "/observability/time-travel",
        destination: "/debugger?mode=time-travel",
        permanent: false,
      },
      {
        source: "/observability/eval",
        destination: "/evals?mode=compare",
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
      { source: "/datasets", destination: "/evals?mode=datasets", permanent: false },
      {
        // Was /evals/datasets/:id, which has no page and 404'd. Dataset
        // detail is a selection inside the evals page (it reads ?mode=/
        // ?tab= and ?id=), so carry the id through instead of dropping it.
        source: "/datasets/:id",
        destination: "/evals?mode=datasets&id=:id",
        permanent: false,
      },
      {
        source: "/experiments",
        destination: "/evals?mode=compare",
        permanent: false,
      },
      // Labeling is live (FEAT-80–83). Studio / Synthetic are not live
      // Evaluate modes — don't silently dump users onto Results.
      { source: "/studio", destination: "/unavailable", permanent: false },
      {
        source: "/synthetic",
        destination: "/unavailable",
        permanent: false,
      },

      // Phase 5 Improve — legacy paths → live mode= queue/plan (page ignores old tab=)
      // /artifacts and /ledger are now real routes (FEAT-6/FEAT-7) — no
      // redirect. (/agents/:id/ledger below is a separate, unrelated rule
      // that keeps an agent cross-link from 404ing — do not fold it in here.)
      {
        source: "/promotions",
        destination: "/improve?mode=queue",
        permanent: false,
      },
      {
        source: "/promotions/:path*",
        destination: "/improve?mode=queue",
        permanent: false,
      },
      { source: "/improve/plans", destination: "/improve?mode=plan", permanent: false },
      { source: "/improve/runs", destination: "/improve?mode=queue", permanent: false },
      {
        source: "/improve/runs/:path*",
        destination: "/improve?mode=queue",
        permanent: false,
      },
      {
        source: "/improve/scorecard",
        destination: "/improve?mode=queue",
        permanent: false,
      },
      {
        source: "/improve/scorecard/:path*",
        destination: "/improve?mode=queue",
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
        destination: "/improve?mode=plan",
        permanent: false,
      },
      {
        source: "/pr-suggestions/:path*",
        destination: "/improve?mode=plan",
        permanent: false,
      },
      {
        source: "/agents/eden/inbox",
        destination: "/improve?mode=plan",
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
        destination: "/cost?mode=spend",
        permanent: false,
      },
      {
        source: "/optimization/outcomes",
        destination: "/cost?mode=drivers",
        permanent: false,
      },
      {
        source: "/optimization/predict",
        destination: "/cost?mode=spend",
        permanent: false,
      },
      {
        source: "/optimization/model-advisor",
        destination: "/cost?mode=drivers",
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
        destination: "/guardrails/redteam",
        permanent: false,
      },
      {
        source: "/redteam/:path*",
        destination: "/guardrails/redteam",
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
        destination: "/debugger?mode=replay",
        permanent: false,
      },
      {
        source: "/replay/:path*",
        destination: "/debugger?mode=replay",
        permanent: false,
      },

      // Phase 7 — Settings + Audit aliases (before soft-land catch-alls)
      { source: "/audit", destination: "/settings?mode=audit", permanent: false },
      { source: "/audit/:path*", destination: "/settings?mode=audit", permanent: false },
      { source: "/audit-trail", destination: "/settings?mode=audit", permanent: false },
      { source: "/audit-trail/:path*", destination: "/settings?mode=audit", permanent: false },
      { source: "/profile", destination: "/settings?mode=workspace", permanent: false },
      { source: "/profile/:path*", destination: "/settings?mode=workspace", permanent: false },
      { source: "/billing", destination: "/settings?mode=workspace", permanent: false },
      { source: "/billing/:path*", destination: "/settings?mode=workspace", permanent: false },
      { source: "/finops", destination: "/settings?mode=workspace", permanent: false },
      { source: "/finops/:path*", destination: "/settings?mode=workspace", permanent: false },

      // Former Analytics hub. The page was planned but never built, so these
      // seven rules pointed at a route with no page.tsx and no rule of its
      // own -- every one of them landed on the global catch-all 404, which
      // is strictly worse than not redirecting at all. `/unavailable` is the
      // soft landing for retired URLs and offers Home / Traces / API keys.
      // Restore the `/analytics?tab=` destinations if that hub is ever built.
      { source: "/analytics", destination: "/unavailable", permanent: false },
      { source: "/analytics/:path*", destination: "/unavailable", permanent: false },
      { source: "/users", destination: "/unavailable", permanent: false },
      { source: "/users/:path*", destination: "/unavailable", permanent: false },
      { source: "/tools", destination: "/unavailable", permanent: false },
      { source: "/tools/:path*", destination: "/unavailable", permanent: false },
      { source: "/insights/topics", destination: "/topics", permanent: false },
      { source: "/insights", destination: "/unavailable", permanent: false },
      { source: "/insights/:path*", destination: "/unavailable", permanent: false },

      // Teardown Mode A: remaining former product trees → stub dashboard
      // Observe + Evaluate + Improve + Workspace live; Prompts lives above.
      // First-run: soft-landed routes stay unavailable; onboarding opens home tour.
      // First-run tour entry. GitHub App install callback historically
      // used /onboarding/connect?installation_id=… — that must land on
      // Agents connect (query preserved), not the product tour.
      {
        source: "/onboarding/connect",
        destination: "/agents/connect",
        permanent: false,
      },
      {
        source: "/onboarding/connect/:path*",
        destination: "/agents/connect",
        permanent: false,
      },
      {
        source: "/onboarding",
        destination: "/home",
        permanent: false,
      },
      {
        source: "/onboarding/:path*",
        destination: "/home",
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

export default nextConfig;
