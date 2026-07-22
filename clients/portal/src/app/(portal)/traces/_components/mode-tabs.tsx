"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OBSERVE_MODES, type ObserveMode } from "@/lib/observe-url";

type Props = {
  mode: ObserveMode;
  onModeChange: (mode: ObserveMode) => void;
};

export function ModeTabs({ mode, onModeChange }: Props) {
  const t = useTranslations("traces.modes");

  return (
    <Tabs
      value={mode}
      onValueChange={(v) => onModeChange(v as ObserveMode)}
      data-testid="trace-mode-tabs"
    >
      <TabsList
        variant="underline"
        aria-label={t("label")}
        className="h-auto w-full justify-start gap-space-2 overflow-x-auto rounded-none bg-transparent"
      >
        {OBSERVE_MODES.map((m, i) => (
          <TabsTrigger
            key={m}
            value={m}
            variant="underline"
            className="min-h-11 whitespace-nowrap px-space-3 text-xs"
            data-mode={m}
            title={`${i + 1}`}
          >
            {t(m)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
