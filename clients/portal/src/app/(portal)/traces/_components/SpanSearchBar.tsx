"use client";

/**
 * SpanSearchBar — N10 deep search + save-as-signal with cost preview.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search, Loader2, BookmarkPlus, Bell } from "lucide-react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { suggestQueryCompletions } from "@/lib/query-language";

interface SpanSearchBarProps {
  orgId: string;
  onSelectTrace: (traceId: string) => void;
}

export function SpanSearchBar({ orgId, onSelectTrace }: SpanSearchBarProps) {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [costEstimate, setCostEstimate] = useState<number | null>(null);
  const [hits, setHits] = useState<
    Array<{ trace_id: string; span_id?: string; snippet?: string; score?: number }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [isFallback, setIsFallback] = useState(false);
  const [activeHit, setActiveHit] = useState(0);

  const suggestions = q.trim().length > 0 && q.trim().length < 24 ? suggestQueryCompletions(q) : [];

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setError(null);
      setCostEstimate(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      api
        .searchSpans(orgId, { q: term, per_page: 8 })
        .then((res) => {
          if (cancelled) return;
          setHits(
            (res.hits ?? []).map((h) => ({
              trace_id: h.trace_id,
              span_id: h.span_id,
              snippet: h.snippet ?? h.preview ?? h.name,
              score: h.score,
            })),
          );
          setIsFallback(res.fallback === true);
          setError(null);
          setActiveHit(0);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setHits([]);
          setIsFallback(false);
          setError(e instanceof Error ? e.message : "Search failed");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [orgId, q]);

  const traceIds = Array.from(new Set(hits.map((h) => h.trace_id)));

  const previewCost = async () => {
    const term = q.trim();
    if (!term || traceIds.length === 0) return;
    setPreviewing(true);
    try {
      const res = await api.previewSearchAsSignal(orgId, {
        search_query: term,
        trace_ids: traceIds,
        mode: traceIds.length >= 50 ? "classifier" : "investigator",
      });
      setCostEstimate(res.data.estimated_backfill_cost_usd ?? null);
    } catch {
      setCostEstimate(null);
    } finally {
      setPreviewing(false);
    }
  };

  const saveAsSignal = async () => {
    const term = q.trim();
    if (!term || traceIds.length === 0) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await previewCost();
      const res = await api.saveSearchAsSignal(orgId, {
        search_query: term,
        trace_ids: traceIds,
        mode: traceIds.length >= 50 ? "classifier" : "investigator",
      });
      setSaveMsg(`Signal created (${res.data.signal_id.slice(0, 8)}…) — see Signals library`);
    } catch (e: unknown) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-muted)]" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (hits.length === 0) return;
            if (e.key === "j" || e.key === "ArrowDown") {
              e.preventDefault();
              setActiveHit((i) => Math.min(i + 1, hits.length - 1));
            } else if (e.key === "k" || e.key === "ArrowUp") {
              e.preventDefault();
              setActiveHit((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && hits[activeHit]) {
              e.preventDefault();
              onSelectTrace(hits[activeHit].trace_id);
              setQ("");
              setHits([]);
            }
          }}
          placeholder="Search spans (agent: status: text:…)"
          aria-label="Search spans"
          className="pl-8"
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
        )}
      </div>
      {suggestions.length > 0 && hits.length === 0 && (
        <ul className="rounded border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] text-2xs">
          {suggestions.slice(0, 5).map((s) => (
            <li key={s.label}>
              <button
                type="button"
                className="w-full px-2 py-1 text-left hover:bg-[var(--bg-tertiary)]"
                onClick={() => setQ(s.insert)}
              >
                <span className="font-mono text-[var(--accent)]">{s.label}</span>
                <span className="ml-2 text-[var(--text-muted)]">{s.docs}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-2xs text-[var(--error)]">{error}</p>}
      {isFallback && !error && (
        <p className="text-2xs text-[var(--text-muted)] italic">
          Search index offline — results may be incomplete
        </p>
      )}
      {hits.length > 0 && q.trim().length >= 2 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-2xs text-[var(--text-muted)]">
            {traceIds.length} trace{traceIds.length === 1 ? "" : "s"} · j/k to navigate
            {costEstimate != null && (
              <span className="ml-2 font-mono">~${costEstimate.toFixed(4)} backfill</span>
            )}
          </p>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-2xs"
              disabled={previewing}
              onClick={() => void previewCost()}
            >
              {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : "Estimate cost"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-2xs"
              disabled={saving}
              onClick={() => void saveAsSignal()}
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <BookmarkPlus className="h-3 w-3" />
              )}
              <span className="ml-1">Save as signal</span>
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-2xs" asChild>
              <Link href={`/alerts?tab=rules&q=${encodeURIComponent(q)}`}>
                <Bell className="h-3 w-3 mr-1" />
                Alert
              </Link>
            </Button>
          </div>
        </div>
      )}
      {saveMsg && (
        <p className="text-2xs text-[var(--text-muted)]">
          {saveMsg}{" "}
          <Link href="/alerts?tab=signals" className="text-[var(--accent)] hover:underline">
            Open signals
          </Link>
        </p>
      )}
      {hits.length > 0 && (
        <ul
          className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] divide-y divide-[var(--border-subtle)] max-h-56 overflow-y-auto"
          role="listbox"
          aria-label="Span search results"
        >
          {hits.map((h, i) => (
            <li key={`${h.trace_id}-${h.span_id ?? ""}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeHit}
                className={`w-full text-left px-3 py-2 hover:bg-[var(--bg-tertiary)] ${
                  i === activeHit ? "bg-[var(--bg-tertiary)]" : ""
                }`}
                onClick={() => {
                  onSelectTrace(h.trace_id);
                  setQ("");
                  setHits([]);
                }}
              >
                <p className="font-mono text-2xs text-[var(--text-primary)]">
                  {h.trace_id.slice(0, 20)}…
                </p>
                {h.snippet && (
                  <p className="text-2xs text-[var(--text-muted)] truncate">{h.snippet}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
