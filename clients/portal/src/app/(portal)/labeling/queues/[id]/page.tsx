"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Columns3, Keyboard, RefreshCw, Database } from "lucide-react";
import { PageContent } from "@/components/layout/page-content";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { labelingQueuesApi, labelingApi, datasetsApi } from "@/lib/api";

type BoardItem = {
  id: string;
  prompt?: string;
  kanban_status?: string;
  tags?: string[];
  payload?: Record<string, unknown>;
};

const HOTKEY_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export default function LabelingQueueBoardPage() {
  const { id: queueId } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [board, setBoard] = useState<Record<string, BoardItem[]>>({});
  const [schema, setSchema] = useState<Record<string, unknown>>({});
  const [iaa, setIaa] = useState<{ kappa: number; n: number; agreement_rate: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [showCheat, setShowCheat] = useState(false);

  const labels = useMemo(() => {
    if (String(schema.type || "") === "pairwise") {
      return ["left", "right", "tie"];
    }
    const fromSchema = (schema.labels as string[] | undefined) || [];
    if (fromSchema.length) return fromSchema.slice(0, 9);
    return ["good", "bad", "unclear"];
  }, [schema]);

  const queue = useMemo(() => {
    const todo = board.todo || [];
    const progress = board.in_progress || [];
    return [...progress, ...todo];
  }, [board]);

  const active = queue.find((i) => i.id === activeId) || queue[0] || null;

  const load = useCallback(async () => {
    if (!currentOrg?.id || !queueId) return;
    setLoading(true);
    try {
      const [boardRes, queueRes, iaaRes] = await Promise.all([
        labelingQueuesApi.board(currentOrg.id, queueId),
        labelingQueuesApi.get(currentOrg.id, queueId),
        labelingQueuesApi.iaa(currentOrg.id, queueId).catch(() => null),
      ]);
      setBoard((boardRes.board || {}) as Record<string, BoardItem[]>);
      setSchema((queueRes.queue?.schema as Record<string, unknown>) || {});
      if (iaaRes?.iaa) setIaa(iaaRes.iaa);
      const items = [
        ...((boardRes.board?.in_progress as BoardItem[]) || []),
        ...((boardRes.board?.todo as BoardItem[]) || []),
      ];
      if (!activeId && items[0]) setActiveId(items[0].id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load board");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, queueId, toast, activeId]);

  useEffect(() => {
    load();
  }, [currentOrg?.id, queueId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyLabel = async (label: string) => {
    if (!currentOrg?.id || !active) return;
    try {
      await labelingApi.annotate(currentOrg.id, {
        item_id: active.id,
        label,
        notes: notes.trim() || undefined,
      });
      await labelingQueuesApi.move(currentOrg.id, queueId, {
        item_id: active.id,
        status: "done",
      });
      toast.success(`Labeled ${label}`);
      setNotes("");
      const next = queue.find((i) => i.id !== active.id);
      setActiveId(next?.id ?? null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Annotate failed");
    }
  };

  const skip = async () => {
    if (!currentOrg?.id || !active) return;
    try {
      await labelingApi.skip(currentOrg.id, { item_id: active.id });
      await labelingQueuesApi.move(currentOrg.id, queueId, {
        item_id: active.id,
        status: "skipped",
      });
      toast.success("Skipped");
      const next = queue.find((i) => i.id !== active.id);
      setActiveId(next?.id ?? null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Skip failed");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "?") {
        setShowCheat((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && labels[0]) {
        e.preventDefault();
        void applyLabel(labels[0]);
        return;
      }
      const idx = HOTKEY_LABELS.indexOf(e.key as (typeof HOTKEY_LABELS)[number]);
      if (idx >= 0 && labels[idx]) {
        e.preventDefault();
        void applyLabel(labels[idx]);
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        void skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const exportDataset = async () => {
    if (!currentOrg?.id || !queueId) return;
    let target = datasetId.trim();
    try {
      if (!target) {
        const created = await datasetsApi.create(currentOrg.id, {
          name: `Labels · ${queueId.slice(0, 8)}`,
          description: "Exported from labeling queue",
        });
        target = created.id;
      }
      await labelingQueuesApi.pushToDataset(currentOrg.id, queueId, { dataset_id: target });
      toast.success("Pushed done items to dataset");
      window.location.href = `/datasets/${target}`;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    }
  };

  if (!currentOrg) return <NoOrgState feature="Annotation queue" />;

  const transcript =
    String(active?.payload?.transcript || active?.payload?.messages || active?.prompt || "");

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Evaluate"
        title="Labeling workstation"
        subtitle="Transcript · schema labels · hotkeys 1–9 · export to dataset."
        icon={Columns3}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/evals?tab=labeling">
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowCheat((v) => !v)}>
              <Keyboard className="h-3.5 w-3.5" /> Shortcuts
            </Button>
            <Button onClick={load} variant="outline" size="sm" disabled={loading} loading={loading}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </>
        }
      />

      {showCheat ? (
        <Card className="mb-3 p-3 text-xs text-[var(--text-secondary)]">
          <p className="mb-1 font-medium">Hotkeys</p>
          <ul className="list-inside list-disc space-y-0.5">
            {labels.map((l, i) => (
              <li key={l}>
                <kbd>{i + 1}</kbd> → {l}
              </li>
            ))}
            <li>
              <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> → first label
            </li>
            <li>
              <kbd>S</kbd> skip · <kbd>?</kbd> toggle this sheet
            </li>
          </ul>
        </Card>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
        <span>
          Schema: {String(schema.type || "binary")} · labels [{labels.join(", ")}]
        </span>
        {iaa ? (
          <span>
            IAA κ={iaa.kappa} (n={iaa.n}, agree {(iaa.agreement_rate * 100).toFixed(0)}%)
          </span>
        ) : (
          <span>IAA: add dual labels in payload to compute κ</span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-h-[280px] p-4">
          <h3 className="mb-2 text-sm font-medium">Transcript</h3>
          {active ? (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-sm text-[var(--text-secondary)]">
              {transcript || "(empty)"}
            </pre>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">Queue empty — seed items from labeling list.</p>
          )}
        </Card>

        <Card className="space-y-3 p-4">
          <h3 className="text-sm font-medium">Label</h3>
          <FormField label="Notes" htmlFor="label-notes">
            <Input
              id="label-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
            />
          </FormField>
          <div className="flex flex-wrap gap-2">
            {labels.map((l, i) => (
              <Button
                key={l}
                size="sm"
                variant={i === 0 ? "default" : "outline"}
                disabled={!active}
                onClick={() => void applyLabel(l)}
              >
                <span className="mr-1 text-[var(--text-muted)]">{i + 1}</span>
                {l}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={!active} onClick={() => void skip()}>
              Skip (S)
            </Button>
          </div>

          <div className="border-t border-[var(--border-default)] pt-3">
            <FormField label="Export to dataset id (blank = create)" htmlFor="ds-export">
              <div className="flex gap-2">
                <Input
                  id="ds-export"
                  value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)}
                  placeholder="dataset uuid"
                />
                <Button size="sm" onClick={() => void exportDataset()}>
                  <Database className="h-3.5 w-3.5" /> Export
                </Button>
              </div>
            </FormField>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase text-[var(--text-muted)]">Queue</h4>
            <ul className="max-h-40 space-y-1 overflow-auto text-xs">
              {queue.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`w-full truncate rounded px-2 py-1 text-left ${
                      item.id === active?.id
                        ? "bg-[var(--accent-muted)] text-[var(--accent)]"
                        : "hover:bg-[var(--surface-raised)]"
                    }`}
                    onClick={() => setActiveId(item.id)}
                  >
                    {item.prompt || item.id}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </PageContent>
  );
}
