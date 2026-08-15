/**
 * Signed-in document titles. Never empty, never the marketing tagline.
 */
const TITLES: Record<string, string> = {
  "/home": "Home",
  "/agents": "Agents",
  "/traces": "Traces",
  "/issues": "Issues",
  "/signals": "Detectors",
  "/topics": "Topics",
  "/evals": "Evals",
  "/playgrounds": "Playgrounds",
  "/prompts": "Prompts",
  "/compare": "Live A/B",
  "/labeling": "Labeling",
  "/improve": "Improve",
  "/guardrails": "Guardrails",
  "/cost": "Cost",
  "/gateway": "Gateway",
  "/agent": "Ask Eden",
  "/debugger": "Debugger",
  "/settings": "Settings",
  "/settings/roles": "Roles",
  "/settings/sso": "SSO",
  "/settings/pii": "PII policy",
  "/settings/scim": "SCIM",
  "/sessions": "Sessions",
  "/alerts": "Alerts",
  "/artifacts": "Artifacts",
  "/dashboards": "Dashboards",
};

function prettySegment(seg: string): string {
  if (!seg) return "Portal";
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}

export function portalDocumentTitle(pathname: string | null | undefined): string {
  const path = (pathname ?? "").split("?")[0].split("#")[0];
  if (!path || path === "/") return "Home · Eden";
  if (TITLES[path]) return `${TITLES[path]} · Eden`;
  const segments = path.split("/").filter(Boolean);
  while (segments.length > 1) {
    segments.pop();
    const candidate = "/" + segments.join("/");
    if (TITLES[candidate]) return `${TITLES[candidate]} · Eden`;
  }
  return `${prettySegment(path.split("/").filter(Boolean)[0] ?? "Portal")} · Eden`;
}
