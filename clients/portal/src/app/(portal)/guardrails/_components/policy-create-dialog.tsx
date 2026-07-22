"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GUARDRAILS_SEVERITIES, type GuardrailsSeverity } from "@/lib/guardrails-url";
import type { PolicyDraft } from "./map-violations";

const POLICY_KINDS = ["content", "pii", "hallucination", "injection"] as const;

const EMPTY_DRAFT: PolicyDraft = {
  name: "",
  description: "",
  kind: "content",
  action: "block",
  enabled: true,
  rulesText: "",
  agentIds: [],
  gatewayRoutes: "",
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: PolicyDraft) => Promise<void>;
  pending?: boolean;
};

export function PolicyCreateDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: Props) {
  const t = useTranslations("guardrails");
  const [draft, setDraft] = useState<PolicyDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const nameValid = draft.name.trim().length > 0;

  async function handleSubmit() {
    if (!nameValid) {
      setError(t("policies.validation.nameRequired"));
      return;
    }
    setError(null);
    try {
      await onSubmit(draft);
      setDraft(EMPTY_DRAFT);
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("policies.createError"),
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setDraft(EMPTY_DRAFT);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="guardrails-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("policies.createTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm text-[var(--text-muted)]" htmlFor="pol-name">
              {t("policies.fields.name")}
            </label>
            <Input
              id="pol-name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className="min-h-11"
              autoFocus
              data-testid="guardrails-create-name"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm text-[var(--text-muted)]" htmlFor="pol-desc">
              {t("policies.fields.description")}
            </label>
            <Textarea
              id="pol-desc"
              value={draft.description}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
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
                onValueChange={(v) => setDraft((d) => ({ ...d, kind: v }))}
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
                onValueChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    action: v as GuardrailsSeverity,
                  }))
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

          {error ? (
            <p className="text-sm text-[var(--error)]" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={!nameValid || pending}
            onClick={() => void handleSubmit()}
            data-testid="guardrails-create-submit"
          >
            {pending ? t("policies.creating") : t("policies.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
