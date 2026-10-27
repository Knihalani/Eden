/**
 * Wave 22.2 hold-out — HTTP APIs that are not api.github.com / api.stripe.com.
 *
 *   bun run benchmarks/campaign/jit-url-soak.ts
 */
import { call, runHoldoutSoak, soakProg, type HoldoutTurn } from "./jit-holdout-lib";

const GITLAB = "https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/44";
const BITBUCKET = "https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/9";
const JIRA_URL = "https://acme.atlassian.net/rest/api/3/issue/ENG-8841";
const PAGERDUTY = "https://api.pagerduty.com/incidents/PT4KHLK";
const DATADOG = "https://api.datadoghq.com/api/v1/monitor/1234567";
const GRAFANA = "https://grafana.acme.net/api/dashboards/uid/checkout-slo";
const SLACK_API = "https://slack.com/api/conversations.history";
const LINEAR_API = "https://api.linear.app/graphql";
const NOTION = "https://api.notion.com/v1/pages/8f14e45feea948b19d4c0123456789ab";
const SENTRY = "https://sentry.io/api/0/projects/acme/web/issues/";

export const PROGRAMS = [
  soakProg({ name: "gitlab_mr", seq: ["web_fetch"], url: GITLAB, envelope: { u: [GITLAB] } }),
  soakProg({ name: "bitbucket_pr", seq: ["web_fetch"], url: BITBUCKET, envelope: { u: [BITBUCKET] } }),
  soakProg({ name: "jira_rest", seq: ["web_fetch"], url: JIRA_URL, envelope: { u: [JIRA_URL] } }),
  soakProg({ name: "pd_incident", seq: ["web_fetch"], url: PAGERDUTY, envelope: { u: [PAGERDUTY] } }),
  soakProg({ name: "dd_monitor", seq: ["web_fetch"], url: DATADOG, envelope: { u: [DATADOG] } }),
  soakProg({ name: "grafana_dash", seq: ["web_fetch"], url: GRAFANA, envelope: { u: [GRAFANA] } }),
  soakProg({ name: "slack_hist", seq: ["web_fetch"], url: SLACK_API, envelope: { u: [SLACK_API] } }),
  soakProg({ name: "linear_gql", seq: ["web_fetch"], url: LINEAR_API, envelope: { u: [LINEAR_API] } }),
  soakProg({ name: "notion_page", seq: ["web_fetch"], url: NOTION, envelope: { u: [NOTION] } }),
  soakProg({ name: "sentry_issues", seq: ["web_fetch"], url: SENTRY, envelope: { u: [SENTRY] } }),
];

export function urlSoakTurns(): HoldoutTurn[] {
  const rows: Array<[string, string, string]> = [
    ["gitlab", "gitlab_mr", GITLAB],
    ["bitbucket", "bitbucket_pr", BITBUCKET],
    ["jira-url", "jira_rest", JIRA_URL],
    ["pagerduty", "pd_incident", PAGERDUTY],
    ["datadog", "dd_monitor", DATADOG],
    ["grafana", "grafana_dash", GRAFANA],
    ["slack-api", "slack_hist", SLACK_API],
    ["linear-api", "linear_gql", LINEAR_API],
    ["notion", "notion_page", NOTION],
    ["sentry", "sentry_issues", SENTRY],
  ];
  return rows.map(([label, expect, url]) => ({
    label,
    expect,
    messages: [{ role: "user", content: `GET ${url} and summarize` }],
    call: call("web_fetch", { u: url }),
  }));
}

export function runJitUrlSoak() {
  return runHoldoutSoak({ programs: PROGRAMS, turns: urlSoakTurns() });
}

if (import.meta.main) {
  const r = runJitUrlSoak();
  for (const line of r.lines) console.log(line);
  process.exit(r.pass ? 0 : 1);
}
