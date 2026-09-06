"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { canvasBackTitle, homePath } from "../account/home";
import { useMemo, useRef, useState, useTransition } from "react";
import type { Binding, Step, StretchProgram } from "@eden/ir/types";
import { isCheckName, isMutating } from "@eden/ir/names";
import { eq } from "@eden/ir";
import { approveTool, dismissRequest, pauseTool, promoteTool, resumeTool, type BindEdit } from "./actions";
import { tokensCertLine } from "./cert";
import { approveContractLines, envelopeValueRows, liveCanaryLine, liveStretchLine, pinIslandsOffer, tipLine } from "./contract";
import { DISMISS_CONFIRM_MS, confirmExpired, dismissButtonLabel } from "./dismiss";
import { emptyPanelCopy, failLabel, handoffContractLine, originLine, receiptPostmortem } from "./fail";
import {
  NODE_H,
  NODE_W,
  bindingFaults,
  dependentsOf,
  graphSteps,
  layoutProgram,
  stepAccessLine,
  strippedFromMethod,
  nodeProviderCacheHitLine,
  tokenClassLedgerReconcileLine,
  witnessLines,
} from "./layout-program";
import { pokeActivity } from "../home/activity-context";
import type { CanvasModel } from "./model";
import type { TokenClasses } from "@eden/ir";

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

function isPinnedCheck(step: Step): boolean {
  return step.kind === "assert" || (step.kind === "tool" && isCheckName(step.tool));
}

function kindLabel(step: Step): string {
  if (step.kind === "assert") return "check";
  if (step.kind === "island") return "model";
  if (step.kind === "loop") return "loop";
  if (step.kind === "branch") return "branch";
  return isMutating(step.tool) ? "write" : "read";
}

