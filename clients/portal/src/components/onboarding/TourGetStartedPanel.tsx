"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import {
  QUICKSTART_LANGS,
  buildQuickstartSnippet,
  type QuickstartLang,
} from "@/lib/quickstart-snippets";
import { InstallSnippetCopy } from "@/components/marketing/install-snippet-copy";
import { buildAgentIntegrationPrompt } from "@/lib/agent-integration-prompt";
import { useOrg } from "@/hooks/use-org";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

type FillState =
  | { status: "loading" }
  | { status: "ready"; apiKey: string; orgId: string }
  | { status: "error"; message: string; orgId?: string };

type MintResult = { apiKey: string; orgId: string };

/** Dedupes Strict Mode remounts + Back→Next remounts in one tab session. */
const mintInflight = new Map<string, Promise<MintResult>>();

function cacheKey(orgId: string): string {
  return `eden.tour.quickstart.${orgId}`;
}

function readCachedMint(orgId: string): MintResult | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(cacheKey(orgId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MintResult>;
    if (
      typeof parsed.apiKey === "string" &&
      parsed.apiKey.length > 0 &&
      typeof parsed.orgId === "string"
    ) {
      return { apiKey: parsed.apiKey, orgId: parsed.orgId };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeCachedMint(result: MintResult): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(cacheKey(result.orgId), JSON.stringify(result));
  } catch {
    /* ignore quota */
  }
}

async function mintQuickstartKey(orgId: string): Promise<MintResult> {
  const cached = readCachedMint(orgId);
  if (cached) return cached;

  const existing = mintInflight.get(orgId);
  if (existing) return existing;

  const promise = (async (): Promise<MintResult> => {
    const res = await fetch("/api/docs", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(err?.error || `Key create failed (${res.status})`);
    }
    const data = (await res.json()) as { apiKey: string; orgId: string };
    if (!data.apiKey || !data.orgId) {
      throw new Error("Invalid key create response");
    }
    const result = { apiKey: data.apiKey, orgId: data.orgId };
    writeCachedMint(result);
    return result;
  })();

  mintInflight.set(orgId, promise);
  try {
    return await promise;
  } catch (err) {
    mintInflight.delete(orgId);
    throw err;
  }
}

/**
 * Finish-step panel: mint Quickstart key via POST /api/docs and show
 * filled Python / TypeScript / Bash snippets.
 */
export function TourGetStartedPanel() {
  const { currentOrg } = useOrg();
  const queryClient = useQueryClient();
  const [lang, setLang] = useState<QuickstartLang>("python");
  const [fill, setFill] = useState<FillState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const orgId = currentOrg?.id;
    if (!orgId) {
      setFill({
        status: "error",
        message: "Select a workspace to mint a Quickstart key.",
      });
      return;
    }

    const cached = readCachedMint(orgId);
    if (cached) {
      setFill({ status: "ready", apiKey: cached.apiKey, orgId: cached.orgId });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portal.keys(orgId),
      });
      return;
    }

    setFill({ status: "loading" });
    (async () => {
      try {
        const session = await fetch("/api/docs", {
          method: "GET",
          credentials: "include",
          headers: { "X-Org-Id": orgId },
        });
        if (!session.ok) {
          throw new Error("Could not read session");
        }
        const info = (await session.json()) as {
          loggedIn?: boolean;
          orgId?: string;
          canCreateKeys?: boolean;
        };
        if (!info.loggedIn) {
          if (!cancelled) {
            setFill({
              status: "error",
              message: "Sign in to mint a Quickstart key.",
            });
          }
          return;
        }
        if (!info.canCreateKeys) {
          if (!cancelled) {
            setFill({
              status: "error",
              message:
                "You need owner or admin on this org to mint a key. Create one under Settings → API keys.",
              orgId,
            });
          }
          return;
        }
        const data = await mintQuickstartKey(orgId);
        // Tour visits Settings before mint with an empty keys cache
        // (staleTime 120s, no refetchOnMount) — invalidate so Overview
        // / API keys show the Quickstart row immediately.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.portal.keys(orgId),
        });
        if (!cancelled) {
          setFill({
            status: "ready",
            apiKey: data.apiKey,
            orgId: data.orgId,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setFill({
            status: "error",
            message:
              err instanceof Error
                ? err.message
                : "Could not create a Quickstart key.",
            orgId,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, queryClient]);

  // Shared by the hello-world snippet and the coding-agent prompt so the
  // two can never disagree about which key the user is being handed.
  const creds = {
    apiKey: fill.status === "ready" ? fill.apiKey : null,
    orgId:
      fill.status === "ready"
        ? fill.orgId
        : fill.status === "error"
          ? fill.orgId
          : currentOrg?.id ?? null,
  };
  const snippet = buildQuickstartSnippet(lang, creds);
  const agentPrompt = buildAgentIntegrationPrompt(creds);

  const onLang = useCallback((next: QuickstartLang) => {
    setLang(next);
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
        Copy a filled snippet, run doctor, then open{" "}
        <Link
          href="/traces"
          className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
        >
          Traces
        </Link>{" "}
        for your first event.
      </p>

      {fill.status === "loading" ? (
        <p className="font-mono text-[0.6875rem] text-[var(--text-faint)]">
          Creating Quickstart key…
        </p>
      ) : null}

      {fill.status === "error" ? (
        <div className="border border-[var(--line)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)] px-3 py-2">
          <p className="text-[0.75rem] text-[var(--error)]" role="alert">
            {fill.message}
          </p>
          <Link
            href="/settings?mode=keys"
            className="mt-2 inline-block font-mono text-[0.6875rem] text-[var(--accent)]"
          >
            Settings → API keys →
          </Link>
        </div>
      ) : null}

      {fill.status === "ready" ? (
        <p className="font-mono text-[0.625rem] text-[var(--text-faint)]">
          org <span className="text-[var(--text-secondary)]">{fill.orgId}</span>
          {" · "}
          key minted for this tour (shown once)
        </p>
      ) : null}

      <div className="overflow-hidden border border-[var(--line)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_4%,transparent)] px-2 py-1.5">
          <div className="flex gap-1" role="tablist" aria-label="Snippet language">
            {QUICKSTART_LANGS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={lang === opt.id}
                onClick={() => onLang(opt.id)}
                className={cn(
                  "px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.12em]",
                  lang === opt.id
                    ? "border border-[var(--line-accent)] bg-[var(--accent-muted)] text-[var(--accent)]"
                    : "text-[var(--text-faint)] hover:text-[var(--text-secondary)]",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <InstallSnippetCopy
            snippet={snippet}
            disabled={fill.status !== "ready"}
          />
        </div>
        <pre className="max-h-48 overflow-auto p-3 font-mono text-[0.6875rem] leading-relaxed text-[var(--text-secondary)]">
          <code>{snippet}</code>
        </pre>
      </div>

      <div className="border border-[var(--line)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_4%,transparent)] px-2 py-1.5">
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-[var(--text-faint)]">
            Or: integrate an existing codebase
          </span>
          <InstallSnippetCopy
            snippet={agentPrompt}
            disabled={fill.status !== "ready"}
          />
        </div>
        <div className="space-y-2 px-3 py-2.5">
          <p className="text-[0.75rem] leading-relaxed text-[var(--text-secondary)]">
            The snippet above is a hello-world. To instrument a real project,
            copy this prompt into your coding agent — Claude Code, Cursor,
            Codex, or any other. It surveys your stack, installs the right
            SDK, wires up tracing, and verifies a trace actually lands.
          </p>
          <p className="font-mono text-[0.625rem] text-[var(--text-faint)]">
            {fill.status === "ready"
              ? "Includes your key and org id — treat it as a secret."
              : "Sign in and mint a key to have it filled in automatically."}
          </p>
        </div>
      </div>

      <ol className="space-y-1.5 font-mono text-[0.6875rem] text-[var(--text-muted)]">
        <li>1. Paste the snippet into your project</li>
        <li>
          2. Run{" "}
          <code className="text-[var(--text-secondary)]">
            python -m eden_sdk.doctor
          </code>{" "}
          or{" "}
          <code className="text-[var(--text-secondary)]">npx eden-doctor</code>
        </li>
        <li>3. Open Traces — your hello-world event should appear</li>
      </ol>

      <a
        href={DOCS_QUICKSTART_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block font-mono text-[0.6875rem] text-[var(--text-faint)] hover:text-[var(--accent)]"
      >
        Full docs quickstart →
      </a>
    </div>
  );
}
