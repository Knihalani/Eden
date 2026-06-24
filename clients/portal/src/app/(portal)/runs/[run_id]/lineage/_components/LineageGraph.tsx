"use client";

/**
 * Pure-SVG lineage graph for a fine-tune run.
 *
 * Layout: 3 columns
 *   [Dataset]  ──→  [Run]  ──→  [Production traces]
 *
 * No external graph library — pure SVG so the bundle stays
 * small. Ponytail: this is a visualisation, not a graph editor.
 */

import type { FineTuneLineage } from "@/lib/api";

interface Node {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "dataset" | "run" | "trace";
}

const VIEWBOX_WIDTH = 700;
const ROW_HEIGHT = 22;
const MAX_TRACE_ROWS = 6;

export function LineageGraph({ lineage }: { lineage: FineTuneLineage }) {
  // Build the 3-column layout.
  const backwardCount = lineage.backward.trace_ids.length;
  const forwardCount = lineage.forward.trace_ids.length;

  const backwardNodes: Node[] = lineage.backward.trace_ids
    .slice(0, MAX_TRACE_ROWS)
    .map((tid, i) => ({
      id: tid,
      label: `trc…${tid.slice(-4)}`,
      x: 30,
      y: 60 + i * ROW_HEIGHT,
      width: 140,
      height: 18,
      kind: "trace",
    }));

  const forwardNodes: Node[] = lineage.forward.trace_ids
    .slice(0, MAX_TRACE_ROWS)
    .map((tid, i) => ({
      id: tid,
      label: `trc…${tid.slice(-4)}`,
      x: 530,
      y: 60 + i * ROW_HEIGHT,
      width: 140,
      height: 18,
      kind: "trace",
    }));

  const datasetNode: Node = {
    id: lineage.backward.dataset_id,
    label: `dataset\n${lineage.backward.dataset_id.slice(0, 8)}…`,
    x: 30,
    y: 10,
    width: 140,
    height: 36,
    kind: "dataset",
  };

  const runNode: Node = {
    id: lineage.run.id,
    label: `run\n${lineage.run.id.slice(0, 8)}…`,
    x: 280,
    y: 10,
    width: 140,
    height: 36,
    kind: "run",
  };

  const allNodes = [datasetNode, runNode, ...backwardNodes, ...forwardNodes];

  const maxY = Math.max(
    ...allNodes.map((n) => n.y + n.height),
    200,
  );

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${maxY}`}
      className="w-full h-auto"
      role="img"
      aria-label={`Lineage graph for run ${lineage.run.id}`}
    >
      {/* Edges first so nodes paint on top */}
      {backwardNodes.map((b) => (
        <line
          key={`e-back-${b.id}`}
          x1={datasetNode.x + datasetNode.width}
          y1={datasetNode.y + datasetNode.height / 2}
          x2={runNode.x}
          y2={runNode.y + runNode.height / 2}
          stroke="var(--text-secondary)"
          strokeWidth={1}
          strokeDasharray="2 2"
          opacity={0.4}
        />
      ))}
      {forwardNodes.map((f) => (
        <line
          key={`e-fwd-${f.id}`}
          x1={runNode.x + runNode.width}
          y1={runNode.y + runNode.height / 2}
          x2={f.x}
          y2={f.y + f.height / 2}
          stroke="var(--accent)"
          strokeWidth={1}
          opacity={0.6}
        />
      ))}

      {/* Dataset node */}
      <rect
        x={datasetNode.x}
        y={datasetNode.y}
        width={datasetNode.width}
        height={datasetNode.height}
        rx={4}
        fill="var(--bg-tertiary)"
        stroke="var(--text-secondary)"
      />
      <text
        x={datasetNode.x + datasetNode.width / 2}
        y={datasetNode.y + 14}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fill="var(--text-secondary)"
      >
        DATASET ({backwardCount})
      </text>
      <text
        x={datasetNode.x + datasetNode.width / 2}
        y={datasetNode.y + 28}
        textAnchor="middle"
        fontSize={9}
        fontFamily="monospace"
        fill="var(--text-primary)"
      >
        {datasetNode.id.slice(0, 8)}…
      </text>

      {/* Run node */}
      <rect
        x={runNode.x}
        y={runNode.y}
        width={runNode.width}
        height={runNode.height}
        rx={4}
        fill="var(--accent-faint)"
        stroke="var(--accent)"
      />
      <text
        x={runNode.x + runNode.width / 2}
        y={runNode.y + 14}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fill="var(--accent)"
      >
        RUN
      </text>
      <text
        x={runNode.x + runNode.width / 2}
        y={runNode.y + 28}
        textAnchor="middle"
        fontSize={9}
        fontFamily="monospace"
        fill="var(--text-primary)"
      >
        {runNode.id.slice(0, 8)}…
      </text>

      {/* Backward trace nodes */}
      {backwardNodes.map((b) => (
        <g key={`back-${b.id}`}>
          <rect
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            rx={3}
            fill="var(--bg-secondary)"
            stroke="var(--text-secondary)"
            opacity={0.6}
          />
          <text
            x={b.x + b.width / 2}
            y={b.y + 12}
            textAnchor="middle"
            fontSize={9}
            fontFamily="monospace"
            fill="var(--text-secondary)"
          >
            {b.label}
          </text>
        </g>
      ))}
      {backwardCount > MAX_TRACE_ROWS && (
        <text
          x={datasetNode.x + datasetNode.width / 2}
          y={60 + MAX_TRACE_ROWS * ROW_HEIGHT + 12}
          textAnchor="middle"
          fontSize={9}
          fontStyle="italic"
          fill="var(--text-secondary)"
        >
          … and {backwardCount - MAX_TRACE_ROWS} more
        </text>
      )}

      {/* Forward trace nodes */}
      {forwardNodes.map((f) => (
        <g key={`fwd-${f.id}`}>
          <rect
            x={f.x}
            y={f.y}
            width={f.width}
            height={f.height}
            rx={3}
            fill="var(--accent-faint)"
            stroke="var(--accent)"
            opacity={0.5}
          />
          <text
            x={f.x + f.width / 2}
            y={f.y + 12}
            textAnchor="middle"
            fontSize={9}
            fontFamily="monospace"
            fill="var(--accent)"
          >
            {f.label}
          </text>
        </g>
      ))}
      {forwardCount > MAX_TRACE_ROWS && (
        <text
          x={forwardNodes[0].x + forwardNodes[0].width / 2}
          y={60 + MAX_TRACE_ROWS * ROW_HEIGHT + 12}
          textAnchor="middle"
          fontSize={9}
          fontStyle="italic"
          fill="var(--text-secondary)"
        >
          … and {forwardCount - MAX_TRACE_ROWS} more
        </text>
      )}

      {/* Column labels */}
      <text
        x={30}
        y={maxY - 4}
        fontSize={10}
        fontWeight={600}
        fill="var(--text-secondary)"
      >
        Source traces
      </text>
      <text
        x={280}
        y={maxY - 4}
        fontSize={10}
        fontWeight={600}
        fill="var(--text-secondary)"
      >
        Training
      </text>
      <text
        x={530}
        y={maxY - 4}
        fontSize={10}
        fontWeight={600}
        fill="var(--text-secondary)"
      >
        Production
      </text>
    </svg>
  );
}