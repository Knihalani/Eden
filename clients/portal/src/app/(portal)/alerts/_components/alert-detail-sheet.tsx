"use client";

import { useTranslations } from "next-intl";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AlertRow } from "./alert-types";
import { AlertDetailPanel } from "./alert-detail-panel";

type Props = {
  open: boolean;
  alert: AlertRow | null;
  searchParams: URLSearchParams;
  onClose: () => void;
  onAcknowledge: (alertId: string) => void;
  acknowledging?: boolean;
  ackError?: string | null;
};

/** Mobile / &lt;1280 list → sheet detail for inbox selection. */
export function AlertDetailSheet({
  open,
  alert,
  searchParams,
  onClose,
  onAcknowledge,
  acknowledging,
  ackError,
}: Props) {
  const t = useTranslations("alerts");

  return (
    <Sheet
      open={open && Boolean(alert)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full max-w-lg overflow-y-auto p-0 xl:hidden"
        data-testid="alert-detail-sheet"
      >
        <SheetHeader className="border-b border-[var(--border-subtle)] px-4 py-3">
          <SheetTitle className="truncate text-left text-sm font-medium">
            {alert?.title ?? t("detail.sheetTitle")}
          </SheetTitle>
        </SheetHeader>
        {alert ? (
          <AlertDetailPanel
            alert={alert}
            searchParams={searchParams}
            onAcknowledge={onAcknowledge}
            acknowledging={acknowledging}
            ackError={ackError}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