function collectBind(program: StretchProgram, paths: Record<string, string>, sources: Record<string, string>): BindEdit[] {
  const out: BindEdit[] = [];
  for (const step of graphSteps(program)) {
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
  const layout = useMemo(
    () =>
      program
        ? layoutProgram(program, {
            skipped: model.receipt?.skipped,
            memoized: model.receipt?.tokenClass === "memoized",
            transparent: model.receipt?.tokenClass === "transparent",
            compiledRan: model.mode === "live" && model.receipt?.tokenClass !== "transparent" && model.receipt?.tokenClass !== "frontier",
          })
        : null,
    [program, model.receipt?.skipped, model.receipt?.tokenClass, model.mode],
  );
  const faults = useMemo(() => {
    const base = program ? bindingFaults(program) : [];
    const extra = Object.entries(paths)
      .filter(([, v]) => !v.trim())
      .map(([field]) => ({ field, message: "Missing path." }));
    return [...base.filter((f) => paths[f.field] === undefined), ...extra];
  }, [program, paths]);
  const stripped = program ? strippedFromMethod(program) : [];
  const selectedStep = program && selected ? stepById(program, selected) : undefined;
  const selectedClass = selected && layout ? layout.nodes.find((n) => n.id === selected)?.tokenClass : undefined;
  const blocked = program && selected ? dependentsOf(program, selected) : [];
  const failedDeps = program && model.fail?.step ? dependentsOf(program, model.fail.step) : [];
  const hold = shipHold(model, faults);
  const ship = !hold && canShip(model);
  const origin = originLine(model.origin);

  const onApprove = (opts: {
    transparentWrites: boolean;
    dropValues?: Array<{ path: string; value: unknown }>;
    pinIslands?: boolean;
  }) => {
    start(async () => {
      const bind = program ? collectBind(program, paths, sources) : [];
      const out = await approveTool(model.id, drop, bind, opts);
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
          {canvasBackTitle(model)}
        </Link>
        <h1>{model.name}</h1>
        <p className="canvas-tip">{tipLine(model)}</p>
        <p className="canvas-hint">Scroll to see the whole graph.</p>
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
        <aside className="canvas-panel" aria-label="Step" aria-live="polite">
          {selectedStep ? <span className="sr-only">Selected step: {selectedStep.id}.</span> : null}
          {selectedStep && program ? (
            <NodeDetail
              step={selectedStep}
              tokenClass={selectedClass}
              tokenClasses={model.receipt?.tokenClasses}
              promptTokens={model.receipt?.prompt_tokens}
              completionTokens={model.receipt?.completion_tokens}
              cachedTokens={model.receipt?.cached_tokens}
              cacheWriteTokens={model.receipt?.cache_write_tokens}
              cacheInputTokens={model.receipt?.cache_input_tokens}
              fromIds={graphSteps(program).map((s) => s.id)}
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
            <p className="canvas-panel-empty">{emptyPanelCopy({ program, refusal: model.refusal })}</p>
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
          onPromote={() =>
            start(async () => {
              const out = await promoteTool(model.id);
              setNotice(out.ok ? "Live · 100% of sessions." : out.error || "Could not promote.");
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
    <ul className="canvas-graph" aria-label="Method">
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
            data-token-class={n.tokenClass}
            data-write={n.write ? "true" : undefined}
            data-on={selected === n.id ? "true" : undefined}
            data-drop={drop.includes(n.id) ? "true" : undefined}
            data-fail={failed ? "true" : undefined}
            data-blocked={held ? "true" : undefined}
            data-drag={drag === n.id ? "true" : undefined}
            aria-pressed={selected === n.id}
            aria-label={`${n.label}, ${n.kind === "tool" ? (n.write ? "write" : "read") : n.kind}${failed ? ", failed" : held ? ", blocked" : drop.includes(n.id) ? ", removed" : ""}`}
            onClick={() => onSelect(n.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
                return;
              }
              event.preventDefault();
              const ids = layout.nodes.map((node) => node.id);
              const index = ids.indexOf(n.id);
              const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
              const next = ids[(index + delta + ids.length) % ids.length];
              if (!next) return;
              onSelect(next);
              const root = event.currentTarget.closest(".canvas-graph");
              const target = root?.querySelector(`[data-step="${next}"]`);
              if (target instanceof HTMLElement) target.focus();
            }}
            data-step={n.id}
            onDragStart={(ev) => {
              ev.dataTransfer.setData("text/eden-step", n.id);
              ev.dataTransfer.effectAllowed = "link";
              onDrag(n.id);
            }}
            onDragEnd={() => onDrag(null)}
          >
            <span className="canvas-node-kind">
              {n.kind === "tool" ? (n.write ? "write" : "read") : n.label}
              {failed ? " · failed" : held ? " · blocked" : drop.includes(n.id) ? " · removed" : ""}
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
  tokenClass,
  tokenClasses,
  promptTokens,
  completionTokens,
  cachedTokens,
  cacheWriteTokens,
  cacheInputTokens,
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
  tokenClass?: string;
  tokenClasses?: TokenClasses;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheInputTokens?: number;
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
  const witnessed = witnessLines(step);
  const check = isPinnedCheck(step);
  const provider =
    promptTokens != null && completionTokens != null && Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
      ? { prompt: promptTokens, completion: completionTokens }
      : undefined;
  const ledger = tokenClasses ? tokenClassLedgerReconcileLine(tokenClasses, provider) : null;
  const cacheLine = nodeProviderCacheHitLine({
    cached_tokens: cachedTokens,
    prompt_tokens: promptTokens,
    cache_write_tokens: cacheWriteTokens,
    cache_input_tokens: cacheInputTokens,
  });
  return (
    <>
      <h2>{step.id}</h2>
      <p className="canvas-k">
        {kindLabel(step)}
        {tokenClass ? ` · ${tokenClass}` : ""} · {stepAccessLine(step)}
      </p>
      {ledger ? (
        <p className="canvas-k canvas-ledger" data-token-ledger="">
          {ledger}
        </p>
      ) : null}
      {cacheLine ? (
        <p className="canvas-k canvas-ledger" data-provider-cache-hit="">
          {cacheLine}
        </p>
      ) : null}
      <p className="canvas-k">Version {version.slice(0, 12) || "—"}</p>
      <ul className="canvas-binds">
        {witnessed.map((row) => (
          <li key={row.field}>
            <span>{row.field}</span>
            <code>{row.text}</code>
          </li>
        ))}
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
        ) : witnessed.length ? null : (
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
          Remove this step before Approve
        </label>
      ) : (
        <p className="canvas-k">Pinned check — cannot remove.</p>
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
  onApprove: (opts: {
    transparentWrites: boolean;
    dropValues?: Array<{ path: string; value: unknown }>;
    pinIslands?: boolean;
  }) => void;
  onDismiss: () => void;
}) {
  // Dismiss deletes permanently, so it arms into "Confirm dismiss" for a short
  // window; Esc or moving focus away reverts it before anything is deleted.
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [serveWrites, setServeWrites] = useState(false);
  const [dropValues, setDropValues] = useState<Array<{ path: string; value: unknown }>>([]);
  const [pinIslands, setPinIslands] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirming = armedAt != null && !confirmExpired(armedAt, Date.now());

  const disarm = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedAt(null);
  };

  const arm = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmedAt(Date.now());
    armTimer.current = setTimeout(disarm, DISMISS_CONFIRM_MS);
  };

  const onDismissClick = () => {
    if (!confirming) {
      arm();
      return;
    }
    disarm();
    onDismiss();
  };

  const m = model.manifest;
  const writes = model.program
    ? graphSteps(model.program).filter((s) => s.kind === "tool" && isMutating(s.tool))
    : [];
  const contract = approveContractLines(model);
  const envRows = envelopeValueRows(model.program?.contract.envelope, dropValues);
  const pin = pinIslandsOffer(model.program);
  return (
    <footer className="canvas-ship">
      <div className="canvas-contract">
        {contract.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {envRows.length ? (
          <ul className="canvas-env">
            <li className="canvas-env-lead">Witnessed values. Drop extras to tighten. The last value of a key stays.</li>
            {envRows.map((row, i) => (
                <li key={`${row.path}:${i}`}>
                  <span>{row.text}</span>
                  {row.canDrop ? (
                    <button
                      type="button"
                      className="canvas-quiet canvas-env-drop"
                      disabled={pending}
                      onClick={() =>
                        setDropValues((cur) =>
                          row.dropped
                            ? cur.filter((d) => !(d.path === row.path && eq(d.value, row.value)))
                            : [...cur, { path: row.path, value: row.value }],
                        )
                      }
                    >
                      {row.dropped ? "Keep" : "Drop"}
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        ) : null}
        <p>
          {tokensCertLine(m)}
          {" · "}
          {metric(m?.timeMeasured, m?.timeSavedMs ?? null, "ms")}
          {" · "}
          {qualityLine(model)}
        </p>
        {handoffContractLine(model.program, model.origin?.mode) ? (
          <p>{handoffContractLine(model.program, model.origin?.mode)}</p>
        ) : null}
        {hold ? (
          <p id="canvas-hold" role="status">
            {hold}
          </p>
        ) : null}
      </div>
      {writes.length || (model.program?.sequence ?? []).includes("Write") ? (
        <label className="canvas-write-gate">
          <input
            type="checkbox"
            checked={serveWrites}
            disabled={pending}
            onChange={(event) => setServeWrites(event.target.checked)}
          />
          <span>Serve Write results into the last tool output. Off unless you check this — and the host env allows it.</span>
        </label>
      ) : null}
      {pin.show ? (
        <label className="canvas-write-gate">
          <input
            type="checkbox"
            checked={pinIslands}
            disabled={pending}
            onChange={(event) => setPinIslands(event.target.checked)}
          />
          <span>
            Pin stable islands
            {pin.ready === true ? " — ready" : pin.ready === false ? " — not yet stable" : ""}
          </span>
        </label>
      ) : null}
      {model.siblings.length ? (
        <ul className="canvas-sibs">
          {model.siblings.map((s) => (
            <li key={s.id}>
              <Link href={`/request/${s.id}`}>{s.name}</Link>
              <span>{s.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="canvas-ship-actions">
        <button
          type="button"
          className="signup signup-compact"
          disabled={!ship || pending}
          aria-describedby={hold ? "canvas-hold" : undefined}
          onClick={() =>
            onApprove({
              transparentWrites: serveWrites,
              ...(dropValues.length ? { dropValues } : {}),
              ...(pinIslands ? { pinIslands: true } : {}),
            })
          }
        >
          {pending ? "Shipping…" : "Approve"}
        </button>
        <button
          type="button"
          className="canvas-quiet canvas-dismiss"
          data-armed={confirming ? "true" : undefined}
          disabled={pending}
          onClick={onDismissClick}
          onBlur={disarm}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              disarm();
            }
          }}
        >
          {dismissButtonLabel(confirming)}
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
  onPromote,
}: {
  model: CanvasModel;
  pending: boolean;
  notice: string | null;
  onPause: () => void;
  onResume: () => void;
  onPromote: () => void;
}) {
  const live = model.state === "live";
  const rec = model.receipt;
  const words = model.fail?.stretchWords ?? [];
  const stretch = liveStretchLine(model, words);
  const postmortem = rec
    ? receiptPostmortem(rec, { budgetMs: model.program?.budget?.ms, drift: model.drift, stretchWords: words })
    : model.fail?.stretch ?? "";
  const canary = liveCanaryLine(model);
  return (
    <footer className="canvas-ship">
      <div className="canvas-contract">
        <p>
          {live
            ? "Running the pinned method."
            : "Paused. Resume continues from incomplete work — completed steps stay done."}
        </p>
        {canary ? <p>{canary}</p> : null}
        {stretch ? <p className="canvas-k">{stretch}</p> : null}
        {postmortem ? <p className="canvas-k">{postmortem}</p> : null}
      </div>
      <div className="canvas-ship-actions">
        {live ? (
          <button type="button" className="canvas-quiet" disabled={pending} onClick={onPause} aria-label="Pause this live tool">
            {pending ? "Working…" : "Pause"}
          </button>
        ) : (
          <button
            type="button"
            className="canvas-quiet"
            disabled={pending}
            onClick={onResume}
            aria-label="Resume from incomplete work. Completed steps stay done."
          >
            {pending ? "Working…" : "Resume"}
          </button>
        )}
        {canary ? (
          <button type="button" className="canvas-quiet" disabled={pending} onClick={onPromote}>
            {pending ? "Working…" : "Promote"}
          </button>
        ) : null}
      </div>
      {notice ? <p className="canvas-note">{notice}</p> : null}
    </footer>
  );
}
