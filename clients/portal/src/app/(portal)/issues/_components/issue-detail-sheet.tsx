"use client";

import { useTranslations } from "next-intl";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  IssueDetailBody,
  type IssueDetailBodyProps,
} from "./issue-detail-panel";

type Props = IssueDetailBodyProps & {
  open: boolean;
  onClose: () => void;
};

/** <1280 detail — Sheet preserves list mount under ResourcePageShell. */
export function IssueDetailSheet({ open, onClose, ...bodyProps }: Props) {
  const t = useTranslations("issues.detail");

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full max-w-lg overflow-y-auto xl:hidden"
        data-testid="issue-detail-sheet"
      >
        <SheetHeader>
          <SheetTitle>
            {bodyProps.issue?.title ?? t("panelTitle")}
          </SheetTitle>
        </SheetHeader>
        <IssueDetailBody {...bodyProps} />
      </SheetContent>
    </Sheet>
  );
}
