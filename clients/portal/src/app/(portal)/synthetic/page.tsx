"use client";

import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { qaApi, type GenerateQAResponse, type QATriple } from "@/lib/api";

export default function SyntheticPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const [text, setText] = useState("");
  const [qaPerChunk, setQaPerChunk] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<GenerateQAResponse | null>(null);

  const {
    data: runsMeta,
    isLoading: loading,
    error,
    refetch,
  } = useOrgQuery(
    queryKeys.synthetic.runs(orgId),
    orgId,
    async () => {
      const res = await qaApi.listRuns(orgId!);
      return { runs: res.runs || [], detail: res.detail, total: res.total };
    },
  );

  if (!currentOrg) return <NoOrgState feature="Synthetic Q/A" />;

  const submit = async () => {
    if (!text.trim() || !orgId) return;
    setSubmitting(true);
    try {
      const result = await qaApi.generate(orgId, {
        text: text.trim(),
        qa_per_chunk: qaPerChunk,
      });
      setLastResult(result);
      toast.success(`Generated ${result.triple_count} Q/A triple${result.triple_count === 1 ? "" : "s"}`);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate Q/A");
    } finally {
      setSubmitting(false);
    }
  };

  const triples: QATriple[] = lastResult?.triples ?? [];
  const historyDetail = runsMeta?.detail;

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Eval"
        title="Synthetic Q/A"
        subtitle="Live generator — paste source text and get extractive Q/A triples inline. Saved run history is not persisted yet."
        icon={Sparkles}
        actions={
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            disabled={loading}
            loading={loading}
            aria-label="Refresh runs"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      <Card className="p-4 space-y-3">
        <Textarea
          placeholder="Paste source text (docs, markdown, or plain prose). The generator chunks it and emits extractive Q/A triples."
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-[120px] font-mono text-sm"
          aria-label="Source text for Q/A generation"
          disabled={submitting}
        />
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <label className="text-xs text-[var(--text-muted)] whitespace-nowrap" htmlFor="qa-per-chunk">
            Q/A per chunk
          </label>
          <Input
            id="qa-per-chunk"
            type="number"
            min={1}
            max={20}
            value={qaPerChunk}
            onChange={(e) => setQaPerChunk(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className="w-24"
            aria-label="Number of Q/A triples per chunk"
            disabled={submitting}
          />
          <Button
            onClick={submit}
            disabled={!text.trim() || submitting}
            loading={submitting}
            aria-label="Generate synthetic Q/A pairs"
            className="sm:ml-auto"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {submitting ? "Generating…" : "Generate"}
          </Button>
        </div>
      </Card>

      {lastResult && (
        <Card className="p-2">
          <div className="px-2 py-1.5 text-xs text-[var(--text-muted)]">
            Last run <span className="font-mono">{lastResult.run_id}</span>
            {" · "}
            {lastResult.triple_count} triples · {lastResult.qa_type} · {lastResult.locale}
          </div>
          <DataTable
            rows={triples}
            rowKey={(r) => r.id}
            emptyTitle="No triples in last result"
            emptyDescription="Try longer source text or raise Q/A per chunk."
            emptyIcon={Sparkles}
            columns={[
              { key: "question", header: "Question", cell: (r) => <span className="text-sm">{r.question}</span> },
              { key: "answer", header: "Answer", cell: (r) => <span className="text-sm text-[var(--text-muted)]">{r.answer}</span> },
              { key: "difficulty", header: "Diff", align: "right", sortable: true },
            ]}
          />
        </Card>
      )}

      {error ? (
        <ErrorState
          title="Could not load run history"
          message={error.message}
          action={
            <Button onClick={() => refetch()} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : (
        <Card className="p-2" data-testid="synthetic-runs-table">
          <div className="px-2 py-1.5 text-xs text-[var(--text-muted)]">
            {historyDetail
              ? historyDetail
              : "Saved run history is empty until persistence ships."}
          </div>
          <DataTable
            loading={loading}
            rows={runsMeta?.runs ?? []}
            rowKey={(r) => r.id}
            emptyTitle="No saved runs yet"
            emptyDescription="Generation returns triples above. Persisted run history is deferred."
            emptyIcon={Sparkles}
            columns={[
              { key: "id", header: "Run", cell: (r) => <span className="font-mono text-xs">{r.id}</span> },
              { key: "topic", header: "Topic", sortable: true },
              { key: "count", header: "Count", align: "right", sortable: true },
              { key: "status", header: "Status" },
              { key: "created_at", header: "Created", sortable: true, cell: (r) => new Date(r.created_at).toLocaleString() },
            ]}
          />
        </Card>
      )}
    
    </PageContent>
  );
}
