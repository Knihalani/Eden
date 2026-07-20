/**
 * Honest UX helpers when improvement_agent_v1 is killed (env / org override)
 * or when repo is not connected. Prefer clear empty states over silent empty
 * queues or generic 5xx.
 *
 * GA default is ON (config + new-org seed). Settings → Autonomous does not
 * toggle the master gate — only schedule cadence once the agent is live.
 */

export const IMPROVE_FEATURE_DISABLED_MESSAGE =
  "The improvement agent is disabled for this organization (env kill-switch or org override). Ask an admin or Eden support to re-enable it — Settings does not turn this on.";

export const IMPROVE_FEATURE_DISABLED_TITLE = "Feature disabled";

export const IMPROVE_FEATURE_DISABLED_DESCRIPTION =
  "The improvement agent (improvement_agent_v1) is off for this organization — usually an explicit kill-switch. GA defaults are on; Settings → Autonomous only controls schedule cadence when the agent is enabled. Ask an organization owner or Eden support to re-enable it.";

export const REPO_NOT_CONNECTED_MESSAGE =
  "No GitHub repo connected. Connect the GitHub App in Settings, then try again.";

function blobFromUnknown(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const detail =
      "detail" in err && typeof (err as { detail?: unknown }).detail === "string"
        ? (err as { detail: string }).detail
        : "";
    return `${err.message} ${detail}`;
  }
  if (typeof err === "object") {
    const o = err as { message?: unknown; detail?: unknown; error?: unknown };
    return [o.message, o.detail, o.error]
      .map((v) => (typeof v === "string" ? v : v != null ? JSON.stringify(v) : ""))
      .filter(Boolean)
      .join(" ");
  }
  return String(err);
}

/** True when API/UX copy indicates improvement_agent_v1 is off (often HTTP 503). */
export function isImprovementAgentDisabled(err: unknown): boolean {
  const blob = blobFromUnknown(err);
  return (
    /improvement_agent_v1/i.test(blob) ||
    /improvement agent is disabled/i.test(blob) ||
    /Ask an admin (or Eden support )?to (enable|turn it on)/i.test(blob) ||
    /Settings does not turn this on/i.test(blob)
  );
}

/** True when approve/PR failed because no active repo_connections row. */
export function isRepoNotConnected(err: unknown): boolean {
  const blob = blobFromUnknown(err);
  return (
    /repo_not_connected/i.test(blob) ||
    /Connect GitHub App/i.test(blob) ||
    /No GitHub repo connected/i.test(blob)
  );
}
