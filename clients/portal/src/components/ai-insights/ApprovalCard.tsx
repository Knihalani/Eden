"use client";

/**
 * ApprovalCard — mutation preview with editable EQL (F70/F81).
 *
 * Shown for ``preview_nl_alert`` tool results. The operator can edit
 * the compiled EQL, then Confirm (persist rule) or Cancel.
 */

import { useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Wrench,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { nlAlertsApi } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";

export interface ApprovalCardProps {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: {
    status: "ok" | "error";
    output?: unknown;
    duration_ms?: number;
  };
  onConfirmed?: (ruleId: string) => void;
  onCancelled?: () => void;
}

function extractPreview(output: unknown): {
  nlText: string;
  eql: string;
  warnings: string[];
  suggestedName: string;
} | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  return {
    nlText: String(o.nl_text ?? ""),
    eql: String(o.eql ?? ""),
    warnings: Array.isArray(o.warnings)
      ? o.warnings.map((w) => String(w))
      : [],
    suggestedName: String(o.suggested_name ?? "Alert rule"),
  };
}

export function ApprovalCard({
  id,
  name,
  input,
  result,
  onConfirmed,
  onCancelled,
}: ApprovalCardProps) {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const preview = result?.status === "ok" ? extractPreview(result.output) : null;
  const [eql, setEql] = useState(preview?.eql ?? "");
  const [ruleName, setRuleName] = useState(preview?.suggestedName ?? "");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const isRunning = !result;
  const isError = result?.status === "error";

  const handleConfirm = async () => {
    if (!currentOrg?.id || !preview) return;
    setSaving(true);
    try {
      const created = await nlAlertsApi.createRule(currentOrg.id, {
        name: ruleName || preview.suggestedName,
        nl_text: preview.nlText || String(input?.nl_text ?? ""),
        compiled_eql: eql,
        triage_enabled: true,
      });
      setDone(true);
      toast.success("Alert rule saved");
      onConfirmed?.(created.id);
    } catch (e) {
      toast.error(
        "Could not save alert rule",
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setCancelled(true);
    onCancelled?.();
  };

  return (
    <div
      data-tool-call-id={id}
      className={cn(
        "my-2 rounded-md border bg-[var(--bg-elevated)] font-mono text-xs",
        isError
          ? "border-[var(--error)]/40"
          : "border-[var(--accent)]/30",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)]">
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
        ) : isError ? (
          <AlertTriangle className="h-3.5 w-3.5 text-[var(--error)]" />
        ) : done ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-[var(--success)]" />
        ) : (
          <Wrench className="h-3.5 w-3.5 text-[var(--accent)]" />
        )}
        <span className="font-medium text-[var(--text-primary)]">{name}</span>
        <Tag className="ml-auto text-[10px]">approval</Tag>
        {result && typeof result.duration_ms === "number" && (
          <Tag className="font-mono text-[10px]">{result.duration_ms}ms</Tag>
        )}
      </div>

      {preview && !cancelled && (
        <div className="space-y-2 px-3 py-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              English
            </div>
            <p className="text-[11px] text-[var(--text-secondary)]">
              {preview.nlText}
            </p>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Rule name
            </div>
            <input
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              disabled={done || saving}
              className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
            />
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              EQL preview (editable)
            </div>
            <textarea
              value={eql}
              onChange={(e) => setEql(e.target.value)}
              disabled={done || saving}
              rows={4}
              className="w-full resize-y rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1 text-[11px] leading-relaxed text-[var(--text-secondary)]"
            />
          </div>
          {preview.warnings.length > 0 && (
            <ul className="list-disc pl-4 text-[10px] text-[var(--warning)]">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {!done && (
            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                disabled={saving || !eql.trim()}
                onClick={() => void handleConfirm()}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Confirm"
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={handleCancel}
              >
                Cancel
              </Button>
              <Link
                href="/alerts"
                className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Alerts
              </Link>
            </div>
          )}
          {done && (
            <p className="text-[10px] text-[var(--success)]">
              Rule saved — view on the Alerts Rules tab.
            </p>
          )}
        </div>
      )}

      {cancelled && (
        <p className="px-3 py-2 text-[10px] text-[var(--text-muted)]">
          Alert creation cancelled.
        </p>
      )}

      {isError && (
        <pre className="max-h-40 overflow-auto px-3 py-2 text-[11px] text-[var(--error)]">
          {String(result?.output ?? "")}
        </pre>
      )}
    </div>
  );
}
