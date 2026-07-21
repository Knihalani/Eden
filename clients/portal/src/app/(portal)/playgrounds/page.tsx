"use client";

import { Suspense } from "react";
import Link from "next/link";
import { FlaskConical, Play, Loader2, ArrowUpRight, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { CoreResourcePage } from "@/components/portal-os";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RunMatrixResults, WAVE_E3_MATRIX_COMPLETED } from "./_components/run-matrix";
import {
  usePlaygroundsPage,
  WAVE_E3_PLAYGROUNDS_COMPLETED,
  WAVE_E3_FROM_SPAN_COMPLETED,
  WAVE_E3_PROMOTE_COMPARE_READY,
} from "./_components/use-playgrounds-page";

void WAVE_E3_PLAYGROUNDS_COMPLETED;
void WAVE_E3_FROM_SPAN_COMPLETED;
void WAVE_E3_PROMOTE_COMPARE_READY;
void WAVE_E3_MATRIX_COMPLETED;

function PlaygroundsInner() {
  const {
    currentOrg,
    embedded,
    loading,
    listError,
    playgrounds,
    datasets,
    load,
    active,
    setActive,
    userPrompt,
    setUserPrompt,
    busy,
    run,
    fromProduction,
    dismissFromProduction,
    createNew,
    bindDataset,
    createAndBindDataset,
    runMatrix,
    promote,
    boundDatasetId,
    canPromote,
    canRun,
    runDisabledReason,
    promoteDisabledReason,
  } = usePlaygroundsPage();

  if (!currentOrg) return <NoOrgState feature="Playground" />;

  const primaryActions =
    !loading && !listError && playgrounds.length === 0 ? null : (
      <>
        <Button
          variant="outline"
          className="h-8 min-h-11 md:min-h-8"
          onClick={createNew}
          disabled={busy}
          loading={busy}
          data-wave-e3-cta="new"
        >
          New playground
        </Button>
        {!embedded ? (
          <Button asChild variant="ghost" className="hidden h-8 sm:inline-flex">
            <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
              Docs quickstart
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </Button>
        ) : null}
      </>
    );

  return (
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          eyebrow="Evaluate"
          title="Prompt playground"
          subtitle="Compare prompts side-by-side, bind a dataset, then promote to an offline experiment."
          icon={FlaskConical}
          actions={primaryActions}
          embedded={embedded}
        />
      }
      table={
        <div
          data-wave-e1-embed="playgrounds"
          data-wave-e3-playgrounds="shell"
          data-wave11-mobile="cards"
          data-wave-e6-keyboard="playgrounds"
          data-wave-e6-perf="playgrounds"
        >
          {!embedded ? (
            <p className="mb-space-4 text-sm text-[var(--text-muted)]">
              Offline Evaluate only.{" "}
              <Link
                href="/evals?tab=datasets"
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Datasets
              </Link>
              {" · "}
              <Link
                href="/evals?tab=experiments"
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Experiments
              </Link>
              .
            </p>
          ) : null}

          {fromProduction ? (
            <div
              className="mb-space-3 inline-flex flex-wrap items-center gap-2 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)]"
              data-wave-e1-from-production="chip"
              data-wave-e3-from-production="chip"
              data-testid="playground-from-production"
            >
              <span className="font-medium text-[var(--accent)]">From production</span>
              <span className="font-mono text-[var(--text-muted)]">
                {fromProduction.traceId.slice(0, 12)}…
                {fromProduction.spanId
                  ? ` · span ${fromProduction.spanId.slice(0, 8)}…`
                  : null}
              </span>
              <Link
                href={`/traces?traceId=${encodeURIComponent(fromProduction.traceId)}`}
                className="text-[var(--accent)] underline-offset-2 hover:underline"
                data-wave-e3-from-production="trace-link"
              >
                View trace
              </Link>
              <button
                type="button"
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={dismissFromProduction}
                aria-label="Dismiss from-production chip"
              >
                Dismiss
              </button>
            </div>
          ) : null}

          <QueryState
            loading={loading}
            error={listError ? new Error(listError) : null}
            data={playgrounds}
            onRetry={() => void load()}
            errorTitle="Could not load playgrounds"
            isEmpty={(rows) => rows.length === 0}
            emptySlot={
              <EmptyState
                icon={FlaskConical}
                title="No playgrounds yet"
                description={U20_EMPTY_COPY.playground}
                variant="plain"
                className="mb-space-4"
                action={
                  <div
                    className="flex flex-wrap items-center justify-center gap-2"
                    data-wave-e1-empty="playgrounds"
                    data-wave-e3-empty="playgrounds"
                  >
                    <Button className="h-8 min-h-11 md:min-h-8" onClick={createNew} disabled={busy}>
                      Create playground
                    </Button>
                    <Button asChild className="h-8 min-h-11 md:min-h-8" variant="outline">
                      <Link href="/traces">From traces</Link>
                    </Button>
                    <Button asChild className="h-8 min-h-11 md:min-h-8" variant="ghost">
                      <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                        Docs <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      </a>
                    </Button>
                  </div>
                }
              />
            }
          >
            {(rows) => (
              <>
                <div
                  className="mb-space-3 flex flex-wrap gap-2"
                  role="group"
                  aria-label="Saved playgrounds"
                  data-wave-e3-playgrounds="switcher"
                  data-wave11-mobile="cards"
                  data-wave-e6-keyboard="playgrounds"
                >
                  {rows.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setActive(p)}
                      aria-pressed={active?.id === p.id}
                      className={`h-8 min-h-11 rounded border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] md:min-h-8 ${
                        active?.id === p.id
                          ? "border-[var(--accent)] text-[var(--accent)]"
                          : "border-[var(--border-default)] text-[var(--text-muted)]"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>

                {active ? (
                  <div
                    className="mb-space-4 space-y-space-3 border-y border-[var(--border-subtle)] py-space-4"
                    data-wave-e3-playgrounds="editor"
                  >
                    <FormField label="User message" htmlFor="pg-user">
                      <Textarea
                        id="pg-user"
                        className="mt-1 min-h-[100px]"
                        value={userPrompt}
                        onChange={(e) => setUserPrompt(e.target.value)}
                        placeholder="Paste span input or draft prompt…"
                      />
                    </FormField>
                    <FormField label="Bind dataset" htmlFor="pg-ds">
                      <Select
                        value={boundDatasetId || "none"}
                        onValueChange={(v) => void bindDataset(v === "none" ? "" : v)}
                      >
                        <SelectTrigger
                          id="pg-ds"
                          className="mt-1 h-8 min-h-11 md:min-h-8"
                          data-wave-e3-dataset-bind="select"
                        >
                          <SelectValue placeholder="None (adhoc run)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None (adhoc run)</SelectItem>
                          {datasets.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
                        <button
                          type="button"
                          className="min-h-11 text-[var(--accent)] underline-offset-2 hover:underline disabled:opacity-50 md:min-h-8"
                          disabled={busy || !active}
                          onClick={() => void createAndBindDataset()}
                        >
                          Create dataset
                        </button>
                        <Link
                          href="/evals?tab=datasets"
                          className="inline-flex min-h-11 items-center text-[var(--accent)] underline-offset-2 hover:underline md:min-h-8"
                        >
                          Upload / manage
                        </Link>
                      </div>
                      {!boundDatasetId ? (
                        <p
                          className="mt-1 text-xs text-[var(--text-muted)]"
                          data-wave-e3-dataset-bind="unbound"
                        >
                          Bind a dataset to promote an immutable experiment. Adhoc runs stay mutable.
                        </p>
                      ) : null}
                    </FormField>
                    <div
                      className="flex flex-wrap items-center gap-2"
                      data-wave-e3-cta="hierarchy"
                    >
                      <span title={runDisabledReason} className="inline-flex">
                        <Button
                          className="h-8 min-h-11 md:min-h-8"
                          onClick={runMatrix}
                          disabled={busy || !canRun}
                          loading={busy}
                          aria-disabled={busy || !canRun}
                          aria-describedby={!canRun ? "pg-run-reason" : undefined}
                          data-testid="playground-run-cta"
                          data-wave-e3-cta="run"
                        >
                          <Play className="h-3.5 w-3.5" /> Run
                        </Button>
                      </span>
                      <span title={promoteDisabledReason} className="inline-flex">
                        <Button
                          className="h-8 min-h-11 md:min-h-8"
                          variant="outline"
                          onClick={promote}
                          disabled={busy || !canPromote}
                          aria-disabled={busy || !canPromote}
                          aria-describedby={!canPromote ? "pg-promote-reason" : undefined}
                          data-wave-e3-cta="promote"
                          data-wave-e3-promote="compare-ready"
                        >
                          <ArrowUpRight className="h-3.5 w-3.5" /> Promote → experiment
                        </Button>
                      </span>
                    </div>
                    {!canRun ? (
                      <p id="pg-run-reason" className="text-xs text-[var(--text-muted)]">
                        {runDisabledReason}
                      </p>
                    ) : null}
                    {!canPromote ? (
                      <p id="pg-promote-reason" className="text-xs text-[var(--text-muted)]">
                        {promoteDisabledReason}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {run ? <RunMatrixResults run={run} /> : null}
              </>
            )}
          </QueryState>
        </div>
      }
    />
  );
}

export default function PlaygroundsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <PlaygroundsInner />
    </Suspense>
  );
}
