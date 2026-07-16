import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Dead /jobs and /eval-harnesses surfaces → dashboard.
      { source: "/jobs", destination: "/dashboard", permanent: false },
      { source: "/jobs/:path*", destination: "/dashboard", permanent: false },
      { source: "/eval-harnesses", destination: "/dashboard", permanent: false },
      { source: "/eval-harnesses/:path*", destination: "/dashboard", permanent: false },
      { source: "/builder", destination: "/dashboard", permanent: false },
      { source: "/builder/:path*", destination: "/dashboard", permanent: false },
      { source: "/marketplace", destination: "/dashboard", permanent: false },
      { source: "/marketplace/:path*", destination: "/dashboard", permanent: false },
      { source: "/multi-agent", destination: "/dashboard", permanent: false },
      { source: "/multi-agent/:path*", destination: "/dashboard", permanent: false },
      { source: "/agents/:id/sim-runs", destination: "/dashboard", permanent: false },
      { source: "/agents/:id/sim-runs/:path*", destination: "/dashboard", permanent: false },
      { source: "/agents/:id/test-runs", destination: "/dashboard", permanent: false },
      { source: "/agents/:id/test-runs/:path*", destination: "/dashboard", permanent: false },
      // Auth cutover to Clerk
      { source: "/login", destination: "/sign-in", permanent: false },
      { source: "/login/:path*", destination: "/sign-in/:path*", permanent: false },
      { source: "/signup", destination: "/sign-up", permanent: false },
      { source: "/signup/:path*", destination: "/sign-up/:path*", permanent: false },
      // Docs
      { source: "/docs", destination: "https://docs.edenobservability.com", permanent: true },
      { source: "/docs/:path*", destination: "https://docs.edenobservability.com/:path*", permanent: true },

      // ── July 2026 portal consolidation ─────────────────────────────
      { source: "/pr-suggestions", destination: "/improve?tab=plans", permanent: true },
      { source: "/pr-suggestions/:path*", destination: "/improve?tab=plans", permanent: true },
      { source: "/agents/eden/inbox", destination: "/improve?tab=plans", permanent: true },
      { source: "/agents/eden/inbox/:path*", destination: "/improve?tab=plans", permanent: true },
      { source: "/closed-loop", destination: "/improve", permanent: true },
      { source: "/closed-loop/:path*", destination: "/improve", permanent: true },
      { source: "/autonomous", destination: "/improve", permanent: true },
      { source: "/autonomous/:path*", destination: "/improve", permanent: true },
      { source: "/improve/plans", destination: "/improve?tab=plans", permanent: false },
      { source: "/improve/runs", destination: "/improve?tab=history", permanent: false },

      { source: "/observability", destination: "/traces", permanent: true },
      { source: "/observability/apm", destination: "/traces", permanent: true },
      { source: "/observability/apm/:path*", destination: "/traces", permanent: true },
      { source: "/inspector", destination: "/traces?view=inspect", permanent: true },
      { source: "/replay", destination: "/traces?view=replay", permanent: true },
      { source: "/debugger", destination: "/traces?view=debug", permanent: true },
      { source: "/observability/time-travel", destination: "/traces?view=debug", permanent: true },
      { source: "/observability/query", destination: "/traces?view=query", permanent: true },
      { source: "/observability/mcp", destination: "/traces?facet=mcp", permanent: true },
      { source: "/observability/decisions", destination: "/traces?facet=decisions", permanent: true },
      { source: "/observability/memory", destination: "/traces?facet=memory", permanent: true },
      { source: "/observability/retrieval", destination: "/traces?facet=retrieval", permanent: true },
      { source: "/observability/eval", destination: "/evals?tab=eval", permanent: true },
      { source: "/observability/cohorts", destination: "/traces?view=query", permanent: true },

      { source: "/fleet", destination: "/agents?tab=fleet", permanent: true },
      { source: "/llmops", destination: "/optimization", permanent: true },
      { source: "/llmops/:path*", destination: "/optimization", permanent: true },
      { source: "/profile", destination: "/settings?tab=account", permanent: true },
      { source: "/billing", destination: "/settings?tab=billing", permanent: true },
      { source: "/users", destination: "/analytics?tab=users", permanent: true },
      { source: "/insights", destination: "/analytics?tab=insights", permanent: true },
      { source: "/tools", destination: "/analytics?tab=tools", permanent: true },
      { source: "/signals", destination: "/alerts?tab=signals", permanent: true },
      { source: "/datasets", destination: "/evals?tab=datasets", permanent: true },
      { source: "/labeling", destination: "/evals?tab=labeling", permanent: true },
      { source: "/studio", destination: "/evals?tab=studio", permanent: true },
      { source: "/synthetic", destination: "/evals?tab=synthetic", permanent: true },
      { source: "/incidents", destination: "/issues?tab=incidents", permanent: true },
      { source: "/redteam", destination: "/guardrails?tab=redteam", permanent: true },

      // Docs Fill-in lives on docs site; old portal quickstart → docs
      { source: "/quickstart", destination: "https://docs.edenobservability.com/quickstart", permanent: true },

      // Onboarding → dashboard overlay
      { source: "/onboarding", destination: "/dashboard?onboarding=1", permanent: true },
      { source: "/onboarding/:path*", destination: "/dashboard?onboarding=1", permanent: true },
    ];
  },
};

export default withNextIntl(nextConfig);
