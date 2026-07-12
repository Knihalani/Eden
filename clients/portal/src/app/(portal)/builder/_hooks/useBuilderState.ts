/**
 * useBuilderState — the central state hook for the builder.
 *
 * Responsibilities:
 *  - Holds the React Flow ``nodes`` and ``edges`` arrays.
 *  - Debounced localStorage auto-save (so refreshes don't wipe work).
 *  - Undo / redo with a bounded history stack.
 *  - Exposes the small set of mutations the page needs:
 *    addNode, removeNode, replaceNode (Inspector edit), reset,
 *    loadFromStorage, duplicateNode, tidy.
 *  - Exposes the pushAndRun orchestration: validate → translate
 *    → tarball → optional register → upload → triggerSimRun →
 *    poll every 2 s until terminal status.
 *
 * The hook is intentionally chatty with its dependencies so the
 * page can stay declarative.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams } from "@xyflow/react";

import { agentsApi } from "@/lib/api";
import type { SimRun } from "@/lib/api";

const MAX_SIM_POLL_MS = 30 * 60 * 1000;
import type { BlockData, BlockKind, SavedGraph } from "@/lib/types";
import { useToast } from "@/components/ui/toast";

import { translate, previewYaml } from "../_lib/specTranslator";
import { buildTarballFile, slugify } from "../_lib/tarballBuilder";
import { tidyLayout } from "../_lib/layout";
import { isValidHandlePair, rejectionReason } from "../_lib/validHandles";
import {
  flushGraph,
  loadGraph,
  lookupAgentId,
  persistGraph,
  rememberAgentId,
  saveGraphDebounced } from "../_lib/storage";
import { makeBlockNode, type EdenEdge, type EdenNode } from "../_lib/types";

import type { RunDialogState } from "../_components/RunResultsDialog";

export interface PushAndRunArgs {
  orgId: string;
  /** Optional agent_id; if absent we register a new agent. */
  agentId?: string;
}

export interface UseBuilderState {
  // Graph state
  nodes: EdenNode[];
  edges: EdenEdge[];
  selectedNodeId: string | null;
  graphName: string;
  lastSavedAt: number | null;
  /** Live YAML preview for the Inspector. */
  yamlPreview: string;

  // History
  canUndo: boolean;
  canRedo: boolean;

