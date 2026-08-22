"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { homePath } from "../account/home";
import { useMemo, useState, useTransition } from "react";
import type { Binding, Step, StretchProgram } from "@eden/ir/types";
import { isCheckName, isMutating } from "@eden/ir/names";
import { approveTool, dismissRequest, pauseTool, resumeTool, type BindEdit } from "./actions";
import { failLabel, originLine, receiptPostmortem } from "./fail";
import {
  NODE_H,
  NODE_W,
  bindingFaults,
  dependentsOf,
  layoutProgram,
  methodSteps,
  strippedFromMethod,
} from "./layout-program";
import { pokeActivity } from "../home/activity-context";
import type { CanvasModel } from "./model";

function metric(measured: boolean | undefined, value: number | null | undefined, unit: string) {
  if (!measured || value == null || !Number.isFinite(value)) return "Not measured";
  if (unit === "ms") return value >= 1000 ? `${(value / 1000).toFixed(1)}s saved` : `${Math.round(value)}ms saved`;
  return `${Math.round(value)} ${unit}`;
}

function qualityLine(model: CanvasModel): string {
  const m = model.manifest;
  if (!m) return "Quality not held";
  if (m.skipRateAfter === 0) return "Quality held";
  return "Quality not held";
}

function canShip(model: CanvasModel): boolean {
  const m = model.manifest;
  if (model.verdict !== "PASS" || !m || m.skipRateAfter !== 0) return false;
  const tokens = Boolean(m.tokensMeasured) && (m.tokensSaved ?? 0) > 0;
  const time = Boolean(m.timeMeasured) && (m.timeSavedMs ?? 0) > 0;
  return tokens || time;
}

function shipHold(model: CanvasModel, faults: Array<{ field: string; message: string }>): string | null {
  if (faults.length) return `${faults[0]!.field}: ${faults[0]!.message} Nothing is invented.`;
  if (model.verdict && model.verdict !== "PASS") {
    if (model.verdict === "INCONCLUSIVE") return "Not measured";
    if (model.verdict === "pending") return "Waiting on measured tokens and time.";
    return "Quality not held";
  }
  const m = model.manifest;
  if (!m || m.skipRateAfter !== 0) return "Quality not held";
  const tokens = Boolean(m.tokensMeasured) && (m.tokensSaved ?? 0) > 0;
  const time = Boolean(m.timeMeasured) && (m.timeSavedMs ?? 0) > 0;
  if (!tokens && !time) return "Not measured";
  return null;
}

function stepById(program: StretchProgram, id: string): Step | undefined {
  return program.steps.find((s) => s.id === id);
}

function bindLines(step: Step): Array<{ field: string; text: string; binding: Binding }> {
  const rows: Array<{ field: string; text: string; binding: Binding }> = [];
  const show = (field: string, b: Binding) => {
    rows.push({ field, text: describe(b), binding: b });
  };
  if (step.kind === "tool") {
    for (const [k, b] of Object.entries(step.args)) show(k, b);
  } else if (step.kind === "island") show("input", step.input);
  else if (step.kind === "loop") show("over", step.over);
  return rows;
}

function describe(b: Binding): string {
  if (b.kind === "literal") return JSON.stringify(b.value);
  if (b.kind === "input") return `input.${b.path}`;
  if (b.kind === "from") return `${b.step}.${b.path}`;
  return `${b.fn}(${describe(b.of)})`;
}

function accessLine(step: Step): string {
  if (step.kind === "island") return "Model call. Auth declared on wrap — not stored here.";
  if (step.kind === "loop") return "Loop. Body stays inside this step.";
  if (step.kind === "assert") return "Check. Pinned — cannot drop.";
  if (isMutating(step.tool)) return "Write. Auth declared on wrap — not stored here.";
  return "Read. Auth declared on wrap — not stored here.";
}

function isPinnedCheck(step: Step): boolean {
  return step.kind === "assert" || (step.kind === "tool" && isCheckName(step.tool));
}

