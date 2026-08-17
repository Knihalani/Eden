"use client";

import { useMemo, useState } from "react";
import { ago, fmtMs } from "../lib/api";
import { useInbox } from "../lib/use-inbox";
import { useListKeys } from "../lib/use-list-keys";
import { Nav } from "../nav";
import { Canvas } from "../ui/canvas";
import { verdictLabel } from "../ui/flow";

export function LiveView({ token, initialId }: { token: string; initialId?: string }) {
  const { inbox, err, load } = useInbox();
  const [sel, setSel] = useState<string | null>(initialId ?? null);

  const live = inbox?.live ?? [];
  const save = inbox?.savings;
  const selected = useMemo(() => {
    if (sel && live.some((t) => t.id === sel)) return sel;
    return live[0]?.id ?? null;
  }, [sel, live]);
  const ids = useMemo(() => live.map((t) => t.id), [live]);
  useListKeys(ids, selected, setSel);
  const loading = inbox == null && !err;

  return (
    <div className="app">
      <Nav
        path="/live"
        connected={inbox?.connected}
        aside={
          <p className="stats" aria-label="Runs">
            <span className={save?.fail ? "stat-fail" : undefined}>
              <b>{save?.fail ?? 0}</b> failed
            </span>
            <span>
              <b>{live.filter((t) => t.state === "live").length}</b> live
            </span>
          </p>
        }
      />
      <div className="workbench">
        <aside className="rail">
          <section className="panel" aria-labelledby="live-h">
            <div className="panel-head">
              <h1 id="live-h">Live</h1>
              <span className="n">{loading ? "…" : live.length}</span>
            </div>
            {loading ? (
              <div className="list" aria-busy="true" aria-label="Loading live tools">
                <div className="skel" />
                <div className="skel" />
              </div>
            ) : live.length ? (
              <div className="list" role="listbox" aria-label="Live tools">
                {live.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="row"
                    role="option"
                    data-on={selected === t.id ? "true" : "false"}
                    data-state={t.state}
                    aria-selected={selected === t.id}
                    onClick={() => setSel(t.id)}
                  >
                    <div className="row-top">
                      <span className="row-name" title={t.name}>
                        {t.state === "live" ? <i className="pulse" aria-hidden /> : null}
                        {t.name}
                      </span>
                      <span className={`verdict ${t.state === "live" ? "pass" : t.state === "paused" ? "paused" : ""}`}>
                        {verdictLabel(t.state)}
                      </span>
                    </div>
                    <p className="meta live-meta">
                      {t.last
                        ? `${t.last.ok ? "ok" : "fail"} · ${fmtMs(t.last.ms)} · ${ago(t.last.created_at)}`
                        : t.stats?.n
                          ? `${t.stats.n} runs`
                          : t.state === "live"
                            ? "Waiting for wrap"
                            : "Paused · waiting for wrap"}
                      {t.stats?.fail ? ` · ${t.stats.fail} failed runs` : ""}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="empty">Approve a request and it runs here. Pause stops wrap from using it.</p>
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
            <Canvas key={selected} id={selected} token={token} mode="live" inbox={inbox ?? undefined} embedded onGone={() => void load()} />
          ) : loading ? (
            <div className="board-skel" aria-busy="true" aria-label="Opening live tools">
              <i className="skel-node" />
              <i className="skel-node" />
              <i className="skel-node" />
            </div>
          ) : (
            <section className="panel">
              <p className="empty">Select a live tool to inspect the workflow.</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
