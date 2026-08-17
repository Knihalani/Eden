"use client";

import { useMemo, useState } from "react";
import { CopyPrompt } from "./copy-prompt";
import { compileTraces } from "./lib/api";
import type { Candidate } from "./lib/types";
import { useInbox } from "./lib/use-inbox";
import { useListKeys } from "./lib/use-list-keys";
import { Nav } from "./nav";
import { Canvas } from "./ui/canvas";
import { verdictLabel } from "./ui/flow";

function setupPrompt(wrap: string, key: string): string {
  return `Integrate Eden into this agent. Do not add Claude Code hooks.

EDEN_WRAP_URL=${wrap}
EDEN_API_KEY=${key}
Keep OPENAI_API_KEY in this process (islands). Do not send it to Eden.

npm i @eden/wrap

Wrap every tool the model can call with:
  const e = eden({ apiKey: process.env.EDEN_API_KEY, baseUrl: process.env.EDEN_WRAP_URL })
  const tools = e.wrapTools(existingTools)
Pass \`tools\` into the agent, not the originals.
Point the OpenAI client at e.openai(model) (baseURL = wrap /v1).

Eden records traces, compiles, and shows stretches here.
Nothing goes live until a human Approves at ${wrap}.
Fail-open if wrap is down.`;
}

function isIssue(c: Candidate): boolean {
  return Boolean(c.refusal) || c.verdict === "FAIL" || c.verdict === "INCONCLUSIVE";
}

function issueLabel(c: Candidate): string {
  if (c.program?.name) return c.program.name;
  const slot = c.refusal?.slot ?? "";
  return slot.split(/[.\s]/)[0] || "refused";
}

function Chips({ names }: { names: string[] }) {
  return (
    <p className="chips">
      {names.slice(0, 4).map((n) => (
        <span key={n} className="chip">
          {n}
        </span>
      ))}
      {names.length > 4 ? <span className="chip">+{names.length - 4}</span> : null}
    </p>
  );
}

