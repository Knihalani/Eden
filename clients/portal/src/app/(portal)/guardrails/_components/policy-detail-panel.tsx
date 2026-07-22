"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { GuardrailPolicyRow } from "@/lib/api/resources";
import type { AgentSummary } from "@/lib/api/resources";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CodeChip } from "@/components/ui/code-chip";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GUARDRAILS_SEVERITIES, type GuardrailsSeverity } from "@/lib/guardrails-url";
import {
  draftFromPolicy,
  policyConfigFromDraft,
  type PolicyDraft,
} from "./map-violations";

const POLICY_KINDS = ["content", "pii", "hallucination", "injection"] as const;

type Props = {
  open: boolean;
  policy: GuardrailPolicyRow | null;
  agents: AgentSummary[];
  canMutate: boolean;
  pending?: boolean;
  mobileDrawer?: boolean;
  onClose: () => void;
  onSave: (draft: PolicyDraft) => Promise<void>;
  onViewViolations: (policyId: string) => void;
};

export function PolicyDetailPanel({
  open,
  policy,
  agents,
  canMutate,
  pending,
  mobileDrawer = true,
  onClose,
  onSave,
  onViewViolations,
}: Props) {
  const t = useTranslations("guardrails");
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!policy) {
      setDraft(null);
      setError(null);
      return;
    }
    setDraft(draftFromPolicy(policy));
    setError(null);
  }, [policy]);

  const baseline = useMemo(
    () => (policy ? draftFromPolicy(policy) : null),
    [policy],
  );

  const dirty =
    draft != null &&
    baseline != null &&
    JSON.stringify(policyConfigFromDraft(draft)) !==
      JSON.stringify(policyConfigFromDraft(baseline));

  const nameValid = Boolean(draft?.name.trim());

  async function handleSave() {
    if (!draft || !nameValid) {
      setError(t("policies.validation.nameRequired"));
      return;
    }
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("policies.saveError"),
      );
    }
  }

  function toggleAgent(agentId: string) {
    setDraft((d) => {
      if (!d) return d;
      const has = d.agentIds.includes(agentId);
      return {
        ...d,
        agentIds: has
          ? d.agentIds.filter((id) => id !== agentId)
          : [...d.agentIds, agentId],
      };
    });
  }

  if (!policy || !draft) {
    return (
      <DetailPanelShell
        open={open}
        onClose={onClose}
        title={t("policies.detailTitle")}
        mobileDrawer={mobileDrawer}
      >
        <p className="text-sm text-[var(--text-muted)]">
          {t("policies.selectPrompt")}
        </p>
      </DetailPanelShell>
    );
  }

  return (
    <DetailPanelShell
      open={open}
      onClose={onClose}
      title={draft.name || t("policies.detailTitle")}
      mobileDrawer={mobileDrawer}
      headerActions={
        <CodeChip size="sm" data-testid="guardrails-policy-id">
          {policy.policy_id}
        </CodeChip>
      }
    >
      <div className="space-y-4" data-testid="guardrails-policy-editor">
        <p className="text-sm text-[var(--text-muted)]">{t("banner")}</p>

        <div className="space-y-1">
          <label className="text-sm text-[var(--text-muted)]" htmlFor="edit-name">
            {t("policies.fields.name")}
          </label>
          <Input
            id="edit-name"
            value={draft.name}
            disabled={!canMutate}
            onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
            className="min-h-11"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-[var(--text-muted)]" htmlFor="edit-desc">
            {t("policies.fields.description")}
          </label>
          <Textarea
            id="edit-desc"
            value={draft.description}
            disabled={!canMutate}
            onChange={(e) =>
              setDraft((d) => (d ? { ...d, description: e.target.value } : d))
            }
            rows={2}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm text-[var(--text-muted)]">
              {t("policies.fields.kind")}
            </label>
            <Select
              value={draft.kind}
              disabled={!canMutate}
              onValueChange={(v) =>
                setDraft((d) => (d ? { ...d, kind: v } : d))
              }
            >
              <SelectTrigger className="min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POLICY_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`policies.kinds.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-[var(--text-muted)]">
              {t("policies.fields.severity")}
            </label>
            <Select
              value={draft.action}
              disabled={!canMutate}
              onValueChange={(v) =>
                setDraft((d) =>
                  d ? { ...d, action: v as GuardrailsSeverity } : d,
                )
              }
            >
              <SelectTrigger className="min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GUARDRAILS_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`severity.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={draft.enabled ? "success" : "secondary"}>
            {draft.enabled
              ? t("policies.status.enabled")
              : t("policies.status.disabled")}
          </Badge>
          {canMutate ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11"
              onClick={() =>
                setDraft((d) => (d ? { ...d, enabled: !d.enabled } : d))
              }
            >
              {draft.enabled
                ? t("policies.disable")
                : t("policies.enable")}
            </Button>
          ) : null}
        </div>

        <div className="space-y-1">
          <label className="text-sm text-[var(--text-muted)]" htmlFor="edit-rules">
            {t("policies.fields.rules")}
          </label>
          <Textarea
            id="edit-rules"
            value={draft.rulesText}
            disabled={!canMutate}
            onChange={(e) =>
              setDraft((d) => (d ? { ...d, rulesText: e.target.value } : d))
            }
            rows={5}
            placeholder={t("policies.rulesPlaceholder")}
            className="font-mono text-sm"
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            {t("policies.attachAgents")}
          </p>
          {agents.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              {t("policies.noAgents")}
            </p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto">
              {agents.map((agent) => {
                const checked = draft.agentIds.includes(agent.agent_id);
                return (
                  <li key={agent.agent_id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-[var(--accent-faint)]">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canMutate}
                        onChange={() => toggleAgent(agent.agent_id)}
                        className="h-4 w-4"
                      />
                      <span className="text-sm">{agent.name}</span>
                      <CodeChip size="sm">{agent.agent_id}</CodeChip>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="space-y-1">
          <label
            className="text-sm text-[var(--text-muted)]"
            htmlFor="edit-routes"
          >
            {t("policies.attachGateway")}
          </label>
          <Textarea
            id="edit-routes"
            value={draft.gatewayRoutes}
            disabled={!canMutate}
            onChange={(e) =>
              setDraft((d) =>
                d ? { ...d, gatewayRoutes: e.target.value } : d,
              )
            }
            rows={2}
            placeholder={t("policies.gatewayPlaceholder")}
            className="font-mono text-sm"
          />
        </div>

        {error ? (
          <p className="text-sm text-[var(--error)]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-3">
          {canMutate ? (
            <Button
              type="button"
              className="min-h-11"
              disabled={!dirty || !nameValid || pending}
              onClick={() => void handleSave()}
              data-testid="guardrails-save-policy"
            >
              {pending ? t("policies.saving") : t("policies.save")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            onClick={() => onViewViolations(policy.policy_id)}
            data-testid="guardrails-view-violations"
          >
            {t("policies.viewViolations")}
          </Button>
          {draft.agentIds[0] ? (
            <Button asChild type="button" variant="ghost" className="min-h-11">
              <Link href={`/agents/${encodeURIComponent(draft.agentIds[0])}`}>
                {t("policies.openAgent")}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </DetailPanelShell>
  );
}
