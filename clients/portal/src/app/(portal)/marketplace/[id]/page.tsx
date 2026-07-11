"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Box, GitFork, Tag } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { PageContent, PageLoading } from "@/components/layout/page-content";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";

const QUALITY_BADGE_STYLES: Record<string, string> = {
  high: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30",
  medium: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30",
  low: "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-default)]",
};

export default function MarketplaceDetailPage() {
  const params = useParams<{ id: string }>();
  const cardId = decodeURIComponent(params.id);
  const { currentOrg } = useOrg();
  const [card, setCard] = useState<Awaited<ReturnType<typeof api.getMarketplaceCard>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await api.getMarketplaceCard(cardId);
        if (!cancelled) setCard(data);
      } catch (e) {
        if (!cancelled) {
          setError(errorFromCaught(e, "Failed to load environment"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  if (!currentOrg) {
    return (
      <PageContent size="wide">
        <p className="text-sm text-[var(--text-muted)]">Select an organization to view marketplace environments.</p>
      </PageContent>
    );
  }

  if (loading && !card) {
    return <PageLoading size="wide" message="Loading environment…" />;
  }

  if (error || !card) {
    return (
      <PageContent size="narrow" className="space-y-4">
        <Link
          href="/marketplace"
          className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to marketplace
        </Link>
        <ErrorState title="Environment not found" message={error || "This card may have been removed."} />
      </PageContent>
    );
  }

  const qualityBadge = card.quality_band ? QUALITY_BADGE_STYLES[card.quality_band] : null;

  return (
    <PageContent size="wide" className="space-y-6">
      <Link
        href="/marketplace"
        className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
      >
        <ArrowLeft className="w-3 h-3" />
        Back to marketplace
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded">
              {card.category}
            </span>
            {qualityBadge && card.quality_band && (
              <span className={cn("px-2 py-0.5 text-[10px] font-semibold rounded border", qualityBadge)}>
                {card.quality_band}
              </span>
            )}
          </div>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Box className="w-6 h-6 text-[var(--accent)]" aria-hidden />
            {card.title}
          </h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-3xl">{card.summary}</p>
        </div>
        <Link
          href="/builder"
          className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-[var(--accent)] text-[var(--bg-base)] hover:bg-[var(--accent-hover)] shrink-0"
        >
          Open in Builder
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card padding="lg" className="lg:col-span-2 space-y-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Description</h2>
          <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
            {card.description || card.summary}
          </p>
          {(card.tags ?? []).length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pt-2">
              {(card.tags ?? []).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded"
                >
                  <Tag className="w-3 h-3" aria-hidden />
                  {tag}
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card padding="lg" className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-[var(--text-muted)]">Forks</span>
            <span className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)]">
              <GitFork className="w-4 h-4" aria-hidden />
              {card.fork_count ?? 0}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--text-muted)]">Installs</span>
            <span className="font-medium text-[var(--text-primary)]">{card.install_count ?? 0}</span>
          </div>
          {card.quality_score != null && (
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">Quality score</span>
              <span className="font-medium text-[var(--text-primary)]">
                {Math.round(card.quality_score * 100)}%
              </span>
            </div>
          )}
          {card.license && (
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">License</span>
              <span className="font-mono text-xs text-[var(--text-primary)]">{card.license}</span>
            </div>
          )}
          {card.repository_url && (
            <a
              href={card.repository_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xs text-[var(--accent)] hover:underline truncate"
            >
              Repository
            </a>
          )}
        </Card>
      </div>
    </PageContent>
  );
}