function kindLabel(step: Step): string {
  if (step.kind === "assert") return "check";
  if (step.kind === "island") return "model";
  if (step.kind === "loop") return "loop";
  return isMutating(step.tool) ? "write" : "read";
}

function tipLine(model: CanvasModel): string {
  if (model.mode === "live") {
    const state = model.state === "live" ? "Live" : model.state === "paused" ? "Paused" : "Rolled back";
    const pin = model.pinnedVersion ? ` · pinned ${model.pinnedVersion.slice(0, 10)}` : "";
    const live =
      model.liveVersion && model.pinnedVersion && model.liveVersion !== model.pinnedVersion
        ? ` · live ${model.liveVersion.slice(0, 10)}`
        : "";
    return `${state}${pin}${live}`;
  }
  const origin = originLine(model.origin);
  if (origin) return origin;
  if (model.verdict === "PASS") return "Ready to inspect";
  if (model.verdict === "FAIL") return "Refused";
  if (model.verdict === "INCONCLUSIVE") return "Not measured";
  if (model.verdict === "pending") return "Waiting";
  return model.verdict ?? "Waiting";
}

function collectBind(program: StretchProgram, paths: Record<string, string>, sources: Record<string, string>): BindEdit[] {
  const out: BindEdit[] = [];
  for (const step of methodSteps(program)) {
    for (const row of bindLines(step)) {
      const key = `${step.id}.${row.field}`;
      const path = paths[key];
      const from = sources[key];
      if (path === undefined && from === undefined) continue;
      const edit: BindEdit = { step: step.id, field: row.field };
      if (path !== undefined) edit.path = path;
      if (from !== undefined) edit.from = from;
      out.push(edit);
    }
  }
  return out;
}

