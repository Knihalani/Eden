"use client";

/**
 * McpTab — Settings → MCP connection wizard (WS8).
 *
 * Copy-paste `.cursor/mcp.json` and Claude Code config with
 * org-scoped env vars. Dedicated MCP key issuance (`POST /v1/mcp/keys`)
 * is not shipped yet — users reuse org API keys from Settings → API Keys.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink, Key, Terminal } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { IntegrationStatusBanner } from "@/components/settings/integration-status-banner";
import { DOCS_URL } from "@/lib/constants";

const DEFAULT_API_BASE = "https://api.edenobservability.com";

interface McpTabProps {
  org: { id: string; name: string; role: string } | null;
}

type ConfigTarget = "cursor" | "claude";

function buildCursorConfig(orgId: string, apiBase: string) {
  return JSON.stringify(
    {
      mcpServers: {
        eden: {
          command: "python",
          args: ["-m", "eden.mcp_server"],
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
          command: "python",
          args: ["-m", "eden.mcp_server"],
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

const MCP_TOOLS = [
  "search_traces",
  "get_trace",
  "get_transcript",
  "list_checkpoints",
  "rerun_debugger",
  "search_issues",
  "get_issue",
  "triage_issue",
  "run_autofix",
  "get_improvement_queue",
] as const;

const EXAMPLE_PROMPTS = [
  "Why did trace abc-123 fail? Show the transcript and quality signals.",
  "List open P0 agent issues from the last 24 hours.",
  "Triage issue iss_456 and suggest a fix.",
  "Rerun trace abc-123 from step 12 with this system prompt override.",
] as const;

export function McpTab({ org }: McpTabProps) {
  const [target, setTarget] = useState<ConfigTarget>("cursor");
  const [copied, setCopied] = useState(false);

  const apiBase =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_EDEN_API_BASE) ||
    DEFAULT_API_BASE;

  const configText = useMemo(() => {
    const orgId = org?.id ?? "<your-org-id>";
    return target === "cursor"
      ? buildCursorConfig(orgId, apiBase)
      : buildClaudeConfig(orgId, apiBase);
  }, [org?.id, apiBase, target]);

  const configPath =
    target === "cursor" ? ".cursor/mcp.json" : ".claude/mcp.json";

  const copyConfig = () => {
    void navigator.clipboard.writeText(configText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
                Wire Cursor or Claude Code to search traces, triage issues, rerun
                the debugger, and run autofix — without leaving your editor.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {(["cursor", "claude"] as const).map((id) => (
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
                {id === "cursor" ? "Cursor" : "Claude Code"}
              </button>
            ))}
          </div>

          <div className="p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-default)]">
            <p className="text-xs text-[var(--text-muted)] mb-2">
              Save as <code className="font-mono">{configPath}</code> in your
              project root (or merge into your existing MCP config).
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

          <p className="text-xs text-[var(--text-muted)]">
            Requires the Eden platform package so{" "}
            <code className="font-mono">python -m eden.mcp_server</code> is on
            your PATH (monorepo checkout or self-hosted API install). Replace{" "}
            <code className="font-mono">&lt;your-api-key&gt;</code> with an org
            API key.
          </p>
        </div>
      </SettingsCard>

      <SettingsCard>
        <div className="flex items-start gap-3">
          <Key className="w-5 h-5 text-[var(--text-muted)] mt-0.5 flex-shrink-0" />
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              API key
            </h3>
            <p className="text-sm text-[var(--text-secondary)]">
              MCP uses your org API key via{" "}
              <code className="font-mono text-xs">EDEN_API_KEY</code>. Dedicated
              MCP-scoped keys (<code className="font-mono text-xs">mcp:read</code>
              , <code className="font-mono text-xs">mcp:debug</code>,{" "}
              <code className="font-mono text-xs">mcp:fix</code>) ship when the{" "}
              <code className="font-mono text-xs">eden_mcp_server_v1</code> flag
              enables <code className="font-mono text-xs">POST /v1/mcp/keys</code>
              .
            </p>
            <Link
              href="/settings?tab=api-keys"
              className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline"
            >
              Settings → API Keys
              <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
          Available tools
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
