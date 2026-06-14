"use client";

/**
 * Visual environment builder (§8.1).
 *
 * Three-column workspace:
 *  - Left rail: block palette (drag-or-click to add).
 *  - Center: React Flow canvas with custom dark-themed nodes.
 *  - Right rail: property inspector + live eden-sim-eval.yaml preview.
 *
 * The "Push & Run" button packages the graph as a tarball,
 * uploads it via ``agentsApi.upload``, triggers a sim run via
 * ``agentsApi.triggerSimRun``, and polls the result into a
 * modal. The full orchestration lives in
 * ``_hooks/useBuilderState.pushAndRun``; the page is a thin
 * shell that wires the pieces together.
 *
 * Auto-save: every change writes the graph to localStorage
 * (debounced 500ms) so refreshes don't wipe work.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  History,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { Inspector } from "./_components/Inspector";
import { Palette } from "./_components/Palette";
import { RunResultsDialog } from "./_components/RunResultsDialog";
import { useBuilderState } from "./_hooks/useBuilderState";
import { deleteSaved, listRecent, lookupAgentId } from "./_lib/storage";
import { loadSavedByName } from "./_lib/storage";
import type { SavedGraphMeta } from "@/lib/types";

// React Flow touches window/document on mount, so we have to
// dynamic-import the canvas with ssr:false.
const Canvas = dynamic(
  () => import("./_components/Canvas").then((m) => m.Canvas),
  { ssr: false, loading: () => <div className="flex-1 bg-zinc-950" /> },
);

export default function BuilderPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();

  const s = useBuilderState();
  const [recent, setRecent] = useState<SavedGraphMeta[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);

  // Refresh the recent list whenever the active graph changes.
  useEffect(() => {
    setRecent(listRecent());
  }, [s.graphName, s.lastSavedAt]);

  const selectedNode = useMemo(
    () => s.nodes.find((n) => n.id === s.selectedNodeId) ?? null,
    [s.nodes, s.selectedNodeId],
  );

  const savingStatus = useMemo(() => {
    if (s.runState.kind === "pushing" || s.runState.kind === "polling") {
      return s.runState.kind === "pushing" ? "Pushing…" : "Running…";
    }
    if (s.lastSavedAt) {
      const sec = Math.max(1, Math.floor((Date.now() - s.lastSavedAt) / 1000));
      return sec < 60 ? `Saved ${sec}s ago` : `Saved ${Math.floor(sec / 60)}m ago`;
    }
    return "Unsaved";
  }, [s.runState, s.lastSavedAt]);

  const loadRecent = (meta: SavedGraphMeta) => {
    const saved = loadSavedByName(meta.graphName);
    if (!saved) {
      toast.error(`No saved graph for "${meta.graphName}".`);
      return;
    }
    s.setGraphName(saved.graphName);
    // The simplest "load" path is to swap the active graph; we
    // also update the agentId cache so a re-push reuses the
    // same backend agent.
    // We do this by writing to the active key + re-hydrating
    // via a small helper on the state hook.
    // For now we use a direct localStorage write + reload.
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        "eden.builder.graph",
        JSON.stringify(saved),
      );
      window.location.reload();
    }
    setRecentOpen(false);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-primary)]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <input
            className="bg-transparent text-sm font-semibold text-[var(--text-primary)] border-0 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] rounded px-1.5 py-0.5 min-w-0 max-w-[280px]"
            value={s.graphName}
            onChange={(e) => s.setGraphName(e.target.value)}
            aria-label="Graph name"
            spellCheck={false}
          />
          <span
            className="text-[11px] text-[var(--text-muted)] tabular-nums"
            aria-live="polite"
            data-testid="save-status"
          >
            {savingStatus}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Recent ▾ */}
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRecentOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={recentOpen}
            >
              <History className="w-3.5 h-3.5" />
              Recent
              <ChevronDown className="w-3 h-3" />
            </Button>
            {recentOpen && (
              <div
                className="absolute right-0 mt-1 w-72 z-30 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg"
                role="menu"
              >
                {recent.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-[var(--text-muted)]">
                    No saved graphs yet.
                  </p>
                ) : (
                  <ul className="py-1">
                    {recent.map((m) => (
                      <li key={m.graphName}>
                        <button
                          type="button"
                          className="w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)] flex items-center justify-between gap-2"
                          onClick={() => loadRecent(m)}
                        >
                          <span className="truncate">{m.graphName}</span>
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {new Date(m.updatedAt).toLocaleTimeString()}
                          </span>
                        </button>
                        <div className="px-3 pb-1 text-[10px] text-[var(--text-muted)] flex items-center gap-2">
                          <span>{m.summary.agents}A</span>
                          <span>·</span>
                          <span>{m.summary.tools}T</span>
                          <span>·</span>
                          <span>{m.summary.scenarios}S</span>
                          {m.summary.seed !== undefined && (
                            <>
                              <span>·</span>
                              <span>seed {m.summary.seed}</span>
                            </>
                          )}
                          <button
                            type="button"
                            className="ml-auto text-zinc-400 hover:text-[var(--error)]"
                            onClick={() => {
                              deleteSaved(m.graphName);
                              setRecent(listRecent());
                            }}
                            aria-label={`Delete ${m.graphName}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => s.loadFromStorage()}
            aria-label="Reload from localStorage"
            title="Reload the saved graph from localStorage"
          >
            <Save className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={s.reset}
            aria-label="Reset to defaults"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </Button>

          <Button
            type="button"
            onClick={() => {
              if (!orgId) {
                toast.error("Pick an organisation first.");
                return;
              }
              void s.pushAndRun({ orgId });
            }}
            isLoading={s.runState.kind === "pushing" || s.runState.kind === "polling"}
            data-testid="push-and-run"
          >
            {s.runState.kind === "pushing" || s.runState.kind === "polling" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            Push & Run
          </Button>
        </div>
      </div>

      {/* 3-column body */}
      <div className="flex flex-1 overflow-hidden">
        <Palette
          onAdd={(kind) =>
            // Default drop position in the centre of the visible canvas.
            s.addNode(kind, { x: 220 + Math.random() * 60, y: 160 + Math.random() * 60 })
          }
        />
        <Canvas
          nodes={s.nodes}
          edges={s.edges}
          onNodesChange={s.onNodesChange}
          onEdgesChange={s.onEdgesChange}
          onConnect={s.onConnect}
          onSelectionChange={s.onSelectionChange}
          onAdd={(kind, pos) => s.addNode(kind, pos)}
        />
        <Inspector
          selected={selectedNode}
          onChange={(next) => s.onNodeDataChange(next.id, next.data)}
          onRemove={s.removeNode}
          yamlPreview={s.yamlPreview}
        />
      </div>

      <RunResultsDialog
        state={s.runState}
        onClose={s.closeRunDialog}
        orgId={orgId}
      />
    </div>
  );
}
