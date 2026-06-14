/**
 * Inspector — the right-rail property panel for the selected
 * node. Renders a form keyed on ``selectedNode.data.kind``
 * and a live YAML preview at the bottom so the user can see
 * what their DAG translates to before pushing.
 */

"use client";

import { useCallback, useState } from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SimRun } from "@/lib/api";
import type {
  AgentBlockData,
  BlockData,
  CriterionData,
  EdenNode,
  LoopBlockData,
  MemoryBlockData,
  ScenarioBlockData,
  ScoringBlockData,
  SeedBlockData,
  ToolBlockData,
} from "../_lib/types";
import { MAX_SEED } from "../_lib/types";
import { RunHistory } from "./RunHistory";

export interface InspectorProps {
  selected: EdenNode | null;
  onChange: (next: EdenNode) => void;
  onRemove: (id: string) => void;
  yamlPreview: string;
  graphName: string;
  onOpenRun: (run: SimRun, agentId: string) => void;
  historyRefreshKey?: number;
}

export function Inspector({
  selected,
  onChange,
  onRemove,
  yamlPreview,
  graphName,
  onOpenRun,
  historyRefreshKey,
}: InspectorProps) {
  return (
    <aside
      aria-label="Inspector"
      className="hidden lg:flex flex-col w-80 shrink-0 border-l border-[var(--border-default)] bg-[var(--bg-primary)] overflow-y-auto"
    >
      <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Inspector
        </h2>
        {selected && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRemove(selected.id)}
            className="text-[var(--error)] hover:text-[var(--error)]"
            aria-label="Delete block"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
      <div className="flex-1 p-4 space-y-4">
        {selected ? (
          <>
            <FormRow label="Label" hint="Display name on the canvas.">
              <input
                className={inputCls}
                value={selected.data.label}
                onChange={(e) => {
                  const newData = {
                    ...(selected.data as Record<string, unknown>),
                    label: e.target.value,
                  } as unknown as Record<string, unknown> & BlockData;
                  onChange({ ...selected, data: newData });
                }}
                placeholder="Display name"
              />
            </FormRow>
            <div className="border-t border-[var(--border-subtle)] pt-4">
              <NodeForm selected={selected} onChange={onChange} />
            </div>
          </>
        ) : (
          <EmptyState
            icon={Wand2}
            title="No block selected"
            description="Click a node on the canvas to edit its properties."
            size="sm"
          />
        )}
      </div>
      <div className="border-t border-[var(--border-default)] p-4">
        <details open className="text-xs">
          <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-between">
            <span>Generated eden-sim-eval.yaml</span>
            <span className="text-[10px] text-[var(--text-muted)]">live</span>
          </summary>
          <pre
            className="mt-2 max-h-48 overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-[11px] text-[var(--text-primary)] font-mono whitespace-pre"
            data-testid="yaml-preview"
          >
            {yamlPreview}
          </pre>
        </details>
      </div>
      <RunHistory
        graphName={graphName}
        onOpenRun={onOpenRun}
        {...(historyRefreshKey !== undefined ? { refreshKey: historyRefreshKey } : {})}
      />
    </aside>
  );
}

// ── Per-kind forms ────────────────────────────────────────────────

