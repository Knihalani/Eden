"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy, KeyRound } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { CodeChip } from "@/components/ui/code-chip";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { GATEWAY_URL } from "@/lib/constants";

type Props = {
  canConnect: boolean;
  onKeyCreated?: () => void;
};

export function ConnectGatewayPanel({ canConnect, onKeyCreated }: Props) {
  const t = useTranslations("agents.connect");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [keyName, setKeyName] = useState("Gateway");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"key" | "url" | "curl" | null>(null);

  const curlSample = `curl ${GATEWAY_URL}/chat/completions \\
  -H "Authorization: Bearer ${rawKey ?? "$EDEN_API_KEY"}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'`;

  async function createKey() {
    if (!orgId || !canConnect) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createApiKey(orgId, keyName.trim() || "Gateway");
      setRawKey(res.raw_key);
      onKeyCreated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("keyError"));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, which: "key" | "url" | "curl") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  }

  if (!canConnect) {
    return (
      <Panel tone="flat" padding="md" data-testid="connect-gateway-readonly">
        <p className="text-sm text-[var(--text-secondary)]">
          {t("viewerReadonly")}
        </p>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          {t("baseUrl")}: <CodeChip size="sm">{GATEWAY_URL}</CodeChip>
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-4" data-testid="connect-gateway-panel">
      <Panel tone="flat" padding="md" className="space-y-3">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">
          {t("createKey")}
        </h3>
        {!rawKey ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1 space-y-1">
              <label
                htmlFor="gateway-key-name"
                className="text-xs text-[var(--text-muted)]"
              >
                {t("keyName")}
              </label>
              <Input
                id="gateway-key-name"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                disabled={busy}
              />
            </div>
            <Button
              type="button"
              size="sm"
              disabled={busy || !orgId}
              onClick={() => void createKey()}
              className="min-h-11"
            >
              <KeyRound className="mr-1.5 h-4 w-4" aria-hidden />
              {busy ? t("creatingKey") : t("createKeyCta")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-[var(--warning)]">{t("keyOnce")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <CodeChip size="sm" className="max-w-full truncate">
                {rawKey}
              </CodeChip>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void copy(rawKey, "key")}
              >
                {copied === "key" ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                <span className="ml-1.5">{t("copy")}</span>
              </Button>
            </div>
          </div>
        )}
        {error ? (
          <p className="text-sm text-[var(--error)]" role="alert">
            {error}
          </p>
        ) : null}
      </Panel>

      <Panel tone="flat" padding="md" className="space-y-2">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">
          {t("baseUrl")}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <CodeChip size="sm">{GATEWAY_URL}</CodeChip>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void copy(GATEWAY_URL, "url")}
          >
            {copied === "url" ? t("copied") : t("copy")}
          </Button>
        </div>
      </Panel>

      <Panel tone="inset" padding="md" className="space-y-2">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">
          {t("sampleCurl")}
        </h3>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-3 font-mono text-xs text-[var(--text-primary)]">
          {curlSample}
        </pre>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void copy(curlSample, "curl")}
        >
          {copied === "curl" ? t("copied") : t("copy")}
        </Button>
      </Panel>
    </div>
  );
}
