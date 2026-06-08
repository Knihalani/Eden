"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search, Tag, Star, GitFork, ArrowRight, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

interface EnvCardSummary {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  quality_score: number | null;
  quality_band: "low" | "medium" | "high" | null;
  fork_count: number;
  install_count: number;
  is_featured: boolean;
  published_at: string | null;
}

const CATEGORIES = [
  { value: "", label: "All" },
  { value: "coding", label: "Coding" },
  { value: "adversarial", label: "Adversarial" },
  { value: "simulation", label: "Simulation" },
  { value: "multi-agent", label: "Multi-agent" },
];

const QUALITY_BADGE_STYLES: Record<string, string> = {
  high: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30",
  medium: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30",
  low: "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-default)]",
};

export default function MarketplacePage() {
  const { currentOrg } = useOrg();
  const [cards, setCards] = useState<EnvCardSummary[]>([]);
  const [featured, setFeatured] = useState<EnvCardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [quality, setQuality] = useState<"all" | "high" | "medium" | "low">("all");

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params: { q?: string; category?: string; quality?: string } = {};
        if (query) params.q = query;
        if (category) params.category = category;
        if (quality !== "all") params.quality = quality;
        const [list, feat] = await Promise.all([
          api.listMarketplace(params),
          api.listMarketplaceFeatured().catch(() => []),
        ]);
        if (!cancelled) {
          setCards(list || []);
          setFeatured(feat || []);
        }
      } catch (e) {
        console.error("Failed to load marketplace", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentOrg, query, category, quality]);

  if (!currentOrg) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Marketplace"
        description="Create an organization to discover, fork, and contribute environments."
        cta={
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[var(--accent)] text-[var(--bg-base)] px-4 py-2 rounded-lg hover:opacity-90"
          >
            Create Organization
          </Link>
        }
      />
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Marketplace</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Discover, fork, and contribute quality-gated Eden environments.
        </p>
      </div>

      {/* Featured row */}
      {featured.length > 0 && (
        <section aria-labelledby="featured-heading">
          <h2 id="featured-heading" className="text-sm font-mono uppercase tracking-widest text-[var(--text-faint)] mb-3">
            Featured
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {featured.map((card) => (
              <CardTile key={card.id} card={card} featured />
            ))}
          </div>
        </section>
      )}

      {/* Search + filters */}
      <section aria-labelledby="browse-heading" className="space-y-3">
        <h2 id="browse-heading" className="text-sm font-mono uppercase tracking-widest text-[var(--text-faint)]">
          Browse
        </h2>
        <div className="flex flex-col lg:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search environments..."
              aria-label="Search marketplace"
              className="w-full pl-9 pr-3 py-2 text-sm bg-[var(--surface)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
            />
          </div>
          <div role="radiogroup" aria-label="Quality filter" className="flex items-center gap-1 p-1 bg-[var(--surface)] border border-[var(--border-default)] rounded-lg">
            {(["all", "high", "medium", "low"] as const).map((q) => (
              <button
                key={q}
                role="radio"
                aria-checked={quality === q}
                onClick={() => setQuality(q)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors min-h-[32px]",
                  quality === q
                    ? "bg-[var(--accent)] text-[var(--bg-base)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                )}
              >
                {q === "all" ? "All quality" : q}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Category">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              role="tab"
              aria-selected={category === cat.value}
              onClick={() => setCategory(cat.value)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-full border transition-colors min-h-[32px]",
                category === cat.value
                  ? "bg-[var(--accent-bg)] text-[var(--accent)] border-[var(--accent)]/40"
                  : "bg-[var(--surface)] text-[var(--text-secondary)] border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]"
              )}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </section>

      {/* Results */}
      <section aria-label="Marketplace results">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="h-40 rounded-xl bg-[var(--surface)] border border-[var(--border-default)] animate-pulse"
                aria-hidden="true"
              />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No environments match your filters"
            description="Try clearing the search or switching to the All category."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {cards.map((card) => (
              <CardTile key={card.id} card={card} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CardTile({ card, featured = false }: { card: EnvCardSummary; featured?: boolean }) {
  const qualityBadge = card.quality_band ? QUALITY_BADGE_STYLES[card.quality_band] : null;
  return (
    <Link
      href={`/marketplace/${card.slug}`}
      className="group block bg-[var(--surface)] border border-[var(--border-default)] rounded-xl p-4 hover:border-[var(--accent)] transition-colors"
      aria-label={`${card.title} — ${card.category}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded">
            {card.category}
          </span>
          {featured && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded bg-[var(--accent-bg)] text-[var(--accent)]">
              <Star className="w-2.5 h-2.5" aria-hidden="true" />
              Featured
            </span>
          )}
        </div>
        {qualityBadge && (
          <span
            className={cn("px-2 py-0.5 text-[10px] font-semibold rounded border", qualityBadge)}
            aria-label={`Quality: ${card.quality_band}`}
          >
            {card.quality_band}
          </span>
        )}
      </div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1 line-clamp-2">{card.title}</h3>
      <p className="text-xs text-[var(--text-secondary)] line-clamp-2 mb-3">{card.summary}</p>
      {card.tags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap mb-3">
          {card.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded"
            >
              <Tag className="w-2.5 h-2.5" aria-hidden="true" />
              {tag}
            </span>
          ))}
          {card.tags.length > 3 && (
            <span className="text-[10px] text-[var(--text-faint)]">+{card.tags.length - 3}</span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <GitFork className="w-3 h-3" aria-hidden="true" />
            {card.fork_count}
          </span>
          {card.quality_score !== null && (
            <span>{Math.round(card.quality_score * 100)}%</span>
          )}
        </div>
        <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" aria-hidden="true" />
      </div>
    </Link>
  );
}
