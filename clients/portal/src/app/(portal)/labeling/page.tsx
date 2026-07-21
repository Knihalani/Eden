"use client";

import Link from "next/link";
import { Tag as TagIcon, RefreshCw, Plus, ChevronDown } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { DataTableSearch } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLabelingPage } from "./_components/use-labeling-page";
import { LabelingQueuesSection } from "./_components/labeling-queues-section";
import { LabelingItemsTable } from "./_components/labeling-items-table";
import { LabelingReviewDialog } from "./_components/labeling-review-dialog";

export default function LabelingPage() {
  const page = useLabelingPage();

  if (!page.currentOrg) return <NoOrgState feature="Labeling queue" />;

  return (
    <PageContent size="wide">
      <div data-wave-e1-embed="labeling" data-wave-e5-labeling="list" className="contents">
        <PageHeader
          eyebrow="Eval"
          title="Labeling queue"
          subtitle="Approve or skip items — annotations feed datasets."
          icon={TagIcon}
          embedded={page.embedded}
          actions={
            <>
              <div className="hidden min-w-[12rem] sm:block">
                <DataTableSearch
                  value={page.filter}
                  onChange={page.setFilter}
                  placeholder="Filter by prompt or tag"
                />
              </div>
              <Button
                onClick={page.load}
                variant="outline"
                className="h-8 max-md:min-h-11"
                disabled={page.loading}
                loading={page.loading}
                aria-label="Refresh labeling queue"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-8 max-md:min-h-11"
                    aria-label="More labeling actions"
                  >
                    More
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void page.seedItem()}>
                    <Plus className="h-3.5 w-3.5" /> Seed item
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/evals?tab=datasets">Open datasets</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />

        <LabelingQueuesSection
          queues={page.queues}
          queuesLoading={page.queuesLoading}
          queuesError={page.queuesError}
          onRetry={() => void page.queuesQuery.refetch()}
          creatingQueue={page.creatingQueue}
          pushingQueueId={page.pushingQueueId}
          onCreateQueue={page.createQueue}
          onPushToDataset={page.pushQueueToDataset}
        />

        <div className="mb-space-3 sm:hidden">
          <DataTableSearch
            value={page.filter}
            onChange={page.setFilter}
            placeholder="Filter by prompt or tag"
          />
        </div>

        <LabelingItemsTable
          items={page.items}
          filtered={page.filtered}
          loading={page.loading}
          error={page.error}
          filter={page.filter}
          filterActive={page.filterActive}
          filterMiss={page.filterMiss}
          submitting={page.submitting}
          creatingQueue={page.creatingQueue}
          onRetry={page.load}
          onClearFilter={() => page.setFilter("")}
          onOpenReview={page.openReview}
          onSkip={page.handleSkip}
          onSeedItem={page.seedItem}
          onCreateQueue={page.createQueue}
        />

        <LabelingReviewDialog
          reviewItem={page.reviewItem}
          label={page.label}
          notes={page.notes}
          submitting={page.submitting}
          onLabelChange={page.setLabel}
          onNotesChange={page.setNotes}
          onClose={page.closeReview}
          onAnnotate={page.handleAnnotate}
          onSkip={page.handleSkip}
        />
      </div>
    </PageContent>
  );
}
