"use client";

/**
 * McpTab — Settings → MCP connection wizard (WS8 / W28).
 *
 * Copy-paste `.cursor/mcp.json` and Claude Code config with
 * org-scoped env vars. MCP keys: Settings → API Keys (MCP presets)
 * or ``POST /orgs/{org}/mcp/keys``. Streamable HTTP also at ``POST /v1/mcp``.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink, Key, Terminal } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { IntegrationStatusBanner } from "@/components/settings/integration-status-banner";
import { DOCS_URL } from "@/lib/constants";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import { isAdminOrOwner } from "@/lib/roles";

const DEFAULT_API_BASE = "https://api.edenobservability.com";

interface McpTabProps {
  org: { id: string; name: string; role: string } | null;
}

type ConfigTarget = "cursor" | "claude" | "http";

function buildCursorConfig(orgId: string, apiBase: string) {
  return JSON.stringify(
    {
      mcpServers: {
        eden: {
          command: "eden-mcp",
          args: [],
          env: {
            EDEN_API_KEY: "<your-api-key>",
            EDEN_ORG_ID: orgId,
            EDEN_BASE_URL: apiBase,
          },
        },
      },
    },
    null,
    2,
  );
}

function buildClaudeConfig(orgId: string, apiBase: string) {
  return JSON.stringify(
    {
      mcpServers: {
        eden: {
          type: "stdio",
          command: "eden-mcp",
          args: [],
          env: {
            EDEN_API_KEY: "<your-api-key>",
            EDEN_ORG_ID: orgId,
            EDEN_BASE_URL: apiBase,
          },
        },
      },
    },
    null,
    2,
  );
}

function buildHttpNote(orgId: string, apiBase: string) {
  return [
    "# Streamable HTTP (W28)",
    `# POST ${apiBase}/v1/mcp  with Authorization: Bearer <key>`,
    `# Header X-Org-Id: ${orgId}`,
    "# JSON-RPC: initialize | tools/list | tools/call",
    "# Prefer stdio (eden-mcp) for Cursor; HTTP for remote agents.",
  ].join("\n");
}

const MCP_TOOLS = [
  "search_traces",
  "get_trace",
  "get_transcript",
  "list_checkpoints",
  "rerun_debugger",
  "search_issues",
  "get_issue",
  "get_trace_stumbles",
  "triage_issue",
  "run_autofix",
  "get_improvement_queue",
  "list_improvement_plans",
  "get_improvement_plan",
  "approve_improvement_plan",
  "export_fixture",
  "create_regression_case",
  "preview_change_impact",
  "eden_health",
  "tail_trace",
  "label_tool_call",
  "query_eql",
  "query_sql",
  "list_datasets",
  "list_experiments",
  "get_judge_scores",
  "get_cost_breakdown",
  "get_agentic_metrics",
] as const;

const EXAMPLE_PROMPTS = [
  "Why did trace abc-123 fail? Show the transcript and quality signals.",
  "List open P0 agent issues from the last 24 hours.",
  "Run a read-only SQL cost breakdown for the last day.",
  "Show F64 agentic metrics for this org.",
] as const;

export function McpTab({ org }: McpTabProps) {
  const toast = useToast();
  const { role: resolvedRole } = usePermissions();
  const [target, setTarget] = useState<ConfigTarget>("cursor");
  const [copied, setCopied] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);

  // Prefer resolveRole (Clerk org:admin → owner during sync lag) over
  // raw Eden membership role so creators can mint MCP keys immediately.
  const canManageKeys =
    isAdminOrOwner(resolvedRole) || isAdminOrOwner(org?.role);

  // Clear minted secret when switching orgs (avoid cross-tenant key bleed in UI).
  useEffect(() => {
    setRawKey(null);
  }, [org?.id]);

  const apiBase =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_EDEN_API_BASE) ||
    DEFAULT_API_BASE;

  const configText = useMemo(() => {
    const orgId = org?.id ?? "<your-org-id>";
    if (target === "http") return buildHttpNote(orgId, apiBase);
    return target === "cursor"
      ? buildCursorConfig(orgId, apiBase)
      : buildClaudeConfig(orgId, apiBase);
  }, [org?.id, apiBase, target]);

  const configPath =
    target === "cursor"
      ? ".cursor/mcp.json"
      : target === "claude"
        ? ".claude/mcp.json"
        : "HTTP /v1/mcp";

  const copyConfig = () => {
    void navigator.clipboard.writeText(configText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const createMcpKey = async () => {
    if (!org || !canManageKeys) return;
    setCreatingKey(true);
    try {
      const res = await api.createMcpKey(org.id, "MCP");
      setRawKey(res.raw_key ?? null);
      toast.success("MCP-scoped API key created");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create MCP key");
    } finally {
      setCreatingKey(false);
    }
  };

  if (!org) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to configure MCP
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <IntegrationStatusBanner orgId={org.id} watch={["github_action"]} />
      <SettingsCard>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <Terminal className="w-5 h-5 text-[var(--accent)] mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Connect Eden MCP in your IDE
              </h3>
              <p className="text-sm text-[var(--text-secondary)] mt-1">
                Wire Cursor or Claude Code to search traces, run EQL/SQL/eval
                reads, and triage issues — without leaving your editor.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {(["cursor", "claude", "http"] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTarget(id)}
                className={
                  target === id
                    ? "px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent-faint)] text-[var(--accent)]"
                    : "px-3 py-1.5 rounded-lg text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                }
              >
                {id === "cursor"
                  ? "Cursor"
                  : id === "claude"
                    ? "Claude Code"
                    : "Streamable HTTP"}
              </button>
            ))}
          </div>

          <div className="p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-default)]">
            <p className="text-xs text-[var(--text-muted)] mb-2">
              {target === "http" ? (
                <>Endpoint notes for remote agents</>
              ) : (
                <>
                  Save as <code className="font-mono">{configPath}</code> in your
                  project root (or merge into your existing MCP config).
                </>
              )}
            </p>
            <pre className="text-xs font-mono text-[var(--text-primary)] overflow-x-auto whitespace-pre-wrap break-all">
              {configText}
            </pre>
            <button
              type="button"
              onClick={copyConfig}
              className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent)] text-[var(--accent-foreground)] hover:opacity-90"
            >
              {copied ? (
                <Check className="w-4 h-4" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
              {copied ? "Copied" : "Copy config"}
            </button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard>
        <div className="flex items-start gap-3">
          <Key className="w-5 h-5 text-[var(--text-muted)] mt-0.5 flex-shrink-0" />
          <div className="space-y-2 flex-1">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              MCP API key
            </h3>
            <p className="text-sm text-[var(--text-secondary)]">
              Create an org-scoped key with{" "}
              <code className="font-mono text-xs">mcp:read/debug/fix</code>{" "}
              scopes via POST /orgs/&#123;org&#125;/mcp/keys.
            </p>
            <div className="flex flex-wrap gap-2">
              {canManageKeys ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={creatingKey}
                  onClick={() => void createMcpKey()}
                >
                  {creatingKey ? "Creating…" : "Create MCP key"}
                </Button>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">
                  Only org owners and admins can create MCP keys.
                </p>
              )}
              <Link
                href="/settings?tab=api-keys"
                className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline"
              >
                Settings → API Keys
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>
            {rawKey ? (
              <pre className="mt-2 text-xs font-mono break-all rounded border border-[var(--border-default)] p-2">
                {rawKey}
              </pre>
            ) : null}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
          Available tools ({MCP_TOOLS.length})
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {MCP_TOOLS.map((tool) => (
            <span
              key={tool}
              className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            >
              {tool}
            </span>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
          Example prompts
        </h3>
        <ul className="space-y-2 text-sm text-[var(--text-secondary)] list-disc pl-5">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt}>{prompt}</li>
          ))}
        </ul>
        <a
          href={`${DOCS_URL}/how-to/mcp-cursor`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 mt-3 text-sm text-[var(--accent)] hover:underline"
        >
          Full MCP setup guide
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </SettingsCard>
    </div>
  );
}