  // Mutations
  setGraphName: (name: string) => void;
  addNode: (kind: BlockKind, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  renameNode: (id: string, label: string) => void;
  reset: (confirmFn?: () => Promise<boolean>) => Promise<void>;
  loadFromStorage: () => void;
  setSelected: (id: string | null) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onSelectionChange: (params: OnSelectionChangeParams) => void;
  onNodeDataChange: (id: string, data: BlockData) => void;
  replaceGraph: (nodes: EdenNode[], edges: EdenEdge[], graphName?: string) => void;
  undo: () => void;
  redo: () => void;
  tidy: () => void;

  // Push & run
  runState: RunDialogState;
  pushAndRun: (args: PushAndRunArgs) => Promise<void>;
  closeRunDialog: () => void;
  /** Reopen the run dialog in "done" state with a given run.
   *  Used by the historical-run "open" path. */
  showHistoricalRun: (run: SimRun, agentId: string) => void;
  /** Re-trigger the polling loop on an existing run. */
  resumeRunDialog: (orgId: string, run: SimRun, agentId: string) => Promise<void>;
}

const DEFAULT_GRAPH_NAME = "Untitled builder";
const MAX_HISTORY = 50;

function defaultGraph(): { nodes: EdenNode[]; edges: EdenEdge[] } {
  const agent = makeBlockNode("agent", { x: 40, y: 120 });
  const scenario = makeBlockNode("scenario", { x: 360, y: 120 });
  return {
    nodes: [agent, scenario],
    edges: [
      {
        id: `${agent.id}->${scenario.id}`,
        source: agent.id,
        target: scenario.id,
        sourceHandle: "out:agent",
        targetHandle: "in:agent",
        data: { kind: "data" } } as EdenEdge,
    ] };
}

type Snapshot = { nodes: EdenNode[]; edges: EdenEdge[] };

export function useBuilderState(): UseBuilderState {
  const toast = useToast();
  const initial = (() => {
    const saved = loadGraph();
    if (saved && Array.isArray(saved.nodes) && Array.isArray(saved.edges)) {
      return {
        nodes: saved.nodes as EdenNode[],
        edges: saved.edges as EdenEdge[],
        graphName: saved.graphName };
    }
    const d = defaultGraph();
    return {
      nodes: d.nodes,
      edges: d.edges,
      graphName: DEFAULT_GRAPH_NAME };
  })();

  const [nodes, setNodes] = useState<EdenNode[]>(initial.nodes);
  const [edges, setEdges] = useState<EdenEdge[]>(initial.edges);
  const [graphName, setGraphNameState] = useState<string>(initial.graphName);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(
    initial.graphName === DEFAULT_GRAPH_NAME ? null : Date.now(),
  );
  const [runState, setRunState] = useState<RunDialogState>({ kind: "idle" });
  const pollAbortRef = useRef<{ aborted: boolean }>({ aborted: false });

  // ── Undo / redo ───────────────────────────────────────────────
  // We keep the stacks in a ref (mutated synchronously) and bump
  // a counter to force a re-render when the cursor moves.
  const historyRef = useRef<{
    stack: Snapshot[];
    cursor: number; // index of the *current* state in the stack
  }>({
    stack: [{ nodes: initial.nodes, edges: initial.edges }],
    cursor: 0 });
  const [_historyTick, setHistoryTick] = useState(0);
  // Suppress pushing a new snapshot while we're applying undo/redo
  // or while a continuous drag is in progress.
  const applyingHistoryRef = useRef(false);
  const dragInProgressRef = useRef(false);

  const pushHistory = useCallback((next: { nodes: EdenNode[]; edges: EdenEdge[] }) => {
    const h = historyRef.current;
    // Drop the redo branch.
    h.stack = h.stack.slice(0, h.cursor + 1);
    h.stack.push({ nodes: next.nodes, edges: next.edges });
    if (h.stack.length > MAX_HISTORY) h.stack.shift();
    h.cursor = h.stack.length - 1;
    setHistoryTick((t) => t + 1);
  }, []);

  // Persist on every change, debounced 500ms.
  useEffect(() => {
    const g: SavedGraph = {
      graphName,
      nodes: nodes as unknown as SavedGraph["nodes"],
      edges: edges as unknown as SavedGraph["edges"],
      updatedAt: Date.now() };
    saveGraphDebounced(g);
    setLastSavedAt(Date.now());
  }, [nodes, edges, graphName]);

  // Persist on unmount too.
  useEffect(() => () => flushGraph(), []);

  const setGraphName = useCallback((name: string) => {
    setGraphNameState(name.trim() || DEFAULT_GRAPH_NAME);
  }, []);

  const addNode = useCallback(
    (kind: BlockKind, position: { x: number; y: number }) => {
      const node = makeBlockNode(kind, position);
      const nextNodes = [...nodes, node];
      const nextEdges = edges;
      setNodes(nextNodes);
      setEdges(nextEdges);
      setSelectedNodeId(node.id);
      pushHistory({ nodes: nextNodes, edges: nextEdges });
    },
    [nodes, edges, pushHistory],
  );

  const removeNode = useCallback(
    (id: string) => {
      const nextNodes = nodes.filter((n) => n.id !== id);
      const nextEdges = edges.filter((e) => e.source !== id && e.target !== id);
      setNodes(nextNodes);
      setEdges(nextEdges);
      setSelectedNodeId((cur) => (cur === id ? null : cur));
      pushHistory({ nodes: nextNodes, edges: nextEdges });
    },
    [nodes, edges, pushHistory],
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const orig = nodes.find((n) => n.id === id);
      if (!orig) return;
      const dup: EdenNode = {
        ...orig,
        id: `${orig.data.kind}_${Math.random().toString(36).slice(2, 9)}`,
        position: { x: orig.position.x + 40, y: orig.position.y + 40 },
        data: { ...orig.data },
        selected: false };
      const nextNodes = [...nodes, dup];
      setNodes(nextNodes);
      setSelectedNodeId(dup.id);
      pushHistory({ nodes: nextNodes, edges });
    },
    [nodes, edges, pushHistory],
  );

  const renameNode = useCallback(
    (id: string, label: string) => {
      const nextNodes = nodes.map((n) =>
        n.id === id
          ? ({ ...n, data: { ...n.data, label } as unknown as BlockData } as EdenNode)
          : n,
      );
      setNodes(nextNodes);
      pushHistory({ nodes: nextNodes, edges });
    },
    [nodes, edges, pushHistory],
  );

  // reset accepts an optional async `confirmFn` so the caller can
  // use the styled `useConfirm` dialog instead of `window.confirm`.
  // Falls back to window.confirm for any legacy direct callers.
  const reset = useCallback(
    async (confirmFn?: () => Promise<boolean>) => {
      const ok = confirmFn
        ? await confirmFn()
        : typeof window !== "undefined"
          ? window.confirm("Discard the current graph?")
          : true;
      if (!ok) return;
      const d = defaultGraph();
      setNodes(d.nodes);
      setEdges(d.edges);
      setGraphNameState(DEFAULT_GRAPH_NAME);
      setSelectedNodeId(null);
      pushHistory({ nodes: d.nodes, edges: d.edges });
      toast.info("Builder reset to defaults.");
    },
    [toast, pushHistory],
  );

