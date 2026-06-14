/**
 * Canvas — the React Flow host. Renders the graph, accepts drops
 * from the Palette, and forwards all mutations to the parent
 * state hook. Wrapped in ``next/dynamic({ ssr: false })`` from
 * the page because <ReactFlow> touches window/document on mount.
 *
 * The visual layer is intentionally a dark "graph editor" feel
 * (zinc-950 background with a faint dotted grid) — the rest of
 * the page chrome stays in the portal's light theme. This is
 * the same pattern as the pr-suggestions inbox: a dark work
 * area inside a light shell.
 */

"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type OnSelectionChangeParams,
  type OnConnect,
  MiniMap,
  ReactFlow,
  type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useRef } from "react";

import type { BlockKind } from "@/lib/types";
import { makeIsValidConnection } from "../_lib/validHandles";
import { type EdenEdge, type EdenNode } from "../_lib/types";
import { nodeTypes } from "./nodeTypes";

export interface CanvasProps {
  nodes: EdenNode[];
  edges: EdenEdge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onSelectionChange: (params: OnSelectionChangeParams) => void;
  onAdd: (kind: BlockKind, position: { x: number; y: number }) => void;
}

export function Canvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelectionChange,
  onAdd,
}: CanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handleConnect: OnConnect = useCallback(
    (connection) => {
      onConnect({
        ...connection,
        data: { kind: "data" },
      } as Connection);
    },
    [onConnect],
  );

  const handleDragOver = useCallback<React.DragEventHandler<HTMLDivElement>>(
    (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleDrop = useCallback<React.DragEventHandler<HTMLDivElement>>(
    (e) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData("application/eden-block") as BlockKind | "";
      if (!kind) return;
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      onAdd(kind, {
        x: e.clientX - rect.left - 90,
        y: e.clientY - rect.top - 30,
      });
    },
    [onAdd],
  );

  // Wrap the React Flow defaults so that ``data`` we attach to
  // a connection survives the round-trip through <ReactFlow>'s
  // change dispatcher.
  const onConnectWithEdgeData: OnConnect = useCallback(
    (params) => {
      handleConnect(params);
    },
    [handleConnect],
  );

  // Connection validation: React Flow's isValidConnection hook
  // shows a red "X" cursor when the user drags onto an
  // invalid target, AND prevents the onConnect callback from
  // firing for invalid pairs.
  const isValidConnection = useMemo(
    () => makeIsValidConnection(nodes as EdenNode[]),
    [nodes],
  );

  const reactFlowProps: Partial<ReactFlowProps> = {
    colorMode: "dark",
    fitView: true,
    fitViewOptions: { padding: 0.2 },
    proOptions: { hideAttribution: true },
    defaultEdgeOptions: { animated: false, data: { kind: "data" } },
    connectionLineStyle: { stroke: "#10b981", strokeWidth: 2 },
  };

  return (
    <div
      ref={wrapperRef}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="relative flex-1 h-full bg-[var(--bg-base)]"
      data-testid="builder-canvas"
    >
      <ReactFlow
        nodes={nodes as unknown as ReactFlowProps["nodes"]}
        edges={edges as unknown as ReactFlowProps["edges"]}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnectWithEdgeData}
        onSelectionChange={onSelectionChange}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        {...reactFlowProps}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="#3f3f46"
        />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!bg-[var(--bg-base)] !border-[var(--border-default)] !text-[var(--text-muted)]"
        />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          maskColor="rgba(0,0,0,0.6)"
          nodeColor={(n) => {
            switch (n.type) {
              case "agent":
                return "#10b981";
              case "tool":
                return "#0ea5e9";
              case "scenario":
                return "#f59e0b";
              case "scoring":
                return "#a855f7";
              case "memory":
                return "#ec4899";
              case "loop":
                return "#06b6d4";
              case "seed":
                return "#f97316";
              default:
                return "#71717a";
            }
          }}
          className="!bg-[var(--bg-base)] !border-[var(--border-default)]"
        />
      </ReactFlow>
    </div>
  );
}