export function CanvasView({ model }: { model: CanvasModel }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [drop, setDrop] = useState<string[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, string>>({});
  const [drag, setDrag] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const program = model.program;
  const layout = useMemo(() => (program ? layoutProgram(program) : null), [program]);
  const faults = useMemo(() => {
    const base = program ? bindingFaults(program) : [];
    const extra = Object.entries(paths)
      .filter(([, v]) => !v.trim())
      .map(([field]) => ({ field, message: "Missing path." }));
    return [...base.filter((f) => paths[f.field] === undefined), ...extra];
  }, [program, paths]);
  const stripped = program ? strippedFromMethod(program) : [];
  const selectedStep = program && selected ? stepById(program, selected) : undefined;
  const blocked = program && selected ? dependentsOf(program, selected) : [];
  const failedDeps = program && model.fail?.step ? dependentsOf(program, model.fail.step) : [];
  const hold = shipHold(model, faults);
  const ship = !hold && canShip(model);
  const origin = originLine(model.origin);

  const onApprove = () => {
    start(async () => {
      const bind = program ? collectBind(program, paths, sources) : [];
      const out = await approveTool(model.id, drop, bind);
      setNotice(out.ok ? "Approved." : out.error || "Could not approve.");
      pokeActivity();
      if (out.ok) router.push(`/live/${encodeURIComponent(model.id)}`);
      else router.refresh();
    });
  };

  return (
    <section className="canvas">
      <header className="canvas-bar">
        <Link href={model.mode === "live" ? homePath("workflows") : homePath("requests")} className="home-go">
          {model.mode === "live" ? "Workflows" : "Requests"}
        </Link>
        <h1>{model.name}</h1>
        <p className="canvas-tip">{tipLine(model)}</p>
      </header>

      <div className="canvas-stage">
        {layout && program ? (
          <Graph
            layout={layout}
            selected={selected}
            drop={drop}
            fail={model.fail?.step}
            blocked={failedDeps}
            drag={drag}
            onSelect={setSelected}
            onDrag={setDrag}
          />
        ) : (
          <p className="canvas-empty">
            {model.refusal || "No method yet. Wrap more runs, then come back."}
          </p>
        )}
        <aside className="canvas-panel" aria-label="Step">
          {selectedStep && program ? (
            <NodeDetail
              step={selectedStep}
              fromIds={methodSteps(program).map((s) => s.id)}
              version={model.version}
              stripped={stripped}
              blocked={blocked}
              faults={faults.filter((f) => f.field.startsWith(`${selectedStep.id}.`) || f.field === selectedStep.id)}
              paths={paths}
              sources={sources}
              drag={drag}
              onPath={(field, value) => setPaths((cur) => ({ ...cur, [field]: value }))}
              onSource={(field, from) => setSources((cur) => ({ ...cur, [field]: from }))}
              dropped={drop.includes(selectedStep.id)}
              onDrop={(on) =>
                setDrop((cur) => (on ? [...new Set([...cur, selectedStep.id])] : cur.filter((id) => id !== selectedStep.id)))
              }
            />
          ) : (
            <p className="canvas-panel-empty">Select a step to inspect bindings, reads, and writes.</p>
          )}
        </aside>
      </div>

      {origin || model.fail ? (
        <p className="canvas-fail" role="status">
          {origin}
          {origin && model.fail ? " · " : null}
          {model.fail
            ? `${failLabel(model.fail.kind)}${model.fail.step ? ` · ${model.fail.step}` : ""} · ${model.fail.detail} ${model.fail.next}`
            : null}
        </p>
      ) : null}

      {model.mode === "request" ? (
        <ApproveStrip
          model={model}
          ship={ship}
          hold={hold}
          pending={pending}
          notice={notice}
          onApprove={onApprove}
          onDismiss={() =>
            start(async () => {
              const out = await dismissRequest(model.id);
              setNotice(out.ok ? "Dismissed." : out.error || "Could not dismiss.");
              pokeActivity();
              if (out.ok) router.push(homePath("requests"));
            })
          }
        />
      ) : (
        <LiveStrip
          model={model}
          pending={pending}
          notice={notice}
          onPause={() =>
            start(async () => {
              const out = await pauseTool(model.id);
              setNotice(out.ok ? "Paused." : out.error || "Could not pause.");
              pokeActivity();
              router.refresh();
            })
          }
          onResume={() =>
            start(async () => {
              const out = await resumeTool(model.id);
              setNotice(out.ok ? "Resumed from here. Completed steps stay done." : out.error || "Could not resume.");
              pokeActivity();
              router.refresh();
            })
          }
        />
      )}
    </section>
  );
}

function Graph({
  layout,
  selected,
  drop,
  fail,
  blocked,
  drag,
  onSelect,
  onDrag,
}: {
  layout: ReturnType<typeof layoutProgram>;
  selected: string | null;
  drop: string[];
  fail?: string;
  blocked: string[];
  drag: string | null;
  onSelect: (id: string) => void;
  onDrag: (id: string | null) => void;
}) {
  const pad = 28;
  const w = layout.width + pad * 2;
  const h = layout.height + pad * 2;
  return (
    <ul className="canvas-graph">
      <svg className="canvas-wires" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
        {layout.edges.map((e) => {
          const a = layout.nodes.find((n) => n.id === e.from)!;
          const b = layout.nodes.find((n) => n.id === e.to)!;
          const x1 = pad + a.x + NODE_W;
          const y1 = pad + a.y + NODE_H / 2;
          const x2 = pad + b.x;
          const y2 = pad + b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          const on = selected === e.from || selected === e.to;
          return (
            <path
              key={`${e.from}-${e.to}-${e.field}`}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              className={on ? "canvas-wire canvas-wire-on" : "canvas-wire"}
            />
          );
        })}
      </svg>
      {layout.nodes.map((n) => {
        const failed = fail === n.id || fail === n.tool;
        const held = blocked.includes(n.id);
        return (
          <li key={n.id} className="canvas-node-wrap" style={{ left: n.x + pad, top: n.y + pad, width: NODE_W, height: NODE_H }}>
          <button
            type="button"
            className="canvas-node"
            draggable
            data-kind={n.kind}
            data-write={n.write ? "true" : undefined}
            data-on={selected === n.id ? "true" : undefined}
            data-drop={drop.includes(n.id) ? "true" : undefined}
            data-fail={failed ? "true" : undefined}
            data-blocked={held ? "true" : undefined}
            data-drag={drag === n.id ? "true" : undefined}
            onClick={() => onSelect(n.id)}
            onDragStart={(ev) => {
              ev.dataTransfer.setData("text/eden-step", n.id);
              ev.dataTransfer.effectAllowed = "link";
              onDrag(n.id);
            }}
            onDragEnd={() => onDrag(null)}
          >
            <span className="canvas-node-kind">
              {n.kind === "assert" ? "check" : n.write ? "write" : n.kind === "tool" ? "read" : n.kind === "island" ? "model" : n.kind}
              {failed ? " · failed" : held ? " · blocked" : drop.includes(n.id) ? " · dropped" : ""}
            </span>
            <span className="canvas-node-name">{n.label}</span>
          </button>
          </li>
        );
      })}
    </ul>
  );
}

function NodeDetail({
  step,
  fromIds,
  version,
  stripped,
  blocked,
  faults,
  paths,
  sources,
  drag,
  onPath,
  onSource,
  dropped,
  onDrop,
}: {
  step: Step;
  fromIds: string[];
  version: string;
  stripped: string[];
  blocked: string[];
  faults: Array<{ field: string; message: string }>;
  paths: Record<string, string>;
  sources: Record<string, string>;
  drag: string | null;
  onPath: (field: string, value: string) => void;
  onSource: (field: string, from: string) => void;
  dropped: boolean;
  onDrop: (on: boolean) => void;
}) {
  const lines = bindLines(step);
  const check = isPinnedCheck(step);
  return (
    <>
      <h2>{step.id}</h2>
      <p className="canvas-k">{kindLabel(step)} · {accessLine(step)}</p>
      <p className="canvas-k">Version {version.slice(0, 12) || "—"}</p>
      <ul className="canvas-binds">
        {lines.length ? (
          lines.map((row) => {
            const key = `${step.id}.${row.field}`;
            const from = sources[key] ?? (row.binding.kind === "from" ? row.binding.step : undefined);
            const path =
              paths[key] ??
              (row.binding.kind === "from" || row.binding.kind === "input" ? row.binding.path : undefined);
            const rewirable = row.binding.kind === "from";
            return (
              <li
                key={row.field}
                data-drop-on={rewirable && drag && drag !== step.id ? "true" : undefined}
                onDragOver={
                  rewirable
                    ? (ev) => {
                        ev.preventDefault();
                        ev.dataTransfer.dropEffect = "link";
                      }
                    : undefined
                }
                onDrop={
                  rewirable
                    ? (ev) => {
                        ev.preventDefault();
                        const id = ev.dataTransfer.getData("text/eden-step");
                        if (id && id !== step.id) onSource(key, id);
                      }
                    : undefined
                }
              >
                <span>{row.field}</span>
                {row.binding.kind === "from" || row.binding.kind === "input" ? (
                  <input
                    className="canvas-path"
                    value={path ?? ""}
                    aria-label={`${row.field} path`}
                    placeholder="path"
                    onChange={(e) => onPath(key, e.target.value)}
                  />
                ) : (
                  <code>{row.text || "—"}</code>
                )}
                {rewirable ? (
                  <>
                    <select
                      className="canvas-path"
                      aria-label={`${row.field} from`}
                      value={from ?? ""}
                      onChange={(e) => onSource(key, e.target.value)}
                    >
                      {(from && !fromIds.includes(from) ? [from, ...fromIds] : fromIds)
                        .filter((id) => id !== step.id)
                        .map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                    </select>
                    {drag && drag !== step.id ? <span className="canvas-k">drop a node to rewire</span> : null}
                  </>
                ) : null}
              </li>
            );
          })
        ) : (
          <li>No bindings on this step.</li>
        )}
      </ul>
      {faults.length ? (
        <ul className="canvas-faults">
          {faults.map((f) => (
            <li key={f.field}>
              {f.field}: {f.message} Nothing is invented.
            </li>
          ))}
        </ul>
      ) : null}
      {blocked.length ? <p className="canvas-k">Downstream blocked: {blocked.join(", ")}</p> : null}
      {stripped.length ? (
        <p className="canvas-k">Stripped from the method: {stripped.join(", ")}</p>
      ) : null}
      {!check ? (
        <label className="canvas-drop">
          <input type="checkbox" checked={dropped} onChange={(e) => onDrop(e.target.checked)} />
          Drop this step before Approve
        </label>
      ) : (
        <p className="canvas-k">Pinned check — cannot drop.</p>
      )}
    </>
  );
}

function ApproveStrip({
  model,
  ship,
  hold,
  pending,
  notice,
  onApprove,
  onDismiss,
}: {
  model: CanvasModel;
  ship: boolean;
  hold: string | null;
  pending: boolean;
  notice: string | null;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const m = model.manifest;
  const writes = model.program
    ? methodSteps(model.program).filter((s) => s.kind === "tool" && isMutating(s.tool))
    : [];
  const reads = model.program
    ? methodSteps(model.program).filter((s) => s.kind === "tool" && !isMutating(s.tool))
    : [];
  return (
    <footer className="canvas-ship">
      <div className="canvas-contract">
        <p>
          Reads {reads.length || "none"} · Writes {writes.length || "none"}
          {writes.length ? ` (${writes.map((s) => (s.kind === "tool" ? s.tool : s.id)).join(", ")})` : ""}
          {model.version ? ` · ${model.version.slice(0, 10)}` : ""}
        </p>
        <p>
          {metric(m?.tokensMeasured, m?.tokensSaved ?? null, "tokens saved")}
          {" · "}
          {metric(m?.timeMeasured, m?.timeSavedMs ?? null, "ms")}
          {" · "}
          {qualityLine(model)}
        </p>
        {hold ? <p>{hold}</p> : null}
      </div>
      {model.siblings.length ? (
        <ul className="canvas-sibs">
          {model.siblings.map((s) => (
            <li key={s.id}>
              <Link href={`/request/${s.id}`}>{s.name}</Link>
              <span>
                {s.verdict === "PASS" ? "Ready" : s.verdict === "FAIL" ? "Refused" : s.verdict === "INCONCLUSIVE" ? "Not measured" : s.verdict}
                {s.reason ? ` · ${s.reason}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="canvas-ship-actions">
        <button type="button" className="signup signup-compact" disabled={!ship || pending} onClick={onApprove}>
          {pending ? "Shipping…" : "Approve"}
        </button>
        <button type="button" className="canvas-quiet" disabled={pending} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {notice ? <p className="canvas-note">{notice}</p> : null}
    </footer>
  );
}

function LiveStrip({
  model,
  pending,
  notice,
  onPause,
  onResume,
}: {
  model: CanvasModel;
  pending: boolean;
  notice: string | null;
  onPause: () => void;
  onResume: () => void;
}) {
  const live = model.state === "live";
  const rec = model.receipt;
  const postmortem = rec
    ? receiptPostmortem(rec, { budgetMs: model.program?.budget?.ms, drift: model.drift })
    : "";
  return (
    <footer className="canvas-ship">
      <div className="canvas-contract">
        <p>
          {live
            ? "Running the pinned method."
            : "Paused. Resume continues from incomplete work — completed steps stay done."}
        </p>
        {postmortem ? <p className="canvas-k">{postmortem}</p> : null}
      </div>
      <div className="canvas-ship-actions">
        {live ? (
          <button type="button" className="canvas-quiet" disabled={pending} onClick={onPause}>
            {pending ? "Working…" : "Pause"}
          </button>
        ) : (
          <button type="button" className="canvas-quiet" disabled={pending} onClick={onResume}>
            {pending ? "Working…" : "Resume"}
          </button>
        )}
      </div>
      {notice ? <p className="canvas-note">{notice}</p> : null}
    </footer>
  );
}
