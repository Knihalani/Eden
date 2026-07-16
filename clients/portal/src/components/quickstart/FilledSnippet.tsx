"use client";

/**
 * FilledSnippet — one-click Fill in for quickstart code.
 *
 * Raw API keys are only returned at creation time. Fill in:
 * 1. Reuses a session-stored secret for this org if present
 * 2. Otherwise creates a new "Quickstart" key (all scopes) and stores it
 * 3. Injects api key + org id into the snippet
 */

import { useCallback, useMemo, useState } from "react";
import { Check, Copy, Loader2, Sparkles, Terminal } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildQuickstartSnippet,
  QUICKSTART_SESSION_KEY,
  type QuickstartLang,
} from "@/lib/quickstart-snippets";

const SDK_SCOPES = [
  "references:read",
  "references:write",
  "jobs:read",
  "jobs:write",
];

interface FilledSnippetProps {
  orgId: string;
  canManage: boolean;
  className?: string;
}

export function FilledSnippet({ orgId, canManage, className }: FilledSnippetProps) {
  const toast = useToast();
  const [lang, setLang] = useState<QuickstartLang>("python");
  const [apiKey, setApiKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return sessionStorage.getItem(QUICKSTART_SESSION_KEY(orgId));
    } catch {
      return null;
    }
  });
  const [filling, setFilling] = useState(false);
  const [copied, setCopied] = useState(false);

  const keysQuery = useOrgQuery(
    queryKeys.settings.apiKeys(orgId),
    orgId,
    () =>
      api.listApiKeys(orgId) as Promise<
        Array<{ id: string; name: string; key_prefix: string }>
      >,
  );

  const filled = Boolean(apiKey);
  const snippet = useMemo(
    () =>
      buildQuickstartSnippet(lang, {
        apiKey: apiKey ?? "<your-api-key>",
        orgId,
      }),
    [lang, apiKey, orgId],
  );

  const persistKey = useCallback(
    (raw: string) => {
      setApiKey(raw);
      try {
        sessionStorage.setItem(QUICKSTART_SESSION_KEY(orgId), raw);
      } catch {
        // non-fatal — still fill in memory
      }
    },
    [orgId],
  );

  const handleFillIn = async () => {
    if (!canManage) {
      toast.error("Ask an org owner or admin to create an API key");
      return;
    }
    if (apiKey) {
      toast.success("Snippet already filled — copy below");
      return;
    }
    setFilling(true);
    try {
      // Existing keys cannot be re-read. Create a dedicated Quickstart key.
      const data = await api.createApiKey(orgId, "Quickstart", SDK_SCOPES);
      const raw = data.raw_key;
      if (!raw) {
        toast.error("Key created but secret missing — try again");
        return;
      }
      persistKey(raw);
      await keysQuery.refetch();
      toast.success("API key created and filled into the snippet");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not create API key");
    } finally {
      setFilling(false);
    }
  };

  const copySnippet = async () => {
    if (!filled) {
      toast.error("Click Fill in first so the key is in the snippet");
      return;
    }
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success("Snippet copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg bg-[var(--bg-tertiary)] p-0.5">
          {(["python", "typescript", "bash"] as QuickstartLang[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium capitalize",
                lang === l
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              {l === "bash" ? "Env" : l === "python" ? "Python" : "TypeScript"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleFillIn()}
            disabled={filling || (!canManage && !apiKey)}
          >
            {filling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {filled ? "Filled" : "Fill in"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copySnippet()}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            Copy
          </Button>
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        {filled
          ? "Key is in the snippet for this browser session only. Paste and run."
          : "Fill in creates a Quickstart API key (or reuses one from this session) and writes it into the code below."}
      </p>

      <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
        <div className="flex items-center gap-2 border-b border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-1.5">
          <Terminal className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span className="text-xs text-[var(--text-secondary)]">
            {lang === "bash" ? "shell" : lang === "python" ? "hello_eden.py" : "hello-eden.ts"}
          </span>
        </div>
        <pre className="max-h-[420px] overflow-auto bg-[var(--bg-secondary)] p-4 text-[11px] leading-relaxed text-[var(--text-primary)]">
          <code>{snippet}</code>
        </pre>
      </div>
    </div>
  );
}