  const loadFromStorage = useCallback(() => {
    const saved = loadGraph();
    if (!saved) {
      toast.info("No saved graph yet.");
      return;
    }
    const nextNodes = saved.nodes as EdenNode[];
    const nextEdges = saved.edges as EdenEdge[];
    setNodes(nextNodes);
    setEdges(nextEdges);
    setGraphNameState(saved.graphName);
    pushHistory({ nodes: nextNodes, edges: nextEdges });
    toast.success(`Loaded "${saved.graphName}".`);
  }, [toast, pushHistory]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (applyingHistoryRef.current) return; // skip during undo/redo
      const isDragStart = changes.some(
        (c) => c.type === "position" && c.dragging === true,
      );
      const isDragEnd = changes.some(
        (c) => c.type === "position" && c.dragging === false,
      );
      if (isDragStart) {
        // Snapshot the *current* state before applying the drag,
        // so undo returns to where the node was.
        pushHistory({ nodes, edges });
        dragInProgressRef.current = true;
      }
      const next = applyNodeChanges(changes, nodes) as EdenNode[];
      setNodes(next);
      if (isDragEnd) {
        dragInProgressRef.current = false;
        // No second push: the drag-start push already covers the
        // move.
      }
    },
    [nodes, edges, pushHistory],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (applyingHistoryRef.current) return;
      const isRemoval = changes.some((c) => c.type === "remove");
      if (isRemoval) {
        pushHistory({ nodes, edges });
      }
      const next = applyEdgeChanges(changes, edges) as EdenEdge[];
      setEdges(next);
    },
    [nodes, edges, pushHistory],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      // Backstop: React Flow's isValidConnection prop also
      // guards the UI, but programmatic callers (imported
      // graphs, tests) can bypass it. Re-validate here.
      const sh = (connection.sourceHandle ?? null) as
        | "out:agent"
        | "out:tool"
        | "out:scenario"
        | "out:scoring"
        | "out:memory"
        | "out:loop"
        | null;
      const th = (connection.targetHandle ?? null) as
        | "in:agent"
        | "in:tool"
        | "in:scoring"
        | "in:memory"
        | "in:loop"
        | null;
      if (!isValidHandlePair(sh, th)) {
        toast.error(rejectionReason(sh, th));
        return;
      }
      const next = addEdge(
        { ...connection, data: { kind: "data" } },
        edges,
      ) as EdenEdge[];
      setEdges(next);
      pushHistory({ nodes, edges: next });
    },
    [nodes, edges, pushHistory, toast],
  );

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const next = params.nodes?.[0]?.id ?? null;
      setSelectedNodeId(next);
    },
    [],
  );

  const onNodeDataChange = useCallback(
    (id: string, data: BlockData) => {
      const nextNodes = nodes.map((n) =>
        n.id === id ? ({ ...n, data } as EdenNode) : n,
      );
      setNodes(nextNodes);
      pushHistory({ nodes: nextNodes, edges });
    },
    [nodes, edges, pushHistory],
  );

  const replaceGraph = useCallback(
    (nextNodes: EdenNode[], nextEdges: EdenEdge[], nextName?: string) => {
      setNodes(nextNodes);
      setEdges(nextEdges);
      if (nextName) setGraphNameState(nextName);
      pushHistory({ nodes: nextNodes, edges: nextEdges });
    },
    [pushHistory],
  );

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.cursor <= 0) return;
    h.cursor -= 1;
    const snap = h.stack[h.cursor]!;
    applyingHistoryRef.current = true;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    setHistoryTick((t) => t + 1);
    // Defer clearing the flag until after React commits the state.
    queueMicrotask(() => {
      applyingHistoryRef.current = false;
    });
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.cursor >= h.stack.length - 1) return;
    h.cursor += 1;
    const snap = h.stack[h.cursor]!;
    applyingHistoryRef.current = true;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    setHistoryTick((t) => t + 1);
    queueMicrotask(() => {
      applyingHistoryRef.current = false;
    });
  }, []);

  const tidy = useCallback(() => {
    const nextNodes = tidyLayout(nodes, edges);
    setNodes(nextNodes);
    pushHistory({ nodes: nextNodes, edges });
    toast.info("Tidied layout.");
  }, [nodes, edges, pushHistory, toast]);

  const closeRunDialog = useCallback(() => {
    pollAbortRef.current.aborted = true;
    setRunState({ kind: "idle" });
  }, []);

  const showHistoricalRun = useCallback(
    (run: SimRun, agentId: string) => {
      pollAbortRef.current.aborted = true;
      setRunState({ kind: "done", run, agentId });
    },
    [],
  );

  // Re-poll an existing run by id. Used by the Rerun path
  // after ``agentsApi.triggerSimRun`` returns a new SimRun.
  const resumeRunDialog = useCallback(
    async (orgId: string, run: SimRun, agentId: string) => {
      pollAbortRef.current.aborted = true;
      const abort = { aborted: false };
      pollAbortRef.current = abort;
      setRunState({ kind: "polling", run, agentId });

      const terminal = new Set(["passed", "failed", "error"]);
      let last = run;
      const pollStarted = Date.now();
      while (!abort.aborted) {
        if (Date.now() - pollStarted > MAX_SIM_POLL_MS) break;
        await new Promise((r) => setTimeout(r, 2000));
        if (abort.aborted) break;
        try {
          const fresh = await agentsApi.getSimRun(orgId, agentId, last.id);
          last = fresh;
          if (terminal.has(fresh.status)) break;
          setRunState({ kind: "polling", run: fresh, agentId });
        } catch {
          break;
        }
      }
      if (!abort.aborted) {
        setRunState({ kind: "done", run: last, agentId });
      }
    },
    [],
  );

  const pushAndRun = useCallback(
    async ({ orgId, agentId: passedAgentId }: PushAndRunArgs) => {
      pollAbortRef.current.aborted = true;
      const abort = { aborted: false };
      pollAbortRef.current = abort;

      // 1. Validate + translate.
      const result = translate(nodes, edges);
      if (!result.ok) {
        for (const err of result.errors) {
          toast.error(err.message);
        }
        return;
      }
      const { bundle } = result;

      setRunState({ kind: "pushing" });

      // 2. Build the tarball File.
      const file = buildTarballFile(graphName, bundle);

      // 3. Resolve / register agent_id.
      let agentId = passedAgentId ?? lookupAgentId(graphName) ?? null;
      if (!agentId) {
        const agent = nodes.find((n) => n.data.kind === "agent");
        const framework =
          (agent?.data as Extract<BlockData, { kind: "agent" }> | undefined)
            ?.framework ?? "langchain";
        try {
          const reg = await agentsApi.register(orgId, {
            name: slugify(graphName),
            framework: framework === "none" ? undefined : framework });
          agentId = reg.agent.agent_id;
          rememberAgentId(graphName, agentId);
          toast.info(`Registered new agent "${reg.agent.name}".`);
        } catch (err) {
          setRunState({
            kind: "error",
            message: `Failed to register agent: ${(err as Error).message}` });
          return;
        }
      }

      // 4. Upload the tarball.
      let upload;
      try {
        upload = await agentsApi.upload(orgId, agentId, file, file.name);
      } catch (err) {
        setRunState({
          kind: "error",
          message: `Upload failed: ${(err as Error).message}` });
        return;
      }

      // 5. Trigger the sim run.
      let run: SimRun;
      try {
        run = await agentsApi.triggerSimRun(orgId, agentId, {
          upload_id: upload.upload_id,
          runner_kind: "subprocess" });
      } catch (err) {
        setRunState({
          kind: "error",
          message: `Failed to start sim: ${(err as Error).message}` });
        return;
      }

      setRunState({ kind: "polling", run, agentId });

      // 6. Persist the graph with the agent_id for next push.
      persistGraph({
        graphName,
        nodes: nodes as unknown as SavedGraph["nodes"],
        edges: edges as unknown as SavedGraph["edges"],
        updatedAt: Date.now() });

      // 7. Poll until terminal status.
      const terminal = new Set(["passed", "failed", "error"]);
      let last = run;
      const pollStarted = Date.now();
      while (!abort.aborted) {
        if (Date.now() - pollStarted > MAX_SIM_POLL_MS) break;
        await new Promise((r) => setTimeout(r, 2000));
        if (abort.aborted) break;
        try {
          const fresh = await agentsApi.getSimRun(orgId, agentId, last.id);
          last = fresh;
          if (terminal.has(fresh.status)) {
            break;
          }
          setRunState({ kind: "polling", run: fresh, agentId });
        } catch (err) {
          setRunState({
            kind: "error",
            message: `Polling failed: ${(err as Error).message}` });
          return;
        }
      }

      if (!abort.aborted) {
        setRunState({ kind: "done", run: last, agentId });
      }
    },
    [nodes, edges, graphName, toast],
  );

  const yamlPreview = previewYaml(nodes, edges);

  return {
    nodes,
    edges,
    selectedNodeId,
    graphName,
    lastSavedAt,
    yamlPreview,
    canUndo: historyRef.current.cursor > 0,
    canRedo: historyRef.current.cursor < historyRef.current.stack.length - 1,
    setGraphName,
    addNode,
    removeNode,
    duplicateNode,
    renameNode,
    reset,
    loadFromStorage,
    setSelected: setSelectedNodeId,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onSelectionChange,
    onNodeDataChange,
    replaceGraph,
    undo,
    redo,
    tidy,
    runState,
    pushAndRun,
    closeRunDialog,
    showHistoricalRun,
    resumeRunDialog };
}