function NodeForm({
  selected,
  onChange,
}: {
  selected: EdenNode;
  onChange: (next: EdenNode) => void;
}) {
  switch (selected.data.kind) {
    case "agent":
      return <AgentForm node={selected as EdenNode & { data: AgentBlockData }} onChange={onChange} />;
    case "tool":
      return <ToolForm node={selected as EdenNode & { data: ToolBlockData }} onChange={onChange} />;
    case "scenario":
      return <ScenarioForm node={selected as EdenNode & { data: ScenarioBlockData }} onChange={onChange} />;
    case "scoring":
      return <ScoringForm node={selected as EdenNode & { data: ScoringBlockData }} onChange={onChange} />;
    case "memory":
      return <MemoryForm node={selected as EdenNode & { data: MemoryBlockData }} onChange={onChange} />;
    case "loop":
      return <LoopForm node={selected as EdenNode & { data: LoopBlockData }} onChange={onChange} />;
    case "seed":
      return <SeedForm node={selected as EdenNode & { data: SeedBlockData }} onChange={onChange} />;
  }
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </span>
      {children}
      {hint && (
        <span className="block text-[10px] text-[var(--text-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}

const inputCls =
  "w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

function AgentForm({
  node,
  onChange,
}: {
  node: EdenNode & { data: AgentBlockData };
  onChange: (next: EdenNode) => void;
}) {
  const set = (patch: Partial<AgentBlockData>) =>
    onChange({ ...node, data: { ...node.data, ...patch } });
  return (
    <>
      <FormRow label="Name">
        <input
          className={inputCls}
          value={node.data.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </FormRow>
      <FormRow label="Framework">
        <select
          className={inputCls}
          value={node.data.framework}
          onChange={(e) =>
            set({
              framework: e.target.value as AgentBlockData["framework"],
            })
          }
        >
          <option value="langchain">langchain</option>
          <option value="openai-agents">openai-agents</option>
          <option value="raw">raw</option>
          <option value="none">none</option>
        </select>
      </FormRow>
    </>
  );
}

function ToolForm({
  node,
  onChange,
}: {
  node: EdenNode & { data: ToolBlockData };
  onChange: (next: EdenNode) => void;
}) {
  const set = (patch: Partial<ToolBlockData>) =>
    onChange({ ...node, data: { ...node.data, ...patch } });
  return (
    <>
      <FormRow label="Name">
        <input
          className={inputCls}
          value={node.data.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </FormRow>
      <FormRow label="Kind">
        <select
          className={inputCls}
          value={node.data.toolKind}
          onChange={(e) =>
            set({ toolKind: e.target.value as ToolBlockData["toolKind"] })
          }
        >
          <option value="shell">shell</option>
          <option value="file">file</option>
          <option value="http">http</option>
          <option value="custom">custom</option>
        </select>
      </FormRow>
      {/* Per-kind structured form. The values are written into
          the same `config` k/v map so the YAML output is
          unchanged — we just render friendlier inputs per kind. */}
      {node.data.toolKind === "shell" && (
        <ShellToolConfig
          config={node.data.config}
          onChange={(cfg) => set({ config: cfg })}
        />
      )}
      {node.data.toolKind === "file" && (
        <FileToolConfig
          config={node.data.config}
          onChange={(cfg) => set({ config: cfg })}
        />
      )}
      {node.data.toolKind === "http" && (
        <HttpToolConfig
          config={node.data.config}
          onChange={(cfg) => set({ config: cfg })}
        />
      )}
      {node.data.toolKind === "custom" && (
        <ConfigTable
          config={node.data.config}
          onChange={(cfg) => set({ config: cfg })}
        />
      )}
    </>
  );
}

function ShellToolConfig({
  config,
  onChange,
}: {
  config: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <div className="space-y-2">
      <FormRow
        label="Command"
        hint="Shell command template. {input} is substituted with the agent's last output."
      >
        <input
          className={cn(inputCls, "font-mono text-xs")}
          placeholder="echo {input}"
          value={config["command"] ?? ""}
          onChange={(e) => onChange({ ...config, command: e.target.value })}
        />
      </FormRow>
      <FormRow label="Timeout (seconds)">
        <input
          className={inputCls}
          type="number"
          min={0}
          max={600}
          value={config["timeout_s"] ?? "30"}
          onChange={(e) =>
            onChange({ ...config, timeout_s: e.target.value })
          }
        />
      </FormRow>
    </div>
  );
}

function FileToolConfig({
  config,
  onChange,
}: {
  config: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <div className="space-y-2">
      <FormRow
        label="Path"
        hint="Glob or literal path. {input} is substituted with the agent's last output."
      >
        <input
          className={cn(inputCls, "font-mono text-xs")}
          placeholder="/tmp/{input}.txt"
          value={config["path"] ?? ""}
          onChange={(e) => onChange({ ...config, path: e.target.value })}
        />
      </FormRow>
      <FormRow label="Mode">
        <select
          className={inputCls}
          value={config["mode"] ?? "read"}
          onChange={(e) => onChange({ ...config, mode: e.target.value })}
        >
          <option value="read">read</option>
          <option value="write">write</option>
        </select>
      </FormRow>
    </div>
  );
}

function HttpToolConfig({
  config,
  onChange,
}: {
  config: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  // HTTP config stores the URL, method, and headers prefixed
  // by "header." in the same flat k/v map. Custom headers
  // are surfaced as their own key/value rows below the URL
  // and method fields.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (k.startsWith("header.")) {
      headers[k.slice("header.".length)] = v;
    }
  }
  const [newHeader, setNewHeader] = useState("");
  const [newValue, setNewValue] = useState("");

  return (
    <div className="space-y-2">
      <FormRow label="URL">
        <input
          className={cn(inputCls, "font-mono text-xs")}
          placeholder="https://api.example.com/v1/{input}"
          value={config["url"] ?? ""}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
        />
      </FormRow>
      <FormRow label="Method">
        <select
          className={inputCls}
          value={config["method"] ?? "GET"}
          onChange={(e) => onChange({ ...config, method: e.target.value })}
        >
          <option>GET</option>
          <option>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
          <option>DELETE</option>
        </select>
      </FormRow>
      <FormRow
        label="Headers"
        hint="Custom HTTP headers. Sent as-is on every call."
      >
        <div className="space-y-1.5">
          {Object.entries(headers).map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5 text-xs">
              <span className="flex-1 font-mono truncate text-[var(--text-secondary)]">
                {k}
              </span>
              <span className="flex-1 font-mono truncate text-[var(--text-muted)]">
                = {v}
              </span>
              <button
                type="button"
                className="text-[var(--text-muted)] hover:text-[var(--error)]"
                onClick={() => {
                  const next = { ...config };
                  delete next[`header.${k}`];
                  onChange(next);
                }}
                aria-label={`Remove header ${k}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <input
              className={cn(inputCls, "text-xs")}
              placeholder="X-Header"
              value={newHeader}
              onChange={(e) => setNewHeader(e.target.value)}
            />
            <input
              className={cn(inputCls, "text-xs")}
              placeholder="value"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                if (!newHeader.trim()) return;
                onChange({
                  ...config,
                  [`header.${newHeader.trim()}`]: newValue,
                });
                setNewHeader("");
                setNewValue("");
              }}
              aria-label="Add header"
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </FormRow>
    </div>
  );
}

function ConfigTable({
  config,
  onChange,
}: {
  config: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(config);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const add = useCallback(() => {
    if (!newKey.trim()) return;
    onChange({ ...config, [newKey.trim()]: newVal });
    setNewKey("");
    setNewVal("");
  }, [config, newKey, newVal, onChange]);
  return (
    <FormRow
      label="Config"
      hint="Key/value pairs passed to the tool at runtime."
    >
      <div className="space-y-1.5">
        {entries.map(([k, v]) => (
          <div
            key={k}
            className="flex items-center gap-1.5 text-xs"
          >
            <span className="flex-1 font-mono truncate text-[var(--text-secondary)]">{k}</span>
            <span className="flex-1 font-mono truncate text-[var(--text-muted)]">= {v}</span>
            <button
              type="button"
              className="text-[var(--text-muted)] hover:text-[var(--error)]"
              onClick={() => {
                const next = { ...config };
                delete next[k];
                onChange(next);
              }}
              aria-label={`Remove ${k}`}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <input
            className={cn(inputCls, "text-xs")}
            placeholder="key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input
            className={cn(inputCls, "text-xs")}
            placeholder="value"
            value={newVal}
            onChange={(e) => setNewVal(e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={add}
            className="h-7 w-7"
            aria-label="Add config row"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </FormRow>
  );
}

function ScenarioForm({
  node,
  onChange,
}: {
  node: EdenNode & { data: ScenarioBlockData };
  onChange: (next: EdenNode) => void;
}) {
  const set = (patch: Partial<ScenarioBlockData>) =>
    onChange({ ...node, data: { ...node.data, ...patch } });
  return (
    <>
      <FormRow
        label="Slug (id)"
        hint="Used as scenarios/<id>.py filename; lowercase, digits, underscores only."
      >
        <input
          className={inputCls}
          value={node.data.id}
          onChange={(e) => set({ id: e.target.value })}
        />
      </FormRow>
      <FormRow label="Env class name">
        <input
          className={inputCls}
          value={node.data.envClassName}
          onChange={(e) => set({ envClassName: e.target.value })}
        />
      </FormRow>
      <FormRow label="Max episodes" hint="1–50.">
        <input
          className={inputCls}
          type="number"
          min={1}
          max={50}
          value={node.data.maxEpisodes}
          onChange={(e) =>
            set({ maxEpisodes: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })
          }
        />
      </FormRow>
      <FormRow label="Description">
        <textarea
          className={cn(inputCls, "min-h-[60px] resize-y")}
          value={node.data.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </FormRow>
    </>
  );
}

function ScoringForm({
  node,
  onChange,
}: {
  node: EdenNode & { data: ScoringBlockData };
  onChange: (next: EdenNode) => void;
}) {
  const set = (patch: Partial<ScoringBlockData>) =>
    onChange({ ...node, data: { ...node.data, ...patch } });
  const update = (i: number, patch: Partial<CriterionData>) => {
    const next = node.data.criteria.map((c, idx) =>
      idx === i ? { ...c, ...patch } : c,
    );
    set({ criteria: next });
  };
  const remove = (i: number) => {
    set({ criteria: node.data.criteria.filter((_, idx) => idx !== i) });
  };
  const add = () => {
    set({
      criteria: [
        ...node.data.criteria,
        { name: `criterion_${node.data.criteria.length + 1}`, kind: "quality", weight: 1 },
      ],
    });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Criteria
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={add}>
          <Plus className="w-3 h-3" />
          Add
        </Button>
      </div>
      {node.data.criteria.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          No criteria yet. Add one to score scenarios.
        </p>
      ) : (
        node.data.criteria.map((c, i) => (
          <div
            key={i}
            className="rounded-md border border-[var(--border-subtle)] p-2 space-y-1.5"
          >
            <div className="flex items-center gap-1.5">
              <input
                className={cn(inputCls, "text-xs")}
                value={c.name}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-[var(--text-muted)] hover:text-[var(--error)]"
                aria-label="Remove criterion"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <select
                className={cn(inputCls, "text-xs flex-1")}
                value={c.kind}
                onChange={(e) =>
                  update(i, { kind: e.target.value as CriterionData["kind"] })
                }
              >
                <option value="quality">quality</option>
                <option value="adversarial">adversarial</option>
                <option value="behavioural">behavioural</option>
              </select>
              <input
                className={cn(inputCls, "text-xs w-20")}
                type="number"
                min={0}
                step={0.1}
                value={c.weight}
                onChange={(e) => update(i, { weight: Number(e.target.value) || 0 })}
                aria-label="Weight"
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function MemoryForm({
  node,
  onChange,
}: {
  node: EdenNode & { data: MemoryBlockData };
  onChange: (next: EdenNode) => void;
}) {
  const set = (patch: Partial<MemoryBlockData>) =>
    onChange({ ...node, data: { ...node.data, ...patch } });
  return (
    <>
      <FormRow label="Type">
        <select
          className={inputCls}
          value={node.data.memoryType}
          onChange={(e) =>
            set({ memoryType: e.target.value as MemoryBlockData["memoryType"] })
          }
        >
          <option value="none">none</option>
          <option value="short-term">short-term</option>
          <option value="long-term">long-term</option>
        </select>
      </FormRow>
      <FormRow label="Capacity">
        <input
          className={inputCls}
          type="number"
          min={0}
          value={node.data.capacity}
          onChange={(e) =>
            set({ capacity: Math.max(0, Number(e.target.value) || 0) })
          }
        />
      </FormRow>
    </>
  );
}

function LoopForm({
  node,
  onChange,
}: {
  node: EdenNode & { data: LoopBlockData };
  onChange: (next: EdenNode) => void;
}) {
  const set = (patch: Partial<LoopBlockData>) =>
    onChange({ ...node, data: { ...node.data, ...patch } });
  return (
    <>
      <FormRow label="Type">
        <select
          className={inputCls}
          value={node.data.loopType}
          onChange={(e) =>
            set({ loopType: e.target.value as LoopBlockData["loopType"] })
          }
        >
          <option value="none">none</option>
          <option value="retry">retry</option>
          <option value="reflexion">reflexion</option>
        </select>
      </FormRow>
      <FormRow label="Max iterations">
        <input
          className={inputCls}
          type="number"
          min={0}
          value={node.data.maxIterations}
          onChange={(e) =>
            set({ maxIterations: Math.max(0, Number(e.target.value) || 0) })
          }
        />
      </FormRow>
    </>
  );
}

function SeedForm({
  node,
  onChange,
}: {
  node: EdenNode & { data: SeedBlockData };
  onChange: (next: EdenNode) => void;
}) {
  const set = (patch: Partial<SeedBlockData>) =>
    onChange({ ...node, data: { ...node.data, ...patch } });
  const roll = () => set({ value: Math.floor(Math.random() * MAX_SEED) });
  return (
    <>
      <FormRow label="Value" hint="0 ≤ n ≤ 2³¹−1. Non-negative integer.">
        <div className="flex items-center gap-1.5">
          <input
            className={inputCls}
            type="number"
            min={0}
            max={MAX_SEED}
            step={1}
            value={node.data.value}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (Number.isFinite(n) && n >= 0) set({ value: Math.min(MAX_SEED, n) });
            }}
          />
          <Button type="button" variant="outline" size="sm" onClick={roll}>
            🎲 Roll
          </Button>
        </div>
      </FormRow>
      <p className="text-[11px] text-[var(--text-muted)]">
        Replays with the same seed are byte-identical. Without a
        seed, every run uses a fresh random state.
      </p>
    </>
  );
}
