"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, nlAlertsApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Loader2, Megaphone } from "lucide-react";

export interface AlertRulesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId?: string;
  prefillFilters?: {
    realm: string;
    outcome: string;
    agent_id: string;
    pastHours?: string;
    q?: string;
  };
}

/**
 * NL alert rules config — sheet only (Wave 5). Never mounts in the feed
 * viewport so Rules/Channels chrome cannot fight the live list.
 */
export function AlertRulesSheet({
  open,
  onOpenChange,
  orgId,
  prefillFilters,
}: AlertRulesSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="overflow-y-auto"
        data-testid="alerts-rules-sheet"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-space-2">
            <Megaphone className="h-4 w-4 text-[var(--accent)]" aria-hidden />
            Alert rules
          </SheetTitle>
          <SheetDescription>
            Plain-English thresholds that fire into the feed. Delivery channels
            live in Settings — not on the feed.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-space-4 p-space-4">
          <AlertRulesPanel orgId={orgId} prefillFilters={prefillFilters} />
          <p className="text-xs text-[var(--text-muted)]">
            Configure Slack / webhook delivery in{" "}
            <Link
              href="/settings?tab=security"
              className="text-[var(--accent)] hover:underline"
              data-testid="alerts-channels-settings-link"
            >
              Settings → Security
            </Link>
            .
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AlertRulesPanel({
  orgId,
  prefillFilters,
}: {
  orgId?: string;
  prefillFilters?: {
    realm: string;
    outcome: string;
    agent_id: string;
    pastHours?: string;
    q?: string;
  };
}) {
  const toast = useToast();
  const [nlText, setNlText] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [compiledEql, setCompiledEql] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);

  const rulesQuery = useOrgQuery(
    queryKeys.alerts.nlRules(orgId),
    orgId,
    () => api.listNlAlertRules(orgId!),
  );
  const nlRules = rulesQuery.data?.rules ?? [];
  const loading = rulesQuery.isLoading;
  const rulesError = rulesQuery.error?.message ?? null;

  useEffect(() => {
    if (!prefillFilters) return;
    const parts: string[] = [];
    if (prefillFilters.outcome) parts.push(`outcome is ${prefillFilters.outcome}`);
    if (prefillFilters.realm) parts.push(`realm is ${prefillFilters.realm}`);
    if (prefillFilters.agent_id) parts.push(`agent_id is ${prefillFilters.agent_id}`);
    if (prefillFilters.q) parts.push(`matching "${prefillFilters.q}"`);
    if (prefillFilters.pastHours) {
      parts.push(`in the last ${prefillFilters.pastHours} hours`);
    }
    if (parts.length > 0) {
      setNlText(
        `Alert me when traces match ${parts.join(" and ")} and error rate exceeds 5%`,
      );
    }
  }, [prefillFilters]);

  const handleCompile = async () => {
    if (!orgId || !nlText.trim()) return;
    setCompiling(true);
    try {
      const ctx: Record<string, unknown> = {};
      if (prefillFilters) {
        const filters: Record<string, string> = {};
        if (prefillFilters.realm) filters.realm = prefillFilters.realm;
        if (prefillFilters.outcome) filters.outcome = prefillFilters.outcome;
        if (prefillFilters.agent_id) filters.agent_id = prefillFilters.agent_id;
        if (Object.keys(filters).length) ctx.filters = filters;
      }
      const result = await api.compileNlAlert(orgId, { nl_text: nlText, context: ctx });
      setCompiledEql(result.eql);
      setWarnings(result.warnings);
      if (!ruleName) setRuleName(result.suggested_name);
      toast.success("Compiled to EQL");
    } catch (e) {
      toast.error("Compile failed", e instanceof Error ? e.message : undefined);
    } finally {
      setCompiling(false);
    }
  };

  const handleSave = async () => {
    if (!orgId || !compiledEql.trim() || !ruleName.trim()) return;
    setSaving(true);
    try {
      await nlAlertsApi.createRule(orgId, {
        name: ruleName,
        nl_text: nlText,
        compiled_eql: compiledEql,
        triage_enabled: true,
      });
      toast.success("Alert rule saved");
      setNlText("");
      setCompiledEql("");
      setRuleName("");
      setWarnings([]);
      void rulesQuery.refetch();
    } catch (e) {
      toast.error("Save failed", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-space-4" data-testid="alerts-rules-panel">
      <div className="space-y-space-2">
        <label className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
          English
        </label>
        <textarea
          value={nlText}
          onChange={(e) => setNlText(e.target.value)}
          rows={3}
          placeholder="Wake me if support agent cost per run exceeds $0.30 for 15 minutes"
          className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 text-sm text-[var(--text-primary)]"
        />
        <div className="flex gap-space-2">
          <Button
            size="sm"
            onClick={() => void handleCompile()}
            disabled={compiling || !nlText.trim()}
            loading={compiling}
          >
            Compile
          </Button>
        </div>
      </div>

      {compiledEql ? (
        <div className="space-y-space-2">
          <label className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
            EQL preview (editable)
          </label>
          <input
            value={ruleName}
            onChange={(e) => setRuleName(e.target.value)}
            placeholder="Rule name"
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 text-sm"
          />
          <textarea
            value={compiledEql}
            onChange={(e) => setCompiledEql(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 font-mono text-xs"
          />
          {warnings.length > 0 ? (
            <ul className="list-disc pl-space-4 text-xs text-[var(--warning)]">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          <Button size="sm" onClick={() => void handleSave()} disabled={saving} loading={saving}>
            Save rule
          </Button>
        </div>
      ) : null}

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
      ) : rulesError ? (
        <ErrorState
          size="sm"
          title="Could not load rules"
          message={rulesError}
          action={
            <Button size="sm" variant="outline" onClick={() => void rulesQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : nlRules.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No NL rules yet. Compile and save above.</p>
      ) : (
        <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-default)] pt-space-3">
          <p className="pb-space-2 text-xs uppercase tracking-wider text-[var(--text-muted)]">
            Saved rules
          </p>
          {nlRules.map((rule) => (
            <div key={rule.id} className="py-space-3">
              <div className="flex items-center gap-space-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">{rule.name}</span>
                {!rule.enabled ? (
                  <span className="text-xs text-[var(--text-muted)]">Disabled</span>
                ) : null}
              </div>
              <p className="mt-space-1 text-xs text-[var(--text-muted)]">{rule.nl_text}</p>
              <pre className="mt-space-1 line-clamp-2 font-mono text-xs text-[var(--text-secondary)]">
                {rule.compiled_eql}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
