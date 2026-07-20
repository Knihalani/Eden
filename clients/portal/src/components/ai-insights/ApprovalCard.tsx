"use client";

/**
 * ApprovalCard — mutation preview; Confirm is the only write path (W20–W22).
 *
 * - ``preview_nl_alert`` → editable EQL + nlAlertsApi.createRule
 * - ``preview_nl_signal`` → rule preview + signalsApi.create
 * - other ``approval_required`` tools → POST /ai-insights/approve
 */

import { useEffect, useState } from "react";
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
import { nlAlertsApi, signalsApi } from "@/lib/api";
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
  sessionId?: string | null;
  onConfirmed?: (ruleId: string) => void;
  onCancelled?: () => void;
}

function extractAlertPreview(output: unknown): {
  nlText: string;
  eql: string;
  warnings: string[];
  suggestedName: string;
} | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (!("eql" in o) && !("nl_text" in o)) return null;
  if ("rule" in o && !("eql" in o)) return null;
  return {
    nlText: String(o.nl_text ?? ""),
    eql: String(o.eql ?? ""),
    warnings: Array.isArray(o.warnings)
      ? o.warnings.map((w) => String(w))
      : [],
    suggestedName: String(o.suggested_name ?? "Alert rule"),
  };
}

function extractSignalPreview(output: unknown): {
  description: string;
  rule: Record<string, unknown>;
  suggestedName: string;
} | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (!("description" in o) || !("rule" in o)) return null;
  if ("eql" in o) return null;
  const rule =
    o.rule && typeof o.rule === "object" && !Array.isArray(o.rule)
      ? (o.rule as Record<string, unknown>)
      : {};
  return {
    description: String(o.description ?? ""),
    rule,
    suggestedName: String(o.suggested_name ?? "Signal"),
  };
}

function extractGenericApproval(output: unknown, input?: Record<string, unknown>) {
  if (!output || typeof output !== "object") {
    return { tool: "", args: input ?? {}, message: "Confirm to apply this change." };
  }
  const o = output as Record<string, unknown>;
  return {
    tool: String(o.tool ?? ""),
    args: (o.args as Record<string, unknown>) ?? input ?? {},
    message: String(o.message ?? "Confirmation required before this write runs."),
    spendPreview:
      o.spend_preview && typeof o.spend_preview === "object"
        ? (o.spend_preview as Record<string, unknown>)
        : null,
  };
}

