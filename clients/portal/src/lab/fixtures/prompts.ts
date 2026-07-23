/**
 * Prompt registry fixtures — named templates, versions, live/shadow/draft.
 * Improve / Live A/B link here; they do not own deploy.
 */

import { agentById } from "@/lab/fixtures/agents";
import type { PromptDetail, PromptListRow } from "@/lib/api/portal";

export type PromptStatus = "draft" | "shadow" | "live" | "archived";
export type PromptEnv = "dev" | "staging" | "prod";
export type PromptDetailTab = "editor" | "versions" | "deploy";

export type PromptVersion = {
  id: string;
  label: string;
  status: PromptStatus;
  body: string;
  createdAt: string;
  deployedAt?: string;
};

export type PromptFixture = {
  id: string;
  name: string;
  slug: string;
  agentId: string;
  status: PromptStatus;
  bodyPreview: string;
  versions: PromptVersion[];
  /** Env → version id currently pinned. */
  pins: Partial<Record<PromptEnv, string>>;
  usage24h: number;
  failRate: number;
  lastDeployed: string;
  improvePlanId?: string;
  compareExperimentId?: string;
  relatedAgentIds?: string[];
};

const PROMPT_ENVS: PromptEnv[] = ["dev", "staging", "prod"];

/** Empty seed — live rows come from promptsV2Api / page-level React Query. */
export const PROMPT_LIST: PromptFixture[] = [];

function mapApiStatus(raw?: string | null): PromptStatus {
  if (raw === "live" || raw === "shadow" || raw === "archived" || raw === "draft") {
    return raw;
  }
  return "draft";
}

function previewBody(body: string): string {
  return body.slice(0, 72) + (body.length > 72 ? "…" : "");
}

function deriveStatusFromVersions(versions: PromptVersion[]): PromptStatus {
  if (versions.some((v) => v.status === "live")) return "live";
  if (versions.some((v) => v.status === "shadow")) return "shadow";
  return "draft";
}

/** Composed version id used by the UI (`name@version`). */
export function promptVersionId(name: string, version: number): string {
  return `${name}@${version}`;
}