export function Dashboard({ wrap, token, initialId }: { wrap: string; token: string; initialId?: string }) {
  const { inbox, err, setErr, load } = useInbox();
  const [sel, setSel] = useState<string | null>(initialId ?? null);

  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState("");
  const prompt = setupPrompt(wrap.replace(/\/$/, ""), token);

  const candidates = inbox?.candidates ?? [];
  const requests = candidates.filter((c) => c.program && !isIssue(c));
  const issues = candidates.filter(isIssue);
  const save = inbox?.savings;
  const selected = useMemo(() => {
    if (sel && candidates.some((c) => c.id === sel)) return sel;
    return requests[0]?.id ?? issues[0]?.id ?? null;
  }, [sel, candidates, requests, issues]);
  const ids = useMemo(() => [...requests, ...issues].map((c) => c.id), [requests, issues]);
  useListKeys(ids, selected, setSel);
  const railTab = issues.some((c) => c.id === selected) ? "issues" : "requests";
  const loading = inbox == null && !err;

  return (
    <div className="app">
      <Nav
        path="/"
        connected={inbox?.connected}
        aside={
          <p className="stats" aria-label="Runs">
            <span className={save?.fail ? "stat-fail" : undefined}>
              <b>{save?.fail ?? 0}</b> failed
            </span>
            <span>
              <b>{save?.live ?? 0}</b> live
            </span>
          </p>
        }
      />
      <div className="workbench">
        <aside className="rail" data-tab={railTab}>
          <div className="rail-tabs" role="tablist" aria-label="Inbox">
            <button
              type="button"
              role="tab"
              aria-selected={railTab === "requests"}
              onClick={() => setSel(requests[0]?.id ?? selected)}
            >
              Requests {loading ? "…" : requests.length}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={railTab === "issues"}
              onClick={() => setSel(issues[0]?.id ?? selected)}
            >
              Issues {loading ? "…" : issues.length}
            </button>
          </div>
          <section className="panel" aria-labelledby="req-h">
            <div className="panel-head">
              <h1 id="req-h">Requests</h1>
              <span className="n">{loading ? "…" : requests.length}</span>
              <button
                type="button"
                className="ghost push"
                disabled={compiling}
                aria-busy={compiling}
                onClick={() => {
                  setCompiling(true);
                  setCompileErr("");
                  compileTraces(token)
                    .then(load)
                    .catch((e) => setCompileErr(String(e instanceof Error ? e.message : e)))
                    .finally(() => setCompiling(false));
                }}
              >
                {compiling ? "Compiling…" : "Compile"}
              </button>
            </div>
            {compileErr ? (
              <p className="panel-err" role="alert">
                {compileErr}
              </p>
            ) : null}
            {loading ? (
              <div className="list" aria-busy="true" aria-label="Loading requests">
                <div className="skel" />
                <div className="skel" />
                <div className="skel" />
              </div>
            ) : requests.length ? (
              <div className="list" role="listbox" aria-label="Requests">
                {requests.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="row"
                    role="option"
                    data-on={selected === c.id ? "true" : "false"}
                    aria-selected={selected === c.id}
                    onClick={() => setSel(c.id)}
                  >
                    <div className="row-top">
                      <span className="row-name" title={c.program?.name || "stretch"}>
                        {c.program?.name || "stretch"}
                      </span>
                      <span className={`verdict ${c.verdict === "PASS" ? "pass" : ""}`}>{verdictLabel(c.verdict)}</span>
                    </div>
                    <Chips names={c.sequence} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="empty">Nothing to approve yet. Compile traces, or wait for wrap to send them.</p>
            )}
          </section>
          <section className="panel" aria-labelledby="iss-h">
            <div className="panel-head">
              <h2 id="iss-h">Issues</h2>
              <span className="n">{loading ? "…" : issues.length}</span>
            </div>
            {loading ? (
              <div className="list" aria-busy="true" aria-label="Loading issues">
                <div className="skel" />
              </div>
            ) : issues.length ? (
              <div className="list" role="listbox" aria-label="Issues">
                {issues.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="row"
                    role="option"
                    data-on={selected === c.id ? "true" : "false"}
                    data-fail="true"
                    aria-selected={selected === c.id}
                    onClick={() => setSel(c.id)}
                  >
                    <div className="row-top">
                      <span className="row-name" title={c.refusal?.slot || issueLabel(c)}>
                        {issueLabel(c)}
                      </span>
                      <span className="verdict fail">{verdictLabel(c.verdict)}</span>
                    </div>
                    <Chips names={c.sequence} />
                    {c.refusal?.reason ? (
                      <p className="reason" title={c.refusal.reason}>
                        {c.refusal.reason}
                      </p>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <p className="empty">No refusals. Failed stretches will land here.</p>
            )}
          </section>
        </aside>
        <div className="stage">
          {err ? (
            <p className="stage-banner" role="alert">
              {err}
            </p>
          ) : null}
          {selected ? (
            <Canvas key={selected} id={selected} token={token} mode="request" inbox={inbox ?? undefined} embedded onGone={() => void load()} />
          ) : loading ? (
            <div className="board-skel" aria-busy="true" aria-label="Opening the workbench">
              <i className="skel-node" />
              <i className="skel-node" />
              <i className="skel-node" />
            </div>
          ) : (
            <section className="panel setup-panel">
              <div className="setup">
                <ol className="setup-steps">
                  <li>Point wrap at this origin.</li>
                  <li>Wrap every tool the model can call.</li>
                  <li>Approve stretches here before they go live.</li>
                </ol>
                <div className="setup-lead">
                  <p>Give this to your coding agent.</p>
                  <span className="push">
                    <CopyPrompt
                      text={prompt}
                      onFail={() => {
                        const el = document.querySelector(".prompt");
                        if (!(el instanceof HTMLElement)) return;
                        const range = document.createRange();
                        range.selectNodeContents(el);
                        const sel = window.getSelection();
                        sel?.removeAllRanges();
                        sel?.addRange(range);
                      }}
                    />
                  </span>
                </div>
                <pre className="prompt">{prompt}</pre>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