export function ApprovalCard({
  id,
  name,
  input,
  result,
  sessionId,
  onConfirmed,
  onCancelled,
}: ApprovalCardProps) {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const alertPreview =
    result?.status === "ok" ? extractAlertPreview(result.output) : null;
  const signalPreview =
    result?.status === "ok" && !alertPreview
      ? extractSignalPreview(result.output)
      : null;
  const generic =
    result?.status === "ok" && !alertPreview && !signalPreview
      ? extractGenericApproval(result.output, input)
      : null;
  const [eql, setEql] = useState(alertPreview?.eql ?? "");
  const [ruleName, setRuleName] = useState(alertPreview?.suggestedName ?? "");
  const [signalDesc, setSignalDesc] = useState(signalPreview?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  // Sync controlled fields when tool result/preview arrives after mount
  // (card mounts on tool_call; preview lands later on tool_result).
  // Depend on result (stable prop), not the derived preview objects —
  // those are new every render and would clobber in-progress edits.
  useEffect(() => {
    if (result?.status !== "ok") return;
    const ap = extractAlertPreview(result.output);
    if (ap) {
      setEql(ap.eql);
      setRuleName(ap.suggestedName);
      return;
    }
    const sp = extractSignalPreview(result.output);
    if (sp) {
      setSignalDesc(sp.description);
    }
  }, [result]);

  const isRunning = !result;
  const isError = result?.status === "error";

  const handleConfirmAlert = async () => {
    if (!currentOrg?.id || !alertPreview) return;
    setSaving(true);
    try {
      const created = await nlAlertsApi.createRule(currentOrg.id, {
        name: ruleName || alertPreview.suggestedName,
        nl_text: alertPreview.nlText || String(input?.nl_text ?? ""),
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

  const handleConfirmSignal = async () => {
    if (!currentOrg?.id || !signalPreview) return;
    setSaving(true);
    try {
      const created = await signalsApi.create(currentOrg.id, {
        description: signalDesc || signalPreview.description,
        enabled: true,
      });
      setDone(true);
      toast.success("Signal saved");
      onConfirmed?.(created.id);
    } catch (e) {
      toast.error(
        "Could not save signal",
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmGeneric = async () => {
    if (!currentOrg?.id || !generic) return;
    setSaving(true);
    try {
      const tool = generic.tool || name;
      const r = await fetch(
        `/api/ai-insights/approve?org_id=${currentOrg.id}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool,
            args: generic.args,
            session_id: sessionId ?? undefined,
          }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail ?? `HTTP ${r.status}`);
      }
      const body = await r.json().catch(() => ({}));
      // Spend-confirm exports may return a download client_action.
      const out = body?.result;
      if (out && typeof out === "object" && out.client_action === "download") {
        const { executeClientToolAction } = await import("./clientToolExecutors");
        executeClientToolAction(out, { navigate: () => undefined });
      }
      setDone(true);
      toast.success("Change applied");
      onConfirmed?.(tool);
    } catch (e) {
      toast.error(
        "Could not apply change",
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
      data-approval-card
      className={cn(
        "my-space-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] font-mono text-xs",
        isError && "border-[var(--error)]/40",
      )}
      data-approval-quiet
    >
      <div className="flex items-center gap-space-2 border-b border-[var(--border-subtle)] px-space-3 py-space-2">
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
        <Tag className="ml-auto text-2xs text-[var(--text-muted)]">approval</Tag>
        {result && typeof result.duration_ms === "number" && (
          <Tag className="font-mono text-2xs">{result.duration_ms}ms</Tag>
        )}
      </div>

      {alertPreview && !cancelled && (
        <div className="space-y-space-3 px-space-3 py-space-3">
          <div>
            <div className="mb-space-1 text-2xs uppercase tracking-wider text-[var(--text-muted)]">
              English
            </div>
            <p className="text-xs text-[var(--text-secondary)]">{alertPreview.nlText}</p>
          </div>
          <div>
            <div className="mb-space-1 text-2xs uppercase tracking-wider text-[var(--text-muted)]">
              Rule name
            </div>
            <input
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              disabled={done || saving}
              className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-space-2 py-space-1 text-xs text-[var(--text-primary)]"
            />
          </div>
          <div>
            <div className="mb-space-1 text-2xs uppercase tracking-wider text-[var(--text-muted)]">
              EQL preview (editable)
            </div>
            <textarea
              value={eql}
              onChange={(e) => setEql(e.target.value)}
              disabled={done || saving}
              rows={4}
              className="w-full resize-y rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-space-2 py-space-1 text-xs leading-relaxed text-[var(--text-secondary)]"
            />
          </div>
          {alertPreview.warnings.length > 0 && (
            <ul className="list-disc pl-space-4 text-2xs text-[var(--warning)]">
              {alertPreview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {!done && (
            <div className="flex items-center gap-space-2 pt-space-1">
              <Button
                type="button"
                size="sm"
                disabled={saving || !eql.trim()}
                onClick={() => void handleConfirmAlert()}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm"}
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
                className="ml-auto inline-flex items-center gap-space-1 text-xs text-[var(--accent)] hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Alerts
              </Link>
            </div>
          )}
          {done && (
            <p className="text-xs text-[var(--success)]">
              Rule saved — view on the Alerts Rules tab.
            </p>
          )}
        </div>
      )}

      {signalPreview && !cancelled && (
        <div className="space-y-space-3 px-space-3 py-space-3">
          <div>
            <div className="mb-space-1 text-2xs uppercase tracking-wider text-[var(--text-muted)]">
              Description (editable)
            </div>
            <textarea
              value={signalDesc}
              onChange={(e) => setSignalDesc(e.target.value)}
              disabled={done || saving}
              rows={3}
              className="w-full resize-y rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-space-2 py-space-1 text-xs leading-relaxed text-[var(--text-secondary)]"
            />
          </div>
          <div>
            <div className="mb-space-1 text-2xs uppercase tracking-wider text-[var(--text-muted)]">
              Compiled rule
            </div>
            <pre className="max-h-32 overflow-auto rounded bg-[var(--bg-base)] p-space-2 font-mono text-2xs text-[var(--text-muted)]">
              {JSON.stringify(signalPreview.rule, null, 2)}
            </pre>
          </div>
          {!done && (
            <div className="flex items-center gap-space-2 pt-space-1">
              <Button
                type="button"
                size="sm"
                disabled={saving || !signalDesc.trim()}
                onClick={() => void handleConfirmSignal()}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm"}
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
                href="/alerts?tab=signals"
                className="ml-auto inline-flex items-center gap-space-1 text-xs text-[var(--accent)] hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Signals
              </Link>
            </div>
          )}
          {done && (
            <p className="text-xs text-[var(--success)]">
              Signal saved — view on the Signals page.
            </p>
          )}
        </div>
      )}

      {generic && !cancelled && (
        <div className="space-y-space-3 px-space-3 py-space-3">
          <p className="text-xs text-[var(--text-secondary)]">{generic.message}</p>
          {generic.spendPreview && (
            <p className="text-2xs text-[var(--warning)]">
              Spend preview: $
              {Number(generic.spendPreview.estimated_usd ?? 0).toFixed(4)}
              {generic.spendPreview.message
                ? ` — ${String(generic.spendPreview.message)}`
                : ""}
            </p>
          )}
          <pre className="max-h-32 overflow-auto rounded bg-[var(--bg-base)] p-space-2 font-mono text-2xs text-[var(--text-muted)]">
            {JSON.stringify(generic.args, null, 2)}
          </pre>
          {!done && (
            <div className="flex items-center gap-space-2 pt-space-1">
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void handleConfirmGeneric()}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm"}
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
            </div>
          )}
          {done && (
            <p className="text-xs text-[var(--success)]">Change applied.</p>
          )}
        </div>
      )}

      {cancelled && (
        <p className="px-space-3 py-space-3 text-xs text-[var(--text-muted)]">
          Action cancelled.
        </p>
      )}

      {isError && (
        <pre className="max-h-40 overflow-auto px-space-3 py-space-2 text-xs text-[var(--error)]">
          {String(result?.output ?? "")}
        </pre>
      )}
    </div>
  );
}
