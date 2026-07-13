"use client";

/**
 * SpanSearchBar — N10 deep search client for /observability/spans/search.
 */

import { useEffect, useState } from "react";
import { Search, Loader2, BookmarkPlus } from "lucide-react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface SpanSearchBarProps {
  orgId: string;
  onSelectTrace: (traceId: string) => void;
}

export function SpanSearchBar({ orgId, onSelectTrace }: SpanSearchBarProps) {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [hits, setHits] = useState<
    Array<{ trace_id: string; span_id?: string; snippet?: string; score?: number }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setError(null);
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
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setHits([]);
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

  const saveAsSignal = async () => {
    const term = q.trim();
    if (!term || traceIds.length === 0) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await api.saveSearchAsSignal(orgId, {
        search_query: term,
        trace_ids: traceIds,
        mode: traceIds.length >= 50 ? "classifier" : "investigator",
      });
      setSaveMsg(`Signal created (${res.data.signal_id.slice(0, 8)}…)`);
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
          placeholder="Search spans (input, tools, agent id)…"
          aria-label="Search spans"
          className="pl-8"
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
        )}
      </div>
      {error && (
        <p className="text-[11px] text-[var(--error)]">{error}</p>
      )}
      {hits.length > 0 && q.trim().length >= 2 && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] text-[var(--text-muted)]">
            {traceIds.length} trace{traceIds.length === 1 ? "" : "s"} in results
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
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
        </div>
      )}
      {saveMsg && (
        <p className="text-[11px] text-[var(--text-muted)]">{saveMsg}</p>
      )}
      {hits.length > 0 && (
        <ul
          className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] divide-y divide-[var(--border-subtle)] max-h-56 overflow-y-auto"
          role="listbox"
          aria-label="Span search results"
        >
          {hits.map((h) => (
            <li key={`${h.trace_id}-${h.span_id ?? ""}`}>
              <button
                type="button"
                role="option"
                className="w-full text-left px-3 py-2 hover:bg-[var(--bg-tertiary)]"
                onClick={() => {
                  onSelectTrace(h.trace_id);
                  setQ("");
                  setHits([]);
                }}
              >
                <p className="font-mono text-[11px] text-[var(--text-primary)]">
                  {h.trace_id.slice(0, 20)}…
                </p>
                {h.snippet && (
                  <p className="text-[10px] text-[var(--text-muted)] truncate">
                    {h.snippet}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
