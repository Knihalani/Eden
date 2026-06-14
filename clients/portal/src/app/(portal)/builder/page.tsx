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
 *
 * Keyboard shortcuts:
 *   - Delete/Backspace: remove selected node
 *   - Cmd/Ctrl + D:     duplicate the selected node
 *   - Cmd/Ctrl + Z:     undo
 *   - Cmd/Ctrl + Shift + Z / Cmd/Ctrl + Y: redo
 *   - Cmd/Ctrl + S:     save (flush the localStorage debounce)
 *   - F:                fit the canvas to all nodes
 *   - T:                tidy the layout
 *   - Esc:              clear selection
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Clipboard,
  Copy,
  Download,
  History,
  Loader2,
  Play,
  Redo2,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Wand2,
} from "lucide-react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { agentsApi, builderApi } from "@/lib/api";

import { Inspector } from "./_components/Inspector";
import { Palette } from "./_components/Palette";
import { RunHistory } from "./_components/RunHistory";
import { RunResultsDialog } from "./_components/RunResultsDialog";
import { TemplatesMenu } from "./_components/TemplatesMenu";
import { useBuilderState } from "./_hooks/useBuilderState";
import { deleteSaved, flushGraph, listRecent, loadSavedByName } from "./_lib/storage";
import {
  downloadPortable,
  importPortable,
} from "./_lib/portableGraph";
import type { BuilderTemplate } from "./_lib/templates";

import type { SavedGraphMeta } from "@/lib/types";
import type { SimRun } from "@/lib/api";

// React Flow touches window/document on mount, so we have to
// dynamic-import the canvas with ssr:false.
const Canvas = dynamic(
  () => import("./_components/Canvas").then((m) => m.Canvas),
  { ssr: false, loading: () => <div className="flex-1 bg-[var(--bg-base)]" /> },
);

export default function BuilderPage() {
  return (
    <ReactFlowProvider>
      <BuilderPageInner />
    </ReactFlowProvider>
  );
}

function BuilderPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();

  const s = useBuilderState();
  const [recent, setRecent] = useState<SavedGraphMeta[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const reactFlow = useReactFlow();

  // Refresh the recent list whenever the active graph changes.
  useEffect(() => {
    setRecent(listRecent());
  }, [s.graphName, s.lastSavedAt]);

  // Bump the history key whenever a run transitions to "done" so
  // the panel re-fetches the new run row.
  useEffect(() => {
    if (s.runState.kind === "done") {
      setHistoryRefreshKey((k) => k + 1);
    }
  }, [s.runState]);

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

  const loadRecent = useCallback(
    (meta: SavedGraphMeta) => {
      const saved = loadSavedByName(meta.graphName);
      if (!saved) {
        toast.error(`No saved graph for "${meta.graphName}".`);
        return;
      }
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          "eden.builder.graph",
          JSON.stringify(saved),
        );
        window.location.reload();
      }
      setRecentOpen(false);
    },
    [toast],
  );

  const loadTemplate = useCallback(
    (template: BuilderTemplate) => {
      if (
        s.nodes.length > 0 &&
        !window.confirm(
          `Replace the current graph with the "${template.name}" template?`,
        )
      ) {
        return;
      }
      const built = template.build();
      s.replaceGraph(built.nodes, built.edges, built.graphName);
      toast.success(`Loaded template "${template.name}".`);
    },
    [s, toast],
  );

  // ── Export / Import ───────────────────────────────────────────
  const handleExportDownload = useCallback(() => {
    downloadPortable(s.graphName, s.nodes, s.edges, s.yamlPreview);
    toast.success(`Exported "${s.graphName}.builder.json".`);
  }, [s.graphName, s.nodes, s.edges, s.yamlPreview, toast]);

  const handleCopyYaml = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error("Clipboard not available in this browser.");
      return;
    }
    void navigator.clipboard
      .writeText(s.yamlPreview)
      .then(() => toast.success("YAML copied to clipboard."))
      .catch(() => toast.error("Failed to copy YAML."));
  }, [s.yamlPreview, toast]);

  const handleImport = useCallback(() => {
    if (typeof window === "undefined") return;
    const input = window.document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const result = importPortable(text);
      if (!result.ok) {
        toast.error(`Import failed: ${result.error}`);
        return;
      }
      if (
        s.nodes.length > 0 &&
        !window.confirm(
          `Replace the current graph with "${result.graph.graphName}"?`,
        )
      ) {
        return;
      }
      s.replaceGraph(
        result.graph.nodes,
        result.graph.edges,
        result.graph.graphName,
      );
      toast.success(`Imported "${result.graph.graphName}".`);
    };
    input.click();
  }, [s, toast]);

  // ── Save to server ────────────────────────────────────────────
  const handleSaveToServer = useCallback(async () => {
    if (!orgId) {
      toast.error("Pick an organisation first.");
      return;
    }
    try {
      const result = await builderApi.upsert(orgId, {
        name: s.graphName,
        graph: {
          nodes: s.nodes as unknown[],
          edges: s.edges as unknown[],
        },
        yaml: s.yamlPreview,
      });
      toast.success(
        result.created
          ? `Saved "${s.graphName}" to server.`
          : `Updated "${s.graphName}" on server.`,
      );
    } catch (err) {
      toast.error(`Save to server failed: ${(err as Error).message}`);
    }
  }, [orgId, s.graphName, s.nodes, s.edges, s.yamlPreview, toast]);

  // ── Run history ──────────────────────────────────────────────
  const openHistoricalRun = useCallback(
    (run: SimRun, agentId: string) => {
      s.showHistoricalRun(run, agentId);
    },
    [s],
  );

  const rerun = useCallback(
    async (run: SimRun, agentId: string) => {
      if (!orgId) {
        toast.error("Pick an organisation first.");
        return;
      }
      try {
        const fresh = await agentsApi.triggerSimRun(orgId, agentId, {
          upload_id: run.upload_id,
          runner_kind: "subprocess",
        });
        toast.info(`Rerun started: ${fresh.id}`);
        s.closeRunDialog();
        void s.resumeRunDialog(orgId, fresh, agentId);
      } catch (err) {
        toast.error(`Rerun failed: ${(err as Error).message}`);
      }
    },
    [orgId, s, toast],
  );

  // ── Keyboard shortcuts ────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Don't trigger shortcuts while typing in a form field.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        s.undo();
        return;
      }
      if ((mod && e.key === "Z" && e.shiftKey) || (mod && e.key === "y")) {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && e.key === "d") {
        e.preventDefault();
        if (s.selectedNodeId) s.duplicateNode(s.selectedNodeId);
        return;
      }
      if (mod && e.key === "s") {
        e.preventDefault();
        flushGraph();
        toast.info("Graph saved to localStorage.");
        return;
      }
      if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        if (s.selectedNodeId) s.removeNode(s.selectedNodeId);
        return;
      }
      if (!mod && e.key === "f") {
        e.preventDefault();
        try {
          reactFlow.fitView({ padding: 0.2, duration: 300 });
        } catch {
          // no nodes yet
        }
        return;
      }
      if (!mod && e.key === "t") {
        e.preventDefault();
        s.tidy();
        return;
      }
      if (!mod && e.key === "Escape") {
        s.setSelected(null);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s, reactFlow, toast]);

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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={s.undo}
            disabled={!s.canUndo}
            aria-label="Undo (Cmd/Ctrl+Z)"
            title="Undo (⌘Z)"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={s.redo}
            disabled={!s.canRedo}
            aria-label="Redo (Cmd/Ctrl+Shift+Z)"
            title="Redo (⇧⌘Z)"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={s.tidy}
            aria-label="Tidy layout (T)"
            title="Tidy layout (T)"
          >
            <Wand2 className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              try {
                reactFlow.fitView({ padding: 0.2, duration: 300 });
              } catch {
                // no nodes yet
              }
            }}
            aria-label="Fit view (F)"
            title="Fit view (F)"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </Button>

          {s.selectedNodeId && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => s.duplicateNode(s.selectedNodeId!)}
                aria-label="Duplicate node (Cmd/Ctrl+D)"
                title="Duplicate (⌘D)"
              >
                <Copy className="w-3.5 h-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => s.removeNode(s.selectedNodeId!)}
                aria-label="Delete node"
                title="Delete (⌫)"
                className="text-[var(--error)] hover:text-[var(--error)]"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </>
          )}

          <div className="h-5 w-px bg-[var(--border-subtle)] mx-1" />

          <TemplatesMenu onPick={loadTemplate} />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleExportDownload}
            aria-label="Download graph as .builder.json"
            title="Download .builder.json"
            data-testid="export-button"
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleCopyYaml}
            aria-label="Copy YAML to clipboard"
            title="Copy YAML"
            data-testid="copy-yaml-button"
          >
            <Clipboard className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleImport}
            aria-label="Import .builder.json"
            title="Import .builder.json"
            data-testid="import-button"
          >
            <Upload className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleSaveToServer}
            aria-label="Save to server (builder_graphs table)"
            title="Save to server"
            data-testid="save-to-server-button"
            disabled={!orgId}
          >
            Save
          </Button>

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
                            className="ml-auto text-[var(--text-muted)] hover:text-[var(--error)]"
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
            size="icon"
            onClick={() => s.loadFromStorage()}
            aria-label="Reload from localStorage"
            title="Reload saved graph"
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
          graphName={s.graphName}
          onOpenRun={openHistoricalRun}
          historyRefreshKey={historyRefreshKey}
        />
      </div>

      <RunResultsDialog
        state={s.runState}
        onClose={s.closeRunDialog}
        orgId={orgId}
        onRerun={rerun}
      />
    </div>
  );
}
