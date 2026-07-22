"use client";

import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";

export type ExperimentDiffToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
};

export function ExperimentDiffToggle({
  checked,
  onChange,
  disabled = false,
}: ExperimentDiffToggleProps) {
  const t = useTranslations("evals");

  return (
    <Switch
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      label={t("compare.diff")}
      aria-label={t("compare.diff")}
      data-testid="experiment-diff-toggle"
    />
  );
}
