"use client";

import { FlaskConical, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type ScoringRule = {
  id: string;
  name: string;
  scope?: string;
  scorer_type?: string;
  sample_rate?: number;
  enabled?: boolean;
  filter_query?: string;
  description?: string;
};

function SlmBadge({ type }: { type?: string }) {
  if ((type || "").toLowerCase() !== "slm") return null;
  return (
    <span className="rounded bg-[var(--warning-bg)] px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-[var(--warning)]">
      SLM
    </span>
  );
}

export function OnlineScoringTestPanel({
  testTraceId,
  busy,
  onTraceId,
  onApply,
}: {
  testTraceId: string;
  busy: boolean;
  onTraceId: (v: string) => void;
  onApply: () => void;
}) {
  return (
    <Panel
      tone="flat"
      padding="md"
      className="space-y-2"
      data-testid="online-scoring-test"
    >
      <h3 className="text-sm font-medium">Test on trace</h3>
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="trace id"
          value={testTraceId}
          onChange={(e) => onTraceId(e.target.value)}
          className="max-w-md"
        />
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          onClick={onApply}
          disabled={busy}
        >
          <FlaskConical className="h-3.5 w-3.5" /> Apply rules
        </Button>
      </div>
    </Panel>
  );
}

export function OnlineScoringRulesTable({
  rules,
  busy,
  onToggle,
  onEdit,
  onRewind,
}: {
  rules: ScoringRule[];
  busy: boolean;
  onToggle: (rule: ScoringRule) => void;
  onEdit: (rule: ScoringRule) => void;
  onRewind: (ruleId: string) => void;
}) {
  return (
    <div
      className="overflow-x-auto border-y border-[var(--border-subtle)]"
      data-testid="online-scoring-rules-table"
    >
      <table className="w-full text-sm">
        <thead className="bg-[var(--bg-tertiary)] text-left text-xs text-[var(--text-muted)]">
          <tr>
            <th className="px-space-3 py-space-1.5 font-medium">Name</th>
            <th className="px-space-3 py-space-1.5 font-medium">Type</th>
            <th className="px-space-3 py-space-1.5 font-medium">Sample</th>
            <th className="px-space-3 py-space-1.5 font-medium">Filter</th>
            <th className="px-space-3 py-space-1.5 font-medium">Enabled</th>
            <th className="px-space-3 py-space-1.5 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr
              key={String(rule.id)}
              className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-secondary)]/40"
            >
              <td className="px-space-3 py-space-1.5">
                <p className="font-medium text-[var(--text-primary)]">
                  {String(rule.name)}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {String(rule.scope || "trace")}
                </p>
              </td>
              <td className="px-space-3 py-space-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs">{String(rule.scorer_type)}</span>
                  <SlmBadge type={rule.scorer_type} />
                </div>
              </td>
              <td className="px-space-3 py-space-1.5 tabular-nums text-xs">
                {Math.round(Number(rule.sample_rate ?? 1) * 100)}%
              </td>
              <td className="max-w-[14rem] truncate px-space-3 py-space-1.5 font-mono text-xs text-[var(--text-muted)]">
                {rule.filter_query || "—"}
              </td>
              <td className="px-space-3 py-space-1.5">
                <span
                  className={cn(
                    "text-xs font-medium",
                    rule.enabled
                      ? "text-[var(--terminal)]"
                      : "text-[var(--text-muted)]",
                  )}
                >
                  {rule.enabled ? "On" : "Off"}
                </span>
              </td>
              <td className="px-space-3 py-space-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    checked={Boolean(rule.enabled)}
                    onCheckedChange={() => onToggle(rule)}
                    label={rule.enabled ? "Enabled" : "Disabled"}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => onEdit(rule)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => onRewind(rule.id)}
                    disabled={busy}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Rewind
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