/** Parse trailing `@N` from a composed version id. */
export function versionNumberFromId(vid: string): number {
  const n = Number(vid.split("@").pop());
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid version id: ${vid}`);
  }
  return n;
}

export function promptListRowToFixture(row: PromptListRow): PromptFixture {
  return {
    id: row.name,
    name: row.name,
    slug: row.name,
    agentId: "",
    status: "draft",
    bodyPreview: row.description ?? "",
    versions: [],
    pins: {},
    usage24h: 0,
    failRate: 0,
    lastDeployed: "—",
  };
}

export function promptDetailToFixture(
  detail: PromptDetail,
  pins: Record<string, number>,
): PromptFixture {
  const name = detail.name;
  const versions: PromptVersion[] = [...(detail.versions ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((v) => ({
      id: promptVersionId(name, v.version),
      label: `v${v.version}`,
      status: mapApiStatus(v.status),
      body: v.template ?? "",
      createdAt: v.created_at ?? "—",
    }));

  const mappedPins: Partial<Record<PromptEnv, string>> = {};
  for (const env of PROMPT_ENVS) {
    const version = pins[env];
    if (typeof version === "number" && Number.isFinite(version)) {
      mappedPins[env] = promptVersionId(name, version);
    }
  }

  const liveOrNewest =
    versions.find((v) => v.status === "live") ?? versions[0];
  const body = liveOrNewest?.body ?? detail.description ?? "";

  return {
    id: name,
    name,
    slug: name,
    agentId: "",
    status: deriveStatusFromVersions(versions),
    bodyPreview: previewBody(body),
    versions,
    pins: mappedPins,
    usage24h: 0,
    failRate: 0,
    lastDeployed: "—",
  };
}

export function promptById(
  id: string,
  list: PromptFixture[] = PROMPT_LIST,
): PromptFixture | undefined {
  return list.find((p) => p.id === id);
}

export function promptsForAgent(
  agentId: string | "all",
  list: PromptFixture[] = PROMPT_LIST,
): PromptFixture[] {
  if (agentId === "all") return list;
  return list.filter((p) => p.agentId === agentId);
}

export function defaultPromptId(
  agentId: string | "all",
  list: PromptFixture[] = PROMPT_LIST,
): string {
  const rows = promptsForAgent(agentId, list);
  const live = rows.find((p) => p.status === "live");
  return live?.id ?? rows[0]?.id ?? list[0]?.id ?? "";
}

export function agentLabel(agentId: string): string {
  return agentById(agentId)?.name ?? agentId;
}

export function statusLabel(status: PromptStatus): string {
  return status;
}

export function formatFailRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function versionById(
  p: PromptFixture,
  versionId: string | null | undefined,
): PromptVersion | undefined {
  if (!versionId) return undefined;
  return p.versions.find((v) => v.id === versionId);
}

/** Prod-facing version, else status match, else newest. */
export function liveVersion(p: PromptFixture): PromptVersion | undefined {
  const pinned = versionById(p, p.pins.prod);
  if (pinned) return pinned;
  return (
    p.versions.find((v) => v.status === "live") ??
    p.versions.find((v) => v.status === p.status) ??
    p.versions[0]
  );
}

export function previousVersion(
  p: PromptFixture,
): PromptVersion | undefined {
  const live = liveVersion(p);
  if (!live) return p.versions[1];
  const idx = p.versions.findIndex((v) => v.id === live.id);
  return idx >= 0 ? p.versions[idx + 1] : p.versions[1];
}

export function nextVersionLabel(p: PromptFixture): string {
  const nums = p.versions
    .map((v) => Number.parseInt(v.label.replace(/^v/i, ""), 10))
    .filter((n) => !Number.isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `v${max + 1}`;
}

/** Save current body as a new draft version. */
export function saveDraftVersion(
  list: PromptFixture[],
  promptId: string,
  body: string,
): PromptFixture[] {
  return list.map((p) => {
    if (p.id !== promptId) return p;
    const label = nextVersionLabel(p);
    const id = `${p.id}_${label}`;
    const version: PromptVersion = {
      id,
      label,
      status: "draft",
      body,
      createdAt: "just now",
    };
    return {
      ...p,
      status: p.status === "archived" ? "draft" : p.status,
      bodyPreview: previewBody(body),
      versions: [version, ...p.versions],
    };
  });
}

/** Pin a version to an env; prod pin also marks prompt live. */
export function pinVersion(
  list: PromptFixture[],
  promptId: string,
  versionId: string,
  env: PromptEnv,
): PromptFixture[] {
  return list.map((p) => {
    if (p.id !== promptId) return p;
    const version = versionById(p, versionId);
    if (!version) return p;
    const versions = p.versions.map((v) => {
      if (env !== "prod") return v;
      if (v.id === versionId) {
        return {
          ...v,
          status: "live" as const,
          deployedAt: "just now",
        };
      }
      if (v.status === "live") {
        return { ...v, status: "archived" as const };
      }
      return v;
    });
    return {
      ...p,
      pins: { ...p.pins, [env]: versionId },
      status: env === "prod" ? "live" : p.status === "draft" ? "shadow" : p.status,
      lastDeployed: env === "prod" ? "just now" : p.lastDeployed,
      bodyPreview: previewBody(version.body),
      versions,
    };
  });
}

/** Rollback prod to the previous version (new live pin). */
export function rollbackProd(
  list: PromptFixture[],
  promptId: string,
): PromptFixture[] {
  const p = promptById(promptId, list);
  if (!p) return list;
  const prior = previousVersion(p);
  if (!prior) return list;
  return pinVersion(list, promptId, prior.id, "prod");
}

export function labPromptsHref(params: {
  id?: string;
  agent?: string;
  status?: PromptStatus | "all";
  tab?: PromptDetailTab;
  version?: string;
}): string {
  const q = new URLSearchParams();
  if (params.id) q.set("id", params.id);
  if (params.agent && params.agent !== "all") q.set("agent", params.agent);
  if (params.status && params.status !== "all") q.set("status", params.status);
  if (params.tab && params.tab !== "editor") q.set("tab", params.tab);
  if (params.version) q.set("version", params.version);
  const qs = q.toString();
  return qs ? `/prompts?${qs}` : "/prompts";
}
