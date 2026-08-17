"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ago,
  approve,
  dismissCandidate,
  fmtMs,
  fmtX,
  getInbox,
  getReceipts,
  packEdits,
  pauseTool,
  resumeTool,
  rollbackTool,
} from "@/app/lib/api";
import type { Candidate, Inbox, LiveTool, Step } from "@/app/lib/types";
import { Nav } from "@/app/nav";
import { bindingsOf, Flow, kindHint, kindLabel, labelOf, verdictLabel } from "@/app/ui/flow";

const DEMO: Candidate = {
  id: "demo",
  sequence: [
    "lookupTicket",
    "fetchDetails",
    "parseFields",
    "validate",
    "draftReply",
    "writeRecord",
    "verifyWrite",
    "notify",
  ],
  verdict: "PASS",
  refusal: null,
  created_at: 0,
  manifest: {
    llmReduction: 2.4,
    latencyReduction: 1.8,
    costReduction: 2.1,
    skipRateBefore: 0.12,
    skipRateAfter: 0,
    nShadow: 6,
  },
  program: {
    id: "demo",
    version: "0",
    name: "resolve_ticket",
    description: "Look up, validate, draft, write, verify, notify.",
    sequence: [
      "lookupTicket",
      "fetchDetails",
      "parseFields",
      "validate",
      "draftReply",
      "writeRecord",
      "verifyWrite",
      "notify",
    ],
    manifest: {
      llmReduction: 2.4,
      latencyReduction: 1.8,
      costReduction: 2.1,
      skipRateBefore: 0.12,
      skipRateAfter: 0,
      nShadow: 6,
    },
    steps: [
      { id: "lookup", kind: "tool", tool: "lookupTicket", args: { id: { kind: "input", path: "id" } } },
      { id: "details", kind: "tool", tool: "fetchDetails", args: { id: { kind: "input", path: "id" } } },
      {
        id: "parsed",
        kind: "tool",
        tool: "parseFields",
        args: { details: { kind: "from", step: "details", path: "" } },
      },
      {
        id: "valid",
        kind: "tool",
        tool: "validate",
        args: { fields: { kind: "from", step: "parsed", path: "" } },
      },
      { id: "validOk", kind: "assert", expr: "ok == true", onFail: "deopt" },
      {
        id: "draft",
        kind: "island",
        input: { kind: "from", step: "parsed", path: "" },
        system: "Draft a short, specific support reply. Return JSON {text}.",
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      {
        id: "write",
        kind: "tool",
        tool: "writeRecord",
        args: {
          id: { kind: "input", path: "id" },
          reply: { kind: "from", step: "draft", path: "text" },
        },
      },
      { id: "verify", kind: "tool", tool: "verifyWrite", args: { id: { kind: "input", path: "id" } } },
      { id: "verified", kind: "assert", expr: "verified == true", onFail: "error" },
      { id: "notify", kind: "tool", tool: "notify", args: { id: { kind: "input", path: "id" } } },
    ],
  },
};

type Run = { id: string; ok: number; ms: number; llm_calls: number; created_at: number };

export function Canvas({
  id,
  token,
  mode,
  inbox,
  embedded,
  onGone,
}: {
  id: string;
  token: string;
  mode: "request" | "live";
  inbox?: Inbox;
  embedded?: boolean;
  onGone?: () => void;
}) {
  const router = useRouter();
  const preview = id === "demo";
  const fromInbox = inbox?.candidates.find((x) => x.id === id) ?? null;
  const liveFromInbox = inbox?.live.find((x) => x.id === id) ?? null;
  const [cand, setCand] = useState<Candidate | null>(preview ? DEMO : fromInbox);
  const [live, setLive] = useState<LiveTool | null>(liveFromInbox);
  const [ready, setReady] = useState(preview || Boolean(fromInbox || liveFromInbox));
  const initialName = preview
    ? DEMO.program!.name
    : fromInbox?.program?.name || liveFromInbox?.name || (fromInbox?.refusal?.slot?.split(/[.\s]/)[0] ?? "");
  const [name, setName] = useState(initialName);
  const [origName, setOrigName] = useState(initialName);
  const [drop, setDrop] = useState<string[]>([]);
  const [island, setIsland] = useState<string[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [assertExpr, setAssertExpr] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [recErr, setRecErr] = useState("");

  function addPin() {
    const v = assertExpr.trim();
    if (!v) return;
    setPins((p) => [...p, v]);
    setAssertExpr("");
  }

  useEffect(() => {
    if (preview) return;
    if (inbox) {
      const c = inbox.candidates.find((x) => x.id === id) ?? null;
      const t = inbox.live.find((x) => x.id === id) ?? null;
      setCand(c);
      setLive(t);
      setReady(true);
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const next = await getInbox();
        if (stop) return;
        const c = next.candidates.find((x) => x.id === id) ?? null;
        const t = next.live.find((x) => x.id === id) ?? null;
        setCand(c);
        setLive(t);
        setReady(true);
        const n = c?.program?.name || t?.name;
        if (n) {
          setName((cur) => cur || n);
          setOrigName((o) => o || n);
        }
      } catch (e) {
        if (stop) return;
        setReady(true);
        setErr(String(e instanceof Error ? e.message : e));
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 4000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [id, preview, inbox]);

  useEffect(() => {
    if (mode !== "live" || preview || !id) return;
    let stop = false;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await getReceipts(token, id);
        if (stop) return;
        setRuns(next.receipts.slice(0, 12));
        setRecErr("");
      } catch (e) {
        if (!stop) setRecErr(String(e instanceof Error ? e.message : e));
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 4000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [mode, preview, id, token]);

  const program = cand?.program || live?.program || null;
  const steps = useMemo(() => {
    if (program?.steps?.length) return program.steps;
    const seq = cand?.sequence ?? [];
    return seq.map((tool, i) => ({ id: `seq_${i}`, kind: "tool" as const, tool, args: {} }));
  }, [program, cand]);

  const selected = steps.find((s) => s.id === sel) ?? steps[0];
  const fault = useMemo(() => {
    const slot = cand?.refusal?.slot;
    if (!slot) return null;
    const tool = slot.split(".")[0] ?? "";
    return steps.find((s) => s.kind === "tool" && s.tool === tool)?.id ?? steps.find((s) => s.id === tool)?.id ?? null;
  }, [cand, steps]);

  useEffect(() => {
    if (fault) setSel(fault);
  }, [fault]);

  async function run(fn: () => Promise<unknown>, opts?: { then?: string; gone?: boolean }) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr("");
    try {
      await fn();
      if (opts?.gone) {
        if (opts.then && !embedded) router.push(opts.then);
        else onGone?.();
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const edits = packEdits(name, origName, drop, island, pins);
  const canApprove = !preview && mode === "request" && cand?.verdict === "PASS" && Boolean(cand.program);
  const verdict = preview ? "preview" : cand?.verdict || live?.state || "";
  const m = cand?.manifest || program?.manifest;
  const blocked = whyBlocked(preview, mode, cand, live);

  useEffect(() => {
    if (confirmRollback) confirmBtn.current?.focus();
  }, [confirmRollback]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirmRollback) {
        e.preventDefault();
        setConfirmRollback(false);
        return;
      }
      if (confirmRollback && e.key === "Tab") {
        const a = confirmBtn.current;
        const b = cancelBtn.current;
        if (!a || !b) return;
        e.preventDefault();
        (document.activeElement === a ? b : a).focus();
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canApprove && !busyRef.current) {
        e.preventDefault();
        void run(() => approve(id, token, edits), { then: "/live", gone: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canApprove, confirmRollback, edits, id, token]);

  const body = (
    <div className={`canvas-page${embedded ? " embedded" : ""}${mode === "live" ? " live-mode" : ""}`}>
      <div className="board" role="region" aria-label="Workflow">
        <div className="toolbar">
          {!embedded && (
            <Link className="back" href={mode === "live" ? "/live" : "/"}>
              ← {mode === "live" ? "Live" : "Home"}
            </Link>
          )}
          <input
            className="name-in"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => {
              if (mode === "live") return;
              e.currentTarget.select();
            }}
            aria-label="Workflow name"
            readOnly={mode === "live"}
            spellCheck={false}
            autoComplete="off"
          />
          <span className={`verdict ${verdict === "PASS" || verdict === "live" ? "pass" : verdict === "FAIL" ? "fail" : verdict === "paused" ? "paused" : ""}`}>
            {verdictLabel(verdict)}
          </span>
          {mode === "request" && canApprove ? (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => run(() => dismissCandidate(id, token), { then: "/", gone: true })}
            >
              Dismiss
            </button>
          ) : null}
        </div>
        <Flow steps={steps} selected={sel} dropped={drop} islands={island} fault={fault} live={mode === "live" && live?.state === "live"} onSelect={setSel} />
      </div>
      <aside className="inspect">
        <div className="inspect-body">
          {cand?.refusal?.reason ? <p className="reason">{cand.refusal.reason}</p> : null}
          {selected ? (
            <>
              <span className="kicker" data-kind={cand?.refusal ? "fail" : selected.kind}>
                {cand?.refusal ? "Failed" : kindLabel(selected.kind)}
              </span>
              <h2>{labelOf(selected)}</h2>
              <p>{kindHint(selected.kind)}</p>
              {m ? <p className="meta">{fmtX(m.llmReduction)} LLM after compile{live?.last ? ` · last ${fmtMs(live.last.ms)} ${ago(live.last.created_at)}` : ""}</p> : null}
              <ul className="binds">
                {bindingsOf(selected).length ? (
                  bindingsOf(selected).map((b) => (
                    <li key={b.key}>
                      <span>{b.key}</span>
                      <code title={b.value || undefined}>{b.value || "—"}</code>
                    </li>
                  ))
                ) : (
                  <li>No arguments on this step.</li>
                )}
              </ul>
              {mode === "request" && canApprove && selected.kind === "tool" ? (
                <div className="actions">
                  <button
                    type="button"
                    className="ghost"
                    aria-pressed={drop.includes(selected.id)}
                    onClick={() =>
                      setDrop((d) => (d.includes(selected.id) ? d.filter((x) => x !== selected.id) : [...d, selected.id]))
                    }
                  >
                    {drop.includes(selected.id) ? "Keep this step" : "Drop this step"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    aria-pressed={island.includes(selected.id)}
                    onClick={() =>
                      setIsland((d) => (d.includes(selected.id) ? d.filter((x) => x !== selected.id) : [...d, selected.id]))
                    }
                  >
                    {island.includes(selected.id) ? "Keep compiled" : "Keep as a model call"}
                  </button>
                </div>
              ) : null}
              {mode === "request" && canApprove && selected.kind === "assert" ? (
                <p>This check stays. It cannot be dropped.</p>
              ) : null}
              {mode === "request" && canApprove ? (
                <div className="assert-row">
                  <input
                    value={assertExpr}
                    onChange={(e) => setAssertExpr(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                        e.preventDefault();
                        addPin();
                      }
                    }}
                    placeholder="Add a check"
                    aria-label="Check expression"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button type="button" className="ghost" onClick={addPin}>
                    Add
                  </button>
                </div>
              ) : null}
              {pins.length ? <p className="meta">Added checks: {pins.join(" · ")}</p> : null}
            </>
          ) : (
            <p>This stretch has no graph yet.</p>
          )}
          {mode === "live" && (runs.length || (live?.stats?.n ?? 0) > 0 || recErr) ? (
            <div className="runs">
              <h3>Recent runs</h3>
              <p className="meta">
                {live?.stats?.n ?? runs.length} total
                {live?.stats?.fail ? ` · ${live.stats.fail} failed` : ""}
              </p>
              {recErr ? <p className="err">{recErr}</p> : null}
              <ol>
                {(runs.length ? runs : live?.last ? [live.last] : []).map((r, i) => (
                  <li key={`${r.created_at}-${i}`} data-ok={r.ok ? "true" : "false"}>
                    <span>{r.ok ? "ok" : "fail"}</span>
                    <span>{fmtMs(r.ms)}</span>
                    <span>{"llm_calls" in r && r.llm_calls != null ? `${r.llm_calls} llm` : ""}</span>
                    <span>{ago(r.created_at)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
        <div className="ship">
          {mode === "request" ? (
            <>
              <p className="ship-lead">
                {canApprove
                  ? `This will go live as ${name || "this stretch"}. Nothing runs until you approve.`
                  : blocked}
              </p>
              {canApprove ? editsSummary(drop, island, pins, name, origName, steps) : null}
              {preview ? null : (
                <button
                  type="button"
                  className="primary"
                  disabled={!canApprove || busy}
                  title={canApprove ? undefined : blocked}
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                  onClick={() => {
                    if (!canApprove) return;
                    void run(() => approve(id, token, edits), { then: "/live", gone: true });
                  }}
                >
                  {busy && canApprove ? "Shipping…" : (
                    <>
                      Approve
                      <kbd aria-hidden>⌘↩</kbd>
                    </>
                  )}
                </button>
              )}
              {cand && !preview && !canApprove ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => run(() => dismissCandidate(id, token), { then: "/", gone: true })}
                >
                  Dismiss
                </button>
              ) : null}
            </>
          ) : live ? (
            <>
              <p className="ship-lead">
                {live.state === "live"
                  ? live.last
                    ? `Last run ${fmtMs(live.last.ms)} ${ago(live.last.created_at)}${live.last.ok ? "" : " — failed"}.`
                    : "Live. Waiting for the next wrap run."
                  : "Paused. Wrap will fail-open until you resume."}
              </p>
              <div className="actions">
                {live.state === "live" ? (
                  <button type="button" className="ghost" disabled={busy} onClick={() => run(() => pauseTool(id, token))}>
                    Pause
                  </button>
                ) : (
                  <button type="button" className="primary ice" disabled={busy} onClick={() => run(() => resumeTool(id, token))}>
                    Resume
                  </button>
                )}
                {live.canRollback === false ? null : confirmRollback ? (
                  <>
                    <button
                      ref={confirmBtn}
                      type="button"
                      className="ghost danger"
                      disabled={busy}
                      onClick={() =>
                        run(
                          async () => {
                            await rollbackTool(id, token);
                            setConfirmRollback(false);
                          },
                          { then: "/live", gone: true },
                        )
                      }
                    >
                      Confirm rollback
                    </button>
                    <button ref={cancelBtn} type="button" className="ghost" onClick={() => setConfirmRollback(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmRollback(true)}>
                    Rollback
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="ship-lead">{blocked}</p>
          )}
          {err ? <p className="err" role="alert">{err}</p> : null}
        </div>
      </aside>
    </div>
  );

  if (embedded) return body;

  if (ready && !cand && !live) {
    return (
      <div className="app">
        <Nav path={mode === "live" ? "/live" : "/"} />
        <p className="empty">This workflow is gone.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Nav path={mode === "live" ? "/live" : "/"} />
      {body}
    </div>
  );
}

function whyBlocked(preview: boolean, mode: string, cand: Candidate | null, live: LiveTool | null): string {
  if (preview) return "Preview only — this stretch is not in your inbox.";
  if (mode === "live") return live ? "" : "This live tool is gone.";
  if (!cand) return "This request is gone.";
  if (!cand.program) return "This stretch was refused. Dismiss it, fix the wrap tool, then compile again. There is nothing to approve.";
  if (cand.verdict === "pending") return "Still checking this stretch against traces. Approve unlocks when it passes.";
  if (cand.verdict === "FAIL") return "This stretch did not pass shadow. Dismiss it, fix the wrap tool, then compile again. Approve stays locked.";
  if (cand.verdict === "INCONCLUSIVE") return "Shadow was unclear. It cannot go live yet.";
  return "Edit the graph, then Approve to ship.";
}

function editsSummary(
  drop: string[],
  island: string[],
  pins: string[],
  name: string,
  orig: string,
  steps: Step[],
) {
  const names = new Map(steps.map((s) => [s.id, labelOf(s)]));
  const bits: string[] = [];
  if (name.trim() && name.trim() !== orig) bits.push(`Rename to ${name.trim()}`);
  if (drop.length) bits.push(`Drop ${drop.map((id) => names.get(id) ?? id).join(", ")}`);
  if (island.length) bits.push(`Keep ${island.map((id) => names.get(id) ?? id).join(", ")} as a model call`);
  if (pins.length) bits.push(`Add check ${pins.join(", ")}`);
  if (!bits.length) return null;
  return (
    <ul className="edit-sum">
      {bits.map((b) => (
        <li key={b}>{b}</li>
      ))}
    </ul>
  );
}
