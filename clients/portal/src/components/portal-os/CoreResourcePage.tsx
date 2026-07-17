"use client";

import type { ReactNode } from "react";
import { PageContent, type PageContentProps } from "@/components/layout/page-content";
import { ResourcePageShell } from "./ResourcePageShell";

export interface CoreResourcePageProps {
  size?: PageContentProps["size"];
  className?: string;
  header: ReactNode;
  toolbar?: ReactNode;
  kpiStrip?: ReactNode;
  table: ReactNode;
  detail?: ReactNode;
  bulkBar?: ReactNode;
}

/**
 * U18 migration helper — PageContent + ResourcePageShell on one contract.
 */
export function CoreResourcePage({
  size = "default",
  className,
  header,
  toolbar,
  kpiStrip,
  table,
  detail,
  bulkBar,
}: CoreResourcePageProps) {
  return (
    <PageContent size={size} className={className}>
      <ResourcePageShell
        toolbar={
          <>
            {header}
            {toolbar}
          </>
        }
        kpiStrip={kpiStrip}
        table={table}
        detail={detail}
        bulkBar={bulkBar}
      />
    </PageContent>
  );
}
