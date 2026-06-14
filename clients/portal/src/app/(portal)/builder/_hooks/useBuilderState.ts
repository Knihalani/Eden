/**
 * useBuilderState — the central state hook for the builder.
 *
 * Responsibilities:
 *  - Holds the React Flow ``nodes`` and ``edges`` arrays.
 *  - Debounced localStorage auto-save (so refreshes don't wipe work).
 *  - Exposes the small set of mutations the page needs:
 *    addNode, removeNode, replaceNode (Inspector edit), reset,
 *    loadFromStorage.
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
  type OnSelectionChangeParams,
} from "@xyflow/react";

import { agentsApi } from "@/lib/api";
import type { SimRun } from "@/lib/api";
import type { BlockData, BlockKind, SavedGraph } from "@/lib/types";
import { useToast } from "@/components/ui/toast";

import { translate, previewYaml } from "../_lib/specTranslator";
import { buildTarballFile, slugify } from "../_lib/tarballBuilder";
import {
  flushGraph,
  loadGraph,
  loadSavedByName,
  lookupAgentId,
  persistGraph,
  rememberAgentId,
  saveGraphDebounced,
} from "../_lib/storage";
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

  // Mutations
  setGraphName: (name: string) => void;
  addNode: (kind: BlockKind, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
  reset: () => void;
  loadFromStorage: () => void;
  setSelected: (id: string | null) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onSelectionChange: (params: OnSelectionChangeParams) => void;
  onNodeDataChange: (id: string, data: BlockData) => void;

  // Push & run
  runState: RunDialogState;
  pushAndRun: (args: PushAndRunArgs) => Promise<void>;
  closeRunDialog: () => void;
}

const DEFAULT_GRAPH_NAME = "Untitled builder";

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
        data: { kind: "data" },
      } as EdenEdge,
    ],
  };
}

export function useBuilderState(): UseBuilderState {
  const toast = useToast();
  const initial = (() => {
    const saved = loadGraph();
    if (saved && Array.isArray(saved.nodes) && Array.isArray(saved.edges)) {
      return {
        nodes: saved.nodes as EdenNode[],
        edges: saved.edges as EdenEdge[],
        graphName: saved.graphName,
      };
    }
    const d = defaultGraph();
    return {
      nodes: d.nodes,
      edges: d.edges,
      graphName: DEFAULT_GRAPH_NAME,
    };
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

  // Persist on every change, debounced 500ms.
  useEffect(() => {
    const g: SavedGraph = {
      graphName,
      nodes: nodes as unknown as SavedGraph["nodes"],
      edges: edges as unknown as SavedGraph["edges"],
      updatedAt: Date.now(),
    };
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
      setNodes((prev) => [...prev, node]);
      setSelectedNodeId(node.id);
    },
    [],
  );

  const removeNode = useCallback((id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id));
    setSelectedNodeId((cur) => (cur === id ? null : cur));
  }, []);

  const reset = useCallback(() => {
    if (typeof window !== "undefined" && !window.confirm("Discard the current graph?")) {
      return;
    }
    const d = defaultGraph();
    setNodes(d.nodes);
    setEdges(d.edges);
    setGraphNameState(DEFAULT_GRAPH_NAME);
    setSelectedNodeId(null);
    toast.info("Builder reset to defaults.");
  }, [toast]);

  const loadFromStorage = useCallback(() => {
    const saved = loadGraph();
    if (!saved) {
      toast.info("No saved graph yet.");
      return;
    }
    setNodes(saved.nodes as EdenNode[]);
    setEdges(saved.edges as EdenEdge[]);
    setGraphNameState(saved.graphName);
    toast.success(`Loaded "${saved.graphName}".`);
  }, [toast]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev) as EdenNode[]);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((prev) => applyEdgeChanges(changes, prev) as EdenEdge[]);
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((prev) =>
      addEdge(
        { ...connection, data: { kind: "data" } },
        prev,
      ) as EdenEdge[],
    );
  }, []);

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const next = params.nodes?.[0]?.id ?? null;
      setSelectedNodeId(next);
    },
    [],
  );

  const onNodeDataChange = useCallback((id: string, data: BlockData) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === id ? ({ ...n, data } as EdenNode) : n)),
    );
  }, []);

  const closeRunDialog = useCallback(() => {
    pollAbortRef.current.aborted = true;
    setRunState({ kind: "idle" });
  }, []);

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
            framework: framework === "none" ? undefined : framework,
          });
          agentId = reg.agent.agent_id;
          rememberAgentId(graphName, agentId);
          toast.info(`Registered new agent "${reg.agent.name}".`);
        } catch (err) {
          setRunState({
            kind: "error",
            message: `Failed to register agent: ${(err as Error).message}`,
          });
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
          message: `Upload failed: ${(err as Error).message}`,
        });
        return;
      }

      // 5. Trigger the sim run.
      let run: SimRun;
      try {
        run = await agentsApi.triggerSimRun(orgId, agentId, {
          upload_id: upload.upload_id,
          runner_kind: "subprocess",
        });
      } catch (err) {
        setRunState({
          kind: "error",
          message: `Failed to start sim: ${(err as Error).message}`,
        });
        return;
      }

      setRunState({ kind: "polling", run, agentId });

      // 6. Persist the graph with the agent_id for next push.
      persistGraph({
        graphName,
        nodes: nodes as unknown as SavedGraph["nodes"],
        edges: edges as unknown as SavedGraph["edges"],
        updatedAt: Date.now(),
      });

      // 7. Poll until terminal status.
      const terminal = new Set(["passed", "failed", "error"]);
      let last = run;
      while (!abort.aborted) {
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
            message: `Polling failed: ${(err as Error).message}`,
          });
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
    setGraphName,
    addNode,
    removeNode,
    reset,
    loadFromStorage,
    setSelected: setSelectedNodeId,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onSelectionChange,
    onNodeDataChange,
    runState,
    pushAndRun,
    closeRunDialog,
  };
}
