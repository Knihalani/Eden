"use client";

import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/form-field";

export type PlaygroundEditorValue = {
  system: string;
  user: string;
  model: string;
};

export type PlaygroundEditorProps = {
  value: PlaygroundEditorValue;
  onChange: (next: PlaygroundEditorValue) => void;
  dirty?: boolean;
  canMutate?: boolean;
  running?: boolean;
  promoting?: boolean;
  onRun?: () => void;
  onPromote?: () => void;
  runDisabled?: boolean;
  promoteDisabled?: boolean;
};

export function PlaygroundEditor({
  value,
  onChange,
  dirty = false,
  canMutate = true,
  running = false,
  promoting = false,
  onRun,
  onPromote,
  runDisabled = false,
  promoteDisabled = false,
}: PlaygroundEditorProps) {
  const t = useTranslations("evals");

  function patch(partial: Partial<PlaygroundEditorValue>) {
    onChange({ ...value, ...partial });
  }

  return (
    <div className="space-y-4" data-testid="playground-editor">
      {dirty ? (
        <div data-testid="playground-dirty-banner">
          <Banner tone="warning">{t("playground.dirtyBanner")}</Banner>
        </div>
      ) : null}

      <FormField label={t("playground.system")}>
        <Textarea
          value={value.system}
          onChange={(e) => patch({ system: e.target.value })}
          rows={4}
          disabled={!canMutate}
          data-testid="playground-system"
        />
      </FormField>

      <FormField label={t("playground.user")}>
        <Textarea
          value={value.user}
          onChange={(e) => patch({ user: e.target.value })}
          rows={4}
          disabled={!canMutate}
          data-testid="playground-user"
        />
      </FormField>

      <FormField label={t("playground.model")}>
        <Input
          value={value.model}
          onChange={(e) => patch({ model: e.target.value })}
          disabled={!canMutate}
          data-testid="playground-model"
        />
      </FormField>

      <div className="flex flex-wrap gap-2">
        {canMutate && onRun ? (
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            disabled={runDisabled || running}
            loading={running}
            onClick={onRun}
            data-testid="playground-run"
          >
            {t("playground.run")}
          </Button>
        ) : null}
        {canMutate && onPromote ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-h-11"
            disabled={promoteDisabled || promoting}
            loading={promoting}
            onClick={onPromote}
            data-testid="playground-promote"
          >
            {t("playground.promote")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
